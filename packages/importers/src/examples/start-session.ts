/**
 * "拿示例包开一局" — the second half of M1-I2's acceptance sentence (`docs/06` §2.6:
 * "导入示例包即可开始一局"), expressed as the one data path that has to work:
 *
 *   the world version and the character versions THE LIBRARY HOLDS are pinned by
 *   the session, and its `initialClock` is that world version's `startMinute`.
 *
 * WHICH WORLD, AND WITH WHOM. The example carries two worlds and four cards, so the
 * caller names a ROSTER — one of `EXAMPLE_ROSTERS` (`长日港` + 沈砚 + 陶三娘, or
 * `末班渡` + 阿梧 + 渡伯) — and defaults to the first. A roster is a suggestion the
 * example ships, NOT a schema field: `packages/schema`'s card has no player/cast
 * flag on purpose (ADR-010), and the user's own choice is M1-S1's, in
 * `apps/web/src/session/roster.ts`.
 *
 * WHAT OWNS WHAT. `apps/web` owns the UI-facing half of session creation (which
 * cards the user ticked, whether the clock is editable) and `db/repository.ts` owns
 * the model config and the write. What this function owns is exactly what the PACK
 * provides: which rows to pin and where the clock starts. That is why `modelConfig`
 * and the `promptPreset` pin are REQUIRED inputs — neither is something a content
 * pack can know, and inventing either would put a lie in the session row.
 * `packages/importers` may not import the app, so the built-in preset's id cannot be
 * read from `apps/web/src/chat/builtin-content.ts`; the caller passes it.
 *
 * WHY IT RESOLVES BY PROVENANCE AND NOT BY ID. An import into a library that already
 * holds a same-named world or card REMAPS the entity to a fresh id and records where
 * it came from (`docs/04` §7, `identity.ts`'s `x-smarttavern.origin-id`). A first-run
 * flow therefore cannot assume the pack's ids are the library's ids — so each entity
 * is found by an earlier import's origin id OR by its own id, and the version pinned
 * is the head row's ACTUAL version. `example-pack.test.ts` proves the remap case,
 * which is the whole reason this is a lookup and not a constant.
 */
import { COLLECTIONS, type StorageAdapter } from '@smarttavern/core';
import {
  type Character,
  type CharacterVersion,
  defaultSessionState,
  type EntityPin,
  type Extensions,
  mintUuidV7,
  type SchedulerMode,
  type Session,
  type SessionRefs,
  SessionSchema,
  type World,
  type WorldVersion,
} from '@smarttavern/schema';
import { originIdOf } from '../identity';
import { EXAMPLE_IDS, EXAMPLE_LONGDAY_ROSTER, type ExampleRoster } from './content';

/** Raised when the example's rows are not in the library this call was given. */
export class ExampleContentMissingError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `the example content pack is not in this library (missing: ${missing.join(', ')}); build it with buildExampleContentPack(), import it with importPackage(), then start the session`,
    );
    this.name = 'ExampleContentMissingError';
  }
}

export interface ExampleStartOptions {
  /**
   * `SessionRefs.modelConfig`. Required: the provider and model are the user's
   * configuration, and a pack that guessed them would be wrong on every machine but
   * the one it was written on.
   */
  readonly modelConfig: SessionRefs['modelConfig'];
  /**
   * The preset to pin. Required for the same reason: the only preset that exists in
   * M1 is the app's built-in constant (`apps/web/src/chat/builtin-content.ts`,
   * `BUILTIN_PRESET_ID`), which this package may not import — the caller knows it.
   */
  readonly promptPreset: EntityPin;
  /** Which example world and cast to start. Defaults to `EXAMPLE_LONGDAY_ROSTER`. */
  readonly roster?: ExampleRoster;
  /** The session's id; minted as a UUIDv7 when absent. */
  readonly id?: string;
  /** Defaults to the world's name, which is content and therefore not translated. */
  readonly title?: string;
  readonly schedulerMode?: SchedulerMode;
  readonly now?: () => Date;
}

/** The session row plus the version rows it pinned. */
export interface ExampleStart {
  /** Already validated by `SessionSchema`, so a caller can store it as it stands. */
  readonly session: Session;
  readonly worldVersion: WorldVersion;
  readonly playerVersion: CharacterVersion;
  readonly castVersions: readonly CharacterVersion[];
}

/**
 * The row the example owns, found by the origin id an earlier import recorded, or —
 * when nothing was remapped — by the pack's own id.
 *
 * WHY THE ORIGIN WINS. A row whose `x-smarttavern.origin-id` is the pack's id IS this
 * pack's content, unambiguously. An id match alone can be a local world that merely
 * shares the pack's id: in that conflict the import creates a SECOND row under a
 * minted id, and "the example's world" has to be the one that arrived. When the pack
 * was imported into an empty library both lookups find the same row, so the order
 * only decides the case it exists for. Returns `undefined` when neither exists, so a
 * caller can report every missing piece at once instead of failing on the first one.
 */
function findByOrigin<T extends { readonly id: string; readonly extensions?: Extensions }>(
  rows: readonly T[],
  originId: string,
): T | undefined {
  return (
    rows.find((row) => originIdOf(row) === originId) ?? rows.find((row) => row.id === originId)
  );
}

/**
 * The version row a versioned head points at, or `undefined` when it is missing.
 *
 * `belongsTo` is not optional politeness: a version NUMBER is not an identity. Two
 * worlds in one library both start at version 1 (`docs/04` §4's id-conflict remap
 * creates exactly that), so matching on the number alone would pin the wrong world's
 * payload — the bug `example-pack.test.ts`'s remap case exists to catch.
 */
function versionOf<T extends { readonly version: number }>(
  rows: readonly T[],
  belongsTo: (row: T) => boolean,
  headVersion: number,
): T | undefined {
  return rows.find((row) => belongsTo(row) && row.version === headVersion);
}

/** One head row resolved to the version row it pins. */
interface ResolvedCharacter {
  readonly head: Character;
  readonly version: CharacterVersion;
}

/**
 * The rows a session started from the example pack must pin, and the clock it starts
 * at — read from the library, never from the source constants (`../content`).
 */
export async function exampleStartSession(
  storage: StorageAdapter,
  options: ExampleStartOptions,
): Promise<ExampleStart> {
  const now = options.now ?? (() => new Date());
  const at = now();
  const roster = options.roster ?? EXAMPLE_LONGDAY_ROSTER;
  const worldIds = EXAMPLE_IDS.worlds[roster.world];
  const playerIds = EXAMPLE_IDS.characters[roster.player];
  const castIds = roster.cast.map((key) => EXAMPLE_IDS.characters[key].id);

  return storage.transaction(async (tx) => {
    const worlds = await tx.collection<World>(COLLECTIONS.worlds).list();
    const worldVersions = await tx.collection<WorldVersion>(COLLECTIONS.worldVersions).list();
    const characters = await tx.collection<Character>(COLLECTIONS.characters).list();
    const characterVersions = await tx
      .collection<CharacterVersion>(COLLECTIONS.characterVersions)
      .list();

    const worldHead = findByOrigin(worlds, worldIds.id);
    const playerHead = findByOrigin(characters, playerIds.id);
    const castHeads = castIds.map((id) => findByOrigin(characters, id));

    // One report naming EVERY piece that is missing, rather than failing on the first.
    const missing: string[] = [];
    if (worldHead === undefined) missing.push(`world ${worldIds.id}`);
    if (playerHead === undefined) missing.push(`player card ${playerIds.id}`);
    for (const [index, head] of castHeads.entries()) {
      if (head === undefined) missing.push(`cast card ${castIds[index] ?? index}`);
    }
    if (missing.length > 0) throw new ExampleContentMissingError(missing);

    // The checks above are a REPORT; these are what the compiler needs, because a
    // throw behind an array length does not narrow three separate optionals — and a
    // silently unpinned session is worse than a crash.
    if (worldHead === undefined || playerHead === undefined) {
      throw new ExampleContentMissingError([worldIds.id]);
    }

    const worldVersion = versionOf(
      worldVersions,
      (row) => row.worldId === worldHead.id,
      worldHead.headVersion,
    );
    if (worldVersion === undefined) {
      throw new ExampleContentMissingError([`world ${worldHead.id} v${worldHead.headVersion}`]);
    }

    const playerVersion = versionOf(
      characterVersions,
      (row) => row.characterId === playerHead.id,
      playerHead.headVersion,
    );
    if (playerVersion === undefined) {
      throw new ExampleContentMissingError([
        `character ${playerHead.id} v${playerHead.headVersion}`,
      ]);
    }

    const cast: ResolvedCharacter[] = [];
    for (const head of castHeads) {
      if (head === undefined) throw new ExampleContentMissingError(castIds);
      const version = versionOf(
        characterVersions,
        (row) => row.characterId === head.id,
        head.headVersion,
      );
      if (version === undefined) {
        throw new ExampleContentMissingError([`character ${head.id} v${head.headVersion}`]);
      }
      cast.push({ head, version });
    }

    // The clock is the WORLD's decision (docs/01 §5.4 step 6, ADR-012): the session
    // copies `startMinute` and owns it from then on.
    const initialClock = worldVersion.data.startMinute;
    const session = SessionSchema.parse({
      id: options.id ?? mintUuidV7(() => at),
      title: options.title ?? worldHead.name,
      refs: {
        world: { id: worldHead.id, version: worldVersion.version },
        playerCharacter: { id: playerHead.id, version: playerVersion.version },
        cast: cast.map((entry) => ({ id: entry.head.id, version: entry.version.version })),
        promptPreset: { ...options.promptPreset },
        modelConfig: options.modelConfig,
      },
      initialClock,
      state: defaultSessionState(initialClock),
      schedulerMode: options.schedulerMode ?? 'rules',
      headMessageId: null,
      createdAt: at.getTime(),
      updatedAt: at.getTime(),
    });

    return {
      session,
      worldVersion,
      playerVersion,
      castVersions: cast.map((entry) => entry.version),
    };
  });
}
