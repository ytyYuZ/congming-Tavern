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
import {
  characterDraftId,
  worldDraftId,
  writeLocaleSetting,
  writeProviderSettings,
} from '../db/repository';
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

/**
 * A refusal the way a real gateway sends one (A3): a non-2xx status and the vendor's own words.
 *
 * `co-create/ask.ts` reads a refusal through the adapter, which composes
 * `HTTP {status}: {label} ({this message})` — so the wording here is what decides whether the
 * degradation ladder recognises a refusal as being ABOUT the response schema.
 */
function refusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

  it('retries once without the response schema, then says the degraded path was used', async () => {
    const worldId = await seedWorld();
    // The draft row is seeded for the same reason as in the first test: a proposal that ARRIVES is
    // only useful if it still applies, and the preview is asserted over the proposed value.
    await useContentStore.getState().openWorld(worldId);
    await useContentStore.getState().editWorld(await draftOf(worldId), {});
    await useContentStore.getState().close();

    // ATTEMPT 1 IS REFUSED BY NAME (docs/02 §5.3's level ②), attempt 2 is an ordinary SSE answer
    // carrying a FENCED JSON object — i.e. exactly the prose shape level ③ produces. Reading it is
    // `readProposal`'s job, the one reader this app has: the degraded path adds no second parser.
    let attempts = 0;
    configureCoCreate({
      transport: (() => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? refusal(400, "Invalid parameter: 'response_format' is not supported")
            : answer([
                '```json\n',
                '{"message":"我把一句话设定补上。","ops":[{"op":"replace","path":"/premise","value":"群岛在霜月下沉"}]}\n',
                '```',
              ]),
        );
      }) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await typeInto(host, '[data-field="co-create-input"]', '帮我写一句话设定');
    await clickButton(host, '发送');
    await waitForText(host, '我把一句话设定补上。');

    // EXACTLY two requests: one step down the ladder, taken once (§5.3 has no level ④).
    expect(attempts).toBe(2);
    // The author is told which level produced the answer — as a NOTICE, because nothing failed.
    const degraded = host.querySelector('[data-status="co-create-degraded"]');
    expect(degraded?.textContent).toContain('普通请求重试');
    expect(degraded?.classList.contains('notice-error')).toBe(false);
    expect(host.querySelector('[data-status="co-create-finding"]')).toBeNull();
    expect(host.querySelector('[data-status="co-create-error"]')).toBeNull();
    // The unconstrained answer still became a usable proposal…
    expect(host.querySelector('[data-status="co-create-preview"]')?.textContent).toContain(
      '群岛在霜月下沉',
    );
    expect(host.querySelector('[data-action="co-create-accept"]')).not.toBeNull();
  });

  it('reports a refusal that names nothing as it happened, and spends no second request', async () => {
    const worldId = await seedWorld();
    let attempts = 0;
    configureCoCreate({
      transport: (() => {
        attempts += 1;
        return Promise.resolve(refusal(400, 'model not found'));
      }) as FetchLike,
    });

    const host = await mountAt(`/worlds/${worldId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await typeInto(host, '[data-field="co-create-input"]', '开始');
    await clickButton(host, '发送');
    await waitForText(host, 'model not found');

    // ONE request: nothing in this refusal names the schema, so there is no level to descend to.
    expect(attempts).toBe(1);
    const finding = host.querySelector('[data-status="co-create-finding"]');
    // The honest sentence: the status and the server's own words…
    expect(finding?.textContent).toContain('HTTP 400');
    expect(finding?.textContent).toContain('model not found');
    // …and NOT the guess that the model name is wrong, which is what the reported bug displayed.
    expect(finding?.textContent).not.toContain('模型名');
    // The ladder was never spent, so there is nothing to announce about it.
    expect(host.querySelector('[data-status="co-create-degraded"]')).toBeNull();
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

/*
 * M1-C2 / M1-C3 THROUGH THE CHARACTER SCREEN.
 *
 * `state/character-co-create.test.ts` proves the transitions and the rows for a character; only a DOM test
 * can show that the SAME panel reaches them when it is mounted with `kind="character"` — a panel that
 * listed the world's fields, previewed against the world's schema, or hid the assessment button would be
 * invisible on the store side and obvious to a user. So this suite clicks the real buttons on the real
 * character route and ends every step at the draft ROW.
 */
describe('the co-creation panel on a character card (M1-C2 / M1-C3)', () => {
  /** A character whose card already says something, so 「从零生成」 starts and M1-C3 has evidence. */
  async function seedStartedCharacter(): Promise<string> {
    const characterId = await useContentStore.getState().createCharacter('银松镇的莉安');
    if (characterId === undefined) throw new Error('the character was not created');
    await useContentStore.getState().openCharacter(characterId);
    const draft = useContentStore.getState().characterDraft;
    if (draft === undefined) throw new Error('the character has no draft');
    await useContentStore.getState().editCharacter(
      {
        ...draft.data,
        description: '莉安是银松镇的镇长，说话直接、声音很响，掌握着渡口与粮仓的账目。',
      },
      {},
    );
    return characterId;
  }

  it('walks a character step: preview differs from the form, 采纳 fills it, 撤销 puts it back', async () => {
    const characterId = await seedStartedCharacter();
    const before = JSON.stringify(await storedValue(characterDraftId(characterId)));
    // The answer writes a field the draft row currently holds EMPTY, so "the editor shows the proposed
    // value" cannot be confused with a field that already said something similar.
    configureCoCreate({
      transport: (() =>
        Promise.resolve(
          answer([
            '{"message":"先写性格","ops":[{"op":"replace","path":"/personality",',
            '"value":"急躁、护短"}]}',
          ]),
        )) as FetchLike,
    });

    const host = await mountAt(`/characters/${characterId}`, '发布新版本');
    // The character route has the panel toggle the world route has (M1-C2's missing half).
    await clickAction(host, 'co-create-toggle');
    await waitForText(host, '生成模式');

    /*
     * 从零生成 STARTS THE CHARACTER'S OWN PLAN, and the panel lists it: `identity` is the first step and
     * there are SIX of them, because the plan is the character's field inventory rather than the world's.
     */
    await clickAction(host, 'co-create-start');
    await waitForText(host, '先写性格');
    expect(coCreateRequests().at(-1)?.card).toBe('character');
    expect(coCreateRequests().at(-1)?.step).toBe('identity');
    expect(nextStep(host)).toBe('identity');
    expect(host.querySelectorAll('[data-list="co-create-steps"] [data-step]')).toHaveLength(6);
    // THE PREVIEW IS THE PROPOSED PAYLOAD, while the form still shows the empty draft field.
    expect(host.querySelector('[data-status="co-create-preview"]')?.textContent).toContain(
      '急躁、护短',
    );
    expect(fieldValue(host, '[data-field="character-personality"]')).toBe('');

    // 采纳: the editor shows the proposed value and the draft ROW holds it.
    await clickAction(host, 'co-create-accept');
    await settle();
    expect(fieldValue(host, '[data-field="character-personality"]')).toBe('急躁、护短');
    expect(stepState(host, 'identity')).toBe('accepted');
    await waitForText(host, '撤销这次采纳');

    // 撤销 puts the form AND the row back, byte for byte.
    await clickAction(host, 'co-create-undo');
    await settle();
    expect(fieldValue(host, '[data-field="character-personality"]')).toBe('');
    expect(JSON.stringify(await storedValue(characterDraftId(characterId)))).toBe(before);
  });

  it('assesses the speaking profile from the card, shows the reason, and applies it on 采纳', async () => {
    const characterId = await seedStartedCharacter();
    const before = JSON.stringify(await storedValue(characterDraftId(characterId)));
    configureCoCreate({
      transport: (() =>
        Promise.resolve(
          answer([
            JSON.stringify({
              message: '我按描述评估了发言档案。',
              rationale: '描述里她管着镇子和粮仓账目，所以说话主动、分量足。',
              ops: [
                { op: 'replace', path: '/voice/desire', value: 82 },
                { op: 'replace', path: '/voice/ability', value: 64 },
              ],
            }),
          ]),
        )) as FetchLike,
    });

    const host = await mountAt(`/characters/${characterId}`, '发布新版本');
    await clickAction(host, 'co-create-toggle');
    await waitForText(host, '发言档案评估');
    // The form starts on the blank profile's neutral middle, so the proposal is visibly a change.
    expect(fieldValue(host, '[data-field="voice-desire"]')).toBe('50');

    await clickAction(host, 'co-create-voice-evaluate');
    await waitForText(host, '我按描述评估了发言档案。');

    // The request was the assessment, scoped to the profile fields alone.
    const requested = coCreateRequests().at(-1);
    expect(requested?.kind).toBe('voice-profile');
    expect(requested?.paths).toEqual(['/voice/desire', '/voice/ability', '/voice/roles']);
    // 「并给出理由」 is ON SCREEN beside the numbers, and nothing is written yet.
    const reason = host.querySelector('[data-status="co-create-voice-reason"]');
    expect(reason?.textContent).toContain('粮仓账目');
    expect(fieldValue(host, '[data-field="voice-desire"]')).toBe('50');
    await settle();
    expect(JSON.stringify(await storedValue(characterDraftId(characterId)))).toBe(before);

    await clickAction(host, 'co-create-accept');
    await settle();
    expect(fieldValue(host, '[data-field="voice-desire"]')).toBe('82');
    expect(fieldValue(host, '[data-field="voice-ability"]')).toBe('64');
    // The scheduler's hard limits stay the author's own.
    expect(fieldValue(host, '[data-field="voice-maxLinesPerRound"]')).toBe('1');

    await clickAction(host, 'co-create-undo');
    await settle();
    expect(fieldValue(host, '[data-field="voice-desire"]')).toBe('50');
    expect(JSON.stringify(await storedValue(characterDraftId(characterId)))).toBe(before);
  });
});
