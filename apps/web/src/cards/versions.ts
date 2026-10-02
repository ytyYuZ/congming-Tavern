/**
 * Committing a draft as a NEW version (ADR-010) — the pure half of M1-W1 / M1-C1's save.
 *
 * THE ONE RULE THIS MODULE EXISTS TO MAKE STRUCTURAL
 * A published `WorldVersion` / `CharacterVersion` is IMMUTABLE: an edit is a new row, never
 * an in-place change of one somebody may already be playing (`versioning.ts`, `docs/02` §7).
 * So "save" is exactly two writes — the new version row and the head's `headVersion` pointer
 * — and both are PLANNED here, from the head row as the storage layer just read it, before
 * anything is written. Nothing in this file mutates its input: every value it returns is a
 * new object, which is why a test can freeze the inputs and watch the plan succeed.
 *
 * WHY THE HEAD IS AN INDEX OVER THE PAYLOAD
 * `World` / `Character` exist so the library can list and search without loading every
 * version (`docs/02` §7). Their `name` and `tags` are therefore DERIVED from the payload the
 * version carries — the world's `name`/`genre`, the card's `name`/`tags` — so a list row can
 * never advertise a name the version it points at does not have.
 *
 * WHY THE VERSION NUMBER AND THE LINEAGE PARENT ARE TWO DIFFERENT FACTS
 * `version` is monotonic over the HEAD (`head.headVersion + 1`), because the `(worldId,
 * version)` index is unique and two writers must not mint the same one. `lineage.parentId` /
 * `parentVersion` name the version this draft was EDITED FROM, which is what the change is
 * actually a change of. The two differ in the one real race — another tab published while
 * this tab held a draft — and recording the draft's own base is the honest answer there: the
 * new row is a change the user made to that base, not a descendant of a version they never saw.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED
 * The head's own `extensions` bag. `versionedEntity`'s envelope owns the PLUGIN channel, and the
 * head is an index row rather than a payload: writing a plugin's bag onto it as well would give
 * one plugin two slots that can disagree (`world.ts` says the same about a payload that grows its
 * own `extensions`). The user's own custom fields are payload data and travel in `data`
 * (`cards/custom-fields.ts`), so they are planned like every other field.
 */
import type {
  Character,
  CharacterData,
  CharacterVersion,
  Extensions,
  Lineage,
  Timestamp,
  UuidV7,
  VersionNumber,
  World,
  WorldData,
  WorldVersion,
} from '@smarttavern/schema';

/**
 * The version a draft was edited from: the id of its row (for `Lineage.parentId`) and its
 * number. A structural type rather than `EntityPinSchema`, because the caller already holds
 * the row and a pin's `id` is deliberately looser (`IdSchema`) than a version row's id.
 */
export interface VersionAnchor {
  readonly id: UuidV7;
  readonly version: VersionNumber;
}

/**
 * The anchor plus the sentence that explains the new version.
 *
 * WHY THE REASON TRAVELS WITH THE ANCHOR AND NOT BESIDE IT: a `Lineage` row exists only when
 * there IS a parent (`LineageSchema` is optional, and a FIRST version has none). Keeping the two
 * in one object makes "a reason for a first version" — and worse, "an iteration with no reason" —
 * unspellable, instead of a rule the caller has to remember.
 */
export interface VersionBase {
  readonly anchor: VersionAnchor;
  /**
   * The lineage sentence, in the language active at the save. Persisted data, so the CALLER
   * chooses it (`db/repository.ts`'s `createSession` title makes the same split), and it is
   * `LineageSchema`'s (`min(1).max(500)`) business to refuse an empty one.
   */
  readonly reason: string;
}

/**
 * Everything both planners need beyond the payload.
 *
 * `headVersion` is the head's CURRENT version — 0 for a card being created, whose head row is
 * minted with no versions yet, and 1..n for one being iterated. Keeping it in the shared shape
 * is what makes creation and iteration one code path instead of two that can drift.
 */
interface PlanInput {
  /** `undefined` for a FIRST version, which has no parent and therefore no `lineage` row. */
  readonly base: VersionBase | undefined;
  readonly headVersion: number;
  /** The row id to mint for the new version. Passed in so this module stays deterministic. */
  readonly id: UuidV7;
  /** When the save happened. Milliseconds since the epoch (`TimestampSchema`). */
  readonly at: Timestamp;
}

/** The envelope fields both kinds share, so the two planners cannot drift apart. */
function envelope(input: PlanInput): {
  readonly version: VersionNumber;
  readonly lineage: Lineage | undefined;
} {
  const base = input.base;
  return {
    version: input.headVersion + 1,
    lineage:
      base === undefined
        ? undefined
        : {
            parentId: base.anchor.id,
            parentVersion: base.anchor.version,
            reason: base.reason,
            at: input.at,
          },
  };
}

/** The plan: the row to write and the head row that now points at it. */
export interface WorldPlan {
  readonly world: World;
  readonly version: WorldVersion;
}

/**
 * Plan the next `WorldVersion` and the head row that points at it.
 *
 * `head.headVersion` may be 0 here: that is a world being CREATED, and version 1 is what this
 * returns. Creation and iteration therefore take one code path, which is what keeps "a first
 * version" from being a special case that forgets the head update.
 */
export function planWorldVersion(input: {
  readonly head: World;
  readonly base: VersionBase | undefined;
  readonly data: WorldData;
  readonly extensions: Extensions | undefined;
  readonly id: UuidV7;
  readonly at: Timestamp;
}): WorldPlan {
  const planned = envelope({ ...input, headVersion: input.head.headVersion });
  const version: WorldVersion = {
    id: input.id,
    worldId: input.head.id,
    version: planned.version,
    createdAt: input.at,
    updatedAt: input.at,
    data: input.data,
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
    ...(planned.lineage === undefined ? {} : { lineage: planned.lineage }),
  };
  const world: World = {
    ...input.head,
    name: input.data.name,
    tags: [...input.data.genre],
    headVersion: planned.version,
    updatedAt: input.at,
  };
  return { world, version };
}

export interface CharacterPlan {
  readonly character: Character;
  readonly version: CharacterVersion;
}

/** Plan the next `CharacterVersion` and the head row that points at it (see above). */
export function planCharacterVersion(input: {
  readonly head: Character;
  readonly base: VersionBase | undefined;
  readonly data: CharacterData;
  readonly extensions: Extensions | undefined;
  readonly id: UuidV7;
  readonly at: Timestamp;
}): CharacterPlan {
  const planned = envelope({ ...input, headVersion: input.head.headVersion });
  const version: CharacterVersion = {
    id: input.id,
    characterId: input.head.id,
    version: planned.version,
    createdAt: input.at,
    updatedAt: input.at,
    data: input.data,
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
    ...(planned.lineage === undefined ? {} : { lineage: planned.lineage }),
  };
  const character: Character = {
    ...input.head,
    name: input.data.name,
    tags: [...input.data.tags],
    headVersion: planned.version,
    updatedAt: input.at,
  };
  return { character, version };
}
