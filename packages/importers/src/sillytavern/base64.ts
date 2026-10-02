/**
 * Base64 for the `chara` chunk, spelled out instead of borrowed.
 *
 * WHY NOT `atob` / `Buffer`
 * `atob` is a DOM global that Node only grew later and that decodes to a
 * LATIN-1 string — the classic SillyTavern bug is a card whose UTF-8 greeting
 * turns into mojibake because somebody forgot the second decode step. `Buffer` is
 * Node-only, and this package is bundled for the browser. Both would also answer
 * "that is not base64" with a thrown `InvalidCharacterError`, and a card in the
 * wild is exactly where a thrown parse is the wrong answer (see `./findings.ts`).
 * So the alphabet is a table and the failure is a REASON string.
 *
 * WHAT IS ACCEPTED, AND WHY IT IS NOT STRICTER
 * ASCII whitespace is ignored (some exporters wrap the payload at 76 columns),
 * padding is optional at the end (`...Ig` and `...Ig==` are the same two bytes),
 * and a trailing `=` anywhere but at the end is refused. Nothing else is
 * tolerated: a `-` or `_` means base64url, which SillyTavern does not write, and
 * guessing would produce bytes that are not the card.
 */

/** The 64 symbols, in value order. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Code unit → value, 255 for "not in the alphabet". */
function buildDecodeTable(): Uint8Array {
  const table = new Uint8Array(128).fill(255);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
}

const DECODE_TABLE = buildDecodeTable();

/** Whitespace an exporter may legitimately wrap a payload with. */
function isIgnorable(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function invalidCharacter(char: string, index: number): string {
  return `character ${JSON.stringify(char)} at ${index} is not in the base64 alphabet`;
}

/** A decode answer: the bytes, or the sentence that says why there are none. */
export interface Base64Decode {
  readonly ok: boolean;
  readonly bytes?: Uint8Array;
  /** Why there are no bytes, in words a finding can quote. */
  readonly reason?: string;
}

/**
 * Decode standard base64 to bytes. Never throws: a bad payload is a reason.
 *
 * The `index` in a reason is the index into the ORIGINAL text (whitespace
 * included), so a caller pointing at a chunk can say where the bad character is.
 */
export function decodeBase64(text: string): Base64Decode {
  const values: number[] = [];
  let padding = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isIgnorable(code)) continue;
    if (text[index] === '=') {
      padding += 1;
      if (padding > 2) return { ok: false, reason: `more than two '=' at ${index}` };
      continue;
    }
    if (padding > 0) {
      return { ok: false, reason: `a symbol after the '=' padding at ${index}` };
    }
    if (code > 127) return { ok: false, reason: invalidCharacter(text[index] ?? '', index) };
    const value = DECODE_TABLE[code] ?? 255;
    if (value === 255) return { ok: false, reason: invalidCharacter(text[index] ?? '', index) };
    values.push(value);
  }

  const remainder = values.length % 4;
  if (remainder === 1) {
    return { ok: false, reason: `a base64 payload cannot end after ${values.length} symbols` };
  }
  // `xx==` and `xxx=` are the only legal paddings; an unpadded tail is allowed.
  const expectedPadding = remainder === 2 ? 2 : remainder === 3 ? 1 : 0;
  if (padding > 0 && padding !== expectedPadding) {
    return { ok: false, reason: `padding does not match the payload length (${padding})` };
  }

  const bytes = new Uint8Array((values.length * 3) >> 2);
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const value of values) {
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex] = (buffer >> bits) & 0xff;
      byteIndex += 1;
    }
  }
  return { ok: true, bytes };
}

/**
 * Encode bytes as standard padded base64 (what SillyTavern writes and what
 * `decodeBase64` reads back byte for byte).
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += ALPHABET[first >> 2] ?? '';
    out += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)] ?? '';
    out +=
      second === undefined ? '=' : (ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] ?? '');
    out += third === undefined ? '=' : (ALPHABET[third & 0x3f] ?? '');
  }
  return out;
}
