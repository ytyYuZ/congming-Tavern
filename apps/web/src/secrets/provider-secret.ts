/**
 * The provider key's LOCK SESSION (M1-G3, docs/06-开发任务拆解.md §2.1) — the owner of
 * the passphrase policy, the in-memory unlock, and the plaintext -> encrypted
 * migration.
 *
 * WHAT THIS MODULE IS FOR
 * `db/repository.ts` stores whatever secret it is handed; `secrets/secret-crypto.ts`
 * can encrypt and decrypt one. Neither decides WHEN a passphrase is asked for, what a
 * cancelled prompt does, or whether anything stays in memory afterwards. Those are
 * product decisions with security consequences, so they live in exactly one place and
 * are written down here rather than emerging from a component.
 *
 * ── THE PASSPHRASE POLICY (the decision this module exists to record) ─────────
 *
 * 1. WHEN IT IS ASKED FOR
 *    (a) UNLOCK — the stored row holds an encrypted envelope and a request needs the
 *        key. The setup screen shows the passphrase field with an 「解锁」 button; the
 *        play screen cannot ask (see "what is left" below), so a turn sent while
 *        locked fails with `key_locked` and a sentence that says where to go.
 *    (b) SEAL — the user asks to encrypt, in one of two shapes: "encrypt the key that
 *        is already stored" (the migration, below) and "store this new key under a
 *        passphrase" (part of a save).
 *    It is NEVER asked for by a background action, a mount effect, or a send. A
 *    passphrase prompt that appears on its own is a prompt users learn to dismiss.
 *
 * 2. IF THE USER CANCELS
 *    Nothing changes, in either direction.
 *    - Cancel an UNLOCK: the envelope stays encrypted in the row, and the session stays
 *      closed. The cost is one refused turn with a sentence naming the cause; the
 *      alternative — sending with no `Authorization` header because the key was
 *      momentarily unavailable — is the "silently broken key" this milestone forbids
 *      (it would surface as a 401 from the provider, i.e. as a WRONG explanation).
 *    - Cancel (or ignore) the offer to SEAL a plaintext row: the row stays plaintext and
 *      the screen keeps saying so. This is the documented FALLBACK, and its failure mode
 *      is stated rather than hidden: the key is protected by nothing but the device's
 *      own disk, which is exactly the M0 state. It is never "half encrypted" and never
 *      silently reverted.
 *
 * 3. A WRONG PASSPHRASE
 *    AES-GCM's tag check fails (`secret-crypto.ts` explains why that is a real check),
 *    the caller gets `wrong-passphrase`, the screen says so, and the user may retype it
 *    as often as they like. NOTHING IS WRITTEN: the row is not re-encrypted, not
 *    cleared, and not "repaired". There is no attempt counter and no lockout — a
 *    lockout on a local device is a denial of service against the owner of the data,
 *    and this design has no server to defend.
 *    There is deliberately NO "forgot passphrase" recovery, because there is nothing to
 *    recover FROM: the ciphertext is the only copy of the key. The honest recovery is
 *    to SAVE A NEW KEY (a new key under a new passphrase overwrites the row), and the
 *    UI says that where it asks. That is why a "remove encryption" action does not
 *    exist either — it would have to write the plaintext back.
 *
 * 4. WHAT IS CACHED IN MEMORY, AND FOR HOW LONG
 *    The PASSPHRASE is never retained: it is a function argument that is encoded and
 *    handed to `importKey`, and it is not copied into a variable that outlives the call,
 *    not into React state, not into the store, and not into any error message.
 *    What IS retained, between an unlock and `lockProviderSecret()`, is the derived
 *    AES key (non-extractable — `secret-crypto.ts` creates it that way) and the
 *    decrypted key string. That lifetime is deliberately "this tab, until locked or
 *    reloaded": a page reload starts locked, because a cache that survives a reload
 *    would have to be persisted, and a persisted key cache is the thing being avoided.
 *    Holding the key in memory is what M0 already did unconditionally; the difference is
 *    that it now requires an explicit passphrase entry first.
 *
 * ── THE MIGRATION (M0's plaintext row -> M1-G3's envelope) ───────────────────
 * M0 wrote `{ baseUrl, apiKey: '<plaintext>', model }`. `migrateStoredSecret` replaces
 * that row with `{ baseUrl, model, apiKey: <envelope> }` in ONE `put` (repository.ts
 * records why one write matters), so there is no intermediate state in which the key
 * exists twice, and no window in which it exists nowhere. It is driven by the user
 * (the same explicit SEAL action), not by a mount effect: encrypting without a
 * passphrase to encrypt WITH is impossible, and inventing one would lose the key.
 * A test proves both halves — the plaintext is gone from every row, and the key comes
 * back from the envelope.
 *
 * The honest limit of "the plaintext is gone": the ROW no longer contains it, and no
 * second copy is written. IndexedDB does not promise to overwrite the freed pages of
 * the value it replaced, so a forensic examination of the disk could still recover it —
 * which is a property of the storage engine, not something this app can fix by writing
 * zeroes it cannot address. Stated here because a claim of erasure that cannot be kept
 * is worse than the accurate one.
 *
 * WHY THE SESSION IS A MODULE VARIABLE AND NOT STORE STATE
 * It must outlive an individual store reset (a test's teardown, a route remount) or the
 * "unlock, navigate away, come back" path would silently re-lock, and it must NOT be in
 * a React state snapshot, which is exactly the place a credential must not be. The
 * values are plain data and a `CryptoKey`, and nothing here logs.
 *
 * WHAT IS LEFT FOR A LATER STEP (named rather than half-built)
 * There is no GLOBAL unlock prompt: the passphrase field lives on the setup screen, so a
 * user who never opens Settings sees `key_locked` on the play screen instead of a
 * dialog. The storage layer below is complete and tested; the remaining piece is one
 * modal reachable from the play view.
 */
import type { StoredProviderSecret } from '../db/repository';
import {
  type DerivedSecret,
  deriveSecret,
  type EncryptedSecret,
  openSecret,
  rederiveSecret,
  SecretFailure,
  type SecretFailureKind,
  sealSecret,
  secretFailureKind,
} from './secret-crypto';

/**
 * What an unlock attempt answers.
 *
 * A union rather than a thrown error: the caller is a form's submit handler, and the
 * `failure` kind is what picks the catalog sentence. `apiKey` on the success arm saves
 * the caller a second read of the session.
 */
export type UnlockOutcome =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly failure: SecretFailureKind };

/**
 * The open key of this tab: the plaintext key, plus the derived AES key when the key
 * came out of an envelope.
 *
 * `derived` is absent for a key adopted from a PLAINTEXT row — the tab can send with
 * it, but it has no way to re-encrypt a changed key without asking for a passphrase,
 * and pretending otherwise would be the silent-plaintext fallback this module refuses.
 */
interface OpenSession {
  readonly apiKey: string;
  readonly derived: DerivedSecret | undefined;
}

let session: OpenSession | undefined;

/* ─────────────────────────────── the session ─────────────────────────────── */

/**
 * The key a request can send with right now, or `undefined` while locked/absent.
 *
 * Synchronous on purpose: the send path reads it at the moment it builds a request and
 * must not await a passphrase prompt in the middle of a turn.
 */
export function unlockedKey(): string | undefined {
  return session?.apiKey;
}

/**
 * Adopt a key that needed no passphrase: a PLAINTEXT row's key, or no key at all.
 *
 * Called by the settings store on load and after every save, so the session mirrors
 * what the row holds, and by nothing else. It never derives anything.
 */
export function adoptUnprotectedKey(apiKey: string | undefined): void {
  session = apiKey === undefined ? undefined : { apiKey, derived: undefined };
}

/** Forget the key and the derived AES key. The row is untouched — this is a UI lock. */
export function lockProviderSecret(): void {
  session = undefined;
}

/**
 * Open an encrypted secret with `passphrase`, adopting it as this tab's session.
 *
 * The failure is returned rather than thrown so the caller (a form submit handler,
 * i.e. a fire-and-forget gesture) decides what to show; the two failure kinds it can
 * see are `wrong-passphrase` and `crypto-unavailable`.
 */
export async function unlockProviderSecret(
  secret: StoredProviderSecret,
  passphrase: string,
): Promise<UnlockOutcome> {
  if (secret.kind !== 'encrypted') {
    // A plaintext or absent secret has nothing to unlock. Reported as a failure rather
    // than adopted, so a caller that asks for a passphrase for a row that has none
    // cannot believe it succeeded.
    return { ok: false, failure: 'malformed-envelope' };
  }
  try {
    const derived = await rederiveSecret(secret.envelope, passphrase);
    const apiKey = await openSecret(derived, secret.envelope);
    session = { apiKey, derived };
    return { ok: true, apiKey };
  } catch (cause) {
    const failure = secretFailureKind(cause);
    // A crash that is not a `SecretFailure` is still a refusal to open: the session stays
    // closed and the caller shows the generic wrong-passphrase sentence, which is the
    // only action available to the user either way.
    return { ok: false, failure: failure ?? 'wrong-passphrase' };
  }
}

/* ──────────────────────────── sealing and migrating ──────────────────────── */

/**
 * Encrypt `apiKey` under `passphrase` and adopt the result as this tab's session.
 *
 * This is the SEAL half of the policy: the passphrase is used to derive a fresh key,
 * and the derived key is kept so that a later key change in the same tab re-encrypts
 * without asking again. A refusal (`passphrase-too-short`, `crypto-unavailable`)
 * throws, because the caller is the store and its answer is a typed failure kind.
 */
export async function sealNewSecret(apiKey: string, passphrase: string): Promise<EncryptedSecret> {
  const derived = await deriveSecret(passphrase);
  const envelope = await sealSecret(derived, apiKey);
  session = { apiKey, derived };
  return envelope;
}

/**
 * Re-encrypt a changed key with the passphrase already open in this tab.
 *
 * A fresh IV and the SAME salt (`secret-crypto.ts` records why): the cached key must
 * remain the key that opens the new envelope. Throws `locked` when there is no derived
 * key — a guard, never a fallback to plaintext.
 */
export async function resealWithSession(apiKey: string): Promise<EncryptedSecret> {
  const derived = session?.derived;
  if (derived === undefined) {
    throw new SecretFailure('locked', 'no unlocked passphrase in this tab to re-encrypt with');
  }
  const envelope = await sealSecret(derived, apiKey);
  session = { apiKey, derived };
  return envelope;
}

/**
 * The migration: replace a plaintext row's key with an envelope of it.
 *
 * The caller passes the secret it READ and gets back the one to WRITE; this function
 * neither reads the row nor writes it, so the whole migration is visible in one place
 * in the store — read, seal, single write — and a failure at any step leaves the row
 * exactly as it was (the plaintext is still there, so the key is not lost).
 */
export async function migrateStoredSecret(
  secret: StoredProviderSecret,
  passphrase: string,
): Promise<EncryptedSecret> {
  if (secret.kind !== 'plaintext') {
    throw new SecretFailure(
      'malformed-envelope',
      'only a plaintext secret can be migrated to an encrypted one',
    );
  }
  return sealNewSecret(secret.apiKey, passphrase);
}
