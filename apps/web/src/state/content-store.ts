/**
 * The card editors' state layer (M1-W1 / M1-C1, ADR-017): the two libraries, the open card, its
 * draft, and the publish act.
 *
 * WHAT IS STATE AND WHAT IS A READ
 * `worlds` / `characters` are plain copies the two library screens read once per mount (nothing
 * else writes them), while the OPEN card's payload IS the draft the editor renders. The draft is
 * the one value this store owns, and it owns it because every keystroke writes it — autosave is
 * write-through, not a subscription.
 *
 * WHY AUTOSAVE IS WRITE-THROUGH AND NOT DEBOUNCED
 * Every accepted edit writes the draft row immediately, in the same order `state/appearance-store
 * .ts` uses for a slider: the in-memory value moves first — the form must not wait for IndexedDB
 * to show the character the user just typed — and the row follows. A debounce would need a timer
 * and a flush-on-unmount rule, i.e. a second write path whose failure mode (a tab closed inside
 * the debounce window) is exactly the lost work the draft exists to prevent; the cost it saves is
 * one put of a JSON document per keystroke, on a local database, for a document measured in
 * kilobytes.
 *
 * WHY A FAILED DRAFT WRITE LEAVES THE VALUE IN PLACE
 * The change stands (the user asked for it, and reverting is a second, surprising change) and
 * `error` records the failure's NAME for the editor's status line — see `state/write-error.ts`,
 * which owns the rule and the reason the message itself is deliberately dropped.
 *
 * WHY PUBLISH WRITES FIRST AND THEN ADOPTS WHAT THE ROW RETURNED
 * The next gesture after a publish reads the ROW: another tab, a reload, and S1's session picker
 * all list `headVersion`. So the row is written first and the store adopts the row the repository
 * returned — never a value it computed itself and never a second read, which is the same rule the
 * checkpoint panel follows (ADR-010's "an edit is a new version" made structural: this action can
 * only ever produce the row the planner made inside the transaction).
 *
 * WHY VALIDATION IS CHECKED HERE AS WELL AS IN THE REPOSITORY
 * This is the GATE the user sees: a payload with issues is refused before anything is written, and
 * the editor's panel already lists them. The repository parses again inside its transaction, so a
 * programmatic caller (a test, a future import path) cannot write a version the schema refuses.
 */
import type {
  Character,
  CharacterData,
  CharacterVersion,
  Extensions,
  Id,
  World,
  WorldData,
  WorldVersion,
} from '@smarttavern/schema';
import { create } from 'zustand';
import { blankCharacterData, characterIssues } from '../cards/character';
import {
  type CharacterDraft,
  characterDraftOf,
  type WorldDraft,
  worldDraftOf,
} from '../cards/draft';
import { blankWorldData, worldIssues } from '../cards/world';
import {
  clearCharacterDraft,
  clearWorldDraft,
  createCharacter as createCharacterRow,
  createWorld as createWorldRow,
  getCharacter,
  getWorld,
  latestCharacterVersion,
  latestWorldVersion,
  listCharacters,
  listWorlds,
  publishCharacter as publishCharacterRow,
  publishWorld as publishWorldRow,
  readCharacterDraft,
  readWorldDraft,
  writeCharacterDraft,
  writeWorldDraft,
} from '../db/repository';
import { translate } from '../i18n/translate';
import { writeErrorName } from './write-error';

/** Which `open*` is current, so a read that resolves after its view is gone cannot install state. */
let openToken = 0;

export interface ContentState {
  /** Every world card, by name. The library screen's list. */
  worlds: World[];
  /** Every character card, by name. */
  characters: Character[];

  /** The open world's head row, or `undefined` while nothing is open (or still loading). */
  world: World | undefined;
  /** The newest PUBLISHED version — the payload the draft was based on. */
  worldVersion: WorldVersion | undefined;
  /** What the editor is showing: the stored draft, or the published payload when there is none. */
  worldDraft: WorldDraft | undefined;
  /** True while `worldDraft` is backed by a stored draft row rather than by the version. */
  worldDirty: boolean;

  character: Character | undefined;
  characterVersion: CharacterVersion | undefined;
  characterDraft: CharacterDraft | undefined;
  characterDirty: boolean;

  /** The last write failure's name, or `undefined`. See `state/write-error.ts`. */
  error: string | undefined;

  loadWorlds: () => Promise<void>;
  loadCharacters: () => Promise<void>;
  /** Create a world (head + version 1) and resolve its id, or `undefined` on a refusal. */
  createWorld: (name: string) => Promise<Id | undefined>;
  createCharacter: (name: string) => Promise<Id | undefined>;
  /** Open one world's editor: head, newest version, and the draft over it. */
  openWorld: (worldId: Id) => Promise<void>;
  openCharacter: (characterId: Id) => Promise<void>;
  /** Forget the open card. Called by the route on unmount. */
  close: () => void;
  /**
   * Autosave one world edit. Resolves whether the draft row was written.
   *
   * `extensions` is the VERSION ENVELOPE's plugin bag, not the user's own fields — those are
   * payload data (`cards/custom-fields.ts`). The editor renders no part of it; it travels through
   * the draft so a plugin's data survives a user edit instead of being dropped by the next publish.
   */
  editWorld: (data: WorldData, extensions: Extensions) => Promise<boolean>;
  /** The same, for a character card. */
  editCharacter: (data: CharacterData, extensions: Extensions) => Promise<boolean>;
  /** Publish the open world's draft as a new version. See the header for the order. */
  publishWorld: () => Promise<boolean>;
  publishCharacter: () => Promise<boolean>;
  /** Drop the draft row and fall back to the published payload. */
  discardWorldDraft: () => Promise<boolean>;
  discardCharacterDraft: () => Promise<boolean>;
}

/** The state an open card starts from — one shape for both kinds, so a close cannot half-clear. */
function closedCard(): Pick<
  ContentState,
  | 'world'
  | 'worldVersion'
  | 'worldDraft'
  | 'worldDirty'
  | 'character'
  | 'characterVersion'
  | 'characterDraft'
  | 'characterDirty'
  | 'error'
> {
  return {
    world: undefined,
    worldVersion: undefined,
    worldDraft: undefined,
    worldDirty: false,
    character: undefined,
    characterVersion: undefined,
    characterDraft: undefined,
    characterDirty: false,
    error: undefined,
  };
}

export const useContentStore = create<ContentState>((set, get) => ({
  worlds: [],
  characters: [],
  ...closedCard(),

  async loadWorlds(): Promise<void> {
    try {
      set({ worlds: await listWorlds() });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card read failure') });
    }
  },

  async loadCharacters(): Promise<void> {
    try {
      set({ characters: await listCharacters() });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card read failure') });
    }
  },

  /**
   * Create a world and hand back its id, so the caller can navigate to the editor.
   *
   * The payload is the editor's blank (`cards/world.ts`) — schema-valid on purpose, so 「新建」
   * writes version 1 instead of refusing — and a blank NAME is refused here rather than written,
   * because `WorldDataSchema.name` (`min(1)`) is the only content constraint a new world has.
   */
  async createWorld(name: string): Promise<Id | undefined> {
    const title = name.trim();
    if (title === '') return undefined;
    try {
      const created = await createWorldRow({ name: title, data: blankWorldData(title) });
      if (created === undefined) return undefined;
      set({ worlds: [...get().worlds, created.world], error: undefined });
      return created.world.id;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return undefined;
    }
  },

  async createCharacter(name: string): Promise<Id | undefined> {
    const title = name.trim();
    if (title === '') return undefined;
    try {
      const created = await createCharacterRow({ name: title, data: blankCharacterData(title) });
      if (created === undefined) return undefined;
      set({ characters: [...get().characters, created.character], error: undefined });
      return created.character.id;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return undefined;
    }
  },

  /**
   * Open a world's editor.
   *
   * THREE READS, IN ORDER: the head (is there such a world), the newest version (the payload a
   * draft is completed against) and the draft row itself. The token makes the whole sequence
   * abandonable: a view that unmounted, or a second `openWorld`, must not be overwritten by the
   * first one's late answer (`state/chat-store.ts`'s `open` records the same race).
   *
   * A draft row that exists decides `worldDirty`; one that does not means the editor shows the
   * PUBLISHED payload, which is also where a draft row nobody can read lands (`cards/draft.ts`).
   */
  async openWorld(worldId: Id): Promise<void> {
    openToken += 1;
    const token = openToken;
    const world = await getWorld(worldId);
    if (token !== openToken) return;
    const version = await latestWorldVersion(worldId);
    if (token !== openToken) return;
    if (world === undefined || version === undefined) {
      set(closedCard());
      return;
    }
    const stored = await readWorldDraft(worldId, version);
    if (token !== openToken) return;
    set({
      world,
      worldVersion: version,
      worldDraft: stored ?? worldDraftOf(version),
      worldDirty: stored !== undefined,
      error: undefined,
    });
  },

  async openCharacter(characterId: Id): Promise<void> {
    openToken += 1;
    const token = openToken;
    const character = await getCharacter(characterId);
    if (token !== openToken) return;
    const version = await latestCharacterVersion(characterId);
    if (token !== openToken) return;
    if (character === undefined || version === undefined) {
      set(closedCard());
      return;
    }
    const stored = await readCharacterDraft(characterId, version);
    if (token !== openToken) return;
    set({
      character,
      characterVersion: version,
      characterDraft: stored ?? characterDraftOf(version),
      characterDirty: stored !== undefined,
      error: undefined,
    });
  },

  close(): void {
    // Bumping the token invalidates any in-flight `open*`, so it cannot install state afterwards.
    openToken += 1;
    set({ ...closedCard() });
  },

  /**
   * Autosave one world edit (M1-W1's 「自动保存可用」).
   *
   * `baseVersion` travels with the draft: it is the version this content was EDITED FROM, and it
   * is what the publish records as the lineage parent (`cards/draft.ts`). It comes from the draft
   * that is open — not from `worldVersion` — because the two differ exactly when another tab
   * published while this editor was open, and the honest anchor then is the older one.
   */
  async editWorld(data: WorldData, extensions: Extensions): Promise<boolean> {
    const { world, worldDraft } = get();
    if (world === undefined || worldDraft === undefined) return false;
    const draft: WorldDraft = { baseVersion: worldDraft.baseVersion, data, extensions };
    set({ worldDraft: draft, worldDirty: true });
    try {
      await writeWorldDraft(world.id, draft);
      set({ error: undefined });
      return true;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return false;
    }
  },

  async editCharacter(data: CharacterData, extensions: Extensions): Promise<boolean> {
    const { character, characterDraft } = get();
    if (character === undefined || characterDraft === undefined) return false;
    const draft: CharacterDraft = { baseVersion: characterDraft.baseVersion, data, extensions };
    set({ characterDraft: draft, characterDirty: true });
    try {
      await writeCharacterDraft(character.id, draft);
      set({ error: undefined });
      return true;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return false;
    }
  },

  /**
   * Publish the open world's draft (ADR-010: a new version, never an edit of one).
   *
   * The VALIDATION GATE runs first and writes nothing when it refuses, so a world that is missing
   * a month name cannot become a version — the panel beside the button is what explains it. The
   * lineage sentence is chosen here because it is PERSISTED copy and has to be written in the
   * language that was active at the save (`db/repository.ts`'s `createSession` title, same rule).
   */
  async publishWorld(): Promise<boolean> {
    const { world, worldDraft } = get();
    if (world === undefined || worldDraft === undefined) return false;
    if (worldIssues(worldDraft.data).length > 0) return false;
    try {
      const published = await publishWorldRow({
        worldId: world.id,
        data: worldDraft.data,
        extensions: worldDraft.extensions,
        baseVersion: worldDraft.baseVersion,
        reason: translate('world.lineageReason'),
      });
      if (published === undefined) return false;
      // The ROW is the truth: the editor now shows what was written, and the draft is gone because
      // the repository deleted it in the same transaction.
      set({
        world: published.world,
        worldVersion: published.version,
        worldDraft: worldDraftOf(published.version),
        worldDirty: false,
        error: undefined,
      });
      return true;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return false;
    }
  },

  async publishCharacter(): Promise<boolean> {
    const { character, characterDraft } = get();
    if (character === undefined || characterDraft === undefined) return false;
    if (characterIssues(characterDraft.data).length > 0) return false;
    try {
      const published = await publishCharacterRow({
        characterId: character.id,
        data: characterDraft.data,
        extensions: characterDraft.extensions,
        baseVersion: characterDraft.baseVersion,
        reason: translate('character.lineageReason'),
      });
      if (published === undefined) return false;
      set({
        character: published.character,
        characterVersion: published.version,
        characterDraft: characterDraftOf(published.version),
        characterDirty: false,
        error: undefined,
      });
      return true;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return false;
    }
  },

  /**
   * Drop the draft row, so the editor shows the published version again.
   *
   * The row is cleared BEFORE the in-memory value moves, which is the opposite order from `edit*`
   * and for the checkpoint panel's reason: the next gesture after this one re-reads the row (a
   * reload, the same screen reopened through the router), so a screen that showed the published
   * payload while the row still held the draft would resurrect the draft on the next mount.
   */
  async discardWorldDraft(): Promise<boolean> {
    const { world, worldVersion } = get();
    if (world === undefined || worldVersion === undefined) return false;
    try {
      await clearWorldDraft(world.id);
      set({ worldDraft: worldDraftOf(worldVersion), worldDirty: false, error: undefined });
      return true;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return false;
    }
  },

  async discardCharacterDraft(): Promise<boolean> {
    const { character, characterVersion } = get();
    if (character === undefined || characterVersion === undefined) return false;
    try {
      await clearCharacterDraft(character.id);
      set({
        characterDraft: characterDraftOf(characterVersion),
        characterDirty: false,
        error: undefined,
      });
      return true;
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown card write failure') });
      return false;
    }
  },
}));

/**
 * Test seam: forget everything this process loaded, exactly as the store started.
 *
 * The library reads are direct calls rather than wrappers, so there is nothing else to reset: a
 * `load*` action only ever REPLACES a list it read, and the two lists belong to this store alone.
 */
export function resetContentStore(): void {
  openToken += 1;
  useContentStore.setState({ worlds: [], characters: [], ...closedCard() });
}
