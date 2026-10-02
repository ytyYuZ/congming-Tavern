/**
 * PNG chunk surgery: read the chunk list, read a `tEXt` body, and put one back.
 *
 * WHY THIS IS HAND-ROLLED
 * A SillyTavern character card is a PNG with the card JSON base64-encoded in a
 * `tEXt` chunk named `chara`. PNG's chunk list is a length-prefixed, CRC-checked
 * sequence of byte runs — walking it is thirty lines and needs no image library,
 * and pulling in an image decoder for it would be a dependency bought with no
 * pixels gained. The same walk is what lets PNG EXPORT work without re-encoding
 * the picture: every chunk other than the one we replace is carried through as
 * the exact bytes that were read.
 *
 * WHAT IS PARSED, WHAT IS REFUSED
 *   parsed    the 8-byte signature; every chunk (length, 4-letter type, data,
 *             CRC) up to and including `IEND`; `tEXt` bodies as `keyword\0text`.
 *   refused   a file whose signature is not PNG, a chunk whose length runs past
 *             the buffer, a type that is not four ASCII letters, a missing or
 *             non-empty `IEND` data field, and a first chunk that is not `IHDR`.
 *             Each of those is an ERROR finding with the byte offset; none of
 *             them throws.
 *   noted     a CRC that does not match its chunk is reported per chunk and the
 *             declared/computed pair is kept on the chunk, so the caller that
 *             actually TRUSTS those bytes can escalate it (the card reader turns
 *             a bad CRC on the chunk it used into an error) while a damaged
 *             `IDAT` in an otherwise readable card stays a warning.
 *   ignored   bytes after `IEND`: the image ends at its end marker, and this
 *             reader stops there rather than calling trailing junk a chunk.
 *
 * WHAT IS **NOT** PARSED: `zTXt` (zlib-compressed text) and `iTXt` (international
 * text) are reported when they carry a `chara` keyword, but their bodies are not
 * decoded — `zTXt` would need an inflater this package does not carry, and
 * SillyTavern writes `tEXt`.
 */

import { type StFinding, stFinding, stOk } from './findings';

/** The 8 signature bytes every PNG starts with. */
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ──────────────────────────────── CRC-32 ─────────────────────────────────── */

/** The PNG/zlib CRC polynomial (reflected). */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

/** CRC-32 of a byte run — the number PNG stores after every chunk. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ───────────────────────────────── chunks ────────────────────────────────── */

/** One chunk, with both the bytes as read and what the CRC check said. */
export interface PngChunk {
  /** The 4-letter type (`IHDR`, `tEXt`, `IDAT`, `IEND`, …). */
  readonly type: string;
  /** The chunk's data field (a view into the source bytes). */
  readonly data: Uint8Array;
  /** The whole chunk as read: length + type + data + CRC. */
  readonly raw: Uint8Array;
  /** The CRC the file declares. */
  readonly declaredCrc: number;
  /** The CRC computed over type + data. */
  readonly computedCrc: number;
  /** Byte offset of the length field, so a finding can point at it. */
  readonly offset: number;
}

export interface PngReadResult {
  readonly ok: boolean;
  /** Every chunk up to and including `IEND` that could be read. */
  readonly chunks: readonly PngChunk[];
  readonly findings: readonly StFinding[];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  // DataView rather than shifts: `bytes[i]` is `number | undefined` under
  // `noUncheckedIndexedAccess`, and four `?? 0`s would hide a real short read.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, false);
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setUint32(offset, value >>> 0, false);
}

function hasSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function isLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isTypeByte(byte: number): boolean {
  return isLetterCode(byte);
}

function typeAt(bytes: Uint8Array, offset: number): string | undefined {
  let type = '';
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined || !isTypeByte(byte)) return undefined;
    type += String.fromCharCode(byte);
  }
  return type;
}

/**
 * Walk the chunk list.
 *
 * The result is `ok: false` for a structural problem (see the header) and always
 * carries whatever chunks were readable, because the caller's next question is
 * "how far did it get?".
 */
export function readPngChunks(bytes: Uint8Array): PngReadResult {
  const findings: StFinding[] = [];
  if (!hasSignature(bytes)) {
    findings.push(
      stFinding('st-png-not-png', 'the file does not start with the 8-byte PNG signature'),
    );
    return { ok: false, chunks: [], findings };
  }

  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      findings.push(
        stFinding(
          'st-png-corrupt-chunk',
          `only ${bytes.length - offset} bytes are left, too few for a chunk header and CRC`,
          `byte ${offset}`,
        ),
      );
      break;
    }
    const length = readUint32(bytes, offset);
    const type = typeAt(bytes, offset + 4);
    const end = offset + 12 + length;
    if (type === undefined) {
      findings.push(
        stFinding(
          'st-png-corrupt-chunk',
          'the chunk type is not four ASCII letters',
          `byte ${offset}`,
        ),
      );
      break;
    }
    if (end > bytes.length) {
      findings.push(
        stFinding(
          'st-png-corrupt-chunk',
          `the ${type} chunk declares ${length} bytes but only ${bytes.length - offset - 12} follow`,
          `byte ${offset}`,
        ),
      );
      break;
    }

    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = readUint32(bytes, offset + 8 + length);
    const computedCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (declaredCrc !== computedCrc) {
      findings.push(
        stFinding(
          'st-png-crc-mismatch',
          `the ${type} chunk declares CRC ${declaredCrc} but its bytes compute ${computedCrc}`,
          `${type}@${offset}`,
        ),
      );
    }
    chunks.push({
      type,
      data,
      raw: bytes.subarray(offset, end),
      declaredCrc,
      computedCrc,
      offset,
    });

    if (type === 'IEND') {
      if (length !== 0) {
        findings.push(
          stFinding(
            'st-png-corrupt-chunk',
            'IEND carries data, so the file is malformed',
            `byte ${offset}`,
          ),
        );
      }
      break;
    }
    offset = end;
  }

  const first = chunks[0];
  if (first === undefined) {
    findings.push(stFinding('st-png-corrupt-chunk', 'the file has no chunks at all'));
  } else if (first.type !== 'IHDR') {
    findings.push(
      stFinding(
        'st-png-corrupt-chunk',
        `the first chunk is ${first.type}, not IHDR`,
        `byte ${first.offset}`,
      ),
    );
  }
  const last = chunks[chunks.length - 1];
  if (last !== undefined && last.type !== 'IEND') {
    findings.push(
      stFinding(
        'st-png-corrupt-chunk',
        'the chunk list does not end with IEND',
        `byte ${last.offset}`,
      ),
    );
  }

  return { ok: stOk(findings), chunks, findings };
}

/** A chunk built from scratch, with a correct length field and CRC. */
export function makeChunk(type: string, data: Uint8Array): PngChunk {
  if (type.length !== 4 || [...type].some((char) => !isLetterCode(char.charCodeAt(0)))) {
    // A programming error (the callers pass literals), not bad input: a chunk
    // type that is not four letters cannot be written at all.
    throw new Error(`a PNG chunk type is exactly four ASCII letters, not ${JSON.stringify(type)}`);
  }
  const raw = new Uint8Array(12 + data.length);
  writeUint32(raw, 0, data.length);
  for (let index = 0; index < 4; index += 1) raw[4 + index] = type.charCodeAt(index);
  raw.set(data, 8);
  writeUint32(raw, 8 + data.length, crc32(raw.subarray(4, 8 + data.length)));
  return {
    type,
    data: raw.subarray(8, 8 + data.length),
    raw,
    declaredCrc: readUint32(raw, 8 + data.length),
    computedCrc: readUint32(raw, 8 + data.length),
    offset: 0,
  };
}

/**
 * Signature plus every chunk's exact bytes — so a chunk that came in unchanged
 * goes out byte-identical, and a replacement cannot perturb its neighbours.
 */
export function encodePng(chunks: readonly PngChunk[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.raw.length, PNG_SIGNATURE.length);
  const out = new Uint8Array(total);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    out.set(chunk.raw, offset);
    offset += chunk.raw.length;
  }
  return out;
}

/* ─────────────────────────────── tEXt bodies ─────────────────────────────── */

/** The keyword of a text-ish chunk (`tEXt` / `zTXt` / `iTXt`), before the NUL. */
export function keywordOf(chunk: PngChunk): string | undefined {
  if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt' && chunk.type !== 'iTXt') return undefined;
  let keyword = '';
  for (const byte of chunk.data) {
    if (byte === 0) return keyword;
    keyword += String.fromCharCode(byte);
  }
  return undefined;
}

/** Latin-1 text from bytes, built in chunks so a long payload cannot blow the stack. */
function latin1Text(bytes: Uint8Array): string {
  let text = '';
  const stride = 8192;
  for (let start = 0; start < bytes.length; start += stride) {
    text += String.fromCharCode(...bytes.subarray(start, start + stride));
  }
  return text;
}

/** A `tEXt` body: `keyword` NUL `text`. */
export interface PngTextBody {
  readonly keyword: string;
  readonly text: string;
}

/** Parse a `tEXt` body, or answer why it is not one. */
export function textBodyOf(chunk: PngChunk): PngTextBody | string {
  if (chunk.type !== 'tEXt') return `a ${chunk.type} chunk is not an uncompressed tEXt chunk`;
  const separator = chunk.data.indexOf(0);
  if (separator < 0) return 'the tEXt chunk has no NUL between its keyword and its text';
  if (separator === 0) return 'the tEXt chunk has an empty keyword';
  if (separator > 79) return 'the tEXt keyword is longer than the 79 bytes the format allows';
  return {
    keyword: latin1Text(chunk.data.subarray(0, separator)),
    text: latin1Text(chunk.data.subarray(separator + 1)),
  };
}

/** Every `tEXt` chunk whose keyword is `keyword`, in file order. */
export function findTextChunks(chunks: readonly PngChunk[], keyword: string): readonly PngChunk[] {
  return chunks.filter((chunk) => keywordOf(chunk) === keyword);
}

/* ──────────────────────────────── writing ────────────────────────────────── */

export interface PngWriteResult {
  readonly ok: boolean;
  /** The rebuilt image; absent when nothing could be written. */
  readonly bytes?: Uint8Array;
  readonly findings: readonly StFinding[];
}

/** ASCII-only bytes, which is all a `tEXt` chunk may carry (and all base64 is). */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/**
 * Replace the `tEXt` chunk named `keyword` with `text`, or add it before `IEND`.
 *
 * IN PLACE when the chunk is already there (so a card exported back into its own
 * image keeps the chunk where SillyTavern put it), and every duplicate of that
 * keyword is dropped after a warning — two `chara` chunks are two different
 * cards, and reading the first one while leaving the second is how a tool
 * "edits" a card that then still opens as the old one.
 *
 * `text` must be ASCII: a `tEXt` body is Latin-1, so a caller with non-ASCII text
 * would get a chunk that reads back as mojibake. That is refused rather than
 * silently mis-encoded — the card exporter only ever passes base64.
 */
export function withTextChunk(png: Uint8Array, keyword: string, text: string): PngWriteResult {
  const read = readPngChunks(png);
  const findings = [...read.findings];
  if (!read.ok) return { ok: false, findings };

  if (keyword === '' || keyword.length > 79 || !isAscii(keyword) || keyword.includes('\0')) {
    findings.push(
      stFinding(
        'st-png-text-not-ascii',
        `the keyword ${JSON.stringify(keyword)} is not 1-79 ASCII bytes`,
      ),
    );
    return { ok: false, findings };
  }
  if (!isAscii(text)) {
    findings.push(
      stFinding(
        'st-png-text-not-ascii',
        `the text for the ${keyword} chunk contains a non-ASCII character, which a tEXt body cannot carry`,
        keyword,
      ),
    );
    return { ok: false, findings };
  }

  const body = new Uint8Array(keyword.length + 1 + text.length);
  for (let index = 0; index < keyword.length; index += 1) body[index] = keyword.charCodeAt(index);
  body[keyword.length] = 0;
  for (let index = 0; index < text.length; index += 1) {
    body[keyword.length + 1 + index] = text.charCodeAt(index);
  }
  const replacement = makeChunk('tEXt', body);

  const matches = findTextChunks(read.chunks, keyword);
  if (matches.length > 1) {
    findings.push(
      stFinding(
        'st-png-duplicate-chunk',
        `the image carries ${matches.length} ${keyword} chunks; the first is replaced and the others are dropped`,
        keyword,
      ),
    );
  }

  const first = matches[0];
  const chunks: PngChunk[] = [];
  for (const chunk of read.chunks) {
    if (keywordOf(chunk) === keyword) {
      if (chunk === first) chunks.push(replacement);
      continue;
    }
    chunks.push(chunk);
  }
  if (first === undefined) {
    // No such chunk: put it before IEND, where every reader (and the PNG spec's
    // "ancillary chunks anywhere before the end") finds it, leaving PLTE/IDAT
    // ordering untouched.
    const iend = chunks.findIndex((chunk) => chunk.type === 'IEND');
    chunks.splice(iend < 0 ? chunks.length : iend, 0, replacement);
  }

  return { ok: true, bytes: encodePng(chunks), findings };
}
