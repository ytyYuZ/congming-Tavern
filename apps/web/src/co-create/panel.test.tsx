/**
 * The co-creation panel as a SCREEN (M1-W2): generate → preview → accept → the editor shows it →
 * undo.
 *
 * WHY A DOM TEST ON TOP OF THE STORE'S STORAGE ROUND TRIP
 * `state/co-create-store.test.ts` proves the transitions and the rows; it cannot see whether a CONTROL
 * is wired to them. A preview that renders the DRAFT instead of the proposal, an 采纳 button that
 * calls 否决, or an undo that never re-renders the form are all invisible to a store test — and all
 * three are exactly the failures this milestone's acceptance is stated over. So this file mounts the
 * real `<App/>` at the real path, types into the real textarea, clicks the real buttons, and asserts
 * BOTH the preview pane and the form field the editor renders.
 *
 * THE WIRE IS REAL AND FAKED AT THE SOCKET ONLY
 * The transport is a fake `fetch` answering STANDARD SSE, so the request goes through the app's one
 * provider path (`co-create/ask.ts` -> `OpenAICompatibleProvider`) and the answer through the app's
 * one reader. Nothing about the panel is stubbed.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { FetchLike } from '@smarttavern/providers';
import type { JsonValue } from '@smarttavern/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../app/app';
import { closeDatabase, readTable, resetDatabase } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import { worldDraftId, writeLocaleSetting, writeProviderSettings } from '../db/repository';
import {
  coCreateRequests,
  configureChat,
  configureCoCreate,
  resetChat,
  resetCoCreate,
  resetContentStore,
  resetLocaleStore,
  resetSettingsStore,
  useContentStore,
  useLocaleStore,
  useSettingsStore,
} from '../mount';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;
const originalScrollTo = window.scrollTo;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => undefined;
});

afterAll(() => {
  window.scrollTo = originalScrollTo;
});

beforeEach(async () => {
  databases += 1;
  databaseName = `apps-web-co-create-panel-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetCoCreate();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  // No ordinary turn runs in this file; the co-creation transport is substituted per test.
  configureChat({
    transport: () => Promise.reject(new Error('no chat transport for this test')),
  });
  await writeProviderSettings({
    baseUrl: 'https://gateway.test/v1',
    model: 'test-model-1',
    secret: { kind: 'plaintext', apiKey: 'sk-test' },
  });
  await writeLocaleSetting('zh-CN');
  useLocaleStore.setState({ locale: 'zh-CN' });
  await useSettingsStore.getState().load();
});

afterEach(async () => {
  await unmount();
  resetChat();
  resetCoCreate();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ───────────────────────────── the local harness ─────────────────────────── */

/** The answer the next co-creation turn receives, as a standard SSE body. */
function answer(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const payloads = [
    ...chunks.map(
      (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A world with a published version 1, created through the store the library screen uses. */
async function seedWorld(): Promise<string> {
  const worldId = await useContentStore.getState().createWorld('霜月群岛');
  if (worldId === undefined) throw new Error('the world was not created');
  return worldId;
}

/**
 * The open world's draft payload, as a value this test can then edit.
 *
 * The world is opened for the read and LEFT open: the panel's own `world.tsx` mount opens it again,
 * and an already-open card with no draft row is exactly the state a first visit has.
 */
async function draftOf(worldId: string) {
  await useContentStore.getState().openWorld(worldId);
  const draft = useContentStore.getState().worldDraft;
  if (draft === undefined) throw new Error('the world has no draft');
  return draft.data;
}

async function mountAt(path: string, expected: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  container = host;
  const router = createAppRouter(path);
  await act(async () => {
    root = createRoot(host);
    root.render(<App router={router} />);
  });
  await waitForText(host, expected);
  await settle();
  return host;
}

async function waitForText(host: Element, expected: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((host.textContent ?? '').includes(expected)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected}; DOM was: ${host.innerHTML}`);
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function unmount(): Promise<void> {
  const current = root;
  root = undefined;
  if (current !== undefined) {
    await act(async () => {
      current.unmount();
    });
  }
  container?.remove();
  container = undefined;
}

/** Type into a controlled field the way a browser does. */
async function typeInto(host: Element, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error(`no field ${selector}`);
  }
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Click the button whose label is exactly `label`, or the one with `data-action`. */
async function clickButton(host: Element, label: string): Promise<void> {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The `data-*` value of the step the plan points at, or `undefined` when the list is not rendered. */
function nextStep(host: Element): string | undefined {
  const step = host.querySelector('[data-list="co-create-steps"] [data-step-next="yes"]');
  return step?.getAttribute('data-step') ?? undefined;
}

/** The state of one step, as the plan list prints it. */
function stepState(host: Element, id: string): string | undefined {
  return host.querySelector(`[data-step="${id}"]`)?.getAttribute('data-step-state') ?? undefined;
}

/** Choose an option in a `<select>` the way a browser does (React listens for `change`). */
async function chooseOption(host: Element, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLSelectElement)) throw new Error(`no select ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function clickAction(host: Element, action: string): Promise<void> {
  const button = host.querySelector(`[data-action="${action}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no ${action} button`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** One `settings` row's value, read the way the draft reader reads it. */
async function storedValue(id: string): Promise<JsonValue | undefined> {
  const row = await readTable<{ id: string; value: JsonValue }>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/** A field's current value, as the form renders it. */
function fieldValue(host: Element, selector: string): string {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error(`no field ${selector}`);
  }
  return field.value;
}

/* ────────────────────────────────── tests ───────────────────────────────── */

describe('the co-creation panel', () => {
  it('previews the proposal, shows it in the editor after 采纳, and puts the card back on 撤销', async () => {
    const worldId = await seedWorld();
    // THE DRAFT ROW IS SEEDED FIRST, with an empty premise. Two reasons: 「撤销把草稿恢复成采纳之前的样子」
    // is a statement about the bytes of a row that exists, and the blank premise makes "the editor
    // shows the proposed value" unambiguous — an empty field becoming a sentence cannot be confused
    // with a field that already said something similar.
    await useContentStore.getState().openWorld(worldId);
    await useContentStore.getState().editWorld(await draftOf(worldId), {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    await useContentStore.getState().close();

    configureCoCreate({
      transport: (() =>
        Promise.resolve(
          answer([
            '{"message":"我把一句话设定补上。","ops":[{"op":"replace","path":"/premise",',
            '"value":"群岛在霜月下沉"}]}',
          ]),
        )) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('');

    // 打开 AI 共创 — the panel is a toggle, so its controls are absent until it is opened.
    await clickAction(host, 'co-create-toggle');
    await waitForText(host, 'AI 共创');
    expect(host.querySelector('[data-status="co-create-no-proposal"]')).not.toBeNull();

    await typeInto(host, '[data-field="co-create-input"]', '帮我写一句话设定');
    await clickButton(host, '发送');
    await waitForText(host, '我把一句话设定补上。');

    // THE PREVIEW IS THE PROPOSED PAYLOAD, not the draft: the pane holds the new value while the
    // editor's own field still shows the old one.
    const preview = host.querySelector('[data-status="co-create-preview"]');
    expect(preview?.textContent).toContain('群岛在霜月下沉');
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('');

    await clickAction(host, 'co-create-accept');
    // The editor now shows it, and the draft ROW holds it. `settle` rather than `waitForText`: the
    // store's write is a fire-and-forget promise inside the click handler, and the assertion below is
    // about the ROW, which is what makes "the form shows it" a statement about storage.
    await settle();
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('群岛在霜月下沉');
    const applied = JSON.stringify(await storedValue(worldDraftId(worldId)));
    expect(applied).toContain('群岛在霜月下沉');
    // The preview pane is gone with the proposal, and the undo is offered instead.
    expect(host.querySelector('[data-status="co-create-no-proposal"]')).not.toBeNull();
    await waitForText(host, '撤销这次采纳');

    await clickAction(host, 'co-create-undo');
    await waitForText(host, '当前没有待处理的提案。');
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('');
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
  });

  it('shows a model answer it cannot read as a finding, and changes nothing', async () => {
    const worldId = await seedWorld();
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    configureCoCreate({
      transport: (() => Promise.resolve(answer(['我觉得先聊聊题材比较好。']))) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await typeInto(host, '[data-field="co-create-input"]', '开始');
    await clickButton(host, '发送');
    await waitForText(host, 'JSON');

    // The finding is the catalog's sentence with the model's own words in its `{detail}` slot, and
    // there is nothing to accept.
    const finding = host.querySelector('[data-status="co-create-finding"]');
    expect(finding?.textContent).toContain('JSON');
    expect(finding?.textContent).toContain('我觉得先聊聊题材比较好。');
    expect(host.querySelector('[data-action="co-create-accept"]')).toBeNull();
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
  });

  it('refuses to start when no model service is configured, and says so', async () => {
    const worldId = await seedWorld();
    await writeProviderSettings({ baseUrl: '', model: '', secret: { kind: 'none' } });
    await useSettingsStore.getState().load();
    configureCoCreate({
      transport: (() => Promise.reject(new Error('nothing should be sent'))) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await typeInto(host, '[data-field="co-create-input"]', '你好');
    await clickButton(host, '发送');
    // The refusal is `chat-store.ts`'s own `error.notConfigured` sentence, so a locked key and a
    // missing endpoint cannot be reported as the same problem.
    await waitForText(host, '请先在「设置」中填写服务地址与模型名');
    expect(host.querySelector('[data-status="co-create-error"]')).not.toBeNull();
  });
});

/*
 * M1-W3 / M1-W4 THROUGH THE REAL SCREEN.
 *
 * `state/co-create-store.test.ts` proves the sequence and the rows; only a DOM test can show that the
 * CONTROLS reach them — a 从零生成 button wired to the wrong action, a step list that never marks what is
 * accepted, or a field picker whose selection never reaches the request are all invisible on the store
 * side and obvious to a user. So this suite clicks the real buttons on the real world route and ends
 * every step at the draft ROW.
 */
describe('generation mode and field-level actions', () => {
  /** A world whose draft carries a genre, which is what 「从零生成」 asks for before it starts. */
  async function seedStartedWorld(): Promise<string> {
    const worldId = await seedWorld();
    await useContentStore.getState().openWorld(worldId);
    const draft = useContentStore.getState().worldDraft;
    if (draft === undefined) throw new Error('the world has no draft');
    await useContentStore.getState().editWorld({ ...draft.data, genre: ['冰海奇幻'] }, {});
    await useContentStore.getState().close();
    return worldId;
  }

  it('walks the plan one step at a time: 采纳 the first step, 否决 the second, and the card keeps only the first', async () => {
    const worldId = await seedStartedWorld();
    // The draft row exists, so "nothing of step 2 is in it" is a statement about stored bytes.
    await useContentStore.getState().openWorld(worldId);
    await useContentStore.getState().editWorld(await draftOf(worldId), {});
    await useContentStore.getState().close();

    // ONE ANSWER PER STEP, in the order the walk asks for them: `calls` counts the transport's own
    // invocations, so the first request (step 1) and the second (step 2) each get their own answer.
    let calls = 0;
    configureCoCreate({
      transport: (() => {
        calls += 1;
        const body =
          calls === 1
            ? '{"message":"先给一句概要","ops":[{"op":"replace","path":"/premise","value":"群岛在霜月下沉"}]}'
            : '{"message":"再写世界设定","ops":[{"op":"replace","path":"/era","value":"第三纪"}]}';
        return Promise.resolve(answer([body]));
      }) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await waitForText(host, '生成模式');

    // 从零生成 sends ONE request for the first step, and the plan says which step that is.
    await clickAction(host, 'co-create-start');
    await waitForText(host, '先给一句概要');
    expect(nextStep(host)).toBe('premise');
    expect(stepState(host, 'premise')).toBe('pending');
    expect(stepState(host, 'basics')).toBe('pending');
    // The preview is step 1's payload, and the editor still holds the empty field.
    expect(host.querySelector('[data-status="co-create-preview"]')?.textContent).toContain(
      '群岛在霜月下沉',
    );
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('');

    await clickAction(host, 'co-create-accept');
    // step 1 is accepted, the card shows it, and the walk asked for step 2 by itself.
    await waitForText(host, '再写世界设定');
    expect(stepState(host, 'premise')).toBe('accepted');
    expect(nextStep(host)).toBe('basics');
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('群岛在霜月下沉');
    expect(fieldValue(host, '[data-field="world-era"]')).toBe('');

    // 否决 step 2: nothing of it reaches the card, and the walk stops asking for more.
    await clickAction(host, 'co-create-reject');
    await settle();
    expect(stepState(host, 'basics')).toBe('rejected');
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('群岛在霜月下沉');
    expect(fieldValue(host, '[data-field="world-era"]')).toBe('');
    const row = JSON.stringify(await storedValue(worldDraftId(worldId)));
    expect(row).toContain('群岛在霜月下沉');
    expect(row).not.toContain('第三纪');
  });

  it('rewrites ONE selected field through the field picker, and 撤销 puts the row back', async () => {
    const worldId = await seedWorld();
    await useContentStore.getState().openWorld(worldId);
    const draft = useContentStore.getState().worldDraft;
    if (draft === undefined) throw new Error('the world has no draft');
    await useContentStore
      .getState()
      .editWorld({ ...draft.data, premise: '作者的一句', era: '第三纪' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    await useContentStore.getState().close();
    configureCoCreate({
      transport: (() =>
        Promise.resolve(
          answer([
            '{"message":"重写好了","ops":[{"op":"replace","path":"/premise","value":"霜月压着海面"}]}',
          ]),
        )) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await waitForText(host, '字段级 AI 操作');

    // 选择字段 → 重写: one click pair, and the request is about that field alone.
    await chooseOption(host, '[data-field="co-create-field"]', '/premise');
    await clickAction(host, 'co-create-field-rewrite');
    await waitForText(host, '重写好了');
    const requested = coCreateRequests().at(-1);
    expect(requested?.kind).toBe('field-op');
    expect(requested?.fieldOp).toBe('rewrite');
    expect(requested?.paths).toEqual(['/premise']);
    // The preview shows the new sentence while the editor still shows the author's own.
    expect(host.querySelector('[data-status="co-create-preview"]')?.textContent).toContain(
      '霜月压着海面',
    );
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('作者的一句');
    expect(fieldValue(host, '[data-field="world-era"]')).toBe('第三纪');

    await clickAction(host, 'co-create-accept');
    await settle();
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('霜月压着海面');
    // ONLY that field: the one beside it is byte-for-byte what the author typed.
    expect(fieldValue(host, '[data-field="world-era"]')).toBe('第三纪');

    await clickAction(host, 'co-create-undo');
    await settle();
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('作者的一句');
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
  });

  it('refuses a field proposal that touches another field, shows the finding, and changes no row', async () => {
    const worldId = await seedWorld();
    await useContentStore.getState().openWorld(worldId);
    const draft = useContentStore.getState().worldDraft;
    if (draft === undefined) throw new Error('the world has no draft');
    await useContentStore
      .getState()
      .editWorld({ ...draft.data, premise: '作者的一句', era: '第三纪' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    await useContentStore.getState().close();
    configureCoCreate({
      transport: (() =>
        Promise.resolve(
          answer([
            '{"message":"顺手改了时代","ops":[{"op":"replace","path":"/premise","value":"新的"},{"op":"replace","path":"/era","value":"第四纪"}]}',
          ]),
        )) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await chooseOption(host, '[data-field="co-create-field"]', '/premise');
    await clickAction(host, 'co-create-field-rewrite');
    // The finding names the path the model reached for, and there is nothing to accept.
    await waitForText(host, '/era');
    expect(host.querySelector('[data-action="co-create-accept"]')).toBeNull();
    expect(fieldValue(host, '[data-field="world-premise"]')).toBe('作者的一句');
    expect(fieldValue(host, '[data-field="world-era"]')).toBe('第三纪');
    await settle();
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
  });
});
