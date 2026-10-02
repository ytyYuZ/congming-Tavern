/**
 * The byte layer of the SillyTavern PNG support: CRC-32, the chunk walk, `tEXt`
 * bodies, base64, and the replace/add surgery that PNG export depends on.
 *
 * WHY THESE ARE SEPARATE FROM THE CARD TESTS: everything here is a promise about
 * BYTES, and none of it needs a card to state. The strongest one is the chunk
 * surgery rule the task asks for by name — "adding the `chara` chunk to a source
 * image must leave every other chunk byte-identical" — which is what makes it safe
 * to hand a user's avatar back with the card attached, without re-encoding a single
 * pixel. (The fixtures' IHDR/IDAT bytes and their CRC-32s come from Pillow, not from
 * this code, so the CRC check below is a comparison against an unrelated
 * implementation rather than a tautology — see `../testing/st-fixtures.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '../sillytavern/base64';
import { ST_CCV3_CHUNK, ST_CHARA_CHUNK } from '../sillytavern/character-png';
import {
  crc32,
  encodePng,
  findTextChunks,
  keywordOf,
  makeChunk,
  type PngChunk,
  type PngReadResult,
  readPngChunks,
  textBodyOf,
  withTextChunk,
} from '../sillytavern/png';
import {
  ST_BASE_PNG_BASE64,
  ST_CARD_PNG_BASE64,
  ST_CARD_V2,
  ST_CARD_V3,
  ST_CARD_V3_PNG_BASE64,
} from '../testing/st-fixtures';
import { bytesOf, codesOf } from '../testing/st-harness';

/** The bytes a write/read produced, or a failure naming what it refused. */
function bytesOfResult(result: {
  ok: boolean;
  bytes?: Uint8Array;
  findings: readonly unknown[];
}): Uint8Array {
  if (result.bytes === undefined) {
    throw new Error(`no bytes: ${JSON.stringify(result.findings)}`);
  }
  return result.bytes;
}

/** The chunks of a successful read. */
function chunksOf(result: PngReadResult): readonly PngChunk[] {
  if (!result.ok && result.chunks.length === 0) {
    throw new Error(`unreadable PNG: ${JSON.stringify(result.findings)}`);
  }
  return result.chunks;
}

/** Chunk bytes as plain numbers, so a comparison is unambiguously byte-wise. */
function bytesList(chunks: readonly PngChunk[]): number[][] {
  return chunks.map((chunk) => [...chunk.raw]);
}

describe('SillyTavern PNG chunks, CRC and base64', () => {
  it('every chunk of the Pillow-encoded fixtures passes our CRC-32', () => {
    for (const [name, base64] of [
      ['base', ST_BASE_PNG_BASE64],
      ['card', ST_CARD_PNG_BASE64],
      ['card-v3', ST_CARD_V3_PNG_BASE64],
    ] as const) {
      const read = readPngChunks(bytesOf(base64));
      expect({ name, problems: codesOf(read) }).toEqual({ name, problems: [] });
      expect(read.chunks.map((chunk) => `${chunk.type}:${chunk.declaredCrc}`)).toEqual(
        read.chunks.map((chunk) => `${chunk.type}:${chunk.computedCrc}`),
      );
    }
    // The base image is deliberately more than IHDR/IDAT/IEND: a surgery test that
    // only ever sees three chunk types proves much less.
    expect(chunksOf(readPngChunks(bytesOf(ST_BASE_PNG_BASE64))).map((chunk) => chunk.type)).toEqual(
      ['IHDR', 'gAMA', 'tIME', 'tEXt', 'IDAT', 'IEND'],
    );
  });

  it('the card fixtures carry their card JSON in chara (and ccv3 for the V3 one)', () => {
    const v2 = chunksOf(readPngChunks(bytesOf(ST_CARD_PNG_BASE64)));
    const chara = findTextChunks(v2, ST_CHARA_CHUNK);
    expect(chara).toHaveLength(1);
    const body = textBodyOf(chara[0] ?? makeChunk('tEXt', new Uint8Array(0)));
    if (typeof body === 'string') throw new Error(`the chara chunk is malformed: ${body}`);
    const decoded = decodeBase64(body.text);
    if (decoded.bytes === undefined) throw new Error('the chara chunk is not base64');
    const document: unknown = JSON.parse(new TextDecoder().decode(decoded.bytes));
    // The provenance claim of the fixture module, checked: the PNG is the JSON
    // literal beside it, so replacing the literal is enough to replace the card.
    expect(document).toEqual(ST_CARD_V2);

    const v3 = chunksOf(readPngChunks(bytesOf(ST_CARD_V3_PNG_BASE64)));
    expect(findTextChunks(v3, ST_CHARA_CHUNK)).toHaveLength(1);
    expect(findTextChunks(v3, ST_CCV3_CHUNK)).toHaveLength(1);
    const ccv3 = textBodyOf(
      findTextChunks(v3, ST_CCV3_CHUNK)[0] ?? makeChunk('tEXt', new Uint8Array(0)),
    );
    if (typeof ccv3 === 'string') throw new Error(`the ccv3 chunk is malformed: ${ccv3}`);
    const v3Document = decodeBase64(ccv3.text);
    if (v3Document.bytes === undefined) throw new Error('the ccv3 chunk is not base64');
    expect(JSON.parse(new TextDecoder().decode(v3Document.bytes))).toEqual(ST_CARD_V3);
  });

  it('adding the chara chunk to a source image leaves every other chunk byte-identical', () => {
    const base = bytesOf(ST_BASE_PNG_BASE64);
    const before = chunksOf(readPngChunks(base));
    const written = withTextChunk(
      base,
      ST_CHARA_CHUNK,
      encodeBase64(new TextEncoder().encode('a card')),
    );
    expect(written.ok).toBe(true);
    const after = chunksOf(readPngChunks(bytesOfResult(written)));

    expect(after.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'gAMA',
      'tIME',
      'tEXt',
      'IDAT',
      'tEXt',
      'IEND',
    ]);
    const untouched = after.filter((chunk) => keywordOf(chunk) !== ST_CHARA_CHUNK);
    expect(bytesList(untouched)).toEqual(bytesList(before));
    // …and the image we return is the source image plus that one chunk, byte for
    // byte: no re-encode, no reordered PLTE/IDAT, no touched timestamp.
    expect(bytesOfResult(written).length).toBe(base.length + (after[5]?.raw.length ?? 0));
  });

  it('a card chunk that is already there is replaced in place, not duplicated', () => {
    const card = bytesOf(ST_CARD_PNG_BASE64);
    const before = chunksOf(readPngChunks(card));
    const charaBefore = before.findIndex((chunk) => keywordOf(chunk) === ST_CHARA_CHUNK);
    const elsewhere = before.filter((chunk) => keywordOf(chunk) !== ST_CHARA_CHUNK);
    const written = withTextChunk(
      card,
      ST_CHARA_CHUNK,
      encodeBase64(new TextEncoder().encode('{"name":"Other"}')),
    );
    const after = chunksOf(readPngChunks(bytesOfResult(written)));

    expect(after.filter((chunk) => keywordOf(chunk) === ST_CHARA_CHUNK)).toHaveLength(1);
    expect(after.findIndex((chunk) => keywordOf(chunk) === ST_CHARA_CHUNK)).toBe(charaBefore);
    expect(bytesList(after.filter((chunk) => keywordOf(chunk) !== ST_CHARA_CHUNK))).toEqual(
      bytesList(elsewhere),
    );
  });

  it('two card chunks are reported, and the rewritten image keeps only one', () => {
    const base = chunksOf(readPngChunks(bytesOf(ST_BASE_PNG_BASE64)));
    const first = makeChunk('tEXt', new Uint8Array([...new TextEncoder().encode('chara'), 0, 65]));
    const second = makeChunk('tEXt', new Uint8Array([...new TextEncoder().encode('chara'), 0, 66]));
    const spliced = [...base];
    spliced.splice(spliced.length - 1, 0, first, second);
    const doubled = encodePng(spliced);
    expect(findTextChunks(readPngChunks(doubled).chunks, ST_CHARA_CHUNK)).toHaveLength(2);

    const written = withTextChunk(doubled, ST_CHARA_CHUNK, 'QQ==');
    expect(codesOf(written)).toContain('st-png-duplicate-chunk');
    expect(
      findTextChunks(readPngChunks(bytesOfResult(written)).chunks, ST_CHARA_CHUNK),
    ).toHaveLength(1);
  });

  it('a file that is not a PNG, a truncated chunk and an over-long length are findings', () => {
    const notPng = readPngChunks(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(codesOf(notPng)).toEqual(['st-png-not-png']);
    expect(notPng.chunks).toEqual([]);

    const base = bytesOf(ST_BASE_PNG_BASE64);
    const truncated = readPngChunks(base.slice(0, base.length - 5));
    expect(codesOf(truncated)).toContain('st-png-corrupt-chunk');

    const stretched = Uint8Array.from(base);
    const idat = chunksOf(readPngChunks(base)).find((chunk) => chunk.type === 'IDAT');
    if (idat === undefined) throw new Error('the fixture has no IDAT chunk');
    new DataView(stretched.buffer, stretched.byteOffset, stretched.byteLength).setUint32(
      idat.offset,
      0x00ffffff,
      false,
    );
    const stretchedRead = readPngChunks(stretched);
    expect(codesOf(stretchedRead)).toContain('st-png-corrupt-chunk');
    expect(stretchedRead.ok).toBe(false);
  });

  it('a chunk whose bytes do not match its CRC is reported with both numbers', () => {
    const base = bytesOf(ST_BASE_PNG_BASE64);
    const damaged = Uint8Array.from(base);
    const idat = chunksOf(readPngChunks(base)).find((chunk) => chunk.type === 'IDAT');
    if (idat === undefined) throw new Error('the fixture has no IDAT chunk');
    damaged[idat.offset + 8] = (damaged[idat.offset + 8] ?? 0) ^ 0xff;

    const read = readPngChunks(damaged);
    const finding = read.findings.find((entry) => entry.code === 'st-png-crc-mismatch');
    expect(finding?.severity).toBe('warning');
    expect(finding?.where).toBe(`IDAT@${idat.offset}`);
    // An image chunk we never read is a warning; the walk still succeeds, which is
    // how a card with a damaged picture stays importable.
    expect(read.ok).toBe(true);
    expect(read.chunks.find((chunk) => chunk.type === 'IDAT')?.computedCrc).not.toBe(
      idat.declaredCrc,
    );
  });

  it('base64 tolerates wrapping and optional padding, and refuses anything else', () => {
    expect(decodeBase64('QUJD').bytes).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
    expect(decodeBase64('QUJD\n').bytes).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
    expect(decodeBase64('QU\nJD').bytes).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
    expect(decodeBase64('QQ==').bytes).toEqual(new Uint8Array([0x41]));
    expect(decodeBase64('QQ').bytes).toEqual(new Uint8Array([0x41]));
    expect(decodeBase64('QUI=').bytes).toEqual(new Uint8Array([0x41, 0x42]));
    expect(decodeBase64('QQ=').ok).toBe(false);
    expect(decodeBase64('Q').ok).toBe(false);
    expect(decodeBase64('QU-D').reason).toContain('base64 alphabet');
    expect(decodeBase64('QUJD$').ok).toBe(false);

    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(decodeBase64(encodeBase64(bytes)).bytes).toEqual(bytes);
    expect(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082);
  });

  it('a tEXt body must be ASCII, and a non-ASCII one is refused rather than mis-encoded', () => {
    const written = withTextChunk(bytesOf(ST_BASE_PNG_BASE64), ST_CHARA_CHUNK, 'no — em dash');
    expect(written.bytes).toBeUndefined();
    expect(codesOf(written)).toContain('st-png-text-not-ascii');
  });
});
