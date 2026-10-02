/**
 * The card editors' state layer against real IndexedDB (M1-W1 / M1-C1, ADR-010).
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONE'S OWN WORDS
 * 1. 「所有字段可增删改」 — asserted through STORAGE, not through form state: a payload with every
 *    leaf changed is autosaved, re-opened from the row, and compared field for field; a list row
 *    is added, edited and removed with a storage round trip after each step.
 * 2. 「校验与自动保存可用」 — autosave persists a HALF-TYPED payload (an empty name included) and a
 *    publish is REFUSED by the validation gate while writing nothing.
 * 3. ADR-010's whole point — an edit produces a NEW version while the old one is untouched: the
 *    published row's JSON is compared before and after, byte for byte.
 * 4. 「放弃草稿」 and a corrupt draft both fall back to the published payload rather than throwing.
 *
 * WHAT IS *NOT* RE-ASSERTED HERE: that the completion covers every leaf of the entity schemas
 * (`cards/world.test.ts` / `cards/character.test.ts` do that against the contract itself), and
 * that the ST round trip loses nothing — that is M1-I1's acceptance, and this editor only has to
 * guarantee that the fields exist and survive storage.
 */
/** @vitest-environment node */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { CharacterData, JsonValue, WorldData } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankCharacterData } from '../cards/character';
import { closeDatabase, readTable, resetDatabase, write } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import {
  characterDraftId,
  getCharacterVersion,
  getWorld,
  getWorldVersion,
  readWorldDraft as readStoredWorldDraft,
  worldDraftId,
} from '../db/repository';
import { resetContentStore, useContentStore } from './content-store';
import { useLocaleStore } from './locale-store';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-content-store-${databases}`;
  resetDatabase(databaseName);
  resetContentStore();
  // The lineage sentence is PERSISTED copy, written in the language active at the save, so the
  // assertions below can say which language they expect it in.
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  resetContentStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ──────────────────────────────── helpers ────────────────────────────────── */

const store = () => useContentStore.getState();

/** One `settings` row's value, read the way the draft reader reads it. */
async function storedValue(id: string): Promise<JsonValue | undefined> {
  const row = await readTable<{ id: string; value: JsonValue }>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/** Every leaf of a JSON document as `[dotted path, value]`, arrays included by index. */
function leavesOf(value: unknown, prefix = ''): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.flatMap((member, index) => leavesOf(member, `${prefix}.${index}`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, member]) =>
      leavesOf(member, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return [[prefix, value]];
}

/** Overwrite one leaf of a JSON document by its dotted path. */
function setLeaf(target: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: unknown = target;
  for (const part of parts.slice(0, -1)) {
    node = Array.isArray(node)
      ? node[Number(part)]
      : (node as Record<string, unknown> | undefined)?.[part];
  }
  if (Array.isArray(node)) node[Number(parts.at(-1) ?? '0')] = value;
  else if (node !== null && typeof node === 'object') {
    (node as Record<string, unknown>)[parts.at(-1) ?? ''] = value;
  }
}

/**
 * A distinct, legal value for one leaf.
 *
 * Numbers move by ONE so a positive-integer constraint (a month's days, an hour count) survives
 * the change, and strings get their own path so a value that arrived at the wrong field is
 * visible in the failure rather than being another plausible string.
 */
function changeLeaf(leaf: unknown, path: string): unknown {
  if (typeof leaf === 'string') return `v-${path}`;
  if (typeof leaf === 'number') return leaf + 1;
  if (typeof leaf === 'boolean') return !leaf;
  return leaf;
}

/** The same document with EVERY leaf changed — the 「所有字段可改」 fixture, built from the blank. */
function populated<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as unknown;
  for (const [path, leaf] of leavesOf(copy)) setLeaf(copy, path, changeLeaf(leaf, path));
  return copy as T;
}

/* ──────────────────────────────── worlds ─────────────────────────────────── */

describe('the world editor’s storage round trip', () => {
  it('creates a world as head + version 1, and opens it with no draft', async () => {
    const worldId = await store().createWorld('  霜月群岛  ');
    expect(worldId).toBeDefined();
    if (worldId === undefined) return;

    await store().openWorld(worldId);
    const state = store();
    expect(state.world?.name).toBe('霜月群岛');
    expect(state.world?.headVersion).toBe(1);
    expect(state.worldVersion?.version).toBe(1);
    expect(state.worldDraft?.data.name).toBe('霜月群岛');
    // No draft row yet: the editor is showing the published payload, not a draft of it.
    expect(state.worldDirty).toBe(false);
    expect(await storedValue(worldDraftId(worldId))).toBeUndefined();
    // The library screen's own read sees the new card.
    await store().loadWorlds();
    expect(store().worlds).toContainEqual(
      expect.objectContaining({ id: worldId, name: '霜月群岛' }),
    );
  });

  it('refuses a blank name instead of writing a world nobody can find', async () => {
    expect(await store().createWorld('   ')).toBeUndefined();
    expect(store().worlds).toEqual([]);
  });

  it('autosaves EVERY field into the draft row and leaves version 1 byte-identical', async () => {
    const worldId = await store().createWorld('w');
    if (worldId === undefined) throw new Error('the world was not created');
    await store().openWorld(worldId);
    const publishedBefore = JSON.stringify(await getWorldVersion(worldId, 1));

    const draft = store().worldDraft;
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    const edited = populated(draft.data);
    // A CJK value in a nested group and in the user's own field record, so the row is proven to
    // survive a real character set in both places.
    const withText: WorldData = {
      ...edited,
      premise: '永冬之海上的群岛。',
      regions: [{ id: 'silverpine', name: '银松镇', description: '终年积雪。', tags: ['城镇'] }],
      customFields: { 天气: '暴雪' },
    };
    // The plugin bag travels with the draft and is never rendered (`cards/custom-fields.ts`).
    const extensions = { 'x-mythos.sanity': 9 };
    await expect(store().editWorld(withText, extensions)).resolves.toBe(true);

    // THE ROW, not the form: the draft row holds exactly what was edited...
    const value = await storedValue(worldDraftId(worldId));
    expect(JSON.stringify(value)).toContain('永冬之海上的群岛。');
    expect(JSON.stringify(value)).toContain('暴雪');
    expect(JSON.stringify(value)).toContain('x-mythos.sanity');
    const base = await getWorldVersion(worldId, 1);
    if (base === undefined) throw new Error('version 1 disappeared');
    expect((await readStoredWorldDraft(worldId, base))?.data).toEqual(withText);

    // ...and ADR-010 holds: the PUBLISHED row did not move.
    expect(JSON.stringify(await getWorldVersion(worldId, 1))).toBe(publishedBefore);

    // Re-opening in a fresh store reads the edit back from storage.
    resetContentStore();
    await store().openWorld(worldId);
    expect(store().worldDraft?.data).toEqual(withText);
    expect(store().worldDraft?.extensions).toEqual(extensions);
    expect(store().worldDirty).toBe(true);
  });

  it('opens a card whose user fields are still in the legacy x-custom.* bag', async () => {
    // The read-boundary repair, end to end: a row written by the earlier iteration must open with
    // the field where it now lives, and publishing must persist it in the payload.
    const worldId = await store().createWorld('w');
    if (worldId === undefined) throw new Error('the world was not created');
    const published = await getWorldVersion(worldId, 1);
    if (published === undefined) throw new Error('version 1 is missing');
    await write(async (tx) => {
      await tx.collection<{ id: string; value: JsonValue }>(COLLECTIONS.settings).put({
        id: worldDraftId(worldId),
        value: {
          baseVersion: 1,
          data: published.data,
          extensions: {
            'x-custom.weather': { label: '天气', value: '暴雪' },
            'x-mythos.sanity': 9,
          },
        },
      });
    });

    await store().openWorld(worldId);
    expect(store().worldDraft?.data.customFields).toEqual({ 天气: '暴雪' });
    expect(store().worldDraft?.extensions).toEqual({ 'x-mythos.sanity': 9 });

    await expect(store().publishWorld()).resolves.toBe(true);
    const second = await getWorldVersion(worldId, 2);
    // The next publish persists it in the payload record and does not carry the legacy key on.
    expect(second?.data.customFields).toEqual({ 天气: '暴雪' });
    expect(second?.extensions).toEqual({ 'x-mythos.sanity': 9 });
  });

  it('keeps a half-typed payload, and refuses to publish it', async () => {
    const worldId = await store().createWorld('w');
    if (worldId === undefined) throw new Error('the world was not created');
    await store().openWorld(worldId);
    const draft = store().worldDraft;
    if (draft === undefined) return;

    // The state autosave exists for: the name is empty while the user is retyping it.
    await expect(store().editWorld({ ...draft.data, name: '' }, {})).resolves.toBe(true);
    expect(store().worldDraft?.data.name).toBe('');
    expect(await getWorldVersion(worldId, 2)).toBeUndefined();

    await expect(store().publishWorld()).resolves.toBe(false);
    // Nothing was written by the refusal: no version 2, the draft is still there.
    expect(await getWorldVersion(worldId, 2)).toBeUndefined();
    expect(await storedValue(worldDraftId(worldId))).toBeDefined();
    expect(store().world?.headVersion).toBe(1);
  });

  it('publishes the draft as a NEW version and leaves the old one untouched', async () => {
    const worldId = await store().createWorld('w');
    if (worldId === undefined) throw new Error('the world was not created');
    await store().openWorld(worldId);
    const draft = store().worldDraft;
    if (draft === undefined) return;

    const publishedBefore = JSON.stringify(await getWorldVersion(worldId, 1));
    const edited: WorldData = {
      ...draft.data,
      name: '霜月群岛',
      genre: ['奇幻'],
      openingHooks: ['旅店的灯灭了。'],
      calendar: { ...draft.data.calendar, minutesPerHour: 100, hoursPerDay: 26 },
    };
    await store().editWorld(edited, {});
    await expect(store().publishWorld()).resolves.toBe(true);

    const second = await getWorldVersion(worldId, 2);
    expect(second?.data).toEqual(edited);
    expect(second?.version).toBe(2);
    // The lineage sentence is the caller's, in the language active at the save.
    expect(second?.lineage?.parentVersion).toBe(1);
    expect(second?.lineage?.reason).toContain('世界');
    // THE OLD ROW IS UNTOUCHED (ADR-010's whole point).
    expect(JSON.stringify(await getWorldVersion(worldId, 1))).toBe(publishedBefore);
    // The head is an index over the payload it now points at.
    expect((await getWorld(worldId))?.headVersion).toBe(2);
    expect((await getWorld(worldId))?.name).toBe('霜月群岛');
    expect((await getWorld(worldId))?.tags).toEqual(['奇幻']);
    // The draft became a version: its row is gone, and the editor is on the new version.
    expect(await storedValue(worldDraftId(worldId))).toBeUndefined();
    expect(store().worldDirty).toBe(false);
    expect(store().worldDraft?.baseVersion).toBe(2);

    // ...so the NEXT edit anchors its lineage at the version it was edited from.
    const again = store().worldDraft;
    if (again === undefined) return;
    await store().editWorld({ ...again.data, era: '第三纪' }, {});
    await expect(store().publishWorld()).resolves.toBe(true);
    expect((await getWorldVersion(worldId, 3))?.lineage?.parentVersion).toBe(2);
  });

  it('adds, edits and removes a region through storage', async () => {
    const worldId = await store().createWorld('w');
    if (worldId === undefined) throw new Error('the world was not created');
    await store().openWorld(worldId);
    const add = async (data: WorldData): Promise<void> => {
      await expect(store().editWorld(data, {})).resolves.toBe(true);
      resetContentStore();
      await store().openWorld(worldId);
    };
    const first = store().worldDraft;
    if (first === undefined) return;

    const region = { id: 'silverpine', name: '银松镇', description: '' };
    await add({ ...first.data, regions: [region] });
    expect(store().worldDraft?.data.regions).toEqual([region]);

    const renamed = { ...region, name: '银松堡', parentId: 'silverpine' };
    await add({ ...first.data, regions: [renamed] });
    expect(store().worldDraft?.data.regions).toEqual([renamed]);

    await add({ ...first.data, regions: [] });
    expect(store().worldDraft?.data.regions).toEqual([]);
  });

  it('discards the draft, falling back to the published payload', async () => {
    const worldId = await store().createWorld('published-name');
    if (worldId === undefined) throw new Error('the world was not created');
    await store().openWorld(worldId);
    const draft = store().worldDraft;
    if (draft === undefined) return;
    await store().editWorld({ ...draft.data, name: 'draft-name' }, {});
    expect(await storedValue(worldDraftId(worldId))).toBeDefined();

    await expect(store().discardWorldDraft()).resolves.toBe(true);
    expect(await storedValue(worldDraftId(worldId))).toBeUndefined();
    expect(store().worldDraft?.data.name).toBe('published-name');
    expect(store().worldDirty).toBe(false);
    // ...and a fresh open agrees, because the ROW is what it reads.
    resetContentStore();
    await store().openWorld(worldId);
    expect(store().worldDraft?.data.name).toBe('published-name');
  });

  it('falls back to the published payload when the draft row cannot be read', async () => {
    const worldId = await store().createWorld('w');
    if (worldId === undefined) throw new Error('the world was not created');
    await write(async (tx) => {
      await tx
        .collection<{ id: string; value: JsonValue }>(COLLECTIONS.settings)
        .put({ id: worldDraftId(worldId), value: 'not a draft at all' });
    });

    await expect(store().openWorld(worldId)).resolves.toBeUndefined();
    expect(store().worldDraft?.data.name).toBe('w');
    expect(store().worldDirty).toBe(false);
  });
});

/* ─────────────────────────────── characters ──────────────────────────────── */

describe('the character editor’s storage round trip', () => {
  it('creates a card, autosaves it and publishes a second version', async () => {
    const characterId = await store().createCharacter('莉安');
    expect(characterId).toBeDefined();
    if (characterId === undefined) return;
    await store().openCharacter(characterId);
    expect(store().characterVersion?.version).toBe(1);
    expect(store().characterDraft?.data.name).toBe('莉安');

    const publishedBefore = JSON.stringify(await getCharacterVersion(characterId, 1));
    const draft = store().characterDraft;
    if (draft === undefined) return;
    const filled = populated(draft.data);
    const edited: CharacterData = {
      ...filled,
      tags: ['奇幻'],
      voice: { desire: 80, ability: 20, roles: ['守夜人'], maxLinesPerRound: 3, cooldown: 2 },
      visual: {
        ...filled.visual,
        appearance: { ...filled.visual.appearance, hair: '银白', marks: ['左臂旧伤'] },
        outfits: [{ id: 'outfit-default', name: '守夜斗篷', prompt: 'dark wool cloak' }],
        // The filler cannot tell which strings are enumerations, so the one closed vocabulary it
        // reaches (`seedPolicy`) is set to a legal member explicitly.
        params: { ...filled.visual.params, seedPolicy: 'increment' },
      },
      sampling: { temperature: 0.9, stop: ['\n\n'], reasoningEffort: 'high' },
      stExtensions: { talkativeness: 0.5 },
      customFields: { 阵营: '中立' },
    };
    // The PLUGIN bag travels with the draft; the author's own field is payload data.
    const extensions = { 'x-mythos.sanity': 9 };
    await expect(store().editCharacter(edited, extensions)).resolves.toBe(true);
    // The foreign bag, the plugin bag and the custom record all survive the row round trip.
    resetContentStore();
    await store().openCharacter(characterId);
    expect(store().characterDraft?.data).toEqual(edited);
    expect(store().characterDraft?.extensions).toEqual(extensions);

    await expect(store().publishCharacter()).resolves.toBe(true);
    const second = await getCharacterVersion(characterId, 2);
    expect(second?.data).toEqual(edited);
    expect(second?.lineage?.reason).toContain('角色');
    expect(JSON.stringify(await getCharacterVersion(characterId, 1))).toBe(publishedBefore);
    expect(store().character?.headVersion).toBe(2);
    expect(store().character?.tags).toEqual(['奇幻']);
    expect(await storedValue(characterDraftId(characterId))).toBeUndefined();
  });

  it('keeps a card’s optional groups absent when the user never set them', async () => {
    const characterId = await store().createCharacter('bare');
    if (characterId === undefined) return;
    await store().openCharacter(characterId);
    const draft = store().characterDraft;
    if (draft === undefined) return;
    const blank = blankCharacterData('bare');
    expect(draft.data).toEqual(blank);
    await store().editCharacter(blank, {});
    await expect(store().publishCharacter()).resolves.toBe(true);
    const stored = await getCharacterVersion(characterId, 2);
    // Absent, not empty: the card says nothing about sampling rather than overriding it with {}.
    expect(stored?.data).not.toHaveProperty('sampling');
    expect(stored?.data).not.toHaveProperty('stExtensions');
  });

  it('refuses to publish a card whose voice profile is out of range', async () => {
    const characterId = await store().createCharacter('莉安');
    if (characterId === undefined) return;
    await store().openCharacter(characterId);
    const draft = store().characterDraft;
    if (draft === undefined) return;
    await store().editCharacter({ ...draft.data, voice: { ...draft.data.voice, desire: 200 } }, {});
    await expect(store().publishCharacter()).resolves.toBe(false);
    expect(await getCharacterVersion(characterId, 2)).toBeUndefined();
  });
});
