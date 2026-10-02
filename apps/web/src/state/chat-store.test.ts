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
 */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import { getChain, writeProviderSettings } from '../db/repository';
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
