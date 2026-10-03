/**
 * ADR-037 的开关本身（C1）：`settings` 行 `feature.timeAndScheduling`，**行缺席＝关闭**。
 *
 * WHY THIS FILE EXISTS
 * `docs/05-决策记录.md:758-775` 定的是一件事：升级上来的老库没有这一行，所以默认是关闭；用户
 * 在设置里点一下才打开。别处那些「播种开启态」的文件验的是开启态与开关之前逐字一致，这里验的是
 * 另一半——**关闭时那三件事同时成立**：
 *   ① 不推进：`TimeControls`/`SchedulerPanel`/`CastInterventionPanel` 三组控件不渲染，目录里
 *      也没有它们那三节（那是一条关于 DOM 的规则，走真实挂载，所以留在
 *      `apps/web/src/app/routes/routes.test.tsx` 末尾的 `C1` 那一组）；
 *   ② 时间块不参与组装：本文件的 ① 是那条纯派生，② 是同一批输入下的两态请求；
 *   ③ 调度器不参与发言决定：本文件的 ③ 直接盯 `state/chat-store.ts` 里的那三处调用点。
 *
 * 存储行本身（缺席＝`false`、写入之后＝`true`、形状不对也算关闭）与 store 的两态在 ④。
 *
 * 每个用例开一个自己的数据库并在结尾关掉，所以文件的顺序不影响彼此，也不漏给别的文件。
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { COLLECTIONS, renderParts } from '@smarttavern/core';
import type { FetchLike } from '@smarttavern/providers';
import type { PromptPreset } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, resetDatabase, write } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import * as repository from '../db/repository';
import {
  listTurnPlans,
  readTimeAndSchedulingSetting,
  type SettingsRow,
  TIME_AND_SCHEDULING_SETTINGS_ID,
  writeTimeAndSchedulingSetting,
} from '../db/repository';
// 一个「会话作为容器」的会话，带着创建流程会收集的那组 pin（M1-S1）：这里的主语是开关，不是
// 哪个世界。
import { createTestSession as createSession } from '../db/session.test-helpers';
import {
  resetChat,
  resetFeatureStore,
  useChatStore,
  useFeatureStore,
  useLocaleStore,
} from '../mount';
import {
  BUILTIN_CALENDAR,
  BUILTIN_PRESET,
  WORLD_CLOCK_BLOCK_ID,
  withoutWorldClock,
} from './builtin-content';
import { clockOf } from './clock';
import { sendTurn } from './send-turn';

const CONFIG = {
  baseUrl: 'https://gateway.test/v1',
  apiKey: 'sk-feature-switch',
  model: 'feature-model',
};

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-feature-switch-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  // 开关是模块级状态，和别的 store 一样必须逐例复位，否则「播种开启」的用例会把下一例也打开。
  resetFeatureStore();
  // 本文件断言的提示词文案来自内置内容，不来自目录；但语言钉住之后，任何一句落进目录的
  // 句子都不会随宿主浏览器的报告语言变。
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetChat();
  resetFeatureStore();
  // 先关连接，否则下面的删除请求会被它挡住。
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ────────────────────────── 一个只会点头的假 socket ────────────────────────── */

/**
 * The request the adapter sent, as the shape this file reads.
 *
 * A DECLARED interface and not an index-signature bag: this workspace compiles with
 * `noPropertyAccessFromIndexSignature`, so `body.messages` would be an error on a bag.
 */
interface WireRequest {
  messages?: { role: string; content: string }[];
}

/**
 * `fetch` 的假实现：记下最后一次请求体，回一段标准 SSE。
 *
 * 只有 ② 需要它——两态请求要真的从适配器发出去才看得见提示词。刻意比
 * `send-turn.test.ts` 的那一套小：这里不验重试、不验中止，也不看 `Authorization`。
 */
function fakeWire(): { fetch: FetchLike; lastBody: () => WireRequest | undefined } {
  let body: WireRequest | undefined;
  const fetch: FetchLike = (_url, init) => {
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as WireRequest;
      } catch {
        body = undefined;
      }
    }
    const encoder = new TextEncoder();
    const payloads = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { fetch, lastBody: () => body };
}

/** 一次请求里的 system 消息文本，按顺序。 */
function systemTexts(messages: WireRequest['messages']): string[] {
  return (messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
}

/** 一段提示词，拼成一段文本再断言——「在哪一块里」不是这里的问题。 */
function prompt(texts: readonly string[]): string {
  return texts.join('\n');
}

/**
 * 调用方自己写的 preset：它读时钟的那一块**不叫** `builtin-world-clock`。
 *
 * 这正是「只按 id 滤」挡不住的情形——`withoutWorldClock` 只认得内置的那一块，任何别处的
 * `{{time}}` 都还在。所以关闭态必须在**读数**这一层就没有时钟可读（`chat/clock.ts` 的
 * `promptContext` 第 4 个参数可选、缺席即不出现），否则换一支日历的值顶上照样会把时刻渲染
 * 出来，而那正是 ADR-037:768 要禁止的。
 */
function presetWithOwnClockBlock(): PromptPreset {
  const base = withoutWorldClock(BUILTIN_PRESET);
  return {
    ...base,
    id: 'caller-preset',
    blocks: [
      ...base.blocks,
      {
        id: 'caller-clock-block',
        name: '调用方自己的时间行',
        role: 'system',
        content: '自定义时刻：{{date}} {{time}}（{{segment}}）',
        enabled: true,
        position: 'pre_history',
        order: 9,
        budget: { priority: 'required' },
      },
    ],
  };
}

/** 直接往 `settings` 集合里放一行，绕过仓库的写入器（要造的正是它不会造的形状）。 */
async function putRaw(id: string, value: unknown): Promise<void> {
  await write(async (tx) => {
    await tx.collection<SettingsRow>(COLLECTIONS.settings).put({ id, value } as SettingsRow);
  });
}

/** 一个由测试自己决定何时落地的 promise（用在「迟到的读取」那一例）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (settle === undefined) throw new Error('deferred: no resolver');
      settle(value);
    },
  };
}

/* ────────────────────────────────── 用例 ────────────────────────────────── */

describe('① 时间块：纯派生，不就地改那个常量', () => {
  it('withoutWorldClock 只滤掉 builtin-world-clock，BUILTIN_PRESET 一个字节都没变', () => {
    const before = JSON.stringify(BUILTIN_PRESET);
    const derived = withoutWorldClock(BUILTIN_PRESET);

    // 常量本身还是完整的：`session/roster.ts` 把它的 id/version/name 抄进
    // `BUILTIN_PRESET_CHOICE`（`session/roster.test.ts` 盯着这份相等），chat 的用例直接读它的
    // blocks——就地改会同时污染这两处，所以派生必须是新对象。
    expect(JSON.stringify(BUILTIN_PRESET)).toBe(before);
    expect(BUILTIN_PRESET.blocks.some((block) => block.id === WORLD_CLOCK_BLOCK_ID)).toBe(true);

    expect(derived).not.toBe(BUILTIN_PRESET);
    expect(derived.blocks).not.toBe(BUILTIN_PRESET.blocks);
    expect(derived.blocks.some((block) => block.id === WORLD_CLOCK_BLOCK_ID)).toBe(false);
    expect(derived.blocks).toHaveLength(BUILTIN_PRESET.blocks.length - 1);
    // 是浅拷贝：除了滤掉的那一块，其余的还是同一批对象，id/version/name 也照抄。
    expect(derived.id).toBe(BUILTIN_PRESET.id);
    expect(derived.version).toBe(BUILTIN_PRESET.version);
    expect(derived.name).toBe(BUILTIN_PRESET.name);
    for (const block of derived.blocks) {
      expect(BUILTIN_PRESET.blocks).toContain(block);
    }
  });
});

describe('② 关闭时提示词里没有时间块，开启时有（同一批输入，只差这一位）', () => {
  it('关闭那一遍少一个 system 块，而且找不到这个会话的世界时刻', async () => {
    const session = await createSession({ title: 'switch-prompt' });
    const off = fakeWire();
    const on = fakeWire();

    const offTurn = await sendTurn(
      { config: CONFIG, transport: off.fetch },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );
    const onTurn = await sendTurn(
      { config: CONFIG, transport: on.fetch, timeAndScheduling: true },
      { sessionId: session.id, text: '第二句', signal: new AbortController().signal },
    );
    expect(offTurn.error).toBeUndefined();
    expect(onTurn.error).toBeUndefined();

    const offSystem = systemTexts(off.lastBody()?.messages);
    const onSystem = systemTexts(on.lastBody()?.messages);
    // 这个会话的世界时刻，用视图与既有用例用的同一对函数算出来：目录/日历的措辞改了会跟着走，
    // 而不是把断言断掉。
    const moment = renderParts(clockOf(BUILTIN_CALENDAR, session));

    expect(prompt(offSystem)).not.toContain(moment);
    expect(prompt(offSystem)).not.toContain('当前时间');
    expect(prompt(onSystem)).toContain(moment);
    // 差的正好是那一块：system 块少一个，而两遍都还带着会话自己的块——关掉的是时间，不是
    // 整个 preset。
    expect(onSystem).toHaveLength(offSystem.length + 1);
    expect(prompt(offSystem)).toContain('世界：test-world');
    expect(prompt(onSystem)).toContain('世界：test-world');
  });

  // 反泄漏：② 的前一例靠的是「内置那一块被滤掉了」，而这一例专门造一块**不叫那个 id** 的
  // 时间行——只按 id 滤挡不住它，所以在**读数**这一层就不能有时钟。这条一旦失败，就说明关闭
  // 态又去取了某支日历的读数。
  it('调用方自己的 {{time}} 块在关闭时也不会渲染出时刻，开启时才会', async () => {
    const session = await createSession({ title: 'switch-caller-preset' });
    const preset = presetWithOwnClockBlock();
    const off = fakeWire();
    const on = fakeWire();

    const offTurn = await sendTurn(
      { config: CONFIG, transport: off.fetch, preset },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );
    const onTurn = await sendTurn(
      { config: CONFIG, transport: on.fetch, preset, timeAndScheduling: true },
      { sessionId: session.id, text: '第二句', signal: new AbortController().signal },
    );
    expect(offTurn.error).toBeUndefined();
    expect(onTurn.error).toBeUndefined();

    const offText = prompt(systemTexts(off.lastBody()?.messages));
    const onText = prompt(systemTexts(on.lastBody()?.messages));
    const moment = renderParts(clockOf(BUILTIN_CALENDAR, session));

    // 关闭：宏保持未解析（`engine/prompt/macros.ts` 的规矩：解析不了的宏原样留着），所以
    // 既没有读数，也没有拿别支日历的读数顶上。
    expect(offText).toContain('自定义时刻：{{date}} {{time}}（{{segment}}）');
    expect(offText).not.toContain(moment);
    // 开启：同一个 preset、同一批输入，宏被解析成这个会话的时刻。
    expect(onText).not.toContain('{{time}}');
    expect(onText).toContain(moment);
  });
});

describe('③ 关闭时调度器不参与发言决定', () => {
  it('不给「下一位是谁」的建议，也拒绝走调度器那条路，而且一行 turnPlan 都不写', async () => {
    const session = await createSession({ title: 'switch-off-scheduler' });
    await useChatStore.getState().open(session.id);

    // 建议：关闭时没有可发布的建议（面板也不在场），连陈旧的值都不该留下。
    expect(await useChatStore.getState().proposeNextTurn()).toBeUndefined();
    expect(useChatStore.getState().schedule).toBeUndefined();

    // 发言：`speakNextTurn` 是「调度器挑人」的入口。关闭时它在读链、`planTurn`、
    // `writeTurnPlan` 之前就拒绝——拒绝的原因是开关，而不是「没人能发言」。
    expect(await useChatStore.getState().speakNextTurn()).toEqual({
      kind: 'refused',
      key: 'play.schedulerOff',
    });

    // 三处调用点里唯一会落库的那一处：一行都没有。
    expect(await listTurnPlans(session.id)).toHaveLength(0);
  });

  it('开启时同一对调用会给出建议（对照）', async () => {
    await writeTimeAndSchedulingSetting(true);
    await useFeatureStore.getState().load();
    const session = await createSession({ title: 'switch-on-scheduler' });
    await useChatStore.getState().open(session.id);

    expect(await useChatStore.getState().proposeNextTurn()).toBeDefined();
  });
});

describe('④ 存储行与 store：缺席＝关闭，写入之后＝开启', () => {
  it('键名就是 ADR-037 那一行', () => {
    expect(TIME_AND_SCHEDULING_SETTINGS_ID).toBe('feature.timeAndScheduling');
  });

  it('行缺席读 false；写 true 之后读 true；形状不对也算关闭（不抛错）', async () => {
    expect(await readTimeAndSchedulingSetting()).toBe(false);

    await writeTimeAndSchedulingSetting(true);
    expect(await readTimeAndSchedulingSetting()).toBe(true);
    await writeTimeAndSchedulingSetting(false);
    expect(await readTimeAndSchedulingSetting()).toBe(false);

    // 判定就是 `value === true`（`db/repository.ts`）: 一个不该出现的形状落进这一行时，
    // 答案仍然是「关闭」，而不是抛错——读取处就是判定处。
    await putRaw(TIME_AND_SCHEDULING_SETTINGS_ID, 'yes');
    expect(await readTimeAndSchedulingSetting()).toBe(false);
  });

  it('store 的构造值就是「行缺席」的答案，load() 之后跟随存储行', async () => {
    expect(useFeatureStore.getState().timeAndScheduling).toBe(false);
    expect(useFeatureStore.getState().ready).toBe(false);

    await useFeatureStore.getState().load();
    expect(useFeatureStore.getState().ready).toBe(true);
    expect(useFeatureStore.getState().timeAndScheduling).toBe(false);

    await writeTimeAndSchedulingSetting(true);
    await useFeatureStore.getState().load();
    expect(useFeatureStore.getState().timeAndScheduling).toBe(true);
  });

  it('用户点下关闭之后，那次迟到的读取（说 true）不能把它翻回开启', async () => {
    const late = deferred<boolean>();
    vi.spyOn(repository, 'readTimeAndSchedulingSetting').mockReturnValue(late.promise);

    const loading = useFeatureStore.getState().load();
    await useFeatureStore.getState().setTimeAndScheduling(false);
    late.resolve(true);
    await loading;

    // `loadToken` 那一条口径：用户的显式选择压过任何还没落地的读取。
    expect(useFeatureStore.getState().timeAndScheduling).toBe(false);
  });
});
