/**
 * Creating a session from real rows (M1-S1) — the storage half of the acceptance, against real
 * IndexedDB.
 *
 * WHAT THIS FILE HAS TO PROVE
 * 1. A session created from a world version, two cards and one designated player carries exactly
 *    the versioned pins that were chosen (`EntityPinSchema`, ADR-010), starts its LIVE clock at
 *    `initialClock` through `defaultSessionState` (ADR-032), and has an EMPTY chain — the state
 *    the opening panel is offered in (M1-S3).
 * 2. 「同一张卡可在不同会话担任不同身份」 — the acceptance sentence, in full: the same
 *    `characterId` is `refs.playerCharacter` in one session and an entry of `refs.cast` in
 *    another, BOTH rows are valid sessions, and the card's own stored payload and version are
 *    byte-identical afterwards. The card is not told about either role, because identity is the
 *    session's property (ADR-010 / docs/02 §D9).
 * 3. 「选世界版本」 is a real choice: a world with two versions pins the one the caller named, not
 *    the newest one — and `listWorldVersions` is where that choice comes from, newest first.
 * 4. The pins are a REQUIRED, versioned part of the row: a reference without a version is refused
 *    before anything is written, so no reader can be handed a session it cannot resolve.
 *
 * WHY THE DRAFTS GO THROUGH `session/roster.ts` AND NOT STRAIGHT TO `createSession`: that module
 * is the rule (which card is cast, which preset a session pins), and this file is what happens to
 * the rule's answer once it is stored. Writing the pins by hand here would leave the seam between
 * the two untested — and the seam is where a placeholder would come back.
 */
/** @vitest-environment node */
import 'fake-indexeddb/auto';
import type { EntityPin } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankCharacterData } from '../cards/character';
import { blankWorldData } from '../cards/world';
import { BUILTIN_PRESET_CHOICE, presetPinOf, sessionPinsOf } from '../session/roster';
import { closeDatabase, resetDatabase } from './database';
import { deleteDatabase } from './raw-indexeddb.test-helpers';
import {
  createCharacter,
  createSession,
  createWorld,
  getChain,
  getCharacter,
  getCharacterVersion,
  getSession,
  latestCharacterVersion,
  listWorldVersions,
  publishWorld,
} from './repository';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-session-create-${databases}`;
  resetDatabase(databaseName);
});

afterEach(async () => {
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** The pin of a session in these tests: the built-in preset, which is the only one there is. */
const PRESET: EntityPin = presetPinOf(BUILTIN_PRESET_CHOICE);

/** A card, created the way the editor creates one, as the `{id, version}` a session pins. */
async function cardNamed(name: string): Promise<EntityPin> {
  const created = await createCharacter({ name, data: blankCharacterData(name) });
  if (created === undefined) throw new Error('the card fixture was refused');
  return { id: created.character.id, version: created.version.version };
}

/** A world whose clock starts at `startMinute`, as the `{id, version}` a session pins. */
async function worldStartingAt(name: string, startMinute: number): Promise<EntityPin> {
  const data = { ...blankWorldData(name), startMinute };
  const created = await createWorld({ name, data });
  if (created === undefined) throw new Error('the world fixture was refused');
  return { id: created.world.id, version: created.version.version };
}

/** The draft the create screen would build from `cards` and a designated player. */
function draftOf(world: EntityPin, cards: readonly EntityPin[], player: EntityPin, clock: number) {
  return {
    world,
    cards: cards.map((pin) => ({ id: pin.id, name: pin.id, version: pin.version })),
    playerId: player.id,
    initialClock: clock,
  };
}

/* ──────────────────────────── the pins and the clock ─────────────────────── */

describe('creating a session from a world and a cast', () => {
  it('records the chosen versioned pins, starts the clock there, and has no chain yet', async () => {
    const world = await worldStartingAt('霜月群岛', 720);
    const lian = await cardNamed('莉安');
    const mira = await cardNamed('米拉');

    const pins = sessionPinsOf(draftOf(world, [lian, mira], lian, 720));
    expect(pins).toBeDefined();
    if (pins === undefined) return;

    const session = await createSession({ title: '第一场', refs: pins, initialClock: 720 });

    // Every reference is a VERSIONED pin, and the cast is the ticked cards minus the player.
    expect(session.refs.world).toEqual({ id: world.id, version: world.version });
    expect(session.refs.playerCharacter).toEqual({ id: lian.id, version: lian.version });
    expect(session.refs.cast).toEqual([{ id: mira.id, version: mira.version }]);
    expect(session.refs.promptPreset).toEqual(PRESET);
    // No rule pack exists, so the session binds none — absence, not an invented id.
    expect(Object.hasOwn(session.refs, 'rulePack')).toBe(false);

    // THE CLOCK IS THE ORIGIN (ADR-012/ADR-032): the session owns where it started, and its LIVE
    // state begins at the same minute, which is what the persistent clock reads.
    expect(session.initialClock).toBe(720);
    expect(session.state.clock).toBe(720);
    expect(session.state.scene.time).toBe(720);

    // AN EMPTY CHAIN IS THE STATE THE OPENING IS OFFERED IN (M1-S3): no head, no rows.
    expect(session.headMessageId).toBeNull();
    expect(await getChain(session.id)).toEqual([]);

    // ...and the same row comes back through the READ boundary, parsed by the entity schema.
    const reread = await getSession(session.id);
    expect(reread?.refs).toEqual(session.refs);
    expect(reread?.state.clock).toBe(720);
  });

  it('refuses an unpinned reference instead of storing a row no reader can resolve', async () => {
    await expect(
      createSession({
        title: '没有版本',
        refs: {
          world: { id: 'world-x', version: 0 },
          playerCharacter: { id: 'card-x', version: 1 },
          cast: [],
          promptPreset: PRESET,
        },
        initialClock: 0,
      }),
    ).rejects.toThrow();
  });
});

/* ────────────────────────── one card, two identities ────────────────────── */

describe('one card, two roles', () => {
  it('is the player in one session and an NPC in another, and the card is untouched', async () => {
    const world = await worldStartingAt('霜月群岛', 0);
    const lian = await cardNamed('莉安');
    const mira = await cardNamed('米拉');

    // What the card's OWN two rows are before either session exists.
    const cardBefore = JSON.stringify(await getCharacter(lian.id));
    const versionBefore = JSON.stringify(await getCharacterVersion(lian.id, lian.version));

    const asPlayer = sessionPinsOf(draftOf(world, [lian, mira], lian, 0));
    const asNpc = sessionPinsOf(draftOf(world, [lian, mira], mira, 0));
    expect(asPlayer).toBeDefined();
    expect(asNpc).toBeDefined();
    if (asPlayer === undefined || asNpc === undefined) return;

    const first = await createSession({ title: '莉安视角', refs: asPlayer, initialClock: 0 });
    const second = await createSession({ title: '米拉视角', refs: asNpc, initialClock: 0 });

    // The SAME characterId, two identities — and both rows are valid sessions.
    expect(first.refs.playerCharacter.id).toBe(lian.id);
    expect(first.refs.cast.map((pin) => pin.id)).toEqual([mira.id]);
    expect(second.refs.playerCharacter.id).toBe(mira.id);
    expect(second.refs.cast.map((pin) => pin.id)).toEqual([lian.id]);
    expect((await getSession(first.id))?.refs.playerCharacter.id).toBe(lian.id);
    expect((await getSession(second.id))?.refs.playerCharacter.id).toBe(mira.id);

    // NOTHING ON THE CARD MOVED: same head row, same payload, same version, and no second
    // version was minted by either session.
    expect(JSON.stringify(await getCharacter(lian.id))).toBe(cardBefore);
    expect(JSON.stringify(await getCharacterVersion(lian.id, lian.version))).toBe(versionBefore);
    expect((await getCharacter(lian.id))?.headVersion).toBe(lian.version);
    expect((await latestCharacterVersion(lian.id))?.version).toBe(lian.version);
    expect((await latestCharacterVersion(lian.id))?.data.name).toBe('莉安');
  });
});

/* ───────────────────────────── the version choice ───────────────────────── */

describe('choosing a world version', () => {
  it('lists every version newest first and pins the one that was chosen', async () => {
    const world = await worldStartingAt('霜月群岛', 60);
    const second = await publishWorld({
      worldId: world.id,
      data: { ...blankWorldData('霜月群岛'), startMinute: 120 },
      baseVersion: world.version,
      reason: 'test fixture',
    });
    expect(second?.version.version).toBe(2);

    // Newest first is what the create screen defaults to...
    const versions = await listWorldVersions(world.id);
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect(versions.map((row) => row.data.startMinute)).toEqual([120, 60]);

    // ...and the pin is the CHOSEN one, which may not be it.
    const lian = await cardNamed('莉安');
    const session = await createSession({
      title: '旧版本',
      refs: {
        world: { id: world.id, version: 1 },
        playerCharacter: { id: lian.id, version: lian.version },
        cast: [],
        promptPreset: PRESET,
      },
      initialClock: 60,
    });
    expect(session.refs.world.version).toBe(1);
    expect((await getSession(session.id))?.refs.world.version).toBe(1);

    // The other version is a different session's choice, not an upgrade of this one.
    const newest = await createSession({
      title: '新版本',
      refs: {
        world: { id: world.id, version: 2 },
        playerCharacter: { id: lian.id, version: lian.version },
        cast: [],
        promptPreset: PRESET,
      },
      initialClock: 120,
    });
    expect(newest.refs.world.version).toBe(2);
    expect(session.refs.world.version).toBe(1);
  });
});

/** The one thing the ids above must NOT be: empty. `EntityPinSchema` refuses that (ADR-010). */
describe('every pin names something', () => {
  it('has an id and a positive version on every reference of a created session', async () => {
    const world = await worldStartingAt('霜月群岛', 0);
    const lian = await cardNamed('莉安');
    const pins = sessionPinsOf(draftOf(world, [lian], lian, 0));
    if (pins === undefined) throw new Error('a valid draft must produce pins');
    const session = await createSession({ title: '单人', refs: pins, initialClock: 0 });
    const everyPin: readonly EntityPin[] = [
      session.refs.world,
      session.refs.playerCharacter,
      ...session.refs.cast,
      session.refs.promptPreset,
    ];
    for (const pin of everyPin) {
      expect(pin.id).not.toBe('');
      expect(pin.version).toBeGreaterThan(0);
    }
    expect(session.refs.cast).toEqual([]);
  });
});
