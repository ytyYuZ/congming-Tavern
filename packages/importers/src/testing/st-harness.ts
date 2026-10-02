/**
 * Shared helpers for the SillyTavern suites: base64 fixture bytes, loud access to
 * a result's payload, and the finding-code list a test asserts on.
 *
 * WHY THE ACCESSORS THROW: `StCardImport.card` is optional because an import can
 * refuse, and a test that read it with `?.` would pass while asserting nothing.
 * These helpers fail with the finding codes in the message instead, so a refusal
 * names itself in the failure rather than showing up as "undefined is not an
 * object". (Same reasoning as `only()` in `./harness.ts`.)
 *
 * NOTHING HERE IS PRODUCTION CODE, and the module is NOT re-exported from
 * `../index.ts`: a helper that exists to make a failure readable has no business in
 * the adapter's public surface.
 */
import type { CharacterData, WorldbookEntry } from '@smarttavern/schema';
import { decodeBase64 } from '../sillytavern/base64';
import type { StCardImport } from '../sillytavern/character-card';
import type { StFinding, StFindingCode } from '../sillytavern/findings';
import { isRecord } from '../sillytavern/json';
import type { StWorldbookImport } from '../sillytavern/worldbook';

/** The bytes a base64 fixture literal stands for. */
export function bytesOf(base64: string): Uint8Array {
  const decoded = decodeBase64(base64);
  if (decoded.bytes === undefined) {
    throw new Error(`the fixture is not base64: ${decoded.reason ?? 'unknown reason'}`);
  }
  return decoded.bytes;
}

/** An object from fixture data, or a failure that says which fixture was wrong. */
export function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} is not a JSON object`);
  return value;
}

/** The finding codes of a result, in the order they were produced. */
export function codesOf(result: {
  readonly findings: readonly StFinding[];
}): readonly StFindingCode[] {
  return result.findings.map((finding) => finding.code);
}

/** The findings carrying one code. */
export function findingsOf(
  result: { readonly findings: readonly StFinding[] },
  code: StFindingCode,
): readonly StFinding[] {
  return result.findings.filter((finding) => finding.code === code);
}

/** The card an import produced, or a failure naming what the import complained about. */
export function cardOf(result: StCardImport): CharacterData {
  if (result.card === undefined) {
    throw new Error(`the import produced no card: ${JSON.stringify(codesOf(result))}`);
  }
  return result.card;
}

/** The entries a worldbook import produced, or a failure naming its findings. */
export function entriesOf(result: StWorldbookImport): readonly WorldbookEntry[] {
  if (!result.ok && result.entries.length === 0) {
    throw new Error(`the import produced no entries: ${JSON.stringify(codesOf(result))}`);
  }
  return result.entries;
}

/** One entry by id, so a test can name the row it is about. */
export function entryOf(result: StWorldbookImport, id: string): WorldbookEntry {
  const found = result.entries.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no entry ${id}: ${JSON.stringify(result.entries.map((entry) => entry.id))}`);
  }
  return found;
}
