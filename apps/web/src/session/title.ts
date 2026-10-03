/**
 * A session's TITLE as a person types it — the one rule both naming paths share (M1-T1).
 *
 * WHY THIS IS A MODULE AND NOT TWO `if`s IN THE TWO SCREENS
 * 「新建会话」 validates a DRAFT and the play screen validates a RENAME, and both have to answer
 * the same two questions against the same schema bound
 * (`packages/schema/src/entities/session.ts`: `title: z.string().min(1).max(200)`): "is this a
 * name at all?" and "is it short enough for the row to accept?". One rule with two callers is the
 * shape `session/roster.ts` already gives the draft (`sessionIssues`), and it is what keeps the
 * sentence the screen renders and the value the store writes from being two different opinions.
 *
 * WHY THE LIMIT IS COUNTED IN CODE POINTS (`[...name].length`)
 * That is how the schema counts it: zod's `max` check re-measures with `util.codePointLength`
 * (`node_modules/zod/v4/core/checks.cjs`), so 200 emoji is one valid title where 200 UTF-16 code
 * units would have cut the same name at 100. `state/chat-store.ts`'s `forkTitleOf` cuts a fork
 * title in the same unit (ADR-036), and a browser `maxLength` attribute could NOT be used for
 * this: HTML counts UTF-16 units, so it would refuse a 200-emoji name the schema accepts.
 */
import type { MessageKey } from '@smarttavern/i18n';

/**
 * The longest title `SessionSchema` accepts, in CODE POINTS.
 *
 * A named constant rather than a literal in two files: the rule that enforces the bound and the
 * two sentences that state it are then one edit apart, and `session/title.test.ts` asserts the
 * catalog still says this number.
 */
export const SESSION_TITLE_LIMIT = 200;

/**
 * The name a person typed, or `undefined` when they typed none.
 *
 * WHY TRIMMING IS NOT COSMETIC: the schema requires `min(1)`, so a title of three spaces is a row
 * that cannot be read back. The edges are stripped for the same reason the schema has no `trim()`
 * of its own — the row is what the title bar shows — and `undefined` rather than `''` is what
 * lets a caller say "no name was given" without a second rule about blankness.
 */
export function titleNameOf(input: string | undefined): string | undefined {
  const name = input?.trim() ?? '';
  return name === '' ? undefined : name;
}

/**
 * The refusal a DRAFT's title earns, or `undefined` when the schema would accept it.
 *
 * A MISSING OR BLANK name is no issue at all: naming a session is optional, and the default title
 * is the store's business (`state/chat-store.ts` decides it, because the repository may not read
 * the catalogs — ADR-030). So a draft with no `title` stays valid, which is also what keeps
 * 示例开局 (`app/packs/example-session.ts`) and every programmatic caller on the create path.
 */
export function titleIssueOf(input: string | undefined): MessageKey | undefined {
  const name = titleNameOf(input);
  if (name === undefined) return undefined;
  return [...name].length > SESSION_TITLE_LIMIT ? 'session.nameTooLong' : undefined;
}

/**
 * The refusal a RENAME earns — the same rule plus the one thing a rename cannot mean.
 *
 * WHY THE TWO DIFFER: leaving the create form's field blank is how a person asks for the default
 * name, but an existing session always HAS a name, so a blank rename is not a request for a
 * default — it is a name that cannot be stored, and the form says so instead of writing anything.
 */
export function renameIssueOf(input: string | undefined): MessageKey | undefined {
  if (titleNameOf(input) === undefined) return 'session.nameRequired';
  return titleIssueOf(input);
}
