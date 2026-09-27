/**
 * @smarttavern/i18n — the workspace's single entry point for user-facing copy
 * (M1-G1, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS BARREL IS THE ONLY IMPORT PATH
 * Every other workspace — the lint rule's message, the UI conversion, the future
 * world/character editors — imports `@smarttavern/i18n` and nothing below it. A
 * single entry point means the module layout inside `src/` can change without
 * touching a caller, and it makes the public surface reviewable in one screen: what
 * is not re-exported here (the fallback lookup, the interpolation helper) is an
 * implementation detail a caller must not build on.
 *
 * WHY THE PACKAGE IS FRAMEWORK-FREE AND DEPENDENCY-FREE
 * The repo's convention for `packages/ui` and `packages/i18n` is that the packages
 * stay presentational/platform-agnostic; the React binding that re-renders on a
 * language switch lives in `apps/web`, where the state store owns the preference. So
 * `package.json` declares no `dependencies` at all (pinned by `index.test.ts`), and
 * nothing here reaches for a DOM global: these functions are pure reads of two
 * objects, which is also why the CLI and the tests can use them unchanged.
 *
 * WHY THE LOCALE UNION IS EXPORTED, NOT ONLY THE VALUES
 * Consumers switch on it (`LOCALE_LABELS[locale]`, `Intl` formatters, a persisted
 * preference). Handing them the literal union keeps that switch exhaustive: adding a
 * language turns into compile errors exactly where a human has to decide what the
 * new locale means, which is the behaviour M1-G1's acceptance criterion needs.
 */

export { CATALOGS, en, type MessageKey, type Messages, zhCN } from './catalog';
export {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_LABELS,
  LOCALES,
  type Locale,
  resolveLocale,
} from './locale';
export { createTranslator, type TranslateParams, type Translator } from './translate';
