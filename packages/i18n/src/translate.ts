/**
 * Looking a key up and formatting it (M1-G1).
 *
 * WHY THE LOCALE IS AN ARGUMENT AND NOT MODULE STATE
 * A module-level "current locale" would make the app's language a hidden input to
 * every render, and would break the one thing this milestone promises: switching the
 * language re-renders the whole interface. Here `createTranslator(locale)` is data a
 * component can subscribe to, and the only thing that changes on a switch is the
 * argument — no cache to invalidate, no listener to forget.
 *
 * WHY THERE IS NO MEMOISATION
 * The translator is a two-field object whose work is one property read and one
 * regex replace, so a cache would cost more than it saves and would be a second place
 * for a stale locale to hide. A caller that really wants one instance should hold it
 * where it holds the locale (a React context in `apps/web`, a module constant in a
 * CLI), which is also where the language change is observable.
 *
 * WHY THE LOOKUP IS SPLIT OUT AND EXPORTED
 * The fallback chain is the only part of this file with branches worth testing and it
 * cannot be reached through `t()` with a WELL-FORMED catalog: the types say every
 * locale has every key. `lookupMessage` therefore takes the catalog as an argument so
 * a test can hand it a deliberately incomplete one and watch both fallback steps
 * happen. It is deliberately NOT re-exported from the barrel — `t()` is the contract;
 * this is the seam the contract is proven through.
 *
 * WHY A MISSING PARAMETER KEEPS ITS PLACEHOLDER
 * `t('setup.testOk')` with no `status` returns `连接成功（HTTP {status}）`. Throwing
 * would turn a forgotten argument into a dead screen, and substituting `''` would
 * turn it into `连接成功（HTTP ）`, which reads like the server said nothing. A
 * visible `{status}` in the UI is a bug report; an empty string is a mystery. The
 * same reasoning is why an empty catalog value falls back instead of rendering blank.
 */
import { CATALOGS, type MessageKey, zhCN } from './catalog';
import type { Locale } from './locale';

/** What a message may interpolate: text and numbers, nothing that needs formatting. */
export type TranslateParams = Record<string, string | number>;

/** The read-only view a component gets: one locale, one `t`. */
export interface Translator {
  readonly locale: Locale;
  t(key: MessageKey, params?: TranslateParams): string;
}

/**
 * A catalog as the lookup sees it: the keys are `string` (not `MessageKey`) so an
 * incomplete catalog is expressible, and a value may be absent, which is exactly the
 * case the fallback chain exists for.
 */
export type Catalog = Readonly<Record<string, string | undefined>>;

/** `{name}` — a brace-delimited identifier. No escaping: no catalog string needs one. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Resolve ONE key: the active catalog, then the zh-CN source of truth, then the key
 * itself.
 *
 * WHY zh-CN IS THE SECOND STEP: it is complete BY CONSTRUCTION (every key is defined
 * there first, and `en` is typed against it), so it can always answer a key that the
 * active catalog lost. WHY THE KEY ITSELF IS THE THIRD: something has to render, and
 * `play.send` on a button is an unambiguous report of which key is missing, where an
 * empty string or a thrown error is not.
 *
 * An empty value counts as missing. The catalogs cannot legitimately hold one
 * (`catalog.test.ts` fails on it), so seeing one means the data is wrong, and the
 * fallback chain — not a blank button — is the right answer to wrong data.
 */
export function lookupMessage(catalog: Catalog, key: string): string {
  const own = catalog[key];
  if (own !== undefined && own !== '') return own;

  // Read through the runtime view of the source of truth on purpose: its TYPE says
  // this key cannot be missing, and the reason this branch exists is that a type is
  // not a guarantee.
  const source = (zhCN as Catalog)[key];
  if (source !== undefined && source !== '') return source;

  return key;
}

/**
 * Fill `{name}` placeholders from `params`.
 *
 * Exported for `translate.ts`'s own tests (not from the barrel): it is the one piece
 * of `t()` whose behaviour on malformed input is worth pinning separately.
 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER, (matched: string, name: string): string => {
    const value = params[name];
    return value === undefined ? matched : String(value);
  });
}

/**
 * A translator for one locale. `locale` is exposed so the UI can pass it to
 * `Intl.DateTimeFormat` / `Intl.NumberFormat` — a translated label next to a
 * date in the wrong locale's format is half a language switch.
 */
export function createTranslator(locale: Locale): Translator {
  const catalog: Catalog = CATALOGS[locale];
  return {
    locale,
    t(key: MessageKey, params?: TranslateParams): string {
      return interpolate(lookupMessage(catalog, key), params);
    },
  };
}
