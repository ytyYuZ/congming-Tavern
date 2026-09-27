/**
 * Locale identity for the whole app (M1-G1, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THE SUPPORTED SET IS A `const` TUPLE AND NOT AN ENUM
 * `Locale` is DERIVED from `LOCALES`, so the list and the type cannot drift: adding
 * a language is one entry, and every `Record<Locale, …>` in the workspace (the
 * catalogs, the language labels) becomes a compile error until it is filled in. An
 * `enum` would add a runtime object nobody needs and lose the literal union that
 * makes those `Record`s exhaustive.
 *
 * WHY `resolveLocale` IS A SEPARATE FUNCTION FROM THE STORED PREFERENCE
 * `navigator.languages`, a persisted setting and an `Accept-Language` header are all
 * BCP-47 tags that are NOT necessarily a locale this app ships (`en-US`,
 * `zh-Hans-CN`, `fr-CA`, `''`). This module is the single place that turns such a
 * list into one supported `Locale`, so no caller has to ask "is this tag really
 * zh-CN?" and no caller can invent a fifth spelling of the fallback.
 *
 * WHY THE LABELS ARE WRITTEN IN THEIR OWN LANGUAGE
 * A language picker is read by someone who cannot read the CURRENT interface
 * language — `中文` is the only useful label for a zh-CN speaker looking at an
 * English screen, and `Chinese` is the only useful label for an English speaker
 * looking at a Chinese one. This record is therefore the one place where a locale
 * name is deliberately not translated.
 *
 * WHY THIS FILE KNOWS NOTHING ABOUT REACT, THE DOM OR STORAGE
 * This package is framework-free by the repo's convention for `packages/ui` /
 * `packages/i18n` (M1-G1): the hook that re-renders on a language change
 * belongs to `apps/web`, next to the state store that owns the preference. Keeping
 * the pure lookup here means the catalogs can also be read by the CLI, by tests and
 * by a future desktop shell without dragging in a UI runtime.
 */

/** Every locale the app ships, in the order a picker should offer them. */
export const LOCALES = ['zh-CN', 'en'] as const;

/** One supported locale tag. Narrower than `string` on purpose (see the header). */
export type Locale = (typeof LOCALES)[number];

/**
 * What the app shows before the user has chosen anything, and the last resort of
 * `resolveLocale`. zh-CN because the catalogs' source of truth is zh-CN
 * (docs/01-需求规格.md F10-3: Chinese-first, English on day one).
 */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/**
 * A locale's name in ITS OWN language (see the header). Typed `Record<Locale, …>`
 * so a new locale cannot be added without a label.
 */
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = {
  'zh-CN': '中文',
  en: 'English',
};

/**
 * Is this value exactly one of our locale ids?
 *
 * Deliberately EXACT (case-sensitive, no primary-subtag leniency), unlike
 * `resolveLocale`: this is the validator for data this app itself wrote — a stored
 * preference, a URL parameter — where `'EN'` or `'zh'` is a bug in the writer and
 * silently accepting it would hide that bug. Fuzzy input (a browser's tag list) goes
 * through `resolveLocale` instead.
 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.some((locale) => locale === value);
}

/** BCP-47 tags are case-insensitive; `ZH-hans-cn` and `zh-Hans-CN` are one tag. */
function normalizeTag(candidate: string): string {
  return candidate.trim().toLowerCase();
}

/** The primary subtag of a tag: `zh-Hans-CN` -> `zh`. */
function primarySubtag(tag: string): string {
  // `split` is unbounded, so the first element is `string | undefined` under
  // `noUncheckedIndexedAccess`; `''` means "no primary subtag" and matches nothing.
  return tag.split('-')[0] ?? '';
}

/**
 * The best supported locale for a priority-ordered list of BCP-47 tags (e.g.
 * `navigator.languages`), or `DEFAULT_LOCALE`.
 *
 * THE TWO TIERS ARE APPLIED PER CANDIDATE, NOT AS TWO GLOBAL PASSES. The list is a
 * PREFERENCE order, so the first tag the user asked for that we can serve is the
 * right answer: for `['zh-Hans-CN', 'en']` the speaker's first choice is served by
 * zh-CN's primary subtag, and returning `en` because it happens to match exactly
 * would ignore the stronger signal. A global "exact matches first" pass would do
 * exactly that, so the priority order wins and only the *tier* is ordered.
 *
 * A tag matches when it is an exact (case-insensitive) tag or shares a primary
 * subtag with a supported locale, which is what makes `en-US` -> `en` and
 * `zh-Hans-CN` -> `zh-CN` work. Only BCP-47 hyphen tags are understood: a POSIX-style
 * `en_US` has no matching primary subtag and falls through to the default, which is
 * the honest answer for a spelling `navigator.languages` never produces.
 */
export function resolveLocale(candidates: readonly string[]): Locale {
  for (const candidate of candidates) {
    const tag = normalizeTag(candidate);
    if (tag === '') continue;

    const exact = LOCALES.find((locale) => normalizeTag(locale) === tag);
    if (exact !== undefined) return exact;

    const primary = primarySubtag(tag);
    const byPrimary = LOCALES.find((locale) => primarySubtag(normalizeTag(locale)) === primary);
    if (byPrimary !== undefined) return byPrimary;
  }
  return DEFAULT_LOCALE;
}
