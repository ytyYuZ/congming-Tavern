/**
 * The browser's preferred locale (M1-G1, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS IS A LEAF MODULE, AND WHY THAT IS THE WHOLE POINT OF THE FILE
 * `i18n/translate.ts` reads the locale store (`currentLocale`, `translate`), and
 * `state/locale-store.ts` needs the browser's guess as the last resort of its documented
 * chain — so a `browserLocale()` living in `translate.ts` made the store import the very
 * layer that reads it: `i18n/translate.ts -> state/locale-store.ts -> i18n/translate.ts`.
 * That cycle is benign ONLY while both uses stay inside function bodies, which is what
 * makes it fragile: the day either module reads the other at module-evaluation time, one
 * of them sees a half-evaluated module and the symptom is `translate is not a function`,
 * with no local clue (ADR-030's addendum records the incident). This file exists so that
 * edge cannot exist at all — it imports `@smarttavern/i18n` and NOTHING from `apps/web`,
 * so no import of it can close a loop. If a future change here seems to need the store,
 * the change is wrong: the store-reading lookups belong in `translate.ts`.
 *
 * WHY IT KNOWS ABOUT `navigator` AT ALL
 * `resolveLocale` is the ONE place a fuzzy BCP-47 tag list becomes a supported locale, and
 * a reader's own list (`navigator.languages`) is presentation-adjacent, not storage.
 * `db/repository.ts` stores and returns exactly what its row holds and must not reach for
 * the browser; the caller (`state/locale-store.ts`) is where "the row had nothing, so ask
 * the browser" is decided, and this function is the browser's answer. Keeping the
 * DOM-touching line in the UI layer also means the storage module can be driven by a test
 * with no `navigator` at all.
 */
import { type Locale, resolveLocale } from '@smarttavern/i18n';

/**
 * The browser's preferred locale, or `DEFAULT_LOCALE`.
 *
 * `navigator.languages` is read through a PARAMETERISED key on purpose: this workspace
 * compiles with `noPropertyAccessFromIndexSignature` (which rejects dot access on the
 * `Navigator` index signature) while Biome's `useLiteralKeys` rejects the literal bracket
 * form — the same spelling `db/repository.ts`'s `stringField` uses for the identical
 * conflict. A host without a `languages` list (a test process, a future worker) falls
 * through to `DEFAULT_LOCALE` instead of throwing.
 */
export function browserLocale(): Locale {
  const key = 'languages';
  const candidate: unknown = typeof navigator === 'undefined' ? undefined : navigator[key];
  if (!Array.isArray(candidate)) return resolveLocale([]);
  return resolveLocale(candidate.filter((tag): tag is string => typeof tag === 'string'));
}
