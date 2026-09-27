/**
 * The WebCrypto primitives behind "the key is encrypted at rest" (M1-G3,
 * docs/06-开发任务拆解.md §2.1) — a LEAF module with no import from the app.
 *
 * WHY PBKDF2 DERIVES AN AES-GCM KEY, AND WHY IT IS DONE HERE
 * `docs/02` §10 fixes the mechanism: the Web build stores the API key in IndexedDB
 * encrypted with a key derived from a user passphrase, because the browser has no
 * OS keyring to put it in (ADR-003, desktop is a separate story). Nothing in this
 * workspace may add a dependency, so the derivation is WebCrypto's own PBKDF2, and
 * this module is the only place that mentions a crypto parameter.
 *
 * WHY AES-GCM AND NOT AES-CBC
 * GCM is AUTHENTICATED: a wrong passphrase, or a tampered row, fails to decrypt
 * instead of returning plausible garbage. That property is what lets the passphrase
 * policy say "a wrong passphrase leaves the stored ciphertext untouched and can be
 * retried" (`secrets/provider-secret.ts` records the policy) — with a
 * non-authenticated mode the app could not tell a mistyped passphrase from a
 * corrupted row, and would have to write something back to find out.
 *
 * WHY THE ENVELOPE IS SELF-DESCRIBING
 * `salt` and `iterations` travel INSIDE the stored value rather than in a second row.
 * A password-derived key must be derived from the same salt and cost that encrypted
 * it, so `{salt, iterations}` is not metadata about the ciphertext, it IS part of
 * the ciphertext's definition. Self-describing also makes the version bump
 * mechanical: raising `PBKDF2_ITERATIONS` later changes what NEW envelopes use and
 * leaves old ones readable, so no migration is needed for the cost parameter.
 *
 * WHAT IS DELIBERATELY ABSENT
 * - No key export/import. Both the PBKDF2 derived key and the AES key are created
 *   with `extractable: false`, so no code path — including a future one — can read
 *   the raw key material out of the `CryptoKey` and persist it somewhere else.
 * - No passphrase retention. The passphrase is a string argument that is NFC-normalised
 *   and encoded inside `deriveKey` — the one place it becomes bytes, so no input path can
 *   derive a different key from the same visible passphrase — handed to `importKey`, and
 *   dropped. It is never stored, never put in an error message, and never returned.
 * - No "fast mode" for production. `iterations` is an argument only so a unit test
 *   can exercise the failure paths cheaply; the default is pinned by a test, one
 *   full-cost round trip runs with it, and `decryptSecret` always honours the count
 *   the envelope itself carries.
 *
 * THE ENVIRONMENT'S OWN REQUIREMENT (measured, not assumed)
 * `crypto.subtle` exists only in a SECURE CONTEXT: on a plain `http://` origin a
 * browser exposes `crypto.getRandomValues` but leaves `subtle` undefined. That is a
 * real deployment state for this app (a self-hosted LAN address), so it is a typed
 * failure (`crypto-unavailable`) rather than a crash: the caller can then state the
 * fallback in the UI instead of leaving the user with a key that silently never
 * encrypts. Vitest's jsdom environment keeps Node's `SubtleCrypto`, which is why the
 * tests here can drive the real primitives; that is a property of the runner, not a
 * shim this module installs.
 *
 * NOTHING HERE LOGS, AND NO FAILURE MESSAGE CARRIES ITS INPUT
 * Every `SecretFailure` message is a fixed English developer sentence. A key or a
 * passphrase must not reach a log (HANDOFF §4.1 invariant 6), and an error message is
 * the classic way one does.
 */
import type { JsonValue } from '@smarttavern/schema';

/* ─────────────────────────────── the envelope ─────────────────────────────── */

/**
 * One encrypted secret, as it is stored inside the provider row.
 *
 * Every field is a string or a number, so the value is JSON-serialisable and can
 * live in `settings.value` (`JsonValue`) without a second table.
 */
export interface EncryptedSecret {
  /** Envelope version. A format change re-encrypts on the next successful unlock. */
  readonly v: 1;
  /** The derivation function, named so a future second one is distinguishable. */
  readonly kdf: 'PBKDF2-SHA256';
  /** PBKDF2 round count this ciphertext was derived with. */
  readonly iterations: number;
  /** Base64, `SALT_BYTES` long. */
  readonly salt: string;
  /** Base64, `IV_BYTES` long. Never reused with the same key. */
  readonly iv: string;
  /** Base64 of the AES-GCM output, authentication tag included. */
  readonly ciphertext: string;
}

/** The only envelope version this module writes, and the only one it reads. */
export const ENVELOPE_VERSION = 1;

/** The derivation named in `EncryptedSecret.kdf`; `PBKDF2` with SHA-256. */
export const KDF_NAME = 'PBKDF2-SHA256';

/**
 * PBKDF2 rounds for a NEW envelope.
 *
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 600,000; this is deliberately lower
 * and the reason is a hard constraint rather than taste: the derivation runs on the
 * main thread of a phone browser when the user unlocks, and 600k rounds is a
 * multi-second freeze there. 210,000 is the current 1Password/LastPass-era figure —
 * expensive enough that an offline attack on a leaked IndexedDB row is not a
 * weekend project, cheap enough to stay interactive. The value is pinned by a test
 * and travels inside every envelope, so raising it later is a one-line change that
 * only affects new writes.
 */
export const PBKDF2_ITERATIONS = 210_000;

/** Refuse to run a derivation below this cost: a tampered row must not be cheap. */
export const MIN_ITERATIONS = 1_000;

/**
 * Refuse to run a derivation above this cost.
 *
 * The count comes from the STORED row, which is untrusted input. Without an upper
 * bound, a row edited to `iterations: 10**9` would hang the tab on every unlock —
 * a denial of service on the user's own data, delivered through the one field the
 * app is supposed to trust least.
 */
export const MAX_ITERATIONS = 10_000_000;

/** Salt length in bytes. 128 bits: unique per envelope, never reused. */
export const SALT_BYTES = 16;

/** GCM nonce length in bytes. 96 bits, the size GCM is specified for. */
export const IV_BYTES = 12;

/** AES-GCM's key length. `docs/02` §10 says "WebCrypto", this is the 256-bit reading. */
export const KEY_BITS = 256;

/** `KEY_BITS / 8`: the length PBKDF2 must produce, asserted by a test. */
export const KEY_BYTES = KEY_BITS / 8;

/**
 * The shortest passphrase this module will SET.
 *
 * Enforced when a passphrase is chosen and NOT when one is used, which is the only
 * defensible direction: if the policy tightened later, applying it to decryption
 * would strand an existing key behind a passphrase the app now refuses to accept.
 * A minimum of 8 is a speed bump against "1234", not a claim of strength — the real
 * work is done by PBKDF2's cost, and the failure mode of a weak passphrase is a
 * cheap offline guess at a local database, which the UI states when it asks.
 */
export const MIN_PASSPHRASE_LENGTH = 8;

/* ──────────────────────────────── failures ───────────────────────────────── */

/** Why an encrypt/decrypt refused. Typed so the UI picks a sentence, never parses one. */
export type SecretFailureKind =
  | 'wrong-passphrase'
  | 'crypto-unavailable'
  | 'malformed-envelope'
  | 'passphrase-too-short'
  /**
   * A re-encryption was asked for with no passphrase-derived key in this tab.
   *
   * It is a GUARD rather than a user-visible cause: the store checks
   * `hasDerivedSecret()` before it offers to re-seal, so the sentence for this case is
   * never rendered. It exists so that "re-encrypt with the cached key" cannot be
   * spelled as a silent fallback to plaintext, which is the failure this whole module
   * is about.
   */
  | 'locked';

/**
 * A refused crypto operation.
 *
 * The MESSAGE is a fixed developer sentence and the `kind` is the machine-readable
 * half; a caller renders a catalog sentence from `kind`. Neither ever contains the
 * passphrase or the key, because both travel through this module as arguments that
 * are dropped — see `secretFailureKind` for why the check is structural.
 */
export class SecretFailure extends Error {
  readonly kind: SecretFailureKind;

  constructor(kind: SecretFailureKind, message: string) {
    super(message);
    this.name = 'SecretFailure';
    this.kind = kind;
  }
}

/**
 * The failure kind of a thrown value, or `undefined` when it is something else.
 *
 * WHY STRUCTURAL AND NOT `instanceof`: a module instance is not guaranteed to be the
 * only one in the process (Vitest instantiates a module per environment), and
 * `instanceof` across two copies of this file is silently `false` — the caller would
 * then report a generic failure for a wrong passphrase. Reading `name` and `kind`
 * through parameterised keys is the same rule `state/write-error.ts` applies, for the
 * same reason, and the key indirection is the one spelling both `tsc`
 * (`noPropertyAccessFromIndexSignature`) and Biome (`useLiteralKeys`) accept.
 */
export function secretFailureKind(cause: unknown): SecretFailureKind | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const record: Record<string, unknown> = cause as Record<string, unknown>;
  if (field(record, FIELD_NAME) !== 'SecretFailure') return undefined;
  const kind = field(record, FIELD_KIND);
  return isSecretFailureKind(kind) ? kind : undefined;
}

/** One field of an untrusted record. A parameterised key is the accepted spelling. */
function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function isSecretFailureKind(value: unknown): value is SecretFailureKind {
  return (
    value === 'wrong-passphrase' ||
    value === 'crypto-unavailable' ||
    value === 'malformed-envelope' ||
    value === 'passphrase-too-short' ||
    value === 'locked'
  );
}

const FIELD_NAME = 'name';
const FIELD_KIND = 'kind';

/* ─────────────────────────── reading an envelope ─────────────────────────── */

/**
 * True when `value` is a well-formed envelope.
 *
 * This is the parse the repository runs when it reads its own row back: the row is
 * JSON, so a stored envelope comes back as an object `JsonValue` that is
 * structurally indistinguishable from anything else a previous writer left there
 * (ADR-016). Field-by-field checks against the constants above mean a row that is
 * not ours is `none` rather than a decrypt attempt on garbage.
 */
export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return (
    field(record, 'v') === ENVELOPE_VERSION &&
    field(record, 'kdf') === KDF_NAME &&
    typeof field(record, 'iterations') === 'number' &&
    typeof field(record, 'salt') === 'string' &&
    typeof field(record, 'iv') === 'string' &&
    typeof field(record, 'ciphertext') === 'string'
  );
}

/**
 * An envelope as a `JsonValue`, field by field.
 *
 * WHY THIS IS NOT JUST `envelope as JsonValue`: `JsonValue`'s object member is
 * `{[key: string]: JsonValue}`, and a TypeScript INTERFACE has no implicit index
 * signature, so the cast does not compile — and it would be the wrong thing to want
 * anyway, since it would silently carry any future non-JSON field into the row.
 * Listing the six fields is also what makes "the stored shape is the schema's shape"
 * (ADR-016) true for this value instead of merely claimed.
 */
export function encryptedSecretToJson(envelope: EncryptedSecret): JsonValue {
  return {
    v: envelope.v,
    kdf: envelope.kdf,
    iterations: envelope.iterations,
    salt: envelope.salt,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  };
}

/* ─────────────────────────────── WebCrypto ───────────────────────────────── */

const PBKDF2 = 'PBKDF2';
const AES_GCM = 'AES-GCM';

/**
 * A byte array that WebCrypto accepts as a `BufferSource`.
 *
 * WHY THE EXPLICIT `ArrayBuffer` PARAMETER: TypeScript 5.9's typed arrays are generic over
 * their backing buffer, and the bare `Uint8Array` alias means
 * `Uint8Array<ArrayBufferLike>` — which includes `SharedArrayBuffer`, which `BufferSource`
 * does not accept. The generic argument is therefore not decoration: without it every
 * `salt`/`iv` argument into `subtle.deriveKey` and `subtle.encrypt` is a type error. This
 * is the one spelling that keeps the code honest (the alternative, a cast at each call
 * site, would hide a genuine mismatch if one ever appeared).
 */
type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The platform's `SubtleCrypto`, or `undefined` where the platform has none.
 *
 * The optional read is deliberate: in a non-secure context `crypto` exists and
 * `subtle` does not, and an environment without `crypto` at all must be reported as
 * "unavailable" rather than as a `TypeError` from module scope.
 */
function subtleCrypto(): SubtleCrypto | undefined {
  const platform: { readonly subtle?: SubtleCrypto } | undefined = globalThis.crypto;
  return platform?.subtle;
}

/** True when this environment can encrypt at all (see the file header). */
export function cryptoAvailable(): boolean {
  return subtleCrypto() !== undefined;
}

function subtleOrThrow(): SubtleCrypto {
  const implementation = subtleCrypto();
  if (implementation === undefined) {
    throw new SecretFailure(
      'crypto-unavailable',
      'WebCrypto is unavailable (a secure context is required), so nothing can be encrypted',
    );
  }
  return implementation;
}

function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Base64 of a byte array, built with a loop rather than spread into
 * `String.fromCharCode`.
 *
 * `fromCharCode(...bytes)` passes one argument per byte, so a long ciphertext hits
 * the engine's argument-count limit and throws — a real failure for a key of a few
 * kilobytes. The loop has no such ceiling.
 */
function toBase64(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/** Bytes of a base64 string; a value that is not base64 is a malformed envelope. */
function fromBase64(text: string): Bytes {
  try {
    const binary = globalThis.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new SecretFailure('malformed-envelope', 'the stored secret is not valid base64');
  }
}

/** The PBKDF2 parameters of one envelope, validated against the documented bounds. */
function iterationsOf(envelope: EncryptedSecret): number {
  const { iterations } = envelope;
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new SecretFailure(
      'malformed-envelope',
      'the stored secret names a PBKDF2 round count outside the accepted range',
    );
  }
  return iterations;
}

/**
 * Derive the 256-bit AES-GCM key for `passphrase` and `salt`.
 *
 * WHY THE PASSPHRASE IS NORMALISED TO NFC HERE, AND ONLY HERE
 * The same VISIBLE passphrase can be different code points: `é` is one code point in
 * NFC and two (e + combining acute) in NFD, and the two spellings are different bytes,
 * hence different keys. A user who set a passphrase on one OS and pasted it on another
 * — or whose browser/IME produced the other form — would be told "wrong passphrase"
 * with nothing to inspect, which is the least debuggable failure this feature can have.
 * Normalising makes the derivation a function of the passphrase's TEXT rather than of
 * the encoding a particular input path happened to produce.
 *
 * It is applied at THIS function and not at the call sites on purpose: every entry point
 * (`deriveSecret`, `rederiveSecret`, and through them sealing, unlocking, re-sealing and
 * the migration) reaches the bytes here, so "set through one path, open through another"
 * cannot diverge. A normalisation applied at the edges would be one forgotten caller away
 * from exactly that bug. NFC specifically: it is the form browsers and password managers
 * produce by default, so a value typed today is already canonical and the fix only ever
 * rescues the other spelling.
 *
 * Both levels are `extractable: false`: the PBKDF2 material because nothing needs to
 * read it back, and the derived key because a key that can be exported is a key that
 * some future code path can write somewhere else. The encoded array is unreachable once
 * `importKey` has copied it.
 */
async function deriveKey(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const subtle = subtleOrThrow();
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase.normalize('NFC')),
    PBKDF2,
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: PBKDF2, salt, iterations, hash: 'SHA-256' },
    material,
    { name: AES_GCM, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** What a caller may override about a NEW envelope. See `PBKDF2_ITERATIONS`. */
export interface EncryptOptions {
  /**
   * PBKDF2 rounds. ONLY a unit test passes this, to drive the failure paths without
   * paying the full cost; the app never does, and `decryptSecret` honours whatever
   * the envelope carries.
   */
  readonly iterations?: number;
}

/**
 * A derived AES-GCM key together with the parameters it was derived from.
 *
 * The salt and the round count are carried alongside the key because a re-encryption
 * under the SAME passphrase must produce an envelope that a later unlock can derive
 * the same key from. Caching the passphrase to re-derive it instead would be the
 * thing this module refuses to do (see the file header), so the parameters travel.
 */
export interface DerivedSecret {
  /** Non-extractable; see `deriveKey`. */
  readonly key: CryptoKey;
  /** The salt this key was derived with; reused verbatim when re-sealing. */
  readonly salt: Bytes;
  /** The PBKDF2 round count this key was derived with. */
  readonly iterations: number;
}

/**
 * Derive a key for a NEW secret: fresh salt, the documented round count.
 *
 * The passphrase LENGTH POLICY lives here and not in `rederiveSecret` — see
 * `MIN_PASSPHRASE_LENGTH`: a minimum is enforced when a passphrase is chosen, never
 * when one is used, or a later policy change would strand an existing key.
 */
export async function deriveSecret(
  passphrase: string,
  options: EncryptOptions = {},
): Promise<DerivedSecret> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SecretFailure(
      'passphrase-too-short',
      `a passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new SecretFailure(
      'malformed-envelope',
      'the requested PBKDF2 round count is out of range',
    );
  }
  const salt = randomBytes(SALT_BYTES);
  return { key: await deriveKey(passphrase, salt, iterations), salt, iterations };
}

/**
 * Derive the key an existing envelope was encrypted with.
 *
 * No length policy here, on purpose (see `deriveSecret`), and the round count comes
 * from the envelope — bounded by `iterationsOf`, so a tampered row cannot turn an
 * unlock into an unbounded computation.
 */
export async function rederiveSecret(
  envelope: EncryptedSecret,
  passphrase: string,
): Promise<DerivedSecret> {
  const iterations = iterationsOf(envelope);
  const salt = fromBase64(envelope.salt);
  return { key: await deriveKey(passphrase, salt, iterations), salt, iterations };
}

/**
 * Encrypt `apiKey` with an already-derived key.
 *
 * A FRESH IV every call, including when the same derived key re-seals a changed key:
 * reusing a nonce under one AES-GCM key is the one catastrophic misuse of the mode,
 * and it is exactly what "re-encrypt without asking for the passphrase again" invites.
 * The salt is deliberately reused: it is not a nonce, it is an input to the
 * derivation, and reusing it is what makes the cached key the right one.
 */
export async function sealSecret(derived: DerivedSecret, apiKey: string): Promise<EncryptedSecret> {
  const subtle = subtleOrThrow();
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle.encrypt(
    { name: AES_GCM, iv },
    derived.key,
    new TextEncoder().encode(apiKey),
  );
  return {
    v: ENVELOPE_VERSION,
    kdf: KDF_NAME,
    iterations: derived.iterations,
    salt: toBase64(derived.salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt `envelope` with an already-derived key, or fail with `wrong-passphrase`.
 *
 * GCM's authentication tag is what makes a wrong passphrase detectable at all: a
 * different passphrase derives a different key, so the tag check fails and this
 * function never returns a wrong key's worth of garbage. The caller's response
 * differs by cause — a wrong passphrase is retryable and must leave the stored row
 * alone — which is why the failure is typed rather than a `null`.
 */
export async function openSecret(
  derived: DerivedSecret,
  envelope: EncryptedSecret,
): Promise<string> {
  const subtle = subtleOrThrow();
  try {
    const plaintext = await subtle.decrypt(
      { name: AES_GCM, iv: fromBase64(envelope.iv) },
      derived.key,
      fromBase64(envelope.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Every other cause (a truncated ciphertext, a salt that is not the documented
    // length) is also reported as a wrong passphrase: the user's recovery is identical
    // — retype it, or replace the key — and naming the internal cause would only be
    // actionable to someone probing a stolen row.
    throw new SecretFailure('wrong-passphrase', 'the passphrase does not decrypt this secret');
  }
}

/**
 * Encrypt `apiKey` under `passphrase` — the one-call form.
 *
 * A fresh salt and a fresh IV per call, so encrypting the same key twice produces two
 * different envelopes. That is what makes "the stored row changed" observable, and it
 * is required for GCM's nonce rule.
 */
export async function encryptSecret(
  apiKey: string,
  passphrase: string,
  options: EncryptOptions = {},
): Promise<EncryptedSecret> {
  return sealSecret(await deriveSecret(passphrase, options), apiKey);
}

/** Decrypt `envelope` with `passphrase` — the one-call form of `rederiveSecret` + `openSecret`. */
export async function decryptSecret(
  envelope: EncryptedSecret,
  passphrase: string,
): Promise<string> {
  return openSecret(await rederiveSecret(envelope, passphrase), envelope);
}
