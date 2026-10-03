/**
 * "在这台设备上记住解锁" — the OPT-IN that lets a provider key survive a reload.
 *
 * WHAT THIS MODULE EXISTS TO DECIDE, AND WHY IT IS ITS OWN MODULE
 * `secrets/provider-secret.ts` keeps the unlocked key in memory "this tab, until locked or
 * reloaded". The acceptance test showed what that costs a person: unlocking is not something
 * they do once, it is something every reload asks for again, and the fix they would reach for
 * is a saved PASSWORD. This module is the other answer, and the whole of it is one sentence:
 *
 *     WHAT IS REMEMBERED IS THE DERIVED AES KEY, NEVER THE PASSPHRASE.
 *
 * The passphrase is a string argument that is encoded, imported and dropped
 * (`secret-crypto.ts`); nothing here ever receives it, so nothing here can store it. What is
 * persisted is the `CryptoKey` that PBKDF2 produced — created with `extractable: false`, which
 * is a platform-enforced property rather than a promise: `crypto.subtle.exportKey` on it fails
 * with `InvalidAccessException`, so NO SCRIPT can read its bytes, including this one and
 * including any future one. It can only be USED (`subtle.decrypt`), and using it produces the
 * API key the app already holds while unlocked. (Measured on this host: a non-extractable
 * AES-GCM key survives an IndexedDB round trip, comes back non-extractable, decrypts, and is
 * still refused by `exportKey` — `unlock-memory.test.ts` pins all four facts. Had the platform
 * refused to clone a `CryptoKey` into IndexedDB, the honest answer would have been to store
 * NOTHING and say the option is unavailable; storing raw key bytes or a wrapped passphrase would
 * be exactly the weaker thing this feature must not be.)
 *
 * WHY IT IS NOT A 19TH COLLECTION, AND WHY IT CANNOT REACH AN EXPORT
 * It is device-local state, not part of the portable model: no document describes it, no
 * package carries it, and it is deliberately NOT a table in the app's `StorageAdapter` — the
 * eighteen collections of `docs/02` §7 (ADR-022, ADR-034) are the app's data, and "an
 * unlocked key on THIS device" is not data about a world, a card or a session. It lives in its
 * own IndexedDB database, so:
 *   - `export-package.ts` cannot reach it; it opens a fixed list of collections through the
 *     `StorageAdapter` (`export-secrets.test.ts` proves the structural half), and a second
 *     database is not one of them;
 *   - the byte scan sees nothing, because the plaintext key and the passphrase exist in no
 *     database this module touches and in no exported file (`unlock-memory.test.ts` asserts
 *     both halves: the export bytes contain neither, and the stored record's own enumerable
 *     content is a `CryptoKey` plus two numbers and two strings).
 *
 * WHY ONE RECORD PER PROVIDER ROW (ADR-034)
 * Each provider row has its OWN envelope, so a remembered key that were global would be "a key
 * without a lock" — after a switch it would be tried against another row's ciphertext and fail,
 * or worse, appear to succeed for the wrong provider. The record is keyed by the row id, and
 * `deleteProviderSettings` (through `state/settings-store.ts`) forgets it when the row goes: the
 * key cannot outlive the row it opens.
 *
 * WHY THE DERIVATION PARAMETERS ARE STORED WITH IT
 * The key alone is not enough to be honest about which envelope it opens. `salt` and
 * `iterations` travel inside the envelope (`secret-crypto.ts`), so the record carries the same
 * two values and a recall must MATCH them before the key is tried; a mismatch is a different
 * envelope (a re-seal, an import, a replaced key) and the record is dropped rather than used.
 * GCM's tag is the second, decisive check: if the key somehow does not open the ciphertext,
 * `openSecret` reports it and the record is forgotten — never a partial unlock, never a
 * silent fallback to "no key".
 *
 * WHY THE DATABASE IS OPENED LAZILY AND EVERY FAILURE IS A REFUSAL
 * A browser may have no IndexedDB (a private window, a locked-down embedder) and a secure
 * context is required for the crypto anyway. Neither is an error the user can act on, so both
 * are simply "this option did not work": `remember` answers `false`, `recall` answers
 * `undefined`, and the caller falls back to asking for the passphrase, which is the path that
 * already works. Nothing here throws, and nothing here logs (a log line is where a credential
 * ends up; HANDOFF §4.1 invariant 6).
 *
 * NOTHING IN THIS FILE TOUCHES THE PROVIDER ROW. It does not read it, write it, or know what a
 * `StoredProviderSecret` is; the caller passes the envelope's own parameters. That is what makes
 * "revoking leaves the ciphertext byte-identical" a property of the code rather than a claim
 * about it: there is no write path here to the row at all.
 */
import type { DerivedSecret, EncryptedSecret } from './secret-crypto';

/**
 * The IndexedDB database name, deliberately NOT the app's (`DATABASE_NAME` = `smarttavern`).
 *
 * A separate database is the mechanism, not a detail. It makes the structural claim — "the
 * export path cannot reach this" — true by construction rather than by a filter somebody could
 * forget, and it means a bug in this module cannot damage the library.
 */
export const UNLOCK_MEMORY_DATABASE = 'smarttavern-device';

/** The object store holding one record per provider row. */
export const UNLOCK_MEMORY_STORE = 'unlock-memory';

/** The record format. A future change of shape bumps this and IGNORES older records. */
export const UNLOCK_MEMORY_VERSION = 1;

/**
 * One remembered unlock.
 *
 * `key` is the only field that matters. `salt` / `iterations` are the envelope's own derivation
 * parameters, kept so a recall can tell "this is the envelope I was derived for" from "this is
 * another envelope" before it tries the key; `v` is the record's own format marker.
 */
interface UnlockMemoryRecord {
  readonly v: typeof UNLOCK_MEMORY_VERSION;
  readonly key: CryptoKey;
  readonly salt: string;
  readonly iterations: number;
}

/** The stored record of one provider row, or `undefined` when there is not a usable one. */
function asRecord(value: unknown): UnlockMemoryRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  // Parameterised keys: `noPropertyAccessFromIndexSignature` and Biome's `useLiteralKeys`
  // accept this spelling and nothing else (the same rule `secret-crypto.ts` follows).
  if (field(record, 'v') !== UNLOCK_MEMORY_VERSION) return undefined;
  const key = field(record, 'key');
  const salt = field(record, 'salt');
  const iterations = field(record, 'iterations');
  if (typeof salt !== 'string' || typeof iterations !== 'number') return undefined;
  if (typeof key !== 'object' || key === null) return undefined;
  // A record whose key is not a `CryptoKey` (an older format, a hand-edited database) is
  // dropped rather than passed to `subtle.decrypt`, which would reject it with a `TypeError`
  // the caller would have to translate.
  if (!isCryptoKey(key)) return undefined;
  return { v: UNLOCK_MEMORY_VERSION, key, salt, iterations };
}

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/**
 * True when `value` is a `CryptoKey` this module can use.
 *
 * Structural rather than `instanceof`, for the reason `secretFailureKind` records: a Vitest
 * environment is not guaranteed to expose one `CryptoKey` constructor, and `instanceof` across
 * two copies is silently `false`. The check is the two properties every `CryptoKey` has.
 */
function isCryptoKey(value: object): value is CryptoKey {
  const candidate = value as { algorithm?: unknown; usages?: unknown };
  return candidate.algorithm !== undefined && Array.isArray(candidate.usages);
}

/** The platform's IndexedDB, or `undefined` where there is none. */
function indexedDb(): IDBFactory | undefined {
  const platform: { readonly indexedDB?: IDBFactory } | undefined = globalThis;
  return platform?.indexedDB;
}

/** Open the store, creating it on first use. `undefined` when IndexedDB is unusable. */
async function openStore(
  mode: IDBTransactionMode,
): Promise<{ readonly store: IDBObjectStore; readonly done: Promise<void> } | undefined> {
  const factory = indexedDb();
  if (factory === undefined) return undefined;
  try {
    const request = factory.open(UNLOCK_MEMORY_DATABASE, 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const handle = request.result;
        if (!handle.objectStoreNames.contains(UNLOCK_MEMORY_STORE)) {
          handle.createObjectStore(UNLOCK_MEMORY_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
      request.onblocked = () => reject(new Error('indexeddb open blocked'));
    });
    const tx = db.transaction(UNLOCK_MEMORY_STORE, mode);
    // One transaction per operation, and the connection is closed when it settles: this is a
    // rarely-used side door, and holding a connection open would make a future schema upgrade
    // of this store block for no reason.
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('indexeddb transaction failed'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('indexeddb transaction aborted'));
      };
    });
    return { store: tx.objectStore(UNLOCK_MEMORY_STORE), done };
  } catch {
    // A private window, a forbidden origin, a corrupted database: all of them mean "this
    // option is unavailable", which the caller states by falling back to the passphrase.
    return undefined;
  }
}

/** This module's own `DOMException`-free status check: an aborted request is a miss. */
async function settled<T>(request: IDBRequest<T>): Promise<T | undefined> {
  try {
    return await new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'));
    });
  } catch {
    return undefined;
  }
}

/**
 * Persist `derived` as this device's unlock for `providerId`.
 *
 * Answers `true` only when the record really landed. The `CryptoKey` is handed to IndexedDB as
 * itself — no serialisation step exists that could turn it into bytes a script could read —
 * and the passphrase is not a parameter of this function, so there is nothing weaker it could
 * accidentally store.
 */
export async function rememberUnlock(
  providerId: string,
  envelope: EncryptedSecret,
  derived: DerivedSecret,
): Promise<boolean> {
  const opened = await openStore('readwrite');
  if (opened === undefined) return false;
  const record: UnlockMemoryRecord = {
    v: UNLOCK_MEMORY_VERSION,
    key: derived.key,
    salt: envelope.salt,
    iterations: envelope.iterations,
  };
  try {
    opened.store.put(record, providerId);
    await opened.done;
    return true;
  } catch {
    return false;
  }
}

/** Forget `providerId`'s remembered unlock. `true` when a record was removed. */
export async function forgetUnlock(providerId: string): Promise<boolean> {
  const opened = await openStore('readwrite');
  if (opened === undefined) return false;
  try {
    // The read is inside the same transaction as the delete so that "was there one" and
    // "remove it" cannot disagree; a separate read would be a race in a second tab.
    const existing = await settled(opened.store.get(providerId));
    if (existing === undefined) {
      await opened.done;
      return false;
    }
    opened.store.delete(providerId);
    await opened.done;
    return true;
  } catch {
    return false;
  }
}

/**
 * The remembered unlock for `providerId`, DERIVED FOR `envelope` — or `undefined`.
 *
 * A record whose salt or round count does not match the envelope is a record for a DIFFERENT
 * envelope and is reported as absent, which is what makes replacing a key (or importing a
 * package over a row) ask for the passphrase again instead of failing with a "wrong
 * passphrase" sentence the user cannot explain. THIS FUNCTION DELETES NOTHING: the caller
 * (`secrets/provider-secret.ts`) is the only place that knows the ciphertext was actually
 * tried, and it is where a stale record is forgotten.
 */
export async function recallUnlock(
  providerId: string,
  envelope: EncryptedSecret,
): Promise<DerivedSecret | undefined> {
  const opened = await openStore('readonly');
  if (opened === undefined) return undefined;
  const raw = await settled(opened.store.get(providerId));
  await opened.done;
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  if (record.salt !== envelope.salt || record.iterations !== envelope.iterations) return undefined;
  return { key: record.key, salt: base64Bytes(envelope.salt), iterations: record.iterations };
}

/** True when a record exists for `providerId` — what the UI renders "remembered" from. */
export async function hasRememberedUnlock(providerId: string): Promise<boolean> {
  const opened = await openStore('readonly');
  if (opened === undefined) return false;
  const raw = await settled(opened.store.get(providerId));
  await opened.done;
  return asRecord(raw) !== undefined;
}

/** Every provider id with a remembered unlock, for the `/setup` list's status column. */
export async function rememberedProviderIds(): Promise<readonly string[]> {
  const opened = await openStore('readonly');
  if (opened === undefined) return [];
  const raw = await settled(opened.store.getAllKeys());
  await opened.done;
  return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * Delete the whole device-local database — the TEST seam, and nothing else.
 *
 * Why a test needs it: this database outlives a store reset on purpose (that is the feature), so a
 * test that remembered an unlock would leak a `CryptoKey` into the next one. Production has no
 * caller: forgetting one row is `revokeRememberedUnlock`, and deleting the database in a browser
 * would be an "erase everything" act this feature does not offer.
 */
export async function deleteUnlockMemory(): Promise<void> {
  const factory = indexedDb();
  if (factory === undefined) return;
  try {
    const request = factory.deleteDatabase(UNLOCK_MEMORY_DATABASE);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('indexeddb delete failed'));
      request.onblocked = () => reject(new Error('indexeddb delete blocked'));
    });
  } catch {
    // Already absent, or a browser that refuses: nothing to clean up either way.
  }
}

/**
 * The decoded bytes of the envelope's base64 salt.
 *
 * `DerivedSecret.salt` is bytes and the record keeps the base64 the envelope carries, so a
 * recall rebuilds the bytes here. A salt that is not base64 cannot belong to an envelope
 * `isEncryptedSecret` accepted, and the recall simply answers "no remembered unlock": this
 * module never constructs a `SecretFailure` of its own, because it has no sentence to attach
 * to one.
 */
function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = globalThis.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}
