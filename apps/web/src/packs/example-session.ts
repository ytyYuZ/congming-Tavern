/**
 * 「用示例开局」 — turning an imported example into a session, through the app's own path (M1-A4).
 *
 * WHY THIS IS NOT `@smarttavern/importers`' `exampleStartSession`
 * That helper builds a `Session` row directly and therefore needs a complete `SessionRefs`,
 * including `modelConfig` — a provider and a model that must already be chosen. The app does
 * not have one at creation time, on purpose: `db/repository.ts` records the model on the first
 * turn, and the session-creation screen's `SessionPins` is deliberately `SessionRefs` minus
 * `modelConfig`. Calling the helper would mean inventing a provider here, which is exactly the
 * decision the app defers. So this module produces a `SessionDraft` and hands it to the SAME
 * `useChatStore.create` a person goes through from 「新建会话」: one creation path, one place
 * that validates the pins, one place that writes the session.
 *
 * WHY IT RESOLVES THE ROWS BY ID RATHER THAN ASSUMING THEM
 * The import may have CREATED the example's rows, REUSED rows that were already there, or
 * REMAPPED a conflicting id onto a fresh one (the identity policy in
 * `@smarttavern/importers/src/identity.ts`), and in the last case the rows exist under ids that
 * are not the package's. The report records the mapping, so the draft is built from the ids the
 * import actually produced; when a named row did not arrive at all the function returns
 * `undefined` and the screen offers no button rather than a broken one.
 *
 * WHY THE CLOCK COMES FROM THE WORLD VERSION
 * `defaultClockOf` is the same rule the creation screen uses (the world's `startMinute`), so a
 * session started here and one started by hand begin at the same minute.
 */

import type { ImportEntityKind, ImportReport } from '@smarttavern/importers';
import { EXAMPLE_IDS, EXAMPLE_LONGDAY_ROSTER } from '@smarttavern/importers';
import { latestCharacterVersion, latestWorldVersion } from '../db/repository';
import { type CardChoice, defaultClockOf, type SessionDraft } from '../session/roster';

/**
 * The id an imported row ended up with.
 *
 * A row that was reused or created keeps the package's own id; a REMAPPED row carries the new
 * id and records the package's id as `originId` (the importer's provenance field), so both are
 * matched. A SKIPPED row has no id and cannot be the target of a session.
 */
function arrivedId(
  report: ImportReport,
  entity: ImportEntityKind,
  packageId: string,
): string | undefined {
  for (const row of report.entities) {
    if (row.entity !== entity) continue;
    if (row.id === packageId || row.originId === packageId) return row.id;
  }
  return undefined;
}

/**
 * Whether an import brought in the example's own world — i.e. whether 「用示例开局」 has anything
 * to talk about. A report about some other `.stpack` must not show an example button, and must
 * not apologise for one either.
 */
export function isExamplePack(report: ImportReport): boolean {
  return (
    arrivedId(report, 'world', EXAMPLE_IDS.worlds[EXAMPLE_LONGDAY_ROSTER.world].id) !== undefined
  );
}

/**
 * A ready-to-create draft for the example's own 长日港 world, or `undefined` when the rows this
 * build needs are not all in the library.
 *
 * The head versions are read from the library rather than from the report: the report's `version`
 * is optional by the importer's own contract, and the head row is what a new session must pin.
 */
export async function exampleSessionDraft(report: ImportReport): Promise<SessionDraft | undefined> {
  const roster = EXAMPLE_LONGDAY_ROSTER;
  const worldId = arrivedId(report, 'world', EXAMPLE_IDS.worlds[roster.world].id);
  if (worldId === undefined) return undefined;
  const worldVersion = await latestWorldVersion(worldId);
  if (worldVersion === undefined) return undefined;

  const cards: CardChoice[] = [];
  for (const key of [roster.player, ...roster.cast]) {
    const characterId = arrivedId(report, 'character', EXAMPLE_IDS.characters[key].id);
    if (characterId === undefined) return undefined;
    const characterVersion = await latestCharacterVersion(characterId);
    if (characterVersion === undefined) return undefined;
    cards.push({
      id: characterId,
      name: characterVersion.data.name,
      version: characterVersion.version,
    });
  }

  // The player is the roster's first card; `cards` has one entry per roster slot or the loop
  // above already returned, so a missing first entry is impossible — but the type has to be
  // narrowed honestly rather than asserted.
  const player = cards[0];
  if (player === undefined) return undefined;

  return {
    world: { id: worldId, version: worldVersion.version },
    cards,
    playerId: player.id,
    initialClock: defaultClockOf(worldVersion),
  };
}
