/**
 * `secrets/secret-crypto.ts` against the REAL WebCrypto (M1-G3).
 *
 * WHY THE PRIMITIVES ARE PINNED INDEPENDENTLY OF THE WRAPPER
 * A round trip through `encryptSecret`/`decryptSecret` proves that two functions agree
 * with each other, which is also true of a pair that "encrypts" by concatenating the key
 * with the passphrase. So the first test below re-derives the key from the stored envelope
 * with `deriveBits` and decrypts it with WebCrypto DIRECTLY: the derivation is PBKDF2-SHA256
 * at the envelope's own round count and salt, the output is exactly 32 bytes, and the
 * ciphertext is AES-GCM — none of which the wrapper could fake without this test failing.
 *
 * WHY THE SUITE DOES NOT SHIM CRYPTO (and must not)
 * Vitest's jsdom environment keeps Node's `SubtleCrypto`, but the environment is not the
 * point: `secret-crypto.ts` refuses with a typed `crypto-unavailable` where `subtle` is
 * absent, so a shim here would hide the one deployment state (a plain `http://` origin) the
 * module has to report. `cryptoAvailable()` is asserted true so a future environment that
 * lost `subtle` shows up as a failure of THIS file rather than as a quietly green suite.
 *
 * CHEAP ROUND COUNTS ARE A TEST SEAM, NOT A PRODUCTION PATH
 * `PBKDF2_ITERATIONS` (210,000) is what the app uses and is asserted to be the DEFAULT by
 * the first test — the only one that pays the full cost. The failure-path tests pass
 * `MIN_ITERATIONS`, which is also the value that makes `decryptSecret` reject a tampered
 * envelope before it derives anything.
 */
import { describe, expect, it } from 'vitest';
import {
  cryptoAvailable,
  decryptSecret,
  deriveSecret,
  encryptedSecretToJson,
  encryptSecret,
  IV_BYTES,
  isEncryptedSecret,
  KEY_BITS,
  KEY_BYTES,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  SecretFailure,
  secretFailureKind,
} from './secret-crypto';

const API_KEY = 'sk-crypto-must-not-leak-1234567890';
const PASSPHRASE = 'correct horse battery';

/** Base64 -> bytes, so the test can drive WebCrypto itself rather than through the module. */
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

describe('the encrypted envelope', () => {
  it('is a real PBKDF2-SHA256 + AES-GCM envelope at the documented cost', async () => {
    expect(cryptoAvailable()).toBe(true);
    expect(PBKDF2_ITERATIONS).toBe(210_000);
    expect(KEY_BITS).toBe(256);
    expect(KEY_BYTES).toBe(32);

    // The DEFAULT path, full cost: this is the only test that pays 210k rounds, and it is
    // what proves the parameters the app actually writes.
    const envelope = await encryptSecret(API_KEY, PASSPHRASE);

    expect(envelope.v).toBe(1);
    expect(envelope.kdf).toBe('PBKDF2-SHA256');
    expect(envelope.iterations).toBe(PBKDF2_ITERATIONS);
    expect(bytesOf(envelope.salt)).toHaveLength(SALT_BYTES);
    expect(bytesOf(envelope.iv)).toHaveLength(IV_BYTES);
    expect(envelope.ciphertext).not.toContain(API_KEY);

    // Independent derivation: same PRF, same salt, same rounds, 256 bits of output.
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(PASSPHRASE),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: bytesOf(envelope.salt),
        iterations: envelope.iterations,
        hash: 'SHA-256',
      },
      material,
      256,
    );
    // THE PROPERTY THAT MATTERS: a 32-byte derived key. Anything else is not an AES-GCM
    // key, and importKey refuses it with `DataError: Invalid key length`.
    expect(bits.byteLength).toBe(KEY_BYTES);
    const raw = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesOf(envelope.iv) },
      raw,
      bytesOf(envelope.ciphertext),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(API_KEY);

    // And the wrapper opens its own envelope.
    await expect(decryptSecret(envelope, PASSPHRASE)).resolves.toBe(API_KEY);
  });

  it('keeps both keys non-extractable and usable for both directions', async () => {
    const derived = await deriveSecret(PASSPHRASE, { iterations: MIN_ITERATIONS });
    expect(derived.key.extractable).toBe(false);
    expect(derived.key.usages).toEqual(['encrypt', 'decrypt']);
    expect(derived.key.algorithm.name).toBe('AES-GCM');
    // The derived key's own declared length, read off the CryptoKey rather than assumed.
    expect((derived.key.algorithm as AesKeyAlgorithm).length).toBe(KEY_BITS);
  });

  it('uses a fresh salt and a fresh IV for every seal', async () => {
    const first = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });
    const second = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });

    // The salt and the IV are what make two envelopes of one key different; reusing an IV
    // under one GCM key is the one catastrophic misuse of the mode.
    expect(second.salt).not.toBe(first.salt);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.ciphertext).not.toContain(API_KEY);
  });

  it('normalises the passphrase to NFC, so the same visible text always opens it', async () => {
    // "café-pass" written the two ways a keyboard or a password manager can produce it:
    // NFC uses U+00E9, NFD uses U+0065 U+0301. The two strings are different byte
    // sequences and would derive different keys without the normalisation.
    const nfc = 'caf\u00e9-pass';
    const nfd = 'cafe\u0301-pass';
    expect(nfc).not.toBe(nfd);

    const fromNfc = await encryptSecret(API_KEY, nfc, { iterations: MIN_ITERATIONS });
    await expect(decryptSecret(fromNfc, nfd)).resolves.toBe(API_KEY);

    const fromNfd = await encryptSecret(API_KEY, nfd, { iterations: MIN_ITERATIONS });
    await expect(decryptSecret(fromNfd, nfc)).resolves.toBe(API_KEY);
  });

  it('refuses a passphrase that is too short when SETTING one, and never when USING one', async () => {
    const short = 'x'.repeat(MIN_PASSPHRASE_LENGTH - 1);
    await expect(encryptSecret(API_KEY, short, { iterations: MIN_ITERATIONS })).rejects.toThrow(
      SecretFailure,
    );
    await expect(
      encryptSecret(API_KEY, short, { iterations: MIN_ITERATIONS }),
    ).rejects.toMatchObject({ kind: 'passphrase-too-short' });

    // The same short string used to OPEN an envelope is a wrong passphrase, not a policy
    // violation: a length rule applied on the decrypt path would strand a key that was
    // encrypted before the rule existed.
    const envelope = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });
    await expect(decryptSecret(envelope, short)).rejects.toMatchObject({
      kind: 'wrong-passphrase',
    });
  });

  it('reports a wrong passphrase as a retryable failure that quotes nothing', async () => {
    const envelope = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });
    const failure = await decryptSecret(envelope, 'not the passphrase').catch(
      (cause: unknown) => cause,
    );

    expect(secretFailureKind(failure)).toBe('wrong-passphrase');
    const message = failure instanceof Error ? failure.message : '';
    // The message is a fixed developer sentence: neither the passphrase nor the key may
    // reach a log, and an error message is the classic way one does.
    expect(message).not.toContain('not the passphrase');
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(PASSPHRASE);
  });

  it('refuses a tampered envelope before spending the derivation', async () => {
    const envelope = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });

    // The round count is the one field that costs the machine money, and it arrives from a
    // row the app trusts least: 10**9 would hang every unlock.
    await expect(
      decryptSecret({ ...envelope, iterations: MAX_ITERATIONS + 1 }, PASSPHRASE),
    ).rejects.toMatchObject({ kind: 'malformed-envelope' });
    await expect(
      decryptSecret({ ...envelope, iterations: MIN_ITERATIONS - 1 }, PASSPHRASE),
    ).rejects.toMatchObject({ kind: 'malformed-envelope' });
    await expect(
      decryptSecret({ ...envelope, salt: 'not base64 !!' }, PASSPHRASE),
    ).rejects.toMatchObject({ kind: 'malformed-envelope' });
    // A truncated ciphertext cannot be told apart from a wrong passphrase, and the user's
    // recovery is the same, so it reports as one.
    await expect(
      decryptSecret({ ...envelope, ciphertext: envelope.ciphertext.slice(0, 8) }, PASSPHRASE),
    ).rejects.toMatchObject({ kind: 'wrong-passphrase' });
  });
});

describe('reading a stored envelope back', () => {
  it('accepts only a well-formed envelope', async () => {
    const envelope = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });
    expect(isEncryptedSecret(envelope)).toBe(true);
    expect(isEncryptedSecret(encryptedSecretToJson(envelope))).toBe(true);

    // Everything a row could hold that is not ours — the M0 plaintext string included.
    expect(isEncryptedSecret(API_KEY)).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
    expect(isEncryptedSecret(['v'])).toBe(false);
    expect(isEncryptedSecret({ ...envelope, v: 2 })).toBe(false);
    expect(isEncryptedSecret({ ...envelope, kdf: 'scrypt' })).toBe(false);
    expect(isEncryptedSecret({ ...envelope, salt: undefined })).toBe(false);
  });

  it('serialises exactly the six documented fields, with no room for a stray value', async () => {
    const envelope = await encryptSecret(API_KEY, PASSPHRASE, { iterations: MIN_ITERATIONS });
    const json = encryptedSecretToJson(envelope);

    expect(json).not.toBe(envelope);
    // Narrowed before the key list is read: `JsonValue` includes primitives, and a serialiser that
    // returned a string or `null` would still satisfy "not the envelope object".
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new Error('the serialised envelope is not an object');
    }
    expect(Object.keys(json).sort()).toEqual([
      'ciphertext',
      'iterations',
      'iv',
      'kdf',
      'salt',
      'v',
    ]);
    // The serialised form must carry no field that could hold the passphrase, and the key
    // itself must not appear anywhere in it.
    expect(JSON.stringify(json)).not.toContain(API_KEY);
    expect(JSON.stringify(json)).not.toContain(PASSPHRASE);
  });
});

describe('failure classification', () => {
  it('reads the kind structurally, so a duplicated module instance cannot hide it', () => {
    expect(secretFailureKind(new SecretFailure('locked', 'guard'))).toBe('locked');
    expect(secretFailureKind(new SecretFailure('crypto-unavailable', 'no subtle'))).toBe(
      'crypto-unavailable',
    );
    expect(secretFailureKind(new Error('something else'))).toBeUndefined();
    expect(secretFailureKind('not an error')).toBeUndefined();
    // A look-alike object is trusted for its two fields only; the kind is validated.
    expect(secretFailureKind({ name: 'SecretFailure', kind: 'nonsense' })).toBeUndefined();
  });

  it('stamps every failure with the name the structural read depends on', () => {
    const failure = new SecretFailure('malformed-envelope', 'a fixed sentence');
    expect(failure.name).toBe('SecretFailure');
    expect(failure).toBeInstanceOf(Error);
  });
});
