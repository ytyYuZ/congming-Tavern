/**
 * Character cards inside PNG `tEXt` chunks (`docs/06` §2.6 M1-I1, `docs/01` F9-1 /
 * F9-2) — the form SillyTavern actually ships.
 *
 * THE SAME KEY-FIELD LIST AS THE JSON SUITE, ON PURPOSE: the acceptance is "a real
 * sample round-trips with no key field lost", and a PNG is not allowed to lose a
 * field the JSON path keeps. So the round trip here re-asserts `name` …
 * `character_version` and `character_book` one by one, on the way IN (the fixture
 * chunk) and on the way OUT (the chunk we wrote), rather than re-testing the mapper:
 * what is new here is the container, not the mapping.
 *
 * PNG EXPORT NEEDS A BASE IMAGE AND SAYS SO: without `baseImage` the export returns
 * `st-png-base-image-required` and NO bytes, because this project has no asset
 * pipeline (`docs/06` §10.5) and a PNG without the avatar in it would look like a
 * working export. A caller that has the user's image (or a stored asset) passes it
 * here, and every chunk of it other than the card chunk survives byte-identically —
 * which is asserted in `png.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '../sillytavern/base64';
import { ST_CARD_BAG_KEY } from '../sillytavern/character-card';
import {
  exportStCharacterCardPng,
  importStCharacterCardPng,
  ST_CCV3_CHUNK,
  ST_CHARA_CHUNK,
} from '../sillytavern/character-png';
import { memberOf } from '../sillytavern/json';
import { encodePng, keywordOf, makeChunk, readPngChunks, textBodyOf } from '../sillytavern/png';
import {
  ST_BASE_PNG_BASE64,
  ST_CARD_PNG_BASE64,
  ST_CARD_V2_DATA,
  ST_CARD_V3_PNG_BASE64,
} from '../testing/st-fixtures';
import { bytesOf, cardOf, codesOf, findingsOf, recordOf } from '../testing/st-harness';

/** The fields the PNG round trip must preserve, named one by one. */
const KEY_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'tags',
  'creator',
  'character_version',
] as const;

/** The `data` member of an ST document. */
function dataOf(document: unknown): Record<string, unknown> {
  return recordOf(
    memberOf(recordOf(document, 'the card document'), 'data'),
    'the card document data',
  );
}

/** The bytes a PNG export produced, or a failure naming what it refused. */
function bytesOfResult(result: {
  readonly bytes?: Uint8Array;
  readonly findings: readonly unknown[];
}): Uint8Array {
  if (result.bytes === undefined) throw new Error(`no bytes: ${JSON.stringify(result.findings)}`);
  return result.bytes;
}

/** The card document inside an image's `chara` chunk, decoded. */
function cardDocumentOf(bytes: Uint8Array): Record<string, unknown> {
  const chunk = readPngChunks(bytes).chunks.find((entry) => keywordOf(entry) === ST_CHARA_CHUNK);
  if (chunk === undefined) throw new Error('the image has no chara chunk');
  const body = textBodyOf(chunk);
  if (typeof body === 'string') throw new Error(`the chara chunk is malformed: ${body}`);
  const decoded = decodeBase64(body.text);
  if (decoded.bytes === undefined) throw new Error('the chara chunk is not base64');
  return recordOf(JSON.parse(new TextDecoder().decode(decoded.bytes)), 'the card document');
}

/** An image with one extra chunk before IEND — how a test plants a payload. */
function withChunk(bytes: Uint8Array, chunk: ReturnType<typeof makeChunk>): Uint8Array {
  const chunks = [...readPngChunks(bytes).chunks];
  chunks.splice(chunks.length - 1, 0, chunk);
  return encodePng(chunks);
}

/** A `tEXt` chunk carrying `text` under `keyword`, UTF-8 encoded. */
function textChunk(keyword: string, text: string): ReturnType<typeof makeChunk> {
  const body = new Uint8Array([
    ...new TextEncoder().encode(keyword),
    0,
    ...new TextEncoder().encode(text),
  ]);
  return makeChunk('tEXt', body);
}

describe('SillyTavern character card PNG', () => {
  it('F9-1 a PNG card round-trips every key field and its character_book', () => {
    const imported = importStCharacterCardPng(bytesOf(ST_CARD_PNG_BASE64));
    expect(imported.ok).toBe(true);
    expect(imported.chunk).toBe(ST_CHARA_CHUNK);
    expect(imported.specVersion).toBe(2);
    const card = cardOf(imported);

    // On the way IN: the fixture PNG's chunk mapped to exactly the JSON fixture.
    for (const field of KEY_FIELDS) {
      expect({ field, value: card[field] }).toEqual({ field, value: ST_CARD_V2_DATA[field] });
    }
    const bag = recordOf(card.stExtensions?.[ST_CARD_BAG_KEY], 'the reserved card bag');
    expect(memberOf(bag, 'characterBook')).toEqual(memberOf(ST_CARD_V2_DATA, 'character_book'));

    // On the way OUT: the chunk we write carries the same fields, and re-importing
    // the image produces the same entity.
    const exported = exportStCharacterCardPng(card, { baseImage: bytesOf(ST_BASE_PNG_BASE64) });
    expect(exported.ok).toBe(true);
    expect(exported.specVersion).toBe(2);
    const written = dataOf(cardDocumentOf(bytesOfResult(exported)));
    for (const field of KEY_FIELDS) {
      expect({ field, value: written[field] }).toEqual({ field, value: ST_CARD_V2_DATA[field] });
    }
    expect(memberOf(written, 'character_book')).toEqual(
      memberOf(ST_CARD_V2_DATA, 'character_book'),
    );
    expect(cardOf(importStCharacterCardPng(bytesOfResult(exported)))).toEqual(card);

    // The exported image is the base image plus ONE card chunk, written before IEND.
    expect(readPngChunks(bytesOfResult(exported)).chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'gAMA',
      'tIME',
      'tEXt',
      'IDAT',
      'tEXt',
      'IEND',
    ]);
  });

  it('PNG export without a base image reports the missing asset pipeline and produces nothing', () => {
    const card = cardOf(importStCharacterCardPng(bytesOf(ST_CARD_PNG_BASE64)));
    const exported = exportStCharacterCardPng(card);
    expect(exported.ok).toBe(false);
    expect(exported.bytes).toBeUndefined();
    const finding = findingsOf(exported, 'st-png-base-image-required');
    expect(finding).toHaveLength(1);
    expect(finding[0]?.detail).toContain('§10.5');
  });

  it('a V3 card is read from ccv3 and written back with both chunks', () => {
    const imported = importStCharacterCardPng(bytesOf(ST_CARD_V3_PNG_BASE64));
    expect(imported.chunk).toBe(ST_CCV3_CHUNK);
    expect(imported.specVersion).toBe(3);
    const card = cardOf(imported);

    const exported = exportStCharacterCardPng(card, { baseImage: bytesOf(ST_BASE_PNG_BASE64) });
    const keywords = readPngChunks(bytesOfResult(exported)).chunks.map((chunk) => keywordOf(chunk));
    expect(keywords.filter((keyword) => keyword === ST_CHARA_CHUNK)).toHaveLength(1);
    expect(keywords.filter((keyword) => keyword === ST_CCV3_CHUNK)).toHaveLength(1);
    // The compat copy in `chara` is the same card under a V2 marker, so a V2-only
    // reader still gets every field it understands.
    const compat = cardDocumentOf(bytesOfResult(exported));
    expect(memberOf(compat, 'spec')).toBe('chara_card_v2');
    expect(memberOf(dataOf(compat), 'nickname')).toBe('Bram');
    expect(cardOf(importStCharacterCardPng(bytesOfResult(exported)))).toEqual(card);
  });

  it('a chara chunk that is not base64, not JSON or not an object is a finding, not a throw', () => {
    const base = bytesOf(ST_BASE_PNG_BASE64);
    const notBase64 = importStCharacterCardPng(
      withChunk(base, textChunk(ST_CHARA_CHUNK, 'not base64!!')),
    );
    expect(notBase64.card).toBeUndefined();
    expect(codesOf(notBase64)).toEqual(['st-not-base64']);

    const notJson = importStCharacterCardPng(
      withChunk(base, textChunk(ST_CHARA_CHUNK, encodeBase64(new TextEncoder().encode('{oops')))),
    );
    expect(codesOf(notJson)).toEqual(['st-not-json']);

    const notAnObject = importStCharacterCardPng(
      withChunk(
        base,
        textChunk(ST_CHARA_CHUNK, encodeBase64(new TextEncoder().encode('"a string"'))),
      ),
    );
    expect(codesOf(notAnObject)).toEqual(['st-card-shape']);
  });

  it('a chara chunk whose CRC does not match is refused rather than trusted', () => {
    const card = bytesOf(ST_CARD_PNG_BASE64);
    const damaged = Uint8Array.from(card);
    const chara = readPngChunks(card).chunks.find((chunk) => keywordOf(chunk) === ST_CHARA_CHUNK);
    if (chara === undefined) throw new Error('the fixture has no chara chunk');
    // Flip a byte of the base64 PAYLOAD (past `chara\0`), so the chunk is still
    // recognisable and the damaged CRC is what refuses it.
    damaged[chara.offset + 8 + 10] = (damaged[chara.offset + 8 + 10] ?? 0) ^ 0xff;

    const read = importStCharacterCardPng(damaged);
    expect(read.card).toBeUndefined();
    const finding = findingsOf(read, 'st-png-payload-corrupt');
    expect(finding).toHaveLength(1);
    expect(finding[0]?.where).toBe(`tEXt:${ST_CHARA_CHUNK}@${chara.offset}`);
  });

  it('an image with no card chunk, and a zTXt card chunk, are reported not guessed', () => {
    const base = bytesOf(ST_BASE_PNG_BASE64);
    const missing = importStCharacterCardPng(base);
    expect(missing.card).toBeUndefined();
    expect(codesOf(missing)).toEqual(['st-png-missing-chara-chunk']);

    // zTXt is a legal PNG text chunk, so a compressed card chunk is real territory;
    // it needs an inflater this package does not carry, and the reader says that
    // instead of handing compressed bytes back as if they were text.
    const compressed = withChunk(
      base,
      makeChunk(
        'zTXt',
        new Uint8Array([...new TextEncoder().encode(ST_CHARA_CHUNK), 0, 0, 1, 2, 3]),
      ),
    );
    const read = importStCharacterCardPng(compressed);
    expect(codesOf(read)).toEqual(['st-png-unsupported-text-chunk', 'st-png-missing-chara-chunk']);
  });

  it('an unknown spec version inside a PNG is a finding, not a throw', () => {
    const payload = encodeBase64(
      new TextEncoder().encode(
        JSON.stringify({ spec: 'chara_card_v4', spec_version: '4.0', data: {} }),
      ),
    );
    const read = importStCharacterCardPng(
      withChunk(bytesOf(ST_BASE_PNG_BASE64), textChunk(ST_CHARA_CHUNK, payload)),
    );
    expect(read.card).toBeUndefined();
    expect(codesOf(read)).toEqual(['st-unknown-spec-version']);
  });
});
