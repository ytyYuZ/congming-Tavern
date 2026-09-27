/**
 * The NAME of a failed settings write (M1-G2) — the one field every settings store
 * reports when persistence fails.
 *
 * WHY THIS IS NOT A THROW
 * A store's `set*` action is called from a `<select>`/slider change handler, i.e. a
 * fire-and-forget click: a rejection there becomes an unhandled promise rejection with
 * no user-visible outcome, and the value on screen would disagree with the one on disk
 * in silence. So each store keeps the user's choice, records a short machine-readable
 * label in its `error` field, and lets a caller decide whether to surface it
 * (`state/locale-store.ts` states the full argument).
 *
 * WHY THE NAME AND NOT THE MESSAGE
 * A storage failure's message can quote the value that failed to store — for the
 * provider row that value is the API key (HANDOFF §4.1 invariant 6), and for the rows
 * this feature adds it is a colour scheme, which is not worth a sentence either. The
 * name is the part a diagnostic needs and the part that is safe to keep.
 *
 * WHY THE CHECK IS STRUCTURAL AND NOT `instanceof Error`
 * A browser reports a failed IndexedDB write as a `DOMException`, which is not an `Error`
 * subclass in every engine, and "which engine threw" is not something a diagnostic should
 * depend on.
 *
 * WHY IT LIVES IN ITS OWN MODULE
 * Two stores (locale, appearance) need this rule, and the workspace's rule is one
 * implementation per rule. It is a leaf: it imports nothing, so neither store gains a
 * dependency on the other.
 */

/**
 * The one field read off an unknown thrown value, spelled ONCE as a variable because
 * this workspace's two guards disagree about the literal form: `tsconfig` sets
 * `noPropertyAccessFromIndexSignature` (which rejects `record.name`) while Biome's
 * `useLiteralKeys` rejects `record['name']`. A PARAMETERISED key is the only spelling
 * both accept — the same conflict CONTRIBUTING.md §6 describes.
 */
const ERROR_NAME_FIELD = 'name';

/**
 * An error's `name`, or `whenUnknown` when the thrown value does not carry one.
 *
 * `whenUnknown` is an argument rather than a constant so the label still says WHICH
 * write failed (`'unknown locale write failure'`), which is the only information a log
 * line gets back once the message has been dropped.
 */
export function writeErrorName(cause: unknown, whenUnknown: string): string {
  if (typeof cause === 'object' && cause !== null) {
    const candidate: unknown = (cause as Record<string, unknown>)[ERROR_NAME_FIELD];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return whenUnknown;
}
