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
 *        key. It is asked for from EVERY surface that can be refused, not only from
 *        the setup screen: `secrets/unlock-dialog.tsx` is one dialog, reachable from
 *        the play screen's banner and from the co-creation panel's finding, and the
 *        first manual acceptance test is why — a user who never opens Settings could
 *        not use their own key at all, and "go to Settings" is not an answer to a
 *        refusal that happened on the screen they were reading. The setup screen keeps
 *        its own field for the same act.
 *    (b) SEAL — the user asks to encrypt, in one of two shapes: "encrypt the key that
 *        is already stored" (the migration, below) and "store this new key under a
 *        passphrase" (part of a save).
 *    It is NEVER asked for by a background action, a mount effect, or a send. A
 *    passphrase prompt that appears on its own is a prompt users learn to dismiss.
 *    The one thing that happens WITHOUT a prompt is a REMEMBERED unlock — the opt-in
 *    behind 「在这台设备上记住解锁」 — and it is not an exception to this rule: the
 *    user asked for exactly that, in advance, per provider row
 *    (`secrets/unlock-memory.ts` records what is stored, and why it is not the
 *    passphrase).
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
 *    decrypted key string. That lifetime is "this tab, until locked or reloaded" by
 *    DEFAULT: a page reload starts locked, and `unlock-memory.ts` is the OPT-IN that
 *    changes it for one provider row at a time — by persisting the DERIVED KEY (a
 *    non-extractable `CryptoKey`, which no script can read the bytes of) and never the
 *    passphrase. With the opt-in off, nothing is written and a reload locks again,
 *    which is what the tests pin as the default.
 *    Holding the key in memory is what M0 already did unconditionally; the difference is
 *    that it now requires an explicit passphrase entry first.
 *
 * ── WHICH ROW A SESSION BELONGS TO (ADR-034) ────────────────────────────────
 * Each provider row has its own envelope, so the open key is kept PER ROW ID rather than
 * once for the tab. Unlocking row A must not make row B's key readable, and "locked" is a
 * question about a row: `unlockedKeyFor(id)` answers it there and nowhere else. The
 * settings store passes the row it is editing, which is why switching providers in
 * `/setup` shows the newly selected row's lock state instead of the previous one's.
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
import { forgetUnlock, hasRememberedUnlock, recallUnlock, rememberUnlock } from './unlock-memory';

/**
 * The open key of this tab, for ONE provider row: the plaintext key, plus the derived AES
 * key when the key came out of an envelope.
 *
 * `derived` is absent for a key adopted from a PLAINTEXT row — the tab can send with
 * it, but it has no way to re-encrypt a changed key without asking for a passphrase,
 * and pretending otherwise would be the silent-plaintext fallback this module refuses.
 */
interface OpenSession {
  readonly apiKey: string;
  readonly derived: DerivedSecret | undefined;
}

/**
 * The open key of each provider row, keyed by the row id (ADR-034).
 *
 * A `Map` and not a single slot: every row has its own envelope, so "is this row locked" is a
 * question about that row. The map is a module variable for the reasons in the header, and it
 * holds no passphrase — only an api key and, when there is one, a non-extractable `CryptoKey`.
 */
const sessions = new Map<string, OpenSession>();

/* ─────────────────────────────── the session ─────────────────────────────── */

/**
 * The key a request can send with right now, or `undefined` while locked/absent.
 *
 * Synchronous on purpose: the send path reads it at the moment it builds a request and
 * must not await a passphrase prompt in the middle of a turn.
 */
export function unlockedKey(): string | undefined {
  return sessionFor(undefined)?.apiKey;
}

/** The same question about ONE provider row (ADR-034): what `/setup` shows per list entry. */
export function unlockedKeyFor(providerId: string): string | undefined {
  return sessionFor(providerId)?.apiKey;
}

/**
 * True when `providerId`'s row can be re-encrypted without asking for a passphrase again —
 * i.e. a derived key is open for it (`state/settings-store.ts` uses this to decide whether a
 * key change can re-seal, which is why it is not simply "the key is readable").
 */
export function hasDerivedSecretFor(providerId: string): boolean {
  return sessionFor(providerId)?.derived !== undefined;
}

/** The session of one row; `undefined` selects the MOST RECENTLY adopted one. */
function sessionFor(providerId: string | undefined): OpenSession | undefined {
  if (providerId !== undefined) return sessions.get(providerId);
  return lastAdopted === undefined ? undefined : sessions.get(lastAdopted);
}

/**
 * Which row `unlockedKey()` speaks for: the last one adopted or unlocked.
 *
 * WHY THERE IS A "LAST ONE" AT ALL: the app has exactly one provider it is editing and sending
 * with (`state/settings-store.ts`'s active row), and `unlockedKey()` is the pre-ADR-034
 * spelling of that question — kept because the send path, the co-creation panel and the tests
 * all read it. Making it answer about the ACTIVE row is what keeps those readers correct
 * without every one of them learning the row list.
 */
let lastAdopted: string | undefined;

/**
 * Adopt a key that needed no passphrase: a PLAINTEXT row's key, or no key at all.
 *
 * Called by the settings store on load and after every save, so the session mirrors
 * what the row holds, and by nothing else. It never derives anything.
 */
export function adoptUnprotectedKey(apiKey: string | undefined, providerId = DEFAULT_ROW): void {
  lastAdopted = providerId;
  if (apiKey === undefined) sessions.delete(providerId);
  else sessions.set(providerId, { apiKey, derived: undefined });
}

/** Forget the key and the derived AES key. The row is untouched — this is a UI lock. */
export function lockProviderSecret(providerId = DEFAULT_ROW): void {
  sessions.delete(providerId);
  if (lastAdopted === providerId) lastAdopted = undefined;
}

/**
 * The row id `unlockedKey()` and friends speak for when a caller does not name one.
 *
 * It is the ADOPTED legacy row's id (`db/repository.ts`), which is the row an M0/M1 database
 * holds and the row a single-provider caller means. Named here rather than imported from the
 * repository: this module must stay a leaf that `db/repository.ts` can import transitively
 * through nothing (it is the repository's consumer), and the string is a constant, not a rule.
 */
export const DEFAULT_ROW = 'provider';

/** What an unlock attempt answers. */
export type UnlockOutcome =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly failure: SecretFailureKind };

/**
 * What an unlock attempt may additionally do. Absent means "this tab only", which is the
 * DEFAULT (HANDOFF §4.1 invariant 6): nothing is written unless the user ticked the box.
 */
export interface UnlockOptions {
  /** The provider row the envelope belongs to, and the id the session is keyed by. */
  readonly providerId?: string;
  /**
   * Persist the DERIVED, non-extractable `CryptoKey` for this row, so a reload does not ask
   * again (`secrets/unlock-memory.ts`). The passphrase is not a parameter of the stored record
   * and could not be: it is dropped by `rederiveSecret` before this option is consulted.
   *
   * A failure to persist is NOT a failed unlock: the key is open in this tab either way, and
   * the caller reports the remembered state by asking (`rememberedUnlockFor`) rather than by
   * reading a flag from here.
   */
  readonly remember?: boolean;
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
  options: UnlockOptions = {},
): Promise<UnlockOutcome> {
  if (secret.kind !== 'encrypted') {
    // A plaintext or absent secret has nothing to unlock. Reported as a failure rather
    // than adopted, so a caller that asks for a passphrase for a row that has none
    // cannot believe it succeeded.
    return { ok: false, failure: 'malformed-envelope' };
  }
  const providerId = options.providerId ?? DEFAULT_ROW;
  try {
    const derived = await rederiveSecret(secret.envelope, passphrase);
    const apiKey = await openSecret(derived, secret.envelope);
    sessions.set(providerId, { apiKey, derived });
    lastAdopted = providerId;
    if (options.remember === true) await rememberUnlock(providerId, secret.envelope, derived);
    return { ok: true, apiKey };
  } catch (cause) {
    const failure = secretFailureKind(cause);
    // A crash that is not a `SecretFailure` is still a refusal to open: the session stays
    // closed and the caller shows the generic wrong-passphrase sentence, which is the
    // only action available to the user either way.
    return { ok: false, failure: failure ?? 'wrong-passphrase' };
  }
}

/**
 * Adopt a REMEMBERED unlock for one row — the opt-in path, and the only one that opens an
 * envelope without a passphrase.
 *
 * Answers `true` when the row's key is now readable in this tab. Every other outcome is
 * `false` and leaves the session closed: no record, a record for another envelope, a key that
 * does not decrypt it (all of which `unlock-memory.ts` explains and forgets), or no
 * IndexedDB. `false` is not a failure to report — the caller simply starts locked, which is
 * what a user without the opt-in sees too.
 */
export async function adoptRememberedSecret(
  providerId: string,
  secret: StoredProviderSecret,
): Promise<boolean> {
  if (secret.kind !== 'encrypted') return false;
  const derived = await recallUnlock(providerId, secret.envelope);
  if (derived === undefined) {
    // Either there is no record, or the one there is belongs to a DIFFERENT envelope (a
    // replaced key). The second case is why this drops the record instead of leaving it: the
    // user is about to be asked for the passphrase, and a stale record can only cost the same
    // prompt again on every load.
    await forgetUnlock(providerId);
    return false;
  }
  try {
    const apiKey = await openSecret(derived, secret.envelope);
    sessions.set(providerId, { apiKey, derived });
    lastAdopted = providerId;
    return true;
  } catch {
    // The remembered key is not this envelope's key. The row is untouched and the user is
    // asked for the passphrase, which is the honest next step.
    await forgetUnlock(providerId);
    return false;
  }
}

/** True when this device holds a remembered unlock for `providerId`. */
export function rememberedUnlockFor(providerId: string): Promise<boolean> {
  return hasRememberedUnlock(providerId);
}

/**
 * Forget EVERY row's in-memory session — the test seam, and nothing else.
 *
 * It exists because the sessions live outside the store: a reset that only cleared the store
 * would leak one test's unlock into the next. It deliberately does not touch a REMEMBERED
 * record: that is device state the user opted into, and a test that writes one has to revoke
 * it explicitly (`revokeRememberedUnlock`), which keeps "the opt-in is not silently lost"
 * true for the tests as well as for the app.
 */
export function forgetAllSessions(): void {
  sessions.clear();
  lastAdopted = undefined;
}

/**
 * Revoke the remembered unlock of `providerId`.
 *
 * THE ROW IS NOT TOUCHED: this deletes the device-local record and nothing else, so the stored
 * ciphertext is byte-identical afterwards and the passphrase still opens it. The session in
 * memory is deliberately KEPT — revoking a convenience must not lock a tab that is already
 * unlocked; the user's 「锁定」 button is the act for that.
 */
export function revokeRememberedUnlock(providerId: string): Promise<boolean> {
  return forgetUnlock(providerId);
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
export async function sealNewSecret(
  apiKey: string,
  passphrase: string,
  providerId = DEFAULT_ROW,
): Promise<EncryptedSecret> {
  const derived = await deriveSecret(passphrase);
  const envelope = await sealSecret(derived, apiKey);
  sessions.set(providerId, { apiKey, derived });
  lastAdopted = providerId;
  return envelope;
}

/**
 * Re-encrypt a changed key with the passphrase already open in this tab.
 *
 * A fresh IV and the SAME salt (`secret-crypto.ts` records why): the cached key must
 * remain the key that opens the new envelope. Throws `locked` when there is no derived
 * key — a guard, never a fallback to plaintext.
 *
 * A RE-SEAL DOES NOT UPDATE A REMEMBERED UNLOCK, and that is deliberate: the new envelope
 * carries the same salt and round count (so a remember-check cannot tell them apart) but a
 * fresh IV, and the remembered `CryptoKey` is exactly the key this re-seal used — so the
 * remembered record still opens the new ciphertext. Writing it again would be a second write
 * for no change, and DELETING it would revoke a convenience the user asked for because they
 * edited an unrelated field.
 */
export async function resealWithSession(
  apiKey: string,
  providerId = DEFAULT_ROW,
): Promise<EncryptedSecret> {
  const derived = sessionFor(providerId)?.derived;
  if (derived === undefined) {
    throw new SecretFailure('locked', 'no unlocked passphrase in this tab to re-encrypt with');
  }
  const envelope = await sealSecret(derived, apiKey);
  sessions.set(providerId, { apiKey, derived });
  lastAdopted = providerId;
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
  providerId = DEFAULT_ROW,
): Promise<EncryptedSecret> {
  if (secret.kind !== 'plaintext') {
    throw new SecretFailure(
      'malformed-envelope',
      'only a plaintext secret can be migrated to an encrypted one',
    );
  }
  return sealNewSecret(secret.apiKey, passphrase, providerId);
}
