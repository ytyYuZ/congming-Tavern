/**
 * Errors raised by the self-built `.stpack` ZIP container (M0-T3, ADR-018).
 *
 * WHY THIS FILE EXISTS
 * docs/04-分享格式规范.md §9 and docs/06 §8.2 require every rejection to "指出具体
 * 条目" (name the offending entry) — an untrusted archive must fail with something
 * a user can act on, not "invalid zip". One error type with a structured `context`
 * also lets `tools/stpack-cli` (M0-T4) print a stable, machine-readable reason
 * without pattern-matching on English prose.
 *
 * SCOPE: pure data — no I/O, no DOM, no Node API.
 */

/** Extra, machine-readable detail attached to a {@link ZipError}. */
export interface ZipErrorContext {
  /** Path of the offending entry, when the failure belongs to one. */
  readonly path?: string;
  /** Offset into the archive, when the failure is structural. */
  readonly offset?: number;
  /** The rule that was violated, e.g. `'path-traversal'` or `'encrypted'`. */
  readonly rule?: string;
}

/**
 * Every failure raised by `zip/write.ts` and `zip/read.ts`.
 *
 * One class rather than a hierarchy: callers either surface the message or branch
 * on `context.rule`, and a class per rule would invite a `catch` that silently
 * swallows the next rule added.
 */
export class ZipError extends Error {
  override readonly name = 'ZipError';
  readonly context: ZipErrorContext;

  constructor(message: string, context: ZipErrorContext = {}) {
    const where = context.path !== undefined ? ` [${context.path}]` : '';
    const at = context.offset !== undefined ? ` (at byte ${context.offset})` : '';
    super(`${message}${where}${at}`);
    this.context = context;
  }
}
