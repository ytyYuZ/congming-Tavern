/**
 * The M1-I2 example content pack (`docs/06-开发任务拆解.md` §2.6), as a module of
 * the importers package.
 *
 * WHY IT LIVES IN THIS PACKAGE. The pack is DATA THAT ONLY MEANS SOMETHING THROUGH
 * THE IMPORT PATH: it is built by a `PackageWriter`, imported by
 * `importPackage`, and its acceptance is asserted against the rows that import
 * produces. Keeping the source, the builder and the "start a session from it" step
 * beside the importer keeps that one path testable in one place — and the app can
 * consume all three (`apps/web` may import any package) without a second copy.
 *
 *   ./content       the readable source: the world, its worldbook and its two cards
 *   ./content-pack  the `kind: bundle` exporter + `buildExampleContentPack`
 *   ./start-session the rows → a playable session, pinned and clocked
 *
 * WHAT IS NOT HERE: a rule pack. No rule-pack schema or row exists in this build
 * (`packages/schema` has none; `Session.refs.rulePack` was left absent by M1-S1;
 * `docs/06` §10.5 records the item as unowned), so the pack carries no
 * `data/rulepacks.json`, no `rulepack` reference and no rule-pack count. See
 * `./content`'s header for the full reasoning.
 */
export * from './content';
export * from './content-pack';
export * from './start-session';
