/**
 * The turn path against an encrypted key (M1-G3): the refusal while locked, and the header it
 * becomes once unlocked.
 *
 * WHY THIS TEST EXISTS AT ALL
 * The locked state is the one new way a turn can fail, and the wrong behaviour is subtle: a
 * request sent without the `Authorization` header comes back from the provider as `auth`, so
 * the user is told their key is WRONG when it is merely locked and would go looking in the
 * wrong place. "Nothing was sent" is therefore the assertion that matters, and it is only
 * observable on the transport.
 *
 * WHY THE REAL STORE AND A REAL SESSION
 * `useChatStore.send` is the only caller that assembles the configuration a turn uses
 * (`{ baseUrl, apiKey, model }` out of the row plus the tab's session), and getting that
 * composition wrong — passing an empty key for a locked row, say — is exactly the bug this
 * file is here to catch. A hand-built config object would test nothing.
 *
 * WHAT M1-T1'S FOLLOW-UP ADDED HERE
 * The second describe is about the OPEN session's CALENDAR: the store resolves it from the
 * pinned world version (a real `worlds` + `worldVersions` pair, so the 100-minute hour below is
 * data this app can actually store) and falls back to the built-in face when that row is absent
 * or unreadable — the two positions a session must still open in.
 */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import type { Calendar } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankCharacterData } from '../cards/character';
import { blankWorldData } from '../cards/world';
import { BUILTIN_CALENDAR } from '../chat/builtin-content';
import { closeDatabase, resetDatabase } from '../db/database';
import { deleteDatabase, openRaw, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import {
  createCharacter,
  createSession,
  createWorld,
  getChain,
  getSession,
  listCheckpoints,
  writeProviderSettings,
} from '../db/repository';
import { TEST_SESSION_PINS } from '../db/session.test-helpers';
import type { SessionDraft } from '../session/roster';
import { configureChat, errorSentence, resetChat, useChatStore } from './chat-store';
import { useLocaleStore } from './locale-store';
import { resetSettingsStore, useSettingsStore } from './settings-store';

const API_KEY = 'sk-locked-key-must-not-leak';
const PASSPHRASE = 'a-good-passphrase';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'test-model-1';

/**
 * The choices the create flow would have collected (M1-S1). This file's subject is the key's
 * lifecycle, so the session only has to EXIST — but it is a real form value all the same, because
 * `state/chat-store.ts`'s `create` derives the cast and the pins from it and refuses a draft the
 * pure rule rejects.
 */
const TEST_DRAFT: SessionDraft = {
  world: { id: 'test-world', version: 1 },
  cards: [{ id: 'test-player', name: 'Player', version: 1 }],
  playerId: 'test-player',
  initialClock: 0,
};

let databases = 0;
let databaseName = '';

/** A transport that records the requests it was given and answers an empty stream. */
function recordingWire(): {
  fetch: FetchLike;
  calls: number;
  lastAuthorization: string | undefined;
} {
  const record = {
    calls: 0,
    lastAuthorization: undefined as string | undefined,
    // `_url` is unused on purpose: this transport answers the same empty stream whatever it was
    // asked for, and the underscore is the convention Biome's `noUnusedFunctionParameters` accepts.
    fetch: (_url: string, init: RequestInit): Promise<Response> => {
      record.calls += 1;
      record.lastAuthorization = new Headers(init.headers).get('authorization') ?? undefined;
      return Promise.resolve(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    },
  };
  return record;
}

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-chat-store-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  // `create()` stores a title, and the sentence comes from the active catalog.
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  resetChat();
  resetSettingsStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/** Store a plaintext key and seal it, the way the setup screen does. */
async function sealAKey(): Promise<void> {
  await writeProviderSettings({
    baseUrl: BASE_URL,
    model: MODEL,
    secret: { kind: 'plaintext', apiKey: API_KEY },
  });
  await useSettingsStore.getState().load();
  await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();
}

describe('a turn against an encrypted key', () => {
  it('is refused while locked, with its own sentence and with nothing sent', async () => {
    await sealAKey();
    useSettingsStore.getState().lock();
    const wire = recordingWire();
    configureChat({ transport: wire.fetch });

    const sessionId = await useChatStore.getState().create(TEST_DRAFT);
    if (sessionId === undefined) throw new Error('the session was not created');
    await useChatStore.getState().send('你好');

    const state = useChatStore.getState();
    // A code of its own, not `auth`: the key is present and correct, it is simply locked.
    expect(state.error?.code).toBe('key_locked');
    expect(state.status).toBe('error');
    // THE ASSERTION THAT MATTERS: no request left the device.
    expect(wire.calls).toBe(0);
    expect(wire.lastAuthorization).toBeUndefined();
    // And nothing was persisted either: the user's message belongs to a turn that never began.
    expect(await getChain(sessionId)).toEqual([]);
    expect(errorSentence({ code: state.error?.code ?? '' })).toContain('锁定');
  });

  it('sends once unlocked, and the key reaches the wire only as an Authorization header', async () => {
    await sealAKey();
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    const wire = recordingWire();
    configureChat({ transport: wire.fetch });

    const sessionId = await useChatStore.getState().create(TEST_DRAFT);
    if (sessionId === undefined) throw new Error('the session was not created');
    await useChatStore.getState().send('你好');

    expect(wire.calls).toBe(1);
    expect(wire.lastAuthorization).toBe(`Bearer ${API_KEY}`);
    expect(useChatStore.getState().error).toBeUndefined();
    // The turn is on disk; the KEY is not — the row holds the envelope (M1-G3's at-rest claim,
    // asserted here from the send path, which is where a stray copy would most plausibly appear).
    expect(await getChain(sessionId)).toHaveLength(1);
    const onDisk = await snapshotAllRows(databaseName);
    expect(onDisk).not.toContain(API_KEY);
    expect(onDisk).not.toContain(PASSPHRASE);
    expect(onDisk).toContain('你好');
  });
});

/* ────────────── M1-T1 follow-up: the pinned world's calendar, or the fallback ────────────── */

/**
 * A world face the built-in calendar cannot imitate: a 100-minute hour, a 26-hour day and its
 * own month names. Every assertion below is one the built-in read answers differently, which is
 * what makes these tests fail without the calendar parameter.
 */
const TWO_MOON: Calendar = {
  id: 'two-moon',
  name: 'Two-moon reckoning',
  minutesPerHour: 100,
  hoursPerDay: 26,
  months: [
    { name: 'Frostmoon', days: 20 },
    { name: 'Embermoon', days: 20 },
  ],
  epochLabel: 'Third Age',
  segments: [
    { id: 'first-watch', name: 'First Watch', fromHour: 0, toHour: 13 },
    { id: 'second-watch', name: 'Second Watch', fromHour: 13, toHour: 26 },
  ],
};

/**
 * Plant a `worldVersions` row nobody can parse, so the reader's `WorldVersionSchema.parse`
 * throws — the "its calendar is unreadable" half of the fallback.
 *
 * WHY THE RAW IndexedDB API AND NOT `db/repository.ts`: every writer in the app validates before
 * it stores (ADR-016), so no repository call can produce this row — a test that used one would
 * be asserting a position the app cannot reach. The row goes to a version the world does not
 * have, so the unique `(worldId, version)` index accepts it and a session pin can name it.
 */
async function plantUnreadableVersion(row: unknown): Promise<void> {
  const database = await openRaw(databaseName);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('worldVersions', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore('worldVersions').put(row);
    });
  } finally {
    database.close();
  }
}

/** A real world row + version 1 carrying `calendar`, and the head row that was written. */
async function createWorldWith(calendar: Calendar) {
  return createWorld({
    name: 'Two-moon world',
    data: { ...blankWorldData('Two-moon world'), calendar },
  });
}

describe("the open session's calendar (M1-T1 follow-up)", () => {
  it("reads its PINNED world version's calendar and advances in that world's units", async () => {
    const created = await createWorldWith(TWO_MOON);
    if (created === undefined) throw new Error('the world was not created');
    const session = await createSession({
      title: 'pinned-world',
      refs: {
        ...TEST_SESSION_PINS,
        world: { id: created.world.id, version: created.version.version },
      },
      initialClock: 0,
    });

    await useChatStore.getState().open(session.id);

    // The WORLD's face, not the built-in one: a 100-minute hour is a value the built-in
    // calendar does not have, so this cannot pass by accident.
    expect(useChatStore.getState().calendar.minutesPerHour).toBe(100);
    expect(useChatStore.getState().calendar.months[0]?.name).toBe('Frostmoon');

    // And the advance walks in those units — the arithmetic half of the same bug: one hour of
    // this world is 100 minutes, where the built-in face would have moved 60.
    await expect(useChatStore.getState().advance(TWO_MOON.minutesPerHour)).resolves.toBe(100);
    expect(useChatStore.getState().session?.state.clock).toBe(100);
    expect((await getSession(session.id))?.state.clock).toBe(100);
  });

  it('falls back to the built-in calendar, and still opens, when the world row is gone', async () => {
    // `TEST_DRAFT` pins `test-world`, an id no row carries: the deleted-world position, which is
    // also the fixture every other suite in this workspace creates its sessions with.
    const sessionId = await useChatStore.getState().create(TEST_DRAFT);
    if (sessionId === undefined) throw new Error('the session was not created');
    await useChatStore.getState().open(sessionId);

    const state = useChatStore.getState();
    // IT STILL OPENS: the session and its clock are there, on the built-in face — a deleted card
    // must not take the conversation down with it.
    expect(state.session?.id).toBe(sessionId);
    expect(state.calendar).toBe(BUILTIN_CALENDAR);
  });

  it('falls back to the built-in calendar when the version row cannot be parsed', async () => {
    const created = await createWorld({
      name: 'Broken world',
      data: blankWorldData('Broken world'),
    });
    if (created === undefined) throw new Error('the world was not created');
    // Version 999 is free on this world, and its `data.calendar` is not a calendar at all.
    await plantUnreadableVersion({
      id: 'unreadable-version',
      worldId: created.world.id,
      version: 999,
      data: { calendar: null },
    });
    const session = await createSession({
      title: 'broken-world',
      refs: { ...TEST_SESSION_PINS, world: { id: created.world.id, version: 999 } },
      initialClock: 0,
    });

    // The read THROWS here rather than answering `undefined`; both are the same fact to the
    // caller, and this is the assertion that pins the catch.
    await useChatStore.getState().open(session.id);

    const state = useChatStore.getState();
    expect(state.session?.id).toBe(session.id);
    expect(state.calendar).toBe(BUILTIN_CALENDAR);
  });
});

/* ───────────────────── M1-S4: the cast intervention ──────────────────────── */

/**
 * WHAT THIS SUITE PROVES, AND WHY IT IS AT THE STORE LEVEL RATHER THAN IN THE DOM
 * The intervention's two UNDO SIZES are the point: the panel's one step (the value
 * `interveneCast` replaced), and the durable one (`saveCheckpoint` / `restoreCheckpoint`, which
 * move the whole `SessionState` — the cast included, because it is a field of it). The DOM test
 * in `app/routes/routes.test.tsx` covers the controls and the proposal; here the subject is the
 * stored row, asserted on its BYTES, which is what makes "the cast went back to what it was" a
 * fact about storage rather than about a re-derived value.
 */
describe('the cast intervention (M1-S4)', () => {
  /** One published cast card, with the voice profile the scheduler reads. */
  async function castCard(name: string) {
    const blank = blankCharacterData(name);
    const created = await createCharacter({
      name,
      data: { ...blank, voice: { ...blank.voice, desire: 90, ability: 80 } },
    });
    if (created === undefined) throw new Error(`the card ${name} was not written`);
    return created.character.id;
  }

  /** The row's cast record as the DATABASE spells it, not through a reader. */
  async function storedCastBytes(sessionId: string): Promise<string> {
    return JSON.stringify((await getSession(sessionId))?.state.cast);
  }

  it("writes one member's standing, and the undo restores the bytes that were there", async () => {
    const mira = await castCard('Mira');
    const session = await createSession({
      title: 'intervention',
      refs: { ...TEST_SESSION_PINS, cast: [{ id: mira, version: 1 }] },
      initialClock: 0,
    });
    await useChatStore.getState().open(session.id);
    const before = await storedCastBytes(session.id);
    expect(before).toBe('{}');

    // MUTE: the pure transition runs in the store, and the row is the only copy that matters.
    const previous = await useChatStore.getState().interveneCast(mira, {
      present: true,
      muted: true,
    });
    // Narrowed, not asserted away: the rest of the test is about the value the undo needs, and a
    // `?.` on every use would turn a `undefined` (a refused write) into a passing comparison.
    if (previous === undefined) throw new Error('the intervention was refused');
    expect(previous).toEqual({ present: true, muted: false });
    expect(await storedCastBytes(session.id)).toBe(
      JSON.stringify({ [mira]: { present: true, muted: true } }),
    );
    // ...and the STORE, which is what the panel renders, carries the same value.
    expect(useChatStore.getState().session?.state.cast).toEqual({
      [mira]: { present: true, muted: true },
    });

    // A no-op is refused rather than written: the same mute again answers nothing, so the panel
    // cannot offer an undo for a change that did not happen.
    expect(await useChatStore.getState().interveneCast(mira, { present: true, muted: true })).toBe(
      undefined,
    );

    // UNDO: the value that call replaced, put back through the same transition. The stored bytes
    // are the ones that were there before the intervention - which is the assertion the task asks
    // for ("asserted on the stored row's bytes").
    expect(await useChatStore.getState().restoreCast(mira, previous)).toBe(true);
    expect(await storedCastBytes(session.id)).toBe(before);
    expect(useChatStore.getState().session?.state.cast).toEqual({});
    // An undo of the undo has nothing to restore, so it writes nothing and says so.
    expect(await useChatStore.getState().restoreCast(mira, previous)).toBe(false);
  });

  it('travels with the save point, and rolls back with it (M1-M1 / M1-T4)', async () => {
    const mira = await castCard('Mira');
    const session = await createSession({
      title: 'intervention-checkpoint',
      refs: { ...TEST_SESSION_PINS, cast: [{ id: mira, version: 1 }] },
      initialClock: 0,
    });
    await useChatStore.getState().open(session.id);

    // A save point taken while the cast is untouched: its OWN `castState` snapshot is the live
    // record, copied by the store (`session/cast.ts`'s `checkpointCastOf`).
    const checkpoint = await useChatStore.getState().saveCheckpoint('before');
    if (checkpoint === undefined) throw new Error('the save point was not written');
    expect(checkpoint.castState).toEqual({});

    // THE INTERVENTION, and the save point's own snapshot does NOT move with it: a checkpoint is
    // "then", and the live record is "now" (ADR-032's distinction, asserted rather than assumed).
    await useChatStore.getState().interveneCast(mira, { present: true, muted: true });
    expect(await storedCastBytes(session.id)).toBe(
      JSON.stringify({ [mira]: { present: true, muted: true } }),
    );
    const reloaded = (await listCheckpoints(session.id))[0];
    expect(reloaded?.castState).toEqual({});

    // A SECOND save point taken after the intervention carries it, which is what makes the pair
    // of snapshots a record of what changed between them.
    const after = await useChatStore.getState().saveCheckpoint('after');
    expect(after?.castState).toEqual({ [mira]: { present: true, muted: true } });

    // THE ROLLBACK moves the cast back with the clock, in one write: the field is part of the
    // state the checkpoint holds, so nothing extra restores it and it cannot lag the rest.
    expect(await useChatStore.getState().restoreCheckpoint(checkpoint.id)).toBe(true);
    expect(await storedCastBytes(session.id)).toBe('{}');
    expect(useChatStore.getState().session?.state.cast).toEqual({});
  });
});
