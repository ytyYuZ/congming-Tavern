/**
 * THE one place a state SNAPSHOT's independence is created (ADR-032).
 *
 * WHY THIS MODULE EXISTS AND WHY IT MOVED OUT OF `db/repository.ts`
 * `SessionState` is a value with two roles: the session row's LIVE value and the value a
 * checkpoint stores as "then" (ADR-032). Writing a copy of it correctly - one level deep in
 * every sub-object that could otherwise be aliased - is a RULE, not a storage detail, and the
 * rule now has three callers: `db/repository.ts`'s checkpoint write and rollback, and
 * `session/fork.ts`'s fork (a fork starts from a copy of the save point it came from, for
 * exactly the reason a save point is a copy). Keeping it inside the repository would have made
 * a pure module import the database layer to reuse one function, or duplicate the rule; the
 * repository's own note that `cast.ts`'s `checkpointCastOf` is "the same rule" one field over
 * is the measurement that says the rule belongs beside the data rather than beside the port.
 *
 * WHY NOT `structuredClone`: it exists in every browser this app targets, but it is a global
 * that `biome.json` bans for `packages/core` and that this workspace has not adopted elsewhere;
 * the state's shape is fixed by `SessionStateSchema` (a scene object, the clock, the cast, four
 * flat records, one array of flat objects), so an explicit copy is shorter than the argument for
 * the global and cannot throw on a value the schema already forbids. A field-by-field copy also
 * states, in code, exactly which parts are shared by reference when they are not copied -
 * `sheets`' values are `unknown` to core, so they are the one place a nested mutation could
 * still be observed; that is called out at `copySheets` rather than hidden.
 *
 * `cast` IS COPIED ENTRY BY ENTRY (M1-S4): a save point's `castState` is taken from the live
 * record, and a copy that shared it would follow every later mute - the same "then must not
 * move" rule the whole function exists for, applied to the field the user edits most often. The
 * ENTRIES are copied one level deep: an entry's fields are all primitives by schema, so there is
 * nothing below them to share. A FORK copies its cast through the same function, so "a new
 * timeline must not move under the old one" is the same guarantee and not a second rule.
 */
import type { CastState, Id, SessionState } from '@smarttavern/schema';

/**
 * A DEEP-ENOUGH COPY OF A SESSION STATE. See the header for why it is not `structuredClone`.
 *
 * The clock and the inner clock are numbers and a flat object, so an absent `innerClock` stays
 * absent (`undefined` is not a value the schema accepts, so it must not appear as a key).
 */
export function copyState(state: SessionState): SessionState {
  return {
    scene: { ...state.scene },
    clock: state.clock,
    ...(state.innerClock === undefined ? {} : { innerClock: { ...state.innerClock } }),
    cast: copyCast(state.cast),
    vars: { ...state.vars },
    sheets: copySheets(state.sheets),
    deadlines: state.deadlines.map((deadline) => ({ ...deadline })),
  };
}

/**
 * One new entry per cast member; see the header for why this is a copy at all.
 *
 * `undefined` (a state written before the field existed) becomes `{}`: absence and an empty
 * record mean the same thing to every reader (`session/cast.ts`'s `interventionOf`), and the
 * copy is the value a caller will store.
 */
export function copyCast(cast: SessionState['cast']): Record<Id, CastState> {
  const copy: Record<Id, CastState> = {};
  for (const [characterId, entry] of Object.entries(cast ?? {})) {
    copy[characterId] = { ...entry };
  }
  return copy;
}

/**
 * A new object per sheet, and a new object per row inside it.
 *
 * The CELLS are copied one level deep and no further: a sheet cell is `unknown` because the rule
 * pack owns its schema, and a copy that recursed into it would be guessing at a shape this layer
 * must not know. So a cell that holds an OBJECT is still shared - the same limitation
 * `structuredClone` would not have - and it is recorded here rather than discovered: nothing in
 * M1 writes such a cell (`vars` is primitives by schema and no rule pack ships yet).
 */
function copySheets(sheets: SessionState['sheets']): SessionState['sheets'] {
  const copy: SessionState['sheets'] = {};
  for (const [actorId, row] of Object.entries(sheets)) copy[actorId] = { ...row };
  return copy;
}
