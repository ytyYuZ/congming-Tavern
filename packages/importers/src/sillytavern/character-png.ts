/**
 * SillyTavern character card PNG: the same card JSON, base64-encoded into a PNG
 * `tEXt` chunk (`docs/01` F9-1 / F9-2).
 *
 * WHAT IS IN THE FILE
 * A SillyTavern card is an ordinary PNG (an avatar) whose `tEXt` chunk named
 * `chara` holds the base64 of the card JSON — the JSON `./character-card.ts`
 * maps. A V3 card ALSO carries a `ccv3` chunk with the V3 document, so an older
 * reader still finds the `chara` copy it understands. This module therefore:
 *
 *   read     prefers `ccv3` when both exist (it is the fuller document), falls back
 *            to `chara`, and reports which one it used; a `zTXt`/`iTXt` `chara`
 *            chunk is NOT decoded (`zTXt` would need an inflater this package
 *            does not carry) and is reported instead of guessed at.
 *   write    always writes `chara`, and writes `ccv3` as well when the document
 *            version is 3 — with the same `data` object, because the two chunks
 *            are two views of one card and a divergent compatibility copy is a
 *            bug waiting for a reader to pick the wrong one.
 *
 * WHAT IT REFUSES, AND HOW
 * A file that is not a PNG, a chunk whose length runs past the buffer, a `chara`
 * chunk with a bad CRC, a payload that is not base64, and base64 that is not UTF-8
 * JSON are each an ERROR finding with a locator — never a thrown parse, so one bad
 * card cannot take an import queue down with it.
 *
 * PNG EXPORT NEEDS A BASE IMAGE, AND SAYS SO
 * `docs/06` §10.5 records that this project has no asset pipeline: there is no
 * image generator, no thumbnailer and no stored avatar for a card
 * (`visual.references[].assetId` may dangle). Writing "a PNG" would therefore mean
 * either inventing pixels or emitting an empty image with the card in it — the
 * second is worse, because it looks like a working export. So PNG export takes the
 * SOURCE IMAGE as an explicit input (`baseImage`) and, without one, returns
 * `st-png-base-image-required` and NO bytes. The caller that has an avatar (the
 * file the user dropped, or an asset the store actually holds) passes it here, and
 * every chunk of it other than the card chunk is carried through byte-identical.
 */

import type { CharacterData } from '@smarttavern/schema';
import { canonicalJsonStringify } from '../canonical-json';
import { decodeBase64, encodeBase64 } from './base64';
import {
  exportStCharacterCardJson,
  importStCharacterCardJson,
  type StCardExportOptions,
  type StCardImport,
  type StCardSpecVersion,
} from './character-card';
import { type StFinding, stFinding, stOk } from './findings';
import { describeValue, isRecord } from './json';
import { keywordOf, type PngChunk, readPngChunks, textBodyOf, withTextChunk } from './png';

/** The card chunk SillyTavern writes for V1/V2 documents. */
export const ST_CHARA_CHUNK = 'chara';

/** The V3 document chunk, which SillyTavern writes beside `chara`. */
export const ST_CCV3_CHUNK = 'ccv3';

/** Either card chunk name — a `tEXt` keyword, not free text. */
export type StCardChunkKeyword = typeof ST_CHARA_CHUNK | typeof ST_CCV3_CHUNK;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A PNG card import, plus the chunk the card was read from. */
export interface StPngCardImport extends StCardImport {
  readonly chunk?: StCardChunkKeyword;
}

export interface StPngCardExportOptions extends StCardExportOptions {
  /**
   * The image the card is embedded in. Required: see the header — there is no
   * asset pipeline to draw one, and a PNG without the avatar is not a card.
   */
  readonly baseImage?: Uint8Array;
}

export interface StPngCardExport {
  readonly ok: boolean;
  /** The rebuilt image; absent whenever `ok` is false. */
  readonly bytes?: Uint8Array;
  readonly specVersion?: StCardSpecVersion;
  readonly findings: readonly StFinding[];
}

/** The `tEXt` chunks that could carry a card, in file order, with their keyword. */
interface CardChunk {
  readonly chunk: PngChunk;
  readonly keyword: StCardChunkKeyword;
}

function cardChunksOf(chunks: readonly PngChunk[], findings: StFinding[]): readonly CardChunk[] {
  const found: CardChunk[] = [];
  for (const chunk of chunks) {
    const keyword = keywordOf(chunk);
    if (keyword !== ST_CHARA_CHUNK && keyword !== ST_CCV3_CHUNK) continue;
    if (chunk.type !== 'tEXt') {
      findings.push(
        stFinding(
          'st-png-unsupported-text-chunk',
          `the ${keyword} card chunk is a ${chunk.type} chunk; only the uncompressed tEXt form SillyTavern writes is read`,
          `${chunk.type}@${chunk.offset}`,
        ),
      );
      continue;
    }
    found.push({ chunk, keyword });
  }
  return found;
}

/** Read a character card out of a PNG's `chara` (or `ccv3`) chunk. */
export function importStCharacterCardPng(bytes: Uint8Array): StPngCardImport {
  const read = readPngChunks(bytes);
  const findings: StFinding[] = [...read.findings];
  if (!read.ok) return { ok: false, findings };

  const candidates = cardChunksOf(read.chunks, findings);
  if (candidates.length === 0) {
    findings.push(
      stFinding(
        'st-png-missing-chara-chunk',
        'the image has no tEXt chunk named chara or ccv3, so it carries no character card',
      ),
    );
    return { ok: false, findings };
  }

  // `ccv3` first: when both chunks exist it is the document with the V3 members,
  // and reading `chara` instead would silently drop them.
  const ordered = [
    ...candidates.filter((candidate) => candidate.keyword === ST_CCV3_CHUNK),
    ...candidates.filter((candidate) => candidate.keyword === ST_CHARA_CHUNK),
  ];
  const first = ordered[0];
  if (first === undefined) return { ok: false, findings };
  for (const keyword of [ST_CCV3_CHUNK, ST_CHARA_CHUNK]) {
    const count = candidates.filter((candidate) => candidate.keyword === keyword).length;
    if (count > 1) {
      findings.push(
        stFinding(
          'st-png-duplicate-chunk',
          `the image carries ${count} ${keyword} chunks; the first is read and the others are ignored`,
          keyword,
        ),
      );
    }
  }

  const locator = `tEXt:${first.keyword}@${first.chunk.offset}`;
  if (first.chunk.declaredCrc !== first.chunk.computedCrc) {
    findings.push(
      stFinding(
        'st-png-payload-corrupt',
        `the ${first.keyword} chunk's CRC is ${first.chunk.declaredCrc} but its bytes compute ${first.chunk.computedCrc}, so the payload cannot be trusted`,
        locator,
      ),
    );
    return { ok: false, findings };
  }

  const body = textBodyOf(first.chunk);
  if (typeof body === 'string') {
    findings.push(
      stFinding(
        'st-png-corrupt-chunk',
        `the ${first.keyword} chunk is malformed: ${body}`,
        locator,
      ),
    );
    return { ok: false, findings };
  }

  const decoded = decodeBase64(body.text);
  if (decoded.bytes === undefined) {
    findings.push(
      stFinding(
        'st-not-base64',
        `the ${first.keyword} chunk is not base64: ${decoded.reason ?? 'unknown reason'}`,
        locator,
      ),
    );
    return { ok: false, findings };
  }

  let text: string;
  try {
    text = UTF8.decode(decoded.bytes);
  } catch (cause) {
    findings.push(
      stFinding(
        'st-not-json',
        `the decoded ${first.keyword} payload is not UTF-8 text: ${String(cause)}`,
        locator,
      ),
    );
    return { ok: false, findings };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    findings.push(
      stFinding(
        'st-not-json',
        `the decoded ${first.keyword} payload is not JSON: ${String(cause)}`,
        locator,
      ),
    );
    return { ok: false, findings };
  }

  if (!isRecord(value)) {
    findings.push(
      stFinding(
        'st-card-shape',
        `the ${first.keyword} payload is ${describeValue(value)}, not a card object`,
        locator,
      ),
    );
    return { ok: false, findings };
  }

  const mapped = importStCharacterCardJson(value);
  findings.push(...mapped.findings);
  return {
    ok: stOk(findings),
    ...(mapped.card === undefined ? {} : { card: mapped.card }),
    ...(mapped.specVersion === undefined ? {} : { specVersion: mapped.specVersion }),
    ...(mapped.characterBook === undefined ? {} : { characterBook: mapped.characterBook }),
    chunk: first.keyword,
    findings,
  };
}

/** The base64 a card document takes inside a PNG text chunk. */
function chunkText(document: unknown): string {
  return encodeBase64(new TextEncoder().encode(canonicalJsonStringify(document)));
}

/**
 * Embed a card in `options.baseImage` and return the image bytes.
 *
 * No base image → no PNG (see the header); a base image that is not a readable PNG
 * → the findings from `./png.ts` and no bytes.
 */
export function exportStCharacterCardPng(
  card: CharacterData,
  options: StPngCardExportOptions = {},
): StPngCardExport {
  const findings: StFinding[] = [];
  const baseImage = options.baseImage;
  if (baseImage === undefined) {
    findings.push(
      stFinding(
        'st-png-base-image-required',
        'embedding a card in a PNG needs the source image: this project has no asset pipeline and no image generator (docs/06 §10.5), so no PNG is produced without one',
      ),
    );
    return { ok: false, findings };
  }

  const read = readPngChunks(baseImage);
  findings.push(...read.findings);
  if (!read.ok) return { ok: false, findings };

  const exported = exportStCharacterCardJson(card, options);
  findings.push(...exported.findings);
  if (!exported.ok || exported.value === undefined || exported.specVersion === undefined) {
    return { ok: false, findings };
  }

  // A V3 card is written the way SillyTavern writes it: `chara` holds a
  // V2-marked copy (so a reader that only knows V2 still finds every field it
  // understands) and `ccv3` holds the V3 document. The two differ only in the spec
  // markers — it is one card seen by two readers.
  const compatibility =
    exported.specVersion === 3 && isRecord(exported.value)
      ? { ...exported.value, spec: 'chara_card_v2', spec_version: '2.0' }
      : exported.value;

  const withChara = withTextChunk(baseImage, ST_CHARA_CHUNK, chunkText(compatibility));
  findings.push(...withChara.findings);
  if (withChara.bytes === undefined) return { ok: false, findings };

  let bytes = withChara.bytes;
  if (exported.specVersion === 3) {
    const withCcv3 = withTextChunk(bytes, ST_CCV3_CHUNK, chunkText(exported.value));
    findings.push(...withCcv3.findings);
    if (withCcv3.bytes === undefined) return { ok: false, findings };
    bytes = withCcv3.bytes;
  }

  return { ok: stOk(findings), bytes, specVersion: exported.specVersion, findings };
}
