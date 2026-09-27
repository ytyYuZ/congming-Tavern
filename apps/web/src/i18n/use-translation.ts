/**
 * The React binding for the catalogs (M1-G1, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THE TRANSLATOR IS MEMOISED PER LOCALE AND NOT REBUILT PER RENDER
 * `createTranslator` is cheap, but its RESULT is what a component's props and effects
 * depend on: a new `t` on every render makes `useEffect(…, [t])` re-run forever and makes
 * any `React.memo` below a translated component useless. `i18n/translate.ts` owns one
 * translator per locale, which is the smallest unit that can change, and this hook only
 * decides WHICH locale that is.
 *
 * WHY THE HOOK RE-RENDERS THE WHOLE TREE
 * `useLocaleStore` is the single subscription point for the language, and it is read here
 * rather than in one screen: every component that renders copy calls this hook, so a
 * `setLocale` re-renders all of them and none can be forgotten. That mechanism is what
 * the acceptance criterion ("the whole interface follows the language") rests on.
 *
 * WHY THE PICKER'S LABELS ARE NOT TRANSLATED
 * `LOCALE_LABELS` maps each locale to its name IN ITS OWN LANGUAGE. A picker is read by
 * someone who cannot read the current interface language, so `中文` and `English` are the
 * only useful labels; translating them would make the case they exist for worse.
 *
 * WHY THE NON-REACT LOOKUPS ARE RE-EXPORTED
 * A view should have one import for "language things", and a view is also where a caller
 * that needs `translate` outside a render (an event handler building a message) will be.
 * The implementations live in `i18n/translate.ts` so a storage module can use them
 * without React in its graph — see that file's header for the cycle this avoids.
 */
import { LOCALE_LABELS, LOCALES, type Locale, type Translator } from '@smarttavern/i18n';
import { useMemo } from 'react';
import { useLocaleStore } from '../state/locale-store';
import { translatorFor } from './translate';

/**
 * The non-React lookups a view may also need (an event handler building a sentence, a
 * test asserting a catalog key). Re-exported here so a view has ONE import for language
 * things; the cycle-breaking reason the store-reading ones live in `i18n/translate.ts`
 * and the browser's own preference in `i18n/browser-locale.ts` is recorded in each header.
 */
export { browserLocale } from './browser-locale';
export { currentLocale, translate, translatorFor } from './translate';

export interface Translation {
  /** The catalog lookup for the active locale. Stable until the locale changes. */
  t: Translator['t'];
  /** The active locale, for `Intl` formatting that must match the copy. */
  locale: Locale;
  /** Switch the language; persists in the background (see `state/locale-store.ts`). */
  setLocale: (next: Locale) => Promise<void>;
  /** Every supported locale, in picker order. */
  locales: readonly Locale[];
  /** Each locale's name in its own language. Deliberately untranslated. */
  localeLabels: Readonly<Record<Locale, string>>;
}

/**
 * Every piece of the i18n contract a component needs, from ONE hook.
 *
 * The language is read as a primitive (`useLocaleStore((state) => state.locale)`), which
 * is what makes the subscription cheap: the store's other fields (`ready`, `error`,
 * `setLocale`) cannot re-render a component that only renders copy. `t` is memoised on
 * that primitive, so the identity a `useEffect` depends on changes exactly once per
 * language switch.
 */
export function useTranslation(): Translation {
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  const t = useMemo(() => translatorFor(locale).t, [locale]);
  return { t, locale, setLocale, locales: LOCALES, localeLabels: LOCALE_LABELS };
}
