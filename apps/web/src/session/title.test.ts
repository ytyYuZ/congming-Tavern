/**
 * What a session may be CALLED (M1-T1), as a pure rule: no DOM, no database.
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONE'S OWN WORDS
 * 1. 「创建时可填会话名，留空用默认名」 — a blank field is NOT a missing answer: `titleNameOf`
 *    reports `undefined` for `''`, for spaces and for an absent field, which is exactly the signal
 *    `state/chat-store.ts` turns into the default title. A rename, by contrast, has no default to
 *    fall back on, so the SAME input is a refusal there (`renameIssueOf`) — the two entry points
 *    differ in what they do with blank, and the difference is the whole point of the pair.
 * 2. 「保证界面肯提交就一定过 `SessionSchema.parse`」 — the rule's ceiling is the stored title's
 *    ceiling. The last case checks that against `SessionSchema` itself rather than against a copy
 *    of its number, so a change to `packages/schema/src/entities/session.ts` fails HERE, next to
 *    the rule, instead of at a write nobody is looking at.
 *
 * WHY THE BOUNDARY CASES ARE ASTRAL CHARACTERS: `title` is bounded by `z.string().max(200)`, and
 * zod 4 measures the string in CODE POINTS (`node_modules/zod/v4/core/checks.cjs`, which only
 * falls back to `util.codePointLength` when the UTF-16 length exceeds the bound). One emoji is two
 * code units, so a 200-emoji name is `String.length === 400` and is still storable; a rule that
 * measured `length` would refuse names the database accepts, and one that measured nothing would
 * hand the store a row it cannot write. The cases below therefore spell both counts out.
 */
/** @vitest-environment node */
import { en, zhCN } from '@smarttavern/i18n';
import { SessionSchema } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { renameIssueOf, SESSION_TITLE_LIMIT, titleIssueOf, titleNameOf } from './title';

const EMOJI = '😀';

describe('titleNameOf', () => {
  it('treats an absent, empty or whitespace-only field as no name at all', () => {
    expect(titleNameOf(undefined)).toBeUndefined();
    expect(titleNameOf('')).toBeUndefined();
    expect(titleNameOf('   ')).toBeUndefined();
    expect(titleNameOf('\t\n ')).toBeUndefined();
  });

  it('trims the name it does keep, and keeps the trimmed one', () => {
    expect(titleNameOf(' 霜月群岛的第一夜 ')).toBe('霜月群岛的第一夜');
    expect(titleNameOf('A')).toBe('A');
    // Inner spacing is the user's, not ours: only the ends are cut.
    expect(titleNameOf('  A  B  ')).toBe('A  B');
  });

  it('hands back an over-long name whole, because cutting it is not its job', () => {
    // 201 emoji is 402 UTF-16 units and 201 code points: over the ceiling either way, and still
    // handed back whole, because cutting a name is not this function's to do.
    expect(titleNameOf(EMOJI.repeat(SESSION_TITLE_LIMIT + 1))).toHaveLength(402);
    expect([...(titleNameOf(EMOJI.repeat(SESSION_TITLE_LIMIT + 1)) ?? '')]).toHaveLength(201);
  });
});

describe('titleIssueOf', () => {
  it('says nothing about a name nobody gave: a blank field asks for the default title', () => {
    expect(titleIssueOf(undefined)).toBeUndefined();
    expect(titleIssueOf('')).toBeUndefined();
    expect(titleIssueOf('  ')).toBeUndefined();
  });

  it('accepts a name at the limit and refuses the next code point', () => {
    expect(titleIssueOf(EMOJI.repeat(SESSION_TITLE_LIMIT))).toBeUndefined();
    expect(titleIssueOf(EMOJI.repeat(SESSION_TITLE_LIMIT + 1))).toBe('session.nameTooLong');
  });

  it('counts CODE POINTS, like the stored title does', () => {
    // 200 code units of ASCII plus one emoji is 201 code points: over the limit even though the
    // string is 201 units long too. 199 + one emoji is 200 code points and 201 units: under it.
    expect(titleIssueOf('a'.repeat(200) + EMOJI)).toBe('session.nameTooLong');
    expect(titleIssueOf('a'.repeat(199) + EMOJI)).toBeUndefined();
  });

  it('measures the TRIMMED name, so padding cannot push a good name over', () => {
    expect(titleIssueOf(`  ${EMOJI.repeat(SESSION_TITLE_LIMIT)}  `)).toBeUndefined();
  });
});

describe('renameIssueOf', () => {
  it('refuses a blank name, because a rename has no default to fall back on', () => {
    expect(renameIssueOf(undefined)).toBe('session.nameRequired');
    expect(renameIssueOf('')).toBe('session.nameRequired');
    expect(renameIssueOf(' \t ')).toBe('session.nameRequired');
  });

  it('hands the length question to `titleIssueOf`, so both entry points share one ceiling', () => {
    expect(renameIssueOf(EMOJI.repeat(SESSION_TITLE_LIMIT))).toBeUndefined();
    expect(renameIssueOf(EMOJI.repeat(SESSION_TITLE_LIMIT + 1))).toBe('session.nameTooLong');
  });
});

describe('the rule and the stored title', () => {
  it('accepts exactly what the stored title accepts, in the same unit', () => {
    const stored = SessionSchema.shape.title;
    expect(stored.safeParse(EMOJI.repeat(SESSION_TITLE_LIMIT)).success).toBe(true);
    expect(stored.safeParse(EMOJI.repeat(SESSION_TITLE_LIMIT + 1)).success).toBe(false);
    // The rule is the boundary and not a wider or narrower one: both agree at ±1.
    expect(titleIssueOf(EMOJI.repeat(SESSION_TITLE_LIMIT - 1))).toBeUndefined();
  });

  it('names the same ceiling in the sentence the form shows, in both languages', () => {
    // The refusals are rendered with no parameters (`new-session.tsx` prints `t(key)` for each
    // issue), so the number has to live in the sentence — and has to be THIS number.
    expect(zhCN['session.nameTooLong']).toContain(String(SESSION_TITLE_LIMIT));
    expect(en['session.nameTooLong']).toContain(String(SESSION_TITLE_LIMIT));
  });
});
