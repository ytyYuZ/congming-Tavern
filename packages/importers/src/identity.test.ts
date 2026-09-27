/**
 * The identity policy, table-driven (`docs/04` §7's ID conflict table and §12 items
 * 9, 10, 12).
 *
 * The clause tests in `contract-regression.test.ts` prove the policy END TO END
 * through a real export/import. This file proves the DECISION TABLE itself, row by
 * row, because that is where a subtle ordering mistake lives — "reuse before
 * remap" is what makes the second import idempotent, and a table is the only
 * readable way to state it.
 */
import { describe, expect, it } from 'vitest';
import {
  decideIdentity,
  IMPORT_EXTENSION_KEYS,
  originIdOf,
  provenanceExtensions,
  stripImportExtensions,
} from './identity';

const ALICE = { name: 'Alice', description: 'The lamplighter.' };
const ALICIA = { name: 'Alice', description: 'An edited description.' };

interface Case {
  readonly name: string;
  readonly packageId: string;
  readonly entityName?: string;
  readonly content: unknown;
  readonly locals: readonly {
    id: string;
    originId?: string;
    name?: string;
    content: unknown;
  }[];
  readonly expected: unknown;
}

const CASES: readonly Case[] = [
  {
    name: 'unknown content is created under the package id',
    packageId: 'P1',
    content: ALICE,
    locals: [],
    expected: { action: 'create', id: 'P1', reason: 'not-present' },
  },
  {
    name: 'identical content at the same id is reused',
    packageId: 'L1',
    content: ALICE,
    locals: [{ id: 'L1', content: ALICE }],
    expected: { action: 'reuse', id: 'L1', reason: 'identical-content' },
  },
  {
    name: 'identical content recorded for this origin is reused after a remap',
    packageId: 'P1',
    content: ALICE,
    locals: [{ id: 'N1', originId: 'P1', content: ALICE }],
    expected: { action: 'reuse', id: 'N1', reason: 'from-earlier-import' },
  },
  {
    name: 'identical content under the same name is reused even when the id differs',
    packageId: 'P1',
    entityName: 'Alice',
    content: ALICE,
    locals: [{ id: 'L1', name: 'Alice', content: ALICE }],
    expected: { action: 'reuse', id: 'L1', reason: 'identical-content' },
  },
  {
    name: 'the same id with DIFFERENT content is remapped (§7)',
    packageId: 'L1',
    entityName: 'Alice',
    content: ALICIA,
    locals: [{ id: 'L1', name: 'Alice', content: ALICE }],
    expected: { action: 'remap', originId: 'L1', reason: 'id-collision-content-differs' },
  },
  {
    name: 'another id, same name, DIFFERENT content is remapped (item 10)',
    packageId: 'P1',
    entityName: 'Alice',
    content: ALICIA,
    locals: [{ id: 'L1', name: 'Alice', content: ALICE }],
    expected: { action: 'remap', originId: 'P1', reason: 'same-name-different-content' },
  },
  {
    name: 'another id, same content but no name to match on, is created (flat entity)',
    packageId: 'P1',
    content: ALICE,
    locals: [{ id: 'L1', name: 'Alice', content: ALICE }],
    expected: { action: 'create', id: 'P1', reason: 'not-present' },
  },
  {
    name: 'the id is checked before the name, so a local rename is not a conflict',
    packageId: 'L1',
    content: ALICE,
    locals: [{ id: 'L1', name: 'Renamed', content: ALICE }],
    expected: { action: 'reuse', id: 'L1', reason: 'identical-content' },
  },
  {
    name: 'an unrelated local row is no obstacle',
    packageId: 'P1',
    entityName: 'Bram',
    content: { name: 'Bram' },
    locals: [{ id: 'L1', name: 'Alice', content: ALICE }],
    expected: { action: 'create', id: 'P1', reason: 'not-present' },
  },
];

describe('decideIdentity', () => {
  it.each(CASES)('$name', (testCase) => {
    expect(
      decideIdentity(
        {
          packageId: testCase.packageId,
          ...(testCase.entityName === undefined ? {} : { name: testCase.entityName }),
          content: testCase.content,
        },
        testCase.locals,
      ),
    ).toEqual(testCase.expected);
  });
});

describe('import provenance in extensions', () => {
  it('writes the package id and the origin id under the x-smarttavern namespace', () => {
    const extensions = provenanceExtensions({ 'x-plugin.keep': 1 }, 'P1', 'PKG');
    expect(extensions).toEqual({
      'x-plugin.keep': 1,
      [IMPORT_EXTENSION_KEYS.originId]: 'P1',
      [IMPORT_EXTENSION_KEYS.importedFrom]: 'PKG',
    });
    expect(originIdOf({ extensions })).toBe('P1');
  });

  it('strips its own keys before comparing content, and drops an emptied bag', () => {
    const row = {
      id: 'N1',
      data: { name: 'Alice' },
      extensions: {
        [IMPORT_EXTENSION_KEYS.originId]: 'P1',
        [IMPORT_EXTENSION_KEYS.importedFrom]: 'PKG',
      },
    };
    expect(stripImportExtensions(row)).toEqual({ id: 'N1', data: { name: 'Alice' } });
  });

  it('keeps foreign extensions, nested, and never mutates the input', () => {
    const row = {
      id: 'N1',
      extensions: {
        'x-plugin.keep': { deep: [1, 2] },
        [IMPORT_EXTENSION_KEYS.originId]: 'P1',
      },
    };
    const stripped = stripImportExtensions(row);
    expect(stripped).toEqual({ id: 'N1', extensions: { 'x-plugin.keep': { deep: [1, 2] } } });
    expect(row.extensions[IMPORT_EXTENSION_KEYS.originId]).toBe('P1');

    const version = {
      id: 'N2',
      version: 1,
      data: { name: 'Alice' },
      extensions: { [IMPORT_EXTENSION_KEYS.importedFrom]: 'PKG' },
    };
    expect(stripImportExtensions(version)).toEqual({
      id: 'N2',
      version: 1,
      data: { name: 'Alice' },
    });
  });

  it('reads no origin id from a row that has none', () => {
    expect(originIdOf({})).toBeUndefined();
    expect(
      originIdOf({ extensions: { [IMPORT_EXTENSION_KEYS.importedFrom]: 'PKG' } }),
    ).toBeUndefined();
  });
});
