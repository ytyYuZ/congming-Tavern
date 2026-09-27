/**
 * Catalog lookups with NO React in the graph (M1-G1, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS IS NOT `i18n/use-translation.ts`
 * A non-UI caller needs "the translator for this locale" and "the sentence for this key
 * right now" without pulling React or `react-dom` into its module graph. That is not a
 * style preference: `state/chat-store.ts` builds the sentence a logged error carries, and
 * if the lookup lived in the hook file then a store would drag the React runtime in.
 *
 * WHY THE STORE IS IMPORTED HERE — THE ONE EDGE IN THIS DIRECTION
 * `useLocaleStore` is the only place the preference lives, so a lookup that read anything
 * else could disagree with what is rendered. The edge is safe because it is a LEAF: the
 * locale store imports `db/repository.ts` and this module, and neither of those imports
 * `i18n/use-translation.ts` (which is what would close the `repository -> hook -> store
 * -> repository` cycle and leave `translate` undefined while a module is half-evaluated).
 * The React binding stays in the hook file; the pure lookups stay here.
 *
 * WHY `translate` READS THE STORE AT CALL TIME
 * The alternative — a module-level "current sentences" cache — is the stale copy this
 * whole milestone exists to remove: a caller that ran before a language switch would
 * keep producing the old language forever, with no render to correct it. Reading
 * `useLocaleStore.getState()` per call is a property read and cannot go stale.
 *
 * WHY THE BROWSER PREFERENCE IS RESOLVED HERE AND NOT IN `db/repository.ts`
 * `resolveLocale` is the ONE place a fuzzy tag list becomes a supported locale, and a
 * reader's own list (`navigator.languages`) is presentation-adjacent, not storage. The
 * repository stores and returns exactly what the row holds; this module supplies the
 * browser's guess when it does not. Keeping the DOM-touching line in the UI layer also
 * means the storage module can be driven by a test with no `navigator` at all.
 */
import {
  createTranslator,
  type Locale,
  type MessageKey,
  resolveLocale,
  type TranslateParams,
  type Translator,
} from '@smarttavern/i18n';
import { useLocaleStore } from '../state/locale-store';

/** One translator per locale. At most one entry per supported language. */
const translators = new Map<Locale, Translator>();

/**
 * The translator for `locale`.
 *
 * A pure function of the locale, so a cache miss and a cache hit are the same value and
 * the cache can never hand back a translator for another language.
 */
export function translatorFor(locale: Locale): Translator {
  const cached = translators.get(locale);
  if (cached !== undefined) return cached;
  const created = createTranslator(locale);
  translators.set(locale, created);
  return created;
}

/** The locale currently in effect. Readable outside React. */
export function currentLocale(): Locale {
  return useLocaleStore.getState().locale;
}

/**
 * A catalog lookup for a NON-React caller (a store, a CLI, an error report).
 *
 * It reads the store at call time, so a caller that runs after a language switch uses
 * the language that is on screen.
 */
export function translate(key: MessageKey, params?: TranslateParams): string {
  return translatorFor(currentLocale()).t(key, params);
}

/**
 * The browser's preferred locale, or `DEFAULT_LOCALE`.
 *
 * `navigator.languages` is read through a PARAMETERISED key on purpose: this workspace
 * compiles with `noPropertyAccessFromIndexSignature` (which rejects dot access on the
 * `Navigator` index signature) while Biome's `useLiteralKeys` rejects the literal
 * bracket form — the same spelling `db/repository.ts`'s `stringField` uses for the
 * identical conflict. A host without a `languages` list (a test process, a future
 * worker) falls through to `DEFAULT_LOCALE` instead of throwing.
 */
export function browserLocale(): Locale {
  const key = 'languages';
  const candidate: unknown = typeof navigator === 'undefined' ? undefined : navigator[key];
  if (!Array.isArray(candidate)) return resolveLocale([]);
  return resolveLocale(candidate.filter((tag): tag is string => typeof tag === 'string'));
}
