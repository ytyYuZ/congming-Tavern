/**
 * The M1-I2 EXAMPLE CONTENT PACK, as READABLE SOURCE (`docs/06-开发任务拆解.md` §2.6:
 * "内置世界 ×2、角色 ×4、短剧本 ×1 … 首次启动即可加载并开始").
 *
 * ───── THIS FILE IS CONTENT, NOT UI COPY (read this first) ────────────────────
 * Every Chinese string below is WORLD, WORLDBOOK and CHARACTER content: names,
 * premises and the prose a user will one day author in an editor. ADR-030 is the
 * rule that keeps it out of `packages/i18n` — content must NOT follow the UI
 * language, because switching the interface to English would then change what the
 * model is asked. `apps/web/src/chat/builtin-content.ts` records the same rule for
 * the app's built-in default content. That file needs a lint exemption
 * (`check-i18n-literals.mjs`'s `BUILTIN_CONTENT_FILE`); this one does not, because
 * that checker's scope is `apps/*\/src\/**` and nothing here is rendered as
 * interface copy. The pack's own `README.txt` / `LICENSE.txt` are written in
 * English on purpose (`content-pack.ts`): they are package METADATA a tool reads,
 * like the README inside every other pack this repository writes.
 *
 * ───── WHAT IS IN THE PACK, AND WHY EACH PIECE IS HERE ───────────────────────
 * TWO WORLDS, which is what §2.6's row asks for, and they are deliberately
 * different KINDS of world rather than two of the same:
 *
 * • `长日港` (longdayHarbour) — a FULL-LENGTH setting: regions, factions, magic,
 *   five opening hooks, a long year. It is the world a person browses.
 * • `末班渡` (lastFerry) — the 短剧本: a ONE-SITTING scenario. One place, one night,
 *   one hard deadline (the last crossing at 将晓), two cards. It is the world a
 *   person starts playing in five minutes, which is the point of shipping a short
 *   scenario next to a setting (docs/06 §2.6, and M1-I3's first-run flow).
 *
 * NEITHER CALENDAR IS THE BUILT-IN ONE, and they are not each other's either.
 * `apps/web/src/chat/builtin-content.ts` ships 60 minutes per hour and 24 hours per
 * day (1440 minutes a day). `长日港` declares 100 x 26 = 2600, `末班渡` declares
 * 45 x 20 = 900. A consumer that quietly reads the wrong calendar therefore fails
 * VISIBLY — the rendered date and the length of a day are both observable — instead
 * of producing a plausible date for a world that does not have it (docs/02 §5.7,
 * `engine/time/calendar.ts`: `minutesPerHour` and `hoursPerDay` are DATA).
 *
 * EVERY WORLD'S SEGMENTS TILE ITS DAY WITH NO GAP, so `segmentOf` answers for every
 * minute and a clock readout can never show a nameless stretch. `长日港`'s 静夜
 * WRAPS past the end of the day (`22 → 4`), which is the awkward case
 * `resolveSegments` normalises and an example that avoided it would not exercise.
 *
 * THE WORLDBOOK ENTRIES NAME THOSE SEGMENTS by id in `conditions.timeOfDay` — that
 * lookup is the entire reason day segments exist (docs/02 §5.2, §5.7 `segmentOf`).
 * Each world gets ONE ENTRY PER SEGMENT (4 + 4), so every segment an editor can
 * click is also a segment the example proves is reachable, and two entries carry the
 * other condition fields (`afterMinute` once the story has begun, `withinDays` for
 * act one only).
 *
 * THE FOUR CARDS ARE COMPLETE CARDS: full SillyTavern field set, a speaking profile
 * (`voice`) and a visual bible (`visual`), with different tunings so a scheduler can
 * tell them apart. `EXAMPLE_ROSTERS` records the pairing the demo suggests — 沈砚
 * with 长日港, 阿梧 with 末班渡 — which is a SUGGESTION for a caller, never a field
 * on a card (ADR-010: which card is the player is a property of the session).
 *
 * EVERY ID AND TIMESTAMP IS A LITERAL, and the pack's own identity is fixed
 * (`EXAMPLE_CREATED_AT`), so building the pack twice produces the same bytes
 * (`example-pack.test.ts` asserts it). A bundled example is the same on every start,
 * which is exactly the argument `apps/web/src/chat/builtin-content.ts` makes for its
 * `createdAt: 0`.
 *
 * ───── WHAT IS DELIBERATELY MISSING, AND WHY ─────────────────────────────────
 * • THE RULE PACK. No rule-pack schema or row exists (`packages/schema` has none,
 *   M1-S1 left `Session.refs.rulePack` ABSENT, and `docs/06` §10.5 records the item
 *   as unowned), so this pack carries no `data/rulepacks.json`, declares no
 *   `rulepack` reference and reports `counts.rulePacks: 0`.
 * • THE PRESETS. §2.6's row says 预设 ×2, and the same answer applies for the same
 *   reason: nothing can write a `promptPresets` row yet — the only preset in M1 is
 *   the app's module constant `BUILTIN_PRESET` (`docs/06` §8.5 decision 1), which
 *   this package may not import and which is not a stored row a pack could
 *   faithfully carry. So there is no `data/promptPresets.json` and
 *   `counts.promptPresets` is 0.
 * Both absences are stated INSIDE the artifact: the generated `README.txt` lists
 * them under "what is deliberately NOT inside", because the alternative — a pack
 * that silently under-delivers against its own spec — is the one outcome a new user
 * cannot debug.
 */
import { COLLECTIONS, type StorageAdapter } from '@smarttavern/core';
import {
  type Calendar,
  type Character,
  type CharacterData,
  CharacterDataSchema,
  type CharacterVersion,
  CharacterVersionSchema,
  type World,
  type WorldbookEntry,
  WorldbookEntrySchema,
  type WorldData,
  WorldDataSchema,
  type WorldVersion,
  WorldVersionSchema,
} from '@smarttavern/schema';

/* ─────────────────────────── keys, ids and clock ─────────────────────────── */

/** The two worlds, in the order the pack lists them. */
export const EXAMPLE_WORLD_KEYS = ['longdayHarbour', 'lastFerry'] as const;
export type ExampleWorldKey = (typeof EXAMPLE_WORLD_KEYS)[number];

/** The four cards, in the order the pack lists them. */
export const EXAMPLE_CHARACTER_KEYS = ['shenYan', 'taoSanniang', 'awu', 'duBo'] as const;
export type ExampleCharacterKey = (typeof EXAMPLE_CHARACTER_KEYS)[number];

/** A versioned entity's own id and the id of its first version row. */
export interface ExampleEntityIds {
  readonly id: string;
  readonly versionId: string;
}

/**
 * The example's ids, as literals so a test can name a row instead of searching for
 * it. Worlds and characters are UUIDv7 because `docs/04` §4 requires a session's
 * pins (and anything the format mints a version of) to be time-ordered uuids we
 * minted ourselves; the worldbook entries carry the same shape for one reason — a
 * library should not hold two id dialects for the entities of one pack.
 */
export const EXAMPLE_IDS: {
  readonly worlds: Readonly<Record<ExampleWorldKey, ExampleEntityIds>>;
  readonly characters: Readonly<Record<ExampleCharacterKey, ExampleEntityIds>>;
  readonly worldbook: Readonly<Record<ExampleWorldKey, readonly string[]>>;
} = {
  worlds: {
    longdayHarbour: {
      id: '0192f0a1-1000-7000-8000-000000000001',
      versionId: '0192f0a1-1000-7000-8000-000000000002',
    },
    lastFerry: {
      id: '0192f0a1-1100-7000-8000-000000000001',
      versionId: '0192f0a1-1100-7000-8000-000000000002',
    },
  },
  characters: {
    shenYan: {
      id: '0192f0a1-2000-7000-8000-000000000001',
      versionId: '0192f0a1-2000-7000-8000-000000000002',
    },
    taoSanniang: {
      id: '0192f0a1-2000-7000-8000-000000000003',
      versionId: '0192f0a1-2000-7000-8000-000000000004',
    },
    awu: {
      id: '0192f0a1-2100-7000-8000-000000000001',
      versionId: '0192f0a1-2100-7000-8000-000000000002',
    },
    duBo: {
      id: '0192f0a1-2100-7000-8000-000000000003',
      versionId: '0192f0a1-2100-7000-8000-000000000004',
    },
  },
  worldbook: {
    longdayHarbour: [
      '0192f0a1-3000-7000-8000-000000000001',
      '0192f0a1-3000-7000-8000-000000000002',
      '0192f0a1-3000-7000-8000-000000000003',
      '0192f0a1-3000-7000-8000-000000000004',
    ],
    lastFerry: [
      '0192f0a1-3100-7000-8000-000000000001',
      '0192f0a1-3100-7000-8000-000000000002',
      '0192f0a1-3100-7000-8000-000000000003',
      '0192f0a1-3100-7000-8000-000000000004',
    ],
  },
};

/** The pack's own manifest id — fixed, so two builds are byte-identical. */
export const EXAMPLE_PACKAGE_ID = '0192f0a1-5000-7000-8000-000000000001';

/** The pack's `createdAt`: a literal, for the same reason as the id above. */
export const EXAMPLE_CREATED_AT = '2026-09-27T10:00:00.000Z';

/** Every row's timestamp. Fixed, so an export of the seeded library is stable. */
export const EXAMPLE_BASE_TIME = Date.parse(EXAMPLE_CREATED_AT);

/**
 * The pack's licence: the repository's own identifier. The text was written FOR
 * this repository, so declaring a fresh grant here would be inventing a licence —
 * and `docs/04` §4 forbids the one thing that would matter more: no rule-pack text
 * is redistributed in this pack, which its generated `LICENSE.txt` states.
 */
export const EXAMPLE_LICENSE = 'AGPL-3.0-only';

/** The pack's display name — content, so it is not translated (ADR-030). */
export const EXAMPLE_PACK_NAME = '长日港 · 末班渡 · 示例内容包';

/** The pack's one-line pitch, for `manifest.description`. */
export const EXAMPLE_PACK_DESCRIPTION =
  '两个可直接开局的示例：26 小时一天的长日港，与一夜之间的短剧本末班渡。两张世界版本、四张完整角色卡、八条按时段触发的世界书条目；规则包与预设都不在此包内（两者都还没有可写入的行）。';

/* ─────────────────────────────── the calendars ───────────────────────────── */

/**
 * `长日港`'s clock face: 100 minutes to the hour, 26 hours to the day.
 *
 * THE SEGMENTS TILE THE DAY EXACTLY ONCE: 汐起 4→11, 长昼 11→18, 汐落 18→22 and
 * 静夜 22→4, whose `toHour < fromHour` spelling is how a window that wraps past the
 * end of the day is written (`entities/world.ts`, `resolveSegments`). 7+7+4+8 = 26
 * hours, so `segmentOf` returns a segment for every minute of the day.
 *
 * THE YEAR IS 185 DAYS IN SIX UNEVEN MONTHS, which divides evenly by the five
 * weekday names — so a weekday is well defined too (`weekdayAt` returns nothing when
 * it is not, and a calendar that cannot name its own weekdays would be a quieter
 * version of the same "reads the wrong calendar" trap).
 */
const LONGDAY_HARBOUR_CALENDAR: Calendar = {
  id: 'slowday',
  name: '潮历',
  minutesPerHour: 100,
  hoursPerDay: 26,
  weekdays: ['潮一', '潮二', '潮三', '潮四', '潮五'],
  months: [
    { name: '潮月', days: 31 },
    { name: '雾月', days: 28 },
    { name: '长月', days: 33 },
    { name: '灯月', days: 30 },
    { name: '静月', days: 29 },
    { name: '归月', days: 34 },
  ],
  epochLabel: '潮纪',
  segments: [
    { id: 'tide-rise', name: '汐起', fromHour: 4, toHour: 11 },
    { id: 'long-day', name: '长昼', fromHour: 11, toHour: 18 },
    { id: 'tide-fall', name: '汐落', fromHour: 18, toHour: 22 },
    { id: 'still-night', name: '静夜', fromHour: 22, toHour: 4 },
  ],
};

/**
 * `末班渡`'s clock face: 45 minutes to the hour, 20 hours to the day — a town that
 * rings its bell every three quarters of an hour and calls the dark half of the day
 * its own.
 *
 * THE SEGMENTS TILE THE NIGHT ONCE AND DO NOT WRAP: 候船 0→5, 灯下 5→11, 雾起 11→16,
 * 将晓 16→20. 5+6+5+4 = 20 hours. The scenario's whole shape is in those names: the
 * story opens in 雾起 and the last crossing is at 将晓, so the clock IS the plot.
 */
const LAST_FERRY_CALENDAR: Calendar = {
  id: 'ferry-night',
  name: '渡夜历',
  minutesPerHour: 45,
  hoursPerDay: 20,
  weekdays: ['夜一', '夜二', '夜三', '夜四', '夜五'],
  months: [
    { name: '候潮月', days: 20 },
    { name: '灯月', days: 25 },
  ],
  epochLabel: '渡夜',
  segments: [
    { id: 'waiting', name: '候船', fromHour: 0, toHour: 5 },
    { id: 'lamplight', name: '灯下', fromHour: 5, toHour: 11 },
    { id: 'fog', name: '雾起', fromHour: 11, toHour: 16 },
    { id: 'firstlight', name: '将晓', fromHour: 16, toHour: 20 },
  ],
};

/** Each world's clock face, keyed the same way as everything else here. */
export const EXAMPLE_CALENDARS: Readonly<Record<ExampleWorldKey, Calendar>> = {
  longdayHarbour: LONGDAY_HARBOUR_CALENDAR,
  lastFerry: LAST_FERRY_CALENDAR,
};

/**
 * Where each world's clock starts (docs/02 §5.7); a session copies this.
 *
 * `长日港` at 7440 is day index 2, hour 22, minute 40 — inside 静夜, the segment that
 * WRAPS. A story that opens on the awkward segment is the one whose clock arithmetic
 * gets exercised on the first render.
 *
 * `末班渡` at 1425 is day index 1, hour 11, minute 30 — inside 雾起, a third of the
 * way into the 45-minute hour, and 195 minutes before the last crossing at 将晓.
 */
export const EXAMPLE_START_MINUTES: Readonly<Record<ExampleWorldKey, number>> = {
  longdayHarbour: 7440,
  lastFerry: 1425,
};

/* ──────────────────────────── the worlds' data ───────────────────────────── */

/** `长日港`: the full-length setting — a harbour town on a slow-turning world. */
function longdayHarbourData(): WorldData {
  return WorldDataSchema.parse({
    name: '长日港',
    premise:
      '一天有二十六个小时，一小时有一百分钟。长日港的人不看钟，只看潮：潮水每转向一次，港口就换一副面孔，而说话的人要为自己说过的话负责到下一次转向。',
    genre: ['奇幻', '潮汐', '港口'],
    era: '潮纪 · 第七个长年',
    techOrMagic:
      '潮术：只在潮水转向的那几十分钟里生效，代价是施术者想不起施术那段时日的细节。港里的人因此把重要的事都留在纸上。',
    regions: [
      {
        id: 'longday-harbour',
        name: '长日港',
        description: '依着一条不肯按常规涨落的潮水建起来的港口镇，房子全用潮线以上的旧船木搭。',
      },
      {
        id: 'lamp-quay',
        name: '灯码头',
        description: '唯一挂灯的长码头。汐落之后，外乡人不许从这里上岸。',
        parentId: 'longday-harbour',
      },
      {
        id: 'salt-flats',
        name: '盐背',
        description: '镇子北面晒盐的缓坡，日头最长的时候，盐面白得看不清路。',
        parentId: 'longday-harbour',
      },
    ],
    factions: [
      {
        id: 'tide-wardens',
        name: '潮守',
        description: '守潮钟、记潮向的人。他们不问你从哪来，只问你要待几个长日。',
        stance: '守序，对外乡人客气而疏远',
        goals: ['守住潮钟', '让外乡人在汐落前离开灯码头'],
      },
      {
        id: 'ledger-house',
        name: '账房',
        description: '记人情账的三个人。他们记得的不是钱，是谁欠谁一个下午。',
        stance: '中立，谁都记',
        goals: ['把每一笔人情写进潮账', '不让任何一笔账不了了之'],
      },
    ],
    rulesOfNature: {
      powerSource: '潮水本身：潮向定了，能做的事就定了',
      limits: '只在潮水转向那一刻；一次转向只够做完一件事',
      taboos: '不可在静夜叫出潮水的名字——叫过一次的人，第二天会记不清自己做过什么',
    },
    narrative: {
      conflict: '潮钟停了三天，而长日港靠它记得自己是谁',
      tone: '缓慢、潮湿、克制的惊奇',
      themes: ['记忆的代价', '外乡人与规矩', '被记下来的才算发生过'],
      style: '第二人称，短句，多用潮水、灯与纸的意象；不解释设定，让规矩自己说话',
    },
    calendar: LONGDAY_HARBOUR_CALENDAR,
    startMinute: EXAMPLE_START_MINUTES.longdayHarbour,
    /**
     * `implicitAdvance: false` on purpose: automatic advance is M2-S3's feature, and
     * an example world must not promise behaviour the build does not have. The step
     * is 50 minutes — half a harbour hour — which is what a manual "+时段" advance
     * in M1-T2 moves by.
     */
    timeRhythm: { implicitAdvance: false, advanceEveryTurns: 6, stepMinutes: 50 },
    openingHooks: [
      '你到长日港时，潮水已经转向四十个分钟了：钟楼敲过那一下，静夜从那时起算。',
      '一个孩子在码头边数你的脚步，数到第十七步就不数了，回头朝镇里跑。',
      '客栈的灯亮着，门开着，柜台上的潮账摊在最新一页，那一页只有你的名字。',
    ],
    customFields: {
      潮钟: '港务厅的铜钟，一个长日只敲四次，对应四次潮水转向。',
      长日: '本地人把从汐起到下一次汐起叫「一个长日」，二十六小时、两千六百分。',
      写潮人: '替港口把潮向与人事写下来的差事，一个人一辈子只能当一次。',
    },
  });
}

/**
 * `末班渡`: the 短剧本 — one place, one night, one deadline.
 *
 * IT IS DELIBERATELY SMALL. Everything a one-sitting scenario needs is here and
 * nothing else is: a single location with two sub-places, one rule that creates the
 * pressure (the last crossing leaves at 将晓), one taboo that creates the mystery
 * (do not ask what is on the far bank), and the clock the scenario is played against.
 */
function lastFerryData(): WorldData {
  return WorldDataSchema.parse({
    name: '末班渡',
    premise:
      '一夜之间：这条水路上只剩最后一班船。天亮之前它要么来，要么不来；而等在候船棚里的人，比船上的位置多。',
    genre: ['短剧本', '一夜', '渡口'],
    era: '没有年号的年代，只有一个夜里',
    techOrMagic:
      '没有超自然的东西：只有雾、灯、水声，和一张说不清来处的木牌船票。所有的怪事都能用「有人没说真话」解释。',
    regions: [
      {
        id: 'ferry-landing',
        name: '渡口',
        description: '一条石阶从岸上伸进水里。石阶上有九道被缆绳磨出来的槽，最上面那道最新。',
      },
      {
        id: 'waiting-shed',
        name: '候船棚',
        description: '渡口的木棚，一条长凳，一盏罩子熏黑的灯。棚顶漏雨的地方摆着一只空碗。',
        parentId: 'ferry-landing',
      },
      {
        id: 'far-bank',
        name: '对岸',
        description: '雾里看不见。据说有灯，但没有人能在这一岸指给你看。',
      },
    ],
    factions: [
      {
        id: 'boat-house',
        name: '船行',
        description: '管着这条水路的三个人。他们不赊账、不通融，也不解释规矩。',
        stance: '守规矩，不问缘由',
        goals: ['按规矩开最后一班', '把没写名字的人留在这一岸'],
      },
    ],
    rulesOfNature: {
      powerSource: '潮水与雾：雾起之后的水面不认船',
      limits: '雾起之后不摆渡，除非有人肯坐在船头数浪，数到第九个',
      taboos: '不要问船家「对岸有什么」——问过的人，船票会被还回来',
    },
    narrative: {
      conflict: '最后一班船只有一个位置，而等船的人不止一个',
      tone: '安静的紧迫，湿冷，句子越短越近',
      themes: ['选择', '陌生人的善意', '规矩与人情'],
      style: '第二人称，以对话推进；用灯、雾与钟声的间隔当节拍，不写心理活动',
    },
    calendar: LAST_FERRY_CALENDAR,
    startMinute: EXAMPLE_START_MINUTES.lastFerry,
    /**
     * A one-sitting scenario moves in 15-minute steps — a third of its 45-minute hour
     * — so a manual advance of one step is a beat of the night, not half of it.
     */
    timeRhythm: { implicitAdvance: false, advanceEveryTurns: 4, stepMinutes: 15 },
    openingHooks: [
      '雾是从水面往岸上长出来的。你到渡口的时候，它刚漫过第九道缆绳槽。',
      '候船棚里坐着四个人，长凳中间放着一块刻着「末」的木牌，谁也没伸手。',
      '灯下摊着一本登记簿，最后一行是空着的，笔搁在墨里，没有干。',
    ],
    customFields: {
      末班: '将晓开出的最后一班船，一夜只有一次。',
      木牌船票: '正面刻「末」，背面刻着日期——日期永远是今天。',
      登记簿: '写上名字的人才算上船；写错了，船不认。',
    },
  });
}

/** The world's payload, dispatched by key; each is parsed so drift fails loudly. */
export function exampleWorldData(key: ExampleWorldKey): WorldData {
  switch (key) {
    case 'longdayHarbour':
      return longdayHarbourData();
    case 'lastFerry':
      return lastFerryData();
  }
}

/* ──────────────────────────── the worlds' rows ───────────────────────────── */

/** One world's first immutable version row (`docs/04` §2 carries versions, not heads). */
export function exampleWorldVersion(key: ExampleWorldKey): WorldVersion {
  const ids = EXAMPLE_IDS.worlds[key];
  return WorldVersionSchema.parse({
    id: ids.versionId,
    worldId: ids.id,
    version: 1,
    createdAt: EXAMPLE_BASE_TIME,
    updatedAt: EXAMPLE_BASE_TIME,
    data: exampleWorldData(key),
  });
}

/** Every world's first version, in `EXAMPLE_WORLD_KEYS` order. */
export function exampleWorldVersions(): WorldVersion[] {
  return EXAMPLE_WORLD_KEYS.map((key) => exampleWorldVersion(key));
}

/* ──────────────────────────────── the cards ─────────────────────────────── */

/**
 * `沈砚` — the card the 长日港 demo plays as. Complete on purpose: full SillyTavern
 * field set, a speaking profile and a visual bible. `first_mes` opens inside 静夜,
 * the segment `startMinute` sits in, so the example's first message already agrees
 * with its clock.
 */
function shenYanData(): CharacterData {
  return CharacterDataSchema.parse({
    name: '沈砚',
    description: [
      '长日港的写潮人：替港口把潮向、来客与说过的话写进册子。',
      '二十八岁，声音低，句子短，问问题之前会先在心里数一遍——他相信话和潮一样，说出去就会转向。',
      '左手腕上有一圈旧绳痕，是上一任写潮人系在他手上的；那本册子还剩十一页。',
    ].join('\n'),
    personality: '安静、记性极好、从不打断别人。对规矩近乎固执，对规矩之外的事却意外地宽容。',
    scenario:
      '汐落后的第一个钟头。你刚下船，鞋里全是盐，写潮册的第三本还剩十一页，而港里的人已经知道你来了。',
    first_mes:
      '码头的灯只亮着两盏。沈砚站在灯下，把册子合上，用袖子擦了擦封面上的盐。\n「你是刚到的。」他说，不是问句。「今天第四件事，你不用回答。先跟我走——汐落之后，灯码头不留外乡人。」',
    mes_example: [
      '<START>',
      '{{user}}: 「潮钟刚才是不是少敲了一下？」',
      '{{char}}: 「你没听错。」他把笔搁下，「少的那一下，我记在账上了。」',
      '{{user}}: 「记在账上有什么用？」',
      '{{char}}: 「在长日港，」他说，「被记下来的才算发生过。」',
    ].join('\n'),
    creator_notes:
      '示例内容包的玩家角色（docs/06 §2.6 M1-I2）。他持有「写潮册」，因此任何一句话都可能被写下——这是这张卡留给玩家的第一个选择。',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [
      '「你住了三个月了。」沈砚把册子推过来，翻到夹着盐粒的那一页。「这一页开始，是你的字。要不要写？」',
    ],
    tags: ['示例', '玩家角色', '写潮人'],
    creator: 'SmartTavern 示例内容',
    character_version: '1',
    voice: { desire: 55, ability: 60, roles: ['主角'], maxLinesPerRound: 2, cooldown: 0 },
    visual: {
      appearance: {
        hair: '湿漉漉的黑发，额前有一缕总也干不了',
        eyes: '灰蓝色，看人时先看手',
        build: '清瘦，肩背因为常年伏案略向前倾',
        skin: '晒成浅褐，手背上有一层薄盐霜',
        marks: ['左手腕一圈旧绳痕', '右手中指第一节有墨点'],
      },
      outfits: [
        {
          id: 'default',
          name: '写潮人的灰布长衫',
          prompt:
            'grey hemp robe worn soft, a flat leather book satchel across the chest, salt stains at the hem',
        },
        {
          id: 'rain',
          name: '油布雨披',
          prompt: 'oiled canvas rain cape, hood pushed back, rainwater running off the shoulders',
        },
      ],
      expressions: [
        { id: 'neutral', label: '平静', prompt: 'calm, unreadable, eyes lowered' },
        {
          id: 'wary',
          label: '警觉',
          prompt: 'wary, chin slightly turned, hand resting on the satchel',
        },
        { id: 'warm', label: '温和', prompt: 'faint warm smile, eyes crinkled at the corners' },
      ],
      style: {
        preset: 'l1',
        positive: 'muted harbour light, damp atmosphere, painterly realism',
        negative: 'oversaturated, modern clothing, text artifacts',
        aspect: '832x1216',
      },
      params: { sampler: 'dpmpp_2m', steps: 28, cfg: 4.5, seedPolicy: 'fixed', seed: 2718 },
    },
    sampling: { temperature: 0.85, topP: 0.92 },
    customFields: {
      随身的册子: '写潮册的第三本，已经写到最后十一页。',
      说过的: '「被记下来的才算发生过。」',
    },
  });
}

/**
 * `陶三娘` — the 长日港 cast member. Different in every tuning the schema has
 * (higher desire to speak, a cooldown, a three-line cap) so an example session has
 * two cards a scheduler can actually choose between, not two copies of one.
 */
function taoSanniangData(): CharacterData {
  return CharacterDataSchema.parse({
    name: '陶三娘',
    description: [
      '「半潮栈」的老板娘，也是账房三个人里最不着急的那个。',
      '五十上下，花白头发挽成髻，右手拇指上有一枚被盐磨圆的旧铜顶针。',
      '她记得这镇上每一个人的账，包括还没记上的那几笔——她说，账要等人先做了事，才好写。',
    ].join('\n'),
    personality:
      '爽利、爱笑、说话带刺但不伤人。对不讲规矩的人耐心极短，对守规矩的外乡人却愿意多解释一句。',
    scenario:
      '半潮栈的柜台后。潮账摊开着，灯芯剪得很短；她知道潮钟停了三天，也知道是谁先数出来的。',
    first_mes:
      '「住店还是问事？」陶三娘没抬头，笔在账上划了一下。「住店二十文一个长日，问事——先把你的事说成一句话，说得成，我就答。」',
    mes_example: [
      '{{user}}: 「潮钟为什么停了？」',
      '{{char}}: 「才第二句话，就问这么大的。」她把顶针转了半圈，「先住下。晚上汐落，你自己听着数。」',
    ].join('\n'),
    creator_notes:
      '示例内容包的卡司角色（docs/06 §2.6 M1-I2）。她的发言档案欲望高、上限三条，和玩家卡形成对照，调度器在一局里就能看出差别。',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [
      '「账上多了个名字。」陶三娘把册子转过来给你看，「不是你的——你猜是谁写的？」',
    ],
    tags: ['示例', '卡司', '客栈', '账房'],
    creator: 'SmartTavern 示例内容',
    character_version: '1',
    voice: { desire: 70, ability: 65, roles: ['配角', '向导'], maxLinesPerRound: 3, cooldown: 1 },
    visual: {
      appearance: {
        hair: '花白头发挽成髻，用一根旧骨簪别住',
        eyes: '深褐色，笑起来眯成一条缝',
        build: '矮壮，围裙系得很紧',
        skin: '被海风与灶火养出的红',
        marks: ['右眉一道旧疤', '右手拇指的铜顶针'],
      },
      outfits: [
        {
          id: 'default',
          name: '靛蓝围裙',
          prompt:
            'indigo apron over a patched grey blouse, sleeves rolled to the elbow, brass thimble on the right thumb',
        },
        {
          id: 'lampfestival',
          name: '灯节盛装',
          prompt:
            'festival dress in dark blue with small paper-lantern embroidery, hair pinned higher',
        },
      ],
      expressions: [
        { id: 'neutral', label: '中性', prompt: 'neutral, pen in hand, gaze level' },
        { id: 'laugh', label: '大笑', prompt: 'laughing openly, head tilted back, eyes closed' },
        {
          id: 'stern',
          label: '不悦',
          prompt: 'unimpressed, one eyebrow raised, lips pressed thin',
        },
      ],
      style: {
        preset: 'l1',
        positive: 'warm lantern light, kitchen haze, painterly realism',
        negative: 'oversaturated, modern clothing, text artifacts',
        aspect: '832x1216',
      },
      params: { sampler: 'dpmpp_2m', steps: 28, cfg: 4.5, seedPolicy: 'fixed', seed: 3141 },
    },
    sampling: { temperature: 0.9, topP: 0.95 },
    customFields: {
      半潮栈: '灯码头往北三十步，门口挂一盏只点半边的灯。',
      顶针: '她母亲留下的，据说比潮钟还老。',
    },
  });
}

/**
 * `阿梧` — the card the 末班渡 short scenario plays as: a passenger whose decision
 * the whole night hangs on. Her `first_mes` puts the one boat ticket on the bench
 * between four people, which is the scenario's premise stated as an action.
 */
function awuData(): CharacterData {
  return CharacterDataSchema.parse({
    name: '阿梧',
    description: [
      '二十三四岁，怀里一封没拆的信，手里一块刻着「末」的木牌船票。',
      '她在候船棚里坐了三个钟头，没跟任何人说话，也没把票收起来。',
      '右手食指有一道旧划伤，是拆信拆的——从此她拆什么都先看封口。',
    ].join('\n'),
    personality: '克制、客气、不肯欠人情；越急越慢，越怕越不肯说。',
    scenario: '雾起的第一个钟头。最后一班船只有一个位置，而长凳上坐着的不止她一个想上船的人。',
    first_mes:
      '阿梧把木牌放在长凳中间，没有推给谁，也没有收回去。\n「票在我这儿。」她说，看着灯罩上熏黑的地方，「可我不知道该不该上去。」',
    mes_example: [
      '<START>',
      '{{user}}: 「信里写了什么？」',
      '{{char}}: 「没拆。」她把信按回怀里，「拆开了，我就得决定去不去。」',
      '{{user}}: 「那你要是不去呢？」',
      '{{char}}: 「那这封信就是我替别人保管到天亮。」她说完，把木牌往前挪了一寸。',
    ].join('\n'),
    creator_notes:
      '示例内容包的短剧本玩家角色（docs/06 §2.6 M1-I2）。她的处境是一句话：一张票、四个人、一个天亮。玩家要替她做的选择，就是这一夜的戏。',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [
      '「你也在等船。」阿梧把木牌翻过来给你看背面——日期是今天，永远是今天。「你会写名字吗？我写错过一次。」',
    ],
    tags: ['示例', '玩家角色', '短剧本'],
    creator: 'SmartTavern 示例内容',
    character_version: '1',
    voice: { desire: 60, ability: 62, roles: ['主角'], maxLinesPerRound: 2, cooldown: 0 },
    visual: {
      appearance: {
        hair: '齐耳短发，被雾打湿后贴在脸侧',
        eyes: '深褐色，看东西前先看门槛',
        build: '瘦，坐得很直',
        skin: '没什么血色的白',
        marks: ['右手食指一道旧划伤'],
      },
      outfits: [
        {
          id: 'default',
          name: '深色棉袄',
          prompt:
            'dark padded cotton jacket, collar turned up, a flat wooden ticket held in one hand',
        },
        {
          id: 'rain',
          name: '借来的雨披',
          prompt: 'borrowed oilskin cape, too long, cuffs folded twice',
        },
      ],
      expressions: [
        { id: 'neutral', label: '平静', prompt: 'composed, gaze lowered to the ticket' },
        { id: 'hesitant', label: '犹豫', prompt: 'hesitant, lips parted, hand hovering' },
        { id: 'set', label: '固执', prompt: 'stubborn, chin up, eyes steady' },
      ],
      style: {
        preset: 'l1',
        positive: 'cold fog, single oil lamp, painterly realism, muted palette',
        negative: 'oversaturated, modern clothing, text artifacts',
        aspect: '832x1216',
      },
      params: { sampler: 'dpmpp_2m', steps: 30, cfg: 4.0, seedPolicy: 'fixed', seed: 1618 },
    },
    sampling: { temperature: 0.8, topP: 0.9 },
    customFields: {
      木牌船票: '正面刻「末」，背面刻着今天的日期。',
      那封信: '没有署名，封口没有拆过。',
    },
  });
}

/**
 * `渡伯` — the 末班渡 cast member: the ferryman who owns the rule the scenario runs
 * on. Lowest desire of the four, highest ability, the longest cooldown: he speaks
 * when he decides to, which is what makes the clock feel like his.
 */
function duBoData(): CharacterData {
  return CharacterDataSchema.parse({
    name: '渡伯',
    description: [
      '在这条水路上摆了三十年渡，右手比左手粗一圈。',
      '他不接船钱，只收名字——写不上登记簿的，船不认。',
      '没人见他绕过桩上的缆绳，也没人见他让谁破过规矩。',
    ].join('\n'),
    personality: '寡言、认规矩、对年轻人的急不以为然；从不撒谎，但也从不解释。',
    scenario: '船还系在桩上。雾没散，他也不看雾，只看水——水面上有没有第九个浪，只有他知道。',
    first_mes:
      '「名字。」渡伯把手摊开，没看人，手掌上全是缆绳的纹。\n「写不上名字的，船不认。写了不走的，我也不等。」',
    mes_example: [
      '{{user}}: 「再等一会儿，雾总会散的。」',
      '{{char}}: 「雾不散，浪就散。」他把缆绳往桩上又绕了一圈，「你要上船，就坐到船头去数浪。数到第九个叫我。」',
    ].join('\n'),
    creator_notes:
      '示例内容包的短剧本卡司角色（docs/06 §2.6 M1-I2）。他是这个一夜设定的规则本身：不赊账、不通融，因此玩家的每一句请求都有代价。',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [
      '渡伯把登记簿转过来，指给你看最后一行：「这一行是我留的。你要是不知道自己叫什么，就先写别人的名字。」',
    ],
    tags: ['示例', '卡司', '短剧本', '摆渡人'],
    creator: 'SmartTavern 示例内容',
    character_version: '1',
    voice: { desire: 45, ability: 70, roles: ['配角', '向导'], maxLinesPerRound: 2, cooldown: 2 },
    visual: {
      appearance: {
        hair: '花白短须，鬓角剃得很干净',
        eyes: '灰色，看水比看人多',
        build: '精瘦，肩膀一边高一边低',
        skin: '风霜色，手背青筋凸起',
        marks: ['右手比左手粗一圈', '左手虎口一道缆绳勒痕'],
      },
      outfits: [
        {
          id: 'default',
          name: '蓑衣',
          prompt:
            'straw rain cape over a patched jacket, coiled rope over one shoulder, bare feet on wet stone',
        },
        {
          id: 'lampfestival',
          name: '灯节短褂',
          prompt:
            'short indigo jacket for the lamp festival, sleeves rolled, rope coiled at the waist',
        },
      ],
      expressions: [
        { id: 'neutral', label: '中性', prompt: 'neutral, looking past the viewer at the water' },
        { id: 'impatient', label: '不耐', prompt: 'impatient, jaw set, one hand on the rope' },
        {
          id: 'rare-smile',
          label: '罕见地笑',
          prompt: 'a rare small smile, eyes still on the water',
        },
      ],
      style: {
        preset: 'l1',
        positive: 'oil lamp light, wet stone, fog, painterly realism',
        negative: 'oversaturated, modern clothing, text artifacts',
        aspect: '832x1216',
      },
      params: { sampler: 'dpmpp_2m', steps: 28, cfg: 4.5, seedPolicy: 'fixed', seed: 1414 },
    },
    sampling: { temperature: 0.75, topP: 0.88 },
    customFields: {
      登记簿: '搁在灯下，笔永远蘸着墨。',
      缆绳: '在桩上绕了三圈，三十年没松过。',
    },
  });
}

/** The card's payload, dispatched by key; each is parsed so drift fails loudly. */
export function exampleCharacterData(key: ExampleCharacterKey): CharacterData {
  switch (key) {
    case 'shenYan':
      return shenYanData();
    case 'taoSanniang':
      return taoSanniangData();
    case 'awu':
      return awuData();
    case 'duBo':
      return duBoData();
  }
}

/** One card's first immutable version row. */
export function exampleCharacterVersion(key: ExampleCharacterKey): CharacterVersion {
  const ids = EXAMPLE_IDS.characters[key];
  return CharacterVersionSchema.parse({
    id: ids.versionId,
    characterId: ids.id,
    version: 1,
    createdAt: EXAMPLE_BASE_TIME,
    updatedAt: EXAMPLE_BASE_TIME,
    data: exampleCharacterData(key),
  });
}

/** Every card's first version, in `EXAMPLE_CHARACTER_KEYS` order. */
export function exampleCharacterVersions(): CharacterVersion[] {
  return EXAMPLE_CHARACTER_KEYS.map((key) => exampleCharacterVersion(key));
}

/* ────────────────────────────── the worldbook ───────────────────────────── */

/**
 * `长日港`'s four entries, one per segment, in declaration order — and the
 * `timeOfDay` ids are that calendar's own (`tide-rise` / `long-day` / `tide-fall` /
 * `still-night`), which is the typo this example exists to make impossible to miss:
 * a mistyped id resolves to `undefined` in `segmentOf` and the entry would simply
 * never fire.
 */
function longdayHarbourWorldbook(): WorldbookEntry[] {
  const [rise, market, fall, night] = EXAMPLE_IDS.worldbook.longdayHarbour;
  const worldId = EXAMPLE_IDS.worlds.longdayHarbour.id;
  return [
    WorldbookEntrySchema.parse({
      id: rise,
      worldId,
      keywords: ['潮起', '外乡人', '规矩'],
      content:
        '长日港的规矩：汐起之后、长昼之前，外乡人可以问三件事，港里的人必须答。问第四件，就要先替某个人做一件事。',
      priority: 60,
      position: 'pre_history',
      depth: 0,
      probability: 100,
      conditions: { timeOfDay: 'tide-rise' },
      enabled: true,
      comment: '汐起的常态：把港口的规矩摆到最前面，开局第一轮就该出现。',
    }),
    WorldbookEntrySchema.parse({
      id: market,
      worldId,
      keywords: ['长昼', '市集', '买', '卖'],
      content:
        '长昼的七个钟头里，整个港口都是市集：盐、绳、旧信、别人的名字，什么都卖。落日之前不成交的，就算没发生过。',
      priority: 40,
      position: 'in_history',
      depth: 2,
      probability: 80,
      conditions: { timeOfDay: 'long-day' },
      enabled: true,
      comment: '长昼的市集：概率 80，用来演示「按概率注入」而不是必然注入。',
    }),
    WorldbookEntrySchema.parse({
      id: fall,
      worldId,
      keywords: ['潮落', '账', '人情'],
      content:
        '汐落时账房开门。潮账上记的不是钱，是人情：谁欠谁一个下午，谁欠谁一次沉默。账房只记，不催。',
      priority: 70,
      position: 'in_history',
      depth: 1,
      probability: 100,
      // Only once the story has begun: `afterMinute` is the world's own start, so the
      // entry is real but cannot leak backwards into a scene set before it.
      conditions: { timeOfDay: 'tide-fall', afterMinute: EXAMPLE_START_MINUTES.longdayHarbour },
      enabled: true,
      comment: '汐落的账房：同时用上 timeOfDay 与 afterMinute，两条条件都要成立。',
    }),
    WorldbookEntrySchema.parse({
      id: night,
      worldId,
      keywords: ['静夜', '壳歌', '灯'],
      content:
        '静夜过半，守灯的人会哼「壳歌」——只有十二个字的歌。据说唱完的人会忘记自己唱过，所以没有人肯写下它。',
      priority: 30,
      position: 'post_history',
      depth: 0,
      probability: 60,
      // Act one only: it expires three long days after it first became eligible.
      conditions: { timeOfDay: 'still-night', withinDays: 3 },
      enabled: true,
      comment: '静夜的壳歌：post_history 位置 + withinDays，演示会过期的设定。',
    }),
  ];
}

/**
 * `末班渡`'s four entries, one per segment of ITS OWN calendar
 * (`waiting` / `lamplight` / `fog` / `firstlight`). A second world with a second set
 * of segment ids is the case a typo hides in: the ids look plausible in either
 * calendar, and only the engine's lookup can tell you which one answers.
 */
function lastFerryWorldbook(): WorldbookEntry[] {
  const [waiting, lamplight, fog, firstlight] = EXAMPLE_IDS.worldbook.lastFerry;
  const worldId = EXAMPLE_IDS.worlds.lastFerry.id;
  return [
    WorldbookEntrySchema.parse({
      id: waiting,
      worldId,
      keywords: ['候船', '等', '长凳'],
      content:
        '候船的人不报姓名，只报要去哪一岸。棚子里的长凳坐满了，就是没有人先开口——先开口的人，通常是最后一个上船的。',
      priority: 50,
      position: 'pre_history',
      depth: 0,
      probability: 100,
      conditions: { timeOfDay: 'waiting' },
      enabled: true,
      comment: '候船：短剧本的开场规矩，用一句话把四个人的沉默立起来。',
    }),
    WorldbookEntrySchema.parse({
      id: lamplight,
      worldId,
      keywords: ['灯下', '登记', '名字'],
      content:
        '灯下的登记簿：写上名字的人，船家才认。名字写错了，船就不认你——所以有人在簿子上写别人的名字。',
      priority: 60,
      position: 'in_history',
      depth: 2,
      probability: 80,
      conditions: { timeOfDay: 'lamplight' },
      enabled: true,
      comment: '灯下的登记簿：与渡伯的台词、阿梧的木牌构成同一个机制，概率 80。',
    }),
    WorldbookEntrySchema.parse({
      id: fog,
      worldId,
      keywords: ['雾', '摆渡', '浪'],
      content:
        '雾起之后不摆渡——除非有人肯坐到船头去数浪。数到第九个浪，船家才解缆；数错了，就从头再数。',
      priority: 65,
      position: 'in_history',
      depth: 1,
      probability: 100,
      conditions: { timeOfDay: 'fog' },
      enabled: true,
      comment: '雾起：故事开始的时段（startMinute 就在雾起里），把代价摆到玩家面前。',
    }),
    WorldbookEntrySchema.parse({
      id: firstlight,
      worldId,
      keywords: ['将晓', '末班', '船票'],
      content:
        '将晓开最后一班。没上船的人，要等下一个夜——而船票背面的日期只有今天，明天的票不存在。',
      priority: 75,
      position: 'post_history',
      depth: 0,
      probability: 100,
      // The deadline the whole scenario is played against.
      conditions: { timeOfDay: 'firstlight', afterMinute: EXAMPLE_START_MINUTES.lastFerry },
      enabled: true,
      comment: '将晓：短剧本的硬期限，同时用上 timeOfDay 与 afterMinute。',
    }),
  ];
}

/** One world's worldbook entries, dispatched by key. */
export function exampleWorldbook(key: ExampleWorldKey): WorldbookEntry[] {
  switch (key) {
    case 'longdayHarbour':
      return longdayHarbourWorldbook();
    case 'lastFerry':
      return lastFerryWorldbook();
  }
}

/** Every world's worldbook entries, in `EXAMPLE_WORLD_KEYS` order. */
export function exampleWorldbookEntries(): WorldbookEntry[] {
  return EXAMPLE_WORLD_KEYS.flatMap((key) => exampleWorldbook(key));
}

/* ─────────────────────────────── the rosters ────────────────────────────── */

/**
 * Which card the demo suggests playing as in which world, and who joins.
 *
 * THIS IS A SUGGESTION, NOT A SCHEMA FIELD. `packages/schema`'s character card has
 * no player/cast flag on purpose (ADR-010: which card is the player is a property of
 * the session), so this list exists only so a caller — the CLI's example command,
 * M1-I3's first-run flow, a test — has one honest pairing to offer. The user's own
 * choice is M1-S1's, in `apps/web/src/session/roster.ts`.
 */
export interface ExampleRoster {
  readonly world: ExampleWorldKey;
  /** The card the demo plays as. */
  readonly player: ExampleCharacterKey;
  /** Everyone else on stage, in the order the cast is listed. */
  readonly cast: readonly ExampleCharacterKey[];
}

/** 长日港: the full-length setting, played as the harbour's tide-scribe. */
export const EXAMPLE_LONGDAY_ROSTER: ExampleRoster = {
  world: 'longdayHarbour',
  player: 'shenYan',
  cast: ['taoSanniang'],
};

/** 末班渡: the short scenario, played as the passenger holding the last ticket. */
export const EXAMPLE_LAST_FERRY_ROSTER: ExampleRoster = {
  world: 'lastFerry',
  player: 'awu',
  cast: ['duBo'],
};

/** Every suggested pairing, in the order the pack lists its worlds. */
export const EXAMPLE_ROSTERS: readonly ExampleRoster[] = [
  EXAMPLE_LONGDAY_ROSTER,
  EXAMPLE_LAST_FERRY_ROSTER,
];

/* ──────────────────────────────── the heads ─────────────────────────────── */

/**
 * The head rows `docs/04` §2 does NOT carry: the format stores immutable VERSIONS,
 * so a library that is going to export the example has to derive heads exactly as
 * the importer does (`import-package.ts`'s `worldHead` / `characterHead`: name,
 * `headVersion` and the version row's timestamps). Kept local rather than imported
 * from `../testing/fixtures`, because shipping example content must not depend on
 * test code — and the importer's copies are private to it.
 */
function worldHeadOf(version: WorldVersion): World {
  return {
    id: version.worldId,
    name: version.data.name,
    headVersion: version.version,
    tags: [...version.data.genre],
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

function characterHeadOf(version: CharacterVersion): Character {
  return {
    id: version.characterId,
    name: version.data.name,
    headVersion: version.version,
    tags: [...version.data.tags],
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

/* ──────────────────────────────── seeding ───────────────────────────────── */

/** What an example library holds after `seedExampleLibrary`. */
export interface ExampleLibrary {
  readonly worldIds: readonly string[];
  readonly characterIds: readonly string[];
  readonly worldbookIds: readonly string[];
}

/**
 * Write the example's catalog into a library, so the pack can be BUILT from stored
 * rows exactly as `exportWorldPackage` builds a world package — the example is
 * exported, not hand-assembled into bytes.
 *
 * IT WRITES THROUGH THE `StorageAdapter` PORT AND NOT A `seed` HOOK: the two test
 * doubles and the CLI's JSON library expose `seed`, but the app's IndexedDB adapter
 * does not, and a bundled example that could only be installed into a test double
 * would be a fixture wearing a deliverable's clothes. One transaction, so a failure
 * leaves no half-installed catalog.
 */
export async function seedExampleLibrary(storage: StorageAdapter): Promise<ExampleLibrary> {
  const worlds = exampleWorldVersions();
  const characters = exampleCharacterVersions();
  const worldbook = exampleWorldbookEntries();

  await storage.transaction(async (tx) => {
    await tx.collection<World>(COLLECTIONS.worlds).putMany(worlds.map(worldHeadOf));
    await tx.collection<WorldVersion>(COLLECTIONS.worldVersions).putMany(worlds);
    await tx.collection<WorldbookEntry>(COLLECTIONS.worldbookEntries).putMany(worldbook);
    await tx.collection<Character>(COLLECTIONS.characters).putMany(characters.map(characterHeadOf));
    await tx.collection<CharacterVersion>(COLLECTIONS.characterVersions).putMany(characters);
  });

  return {
    worldIds: worlds.map((row) => row.worldId),
    characterIds: characters.map((row) => row.characterId),
    worldbookIds: worldbook.map((entry) => entry.id),
  };
}
