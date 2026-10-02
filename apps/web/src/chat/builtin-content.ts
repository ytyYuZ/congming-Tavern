/**
 * The app's BUILT-IN default content: one `PromptPreset` and one world `Calendar`
 * (M1 integration; docs/06 §8.5 决定 1, docs/02 §5.1 / §5.7, ADR-029, ADR-030).
 *
 * ─────────────── THIS FILE IS CONTENT, NOT UI COPY (read this first) ──────────
 * The Chinese strings below are WORLD and PROMPT CONTENT — data a user will
 * eventually author in a preset editor and a world editor. They are NOT interface
 * copy, and they must NOT be moved into `packages/i18n`:
 *
 * - ADR-030 forbids the prompt following the UI language. A user with an English
 *   interface must still send the system prompt they authored; routing these
 *   sentences through `t(...)` would silently change MODEL BEHAVIOUR as a side
 *   effect of a UI preference. (The same rule is why `TimeEngine.display()` returns
 *   structured parts instead of a finished sentence — see `engine/time/clock.ts`.)
 * - docs/06 §8.5 决定 1 records why they are here at all: `PromptPreset` rows and
 *   the world editor are deferred, but `Session.refs.promptPreset` is a required pin
 *   on the frozen session schema. So until presets come from real rows, the app
 *   assembles from built-ins, and the pin a new session records
 *   (`session/roster.ts`'s `BUILTIN_PRESET_CHOICE`, M1-S1) names THIS preset.
 * - Consequence for the lint surface: `tools/scripts/check-i18n-literals.mjs` reports
 *   this file under its CJK rule and needs its second documented exemption (the
 *   first, `chat/prompt.ts`, is deleted by this change). That exemption is the
 *   orchestrator's to add; this file must not be "fixed" by cataloguing its text.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT REPLACED WHAT. `chat/prompt.ts` (deleted) hand-assembled the wire messages
 * because neither engine existed. Every sentence it produced still exists — as
 * block `content` below, emitted by `compose()` in the same order — plus the time
 * block that docs/02 §5.1 calls a hard injection (硬注入, P0).
 *
 * WHY THE PRESET IS A CONSTANT AND NOT A PERSISTED ROW: see §8.5 决定 1 above.
 * Nothing here is a `Session` field, and the preset's `id` is not a UUIDv7 minted
 * at runtime — a built-in is the same object on every start, which is what makes
 * the assembly reproducible.
 *
 * WHY `createdAt`/`updatedAt` ARE 0: `PromptPresetSchema` requires nonnegative
 * integer timestamps, and a built-in has no creation moment. A `Date.now()` here
 * would make two runs of the same session differ for no reason; `0` reads as "this
 * shipped with the app", which is what it is.
 */
import type { PromptBudget } from '@smarttavern/core';
import type { Calendar, PromptPreset } from '@smarttavern/schema';

/* ───────────────────────────── the built-in calendar ──────────────────────── */

/** Minutes in one hour of the built-in world's day. */
export const BUILTIN_MINUTES_PER_HOUR = 60;

/** Hours in one day of the built-in world. */
export const BUILTIN_HOURS_PER_DAY = 24;

/** Days in every month of the built-in world (the 12 x 30-day default year). */
export const BUILTIN_DAYS_PER_MONTH = 30;

/**
 * The built-in world's `Calendar` — a plain 12 x 30-day, 24h/60m face with four
 * named day segments.
 *
 * WHY THIS EXISTS AT ALL: no `World` row exists yet (§8.5 决定 1), and without a
 * calendar the time engine cannot map an `EpochMinute` to a date, so `{{date}}`,
 * `{{time}}`, `{{segment}}` and `conditions.timeOfDay` could not resolve at all.
 * The numbers are deliberately boring — a fantasy calendar is a data edit, and a
 * test pinning arithmetic here would be pinning this file's taste.
 *
 * WHY THESE FOUR SEGMENTS: they are the 晨/昼/昏/夜 vocabulary of docs/02 §5.7,
 * which is what `PromptBlock.conditions.timeOfDay` matches against, so the built-in
 * preset can grow a time-conditional block without a second naming scheme.
 */
export const BUILTIN_CALENDAR: Calendar = {
  id: 'builtin-default',
  name: '默认历法',
  minutesPerHour: BUILTIN_MINUTES_PER_HOUR,
  hoursPerDay: BUILTIN_HOURS_PER_DAY,
  months: [
    { name: '一月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '二月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '三月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '四月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '五月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '六月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '七月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '八月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '九月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '十月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '十一月', days: BUILTIN_DAYS_PER_MONTH },
    { name: '十二月', days: BUILTIN_DAYS_PER_MONTH },
  ],
  epochLabel: '纪元',
  // 0-6 晨 / 6-12 昼 / 12-18 昏 / 18-24 夜: the four windows tile the day with no gap
  // and no overlap, so every minute has exactly one segment and a clock readout can
  // never show a nameless stretch.
  segments: [
    { id: 'dawn', name: '晨', fromHour: 0, toHour: 6 },
    { id: 'day', name: '昼', fromHour: 6, toHour: 12 },
    { id: 'dusk', name: '昏', fromHour: 12, toHour: 18 },
    { id: 'night', name: '夜', fromHour: 18, toHour: 24 },
  ],
};

/* ─────────────────────────────── the default preset ───────────────────────── */

/**
 * The id a new session's `Session.refs.promptPreset` pin records (M1-S1), and the id of
 * `BUILTIN_PRESET` below. The two must stay equal, or the pin names a preset nobody can resolve:
 * `session/roster.ts`'s `BUILTIN_PRESET_CHOICE` is the one place both are read, and it is what the
 * create flow pins.
 */
export const BUILTIN_PRESET_ID = 'builtin-default';

/**
 * The instruction that tells the model what it is playing (the M0 default preset's
 * first sentence, verbatim).
 *
 * WHY THE SLOTS ARE `{worldId}` AND NOT `{{world.id}}`
 * `{{...}}` is the composer's MACRO syntax, and this text is not macros: a preset
 * cannot read a field of a context object, so an app-side fill has to substitute
 * these. Spelling that fill with macro notation would give one notation two owners,
 * and the failure mode is silent in the direction that reaches the model — a slot the
 * app missed stays `{{world.id}}` VERBATIM in the prompt (the composer's documented
 * contract for an unregistered macro) and the model is asked about a literal token.
 * Single braces cannot be claimed by the macro pass at all, so a reader sees at once
 * that `chat/builtin-content.ts` + `chat/clock.ts`'s `fillSlots` own them.
 *
 * The version numbers are slots for the same reason: `{{world.version}}` has no
 * expander, so writing it as a macro would leave a raw token by construction.
 */
const SYSTEM_INSTRUCTION = [
  '你是一个交互式小说与 TRPG 的主持人（GM）。',
  '世界：{worldId}（v{worldVersion}）。',
  '玩家扮演的角色：{userId}（v{userVersion}）。',
].join('\n');

/**
 * The values `SYSTEM_INSTRUCTION`'s slots expect. A separate constant rather than
 * inline strings so the preset and its filler cannot drift apart unnoticed — and
 * `clock.test.ts` asserts that filling them leaves ZERO unresolved macros, which is
 * what turns "these are not macros" from a comment into a checked fact.
 */
export const BUILTIN_SLOTS = ['worldId', 'worldVersion', 'userId', 'userVersion'] as const;

/** One slot name the built-in preset declares. */
export type BuiltinSlot = (typeof BUILTIN_SLOTS)[number];

/**
 * The default token budget: 总预算 = 模型上下文长度 − 预留输出长度 (docs/02 §5.1).
 *
 * WHY 8192 / 1024: `ProviderCapabilities` has no `contextWindow` — that number
 * lives on `ModelInfo`, and `packages/providers` answers `countTokens` only when a
 * vendor can really count. `PromptBudget` requires both numbers and a `required`
 * block that does not fit is an explicit error rather than a silent trim, so the
 * default has to be a real, conservative number. 8192 is the floor every
 * OpenAI-compatible model this project targets accepts; a model picker that reads
 * `ModelInfo.contextWindow` is what replaces it. No `counter` is injected, so the
 * composer's documented, deliberately over-counting approximation measures.
 */
export const BUILTIN_BUDGET: PromptBudget = { contextWindow: 8192, reservedOutput: 1024 };

/**
 * The blocks of the built-in preset, in `order`.
 *
 * WHY `required` ON THE FIRST TWO AND NOT ON THE THIRD: the system instruction, the
 * world/player line and the current time ARE the instruction set — docs/02 §5.1
 * calls the time line a 硬注入 (P0), the one injection that must never be trimmed,
 * and a prompt that drops the world line no longer says what it is playing. The
 * style note is the trimmable one: it is an aside about HOW to write, so it is
 * `normal` and it is what disappears first when the budget is tight.
 */
export const BUILTIN_PRESET: PromptPreset = {
  id: BUILTIN_PRESET_ID,
  name: '内置默认预设',
  version: 1,
  blocks: [
    {
      id: 'builtin-system-prompt',
      name: '系统指令',
      role: 'system',
      content: SYSTEM_INSTRUCTION,
      enabled: true,
      position: 'pre_history',
      order: 0,
      budget: { priority: 'required' },
    },
    {
      id: 'builtin-world-clock',
      name: '当前时间',
      role: 'system',
      // The one block whose content is fixed by this task (docs/02 §5.1's hard time
      // injection): the date and the clock face, then the day segment.
      content: '当前时间：{{date}} {{time}}（{{segment}}）。请以此为世界的当前时刻。',
      enabled: true,
      position: 'pre_history',
      order: 1,
      budget: { priority: 'required' },
    },
    {
      id: 'builtin-style-note',
      name: '叙事风格',
      role: 'system',
      content: '请用第二人称推进剧情，只输出角色与旁白的内容，不要复述本说明。',
      enabled: true,
      position: 'pre_history',
      order: 2,
      budget: { priority: 'normal' },
    },
  ],
  createdAt: 0,
  updatedAt: 0,
};
