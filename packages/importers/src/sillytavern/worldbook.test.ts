/**
 * SillyTavern world info ⇄ `WorldbookEntry[]` (`docs/06` §2.6 M1-I1, `docs/01`
 * F9-3), in both ST shapes: the standalone `{entries: {uid: …}}` file and the V2
 * card's `character_book`.
 *
 * THE KEY FIELDS, NAMED: `keywords` (`key`/`keys`), `content`, `priority`
 * (`order`/`insertion_order`), `position`, `depth`, `probability`, `enabled`
 * (`disable`), `comment` — asserted per entry against literals a reviewer can check
 * by eye against `../testing/st-fixtures.ts`. The ST members our entity has no home
 * for (`keysecondary`, `selective`, `constant`, `scanDepth`, the entry's own
 * `extensions`, …) are asserted to be REPORTED and to come back on export; and the
 * one case where our own model is the narrower side — time conditions, and an
 * `in_history` slot a `character_book` cannot spell — is asserted to be reported as
 * well, because a silent behaviour change is the failure this whole report exists to
 * prevent.
 */
import { type WorldbookEntry, WorldbookEntrySchema } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { memberOf } from '../sillytavern/json';
import {
  exportStCharacterBook,
  exportStWorldInfo,
  importStCharacterBook,
  importStWorldInfo,
  parseStWorldInfo,
} from '../sillytavern/worldbook';
import { ST_CHARACTER_BOOK, ST_WORLD_INFO } from '../testing/st-fixtures';
import { codesOf, entriesOf, entryOf, findingsOf, recordOf } from '../testing/st-harness';

const OPTIONS = { worldId: 'world-1' } as const;

/** The key fields of one entry, as a table a failure can point into. */
interface Expected {
  readonly id: string;
  readonly keywords: readonly string[];
  readonly content: string;
  readonly priority: number;
  readonly position: WorldbookEntry['position'];
  readonly depth: number;
  readonly probability: number;
  readonly enabled: boolean;
  readonly comment: string;
}

/** What the world info fixture says, hand-read from `st-fixtures.ts`. */
const EXPECTED: readonly Expected[] = [
  {
    id: '0',
    keywords: ['lamp', 'wick'],
    content: 'The lamp burns whale oil.',
    priority: 10,
    position: 'pre_history',
    depth: 4,
    probability: 100,
    enabled: true,
    comment: 'The lamp',
  },
  {
    id: '1',
    keywords: ['storm'],
    content: 'The wind turns outside the harbour.',
    priority: 20,
    position: 'in_history',
    depth: 2,
    probability: 40,
    enabled: false,
    comment: 'The storm',
  },
  {
    id: '2',
    keywords: ['single-key'],
    content: 'Sometimes the lamp gutters for no reason.',
    priority: 30,
    position: 'pre_history',
    depth: 1,
    probability: 100,
    enabled: true,
    comment: 'Odds and ends',
  },
];

/** Assert every key field of one entry, as `{ field, value }` so a failure names it. */
function expectKeyFields(entry: WorldbookEntry, expected: Expected): void {
  expect({ id: entry.id, field: 'keywords', value: entry.keywords }).toEqual({
    id: expected.id,
    field: 'keywords',
    value: expected.keywords,
  });
  expect({ id: entry.id, field: 'content', value: entry.content }).toEqual({
    id: expected.id,
    field: 'content',
    value: expected.content,
  });
  expect({ id: entry.id, field: 'priority', value: entry.priority }).toEqual({
    id: expected.id,
    field: 'priority',
    value: expected.priority,
  });
  expect({ id: entry.id, field: 'position', value: entry.position }).toEqual({
    id: expected.id,
    field: 'position',
    value: expected.position,
  });
  expect({ id: entry.id, field: 'depth', value: entry.depth }).toEqual({
    id: expected.id,
    field: 'depth',
    value: expected.depth,
  });
  expect({ id: entry.id, field: 'probability', value: entry.probability }).toEqual({
    id: expected.id,
    field: 'probability',
    value: expected.probability,
  });
  expect({ id: entry.id, field: 'enabled', value: entry.enabled }).toEqual({
    id: expected.id,
    field: 'enabled',
    value: expected.enabled,
  });
  expect({ id: entry.id, field: 'comment', value: entry.comment }).toEqual({
    id: expected.id,
    field: 'comment',
    value: expected.comment,
  });
}

describe('SillyTavern world info', () => {
  it('F9-3 a world info file round-trips every key field of every entry', () => {
    const imported = importStWorldInfo(ST_WORLD_INFO, OPTIONS);
    expect(imported.ok).toBe(true);
    expect(imported.form).toBe('world_info');
    const entries = entriesOf(imported);
    expect(entries.map((entry) => entry.id)).toEqual(['0', '1', '2']);
    for (const expected of EXPECTED) expectKeyFields(entryOf(imported, expected.id), expected);
    // Every entry belongs to the world the caller named: ST world info has no world.
    expect(entries.every((entry) => entry.worldId === 'world-1')).toBe(true);

    const exported = exportStWorldInfo(entries);
    expect(exported.ok).toBe(true);
    const again = importStWorldInfo(exported.value, OPTIONS);
    expect(entriesOf(again)).toEqual(entries);
  });

  it('F9-3 a character_book round-trips its entries and hands the container back', () => {
    const imported = importStCharacterBook(ST_CHARACTER_BOOK, OPTIONS);
    expect(imported.ok).toBe(true);
    expect(imported.form).toBe('character_book');
    const entries = entriesOf(imported);
    expect(entries.map((entry) => entry.id)).toEqual(['0', '1']);

    const first = entryOf(imported, '0');
    expect(first.keywords).toEqual(['lamp', 'wick']);
    expect(first.content).toBe('The lamp burns whale oil, and the wick is trimmed at dusk.');
    expect(first.priority).toBe(10);
    expect(first.position).toBe('pre_history');
    expect(first.depth).toBe(4);
    expect(first.enabled).toBe(true);
    const second = entryOf(imported, '1');
    expect(second.priority).toBe(20);
    expect(second.position).toBe('post_history');
    expect(second.enabled).toBe(false);

    // The book container has no entity in our schema: it comes back as data and is
    // named in a finding, and passing it to export is what keeps it.
    expect(imported.container).toEqual({
      name: 'Lamplighter lore',
      description: 'What the card knows about its own world.',
      scan_depth: 3,
      token_budget: 512,
      recursive_scanning: false,
      extensions: { fixture: 'character_book' },
    });
    expect(
      findingsOf(imported, 'st-field-no-home').some((finding) => finding.where === 'container'),
    ).toBe(true);

    const exported = exportStCharacterBook(entries, { container: imported.container });
    expect(exported.ok).toBe(true);
    const again = importStCharacterBook(exported.value, OPTIONS);
    expect(entriesOf(again)).toEqual(entries);
    expect(again.container).toEqual(imported.container);
  });

  it('ST members with no home are kept as data, named, and written back on export', () => {
    const imported = importStWorldInfo(ST_WORLD_INFO, OPTIONS);
    const noHome = findingsOf(imported, 'st-field-no-home');
    const entryZero = noHome.find((finding) => finding.where === 'entry 0');
    for (const field of [
      'keysecondary',
      'selective',
      'selectiveLogic',
      'scanDepth',
      'extensions',
    ]) {
      expect({ field, named: entryZero?.detail.includes(field) === true }).toEqual({
        field,
        named: true,
      });
    }

    const entry = entryOf(imported, '0');
    const bag = entry.extensions?.['x-smarttavern.st-entry'];
    expect(bag).toBeDefined();

    const exported = exportStWorldInfo(entriesOf(imported));
    const document = recordOf(exported.value, 'the exported world info');
    const written = recordOf(
      memberOf(recordOf(memberOf(document, 'entries'), 'the entries map'), '0'),
      'entry 0',
    );
    expect(memberOf(written, 'keysecondary')).toEqual(['oil']);
    expect(memberOf(written, 'selective')).toBe(true);
    expect(memberOf(written, 'scanDepth')).toBeNull();
    expect(memberOf(written, 'extensions')).toEqual({});
  });

  it('constant: true is reported as a behaviour gap, not silently dropped', () => {
    const imported = importStWorldInfo(ST_WORLD_INFO, OPTIONS);
    const constant = findingsOf(imported, 'st-field-no-home').filter((finding) =>
      finding.detail.startsWith('constant: true'),
    );
    expect(constant).toHaveLength(1);
    expect(constant[0]?.where).toBe('entry 1');
    expect(constant[0]?.severity).toBe('warning');
    // The flag itself survives, and the entry keeps its keys.
    expect(entryOf(imported, '1').keywords).toEqual(['storm']);
  });

  it('a value written in the wrong notation is coerced, and an unusable one is reported', () => {
    const imported = importStWorldInfo(ST_WORLD_INFO, OPTIONS);
    const codes = codesOf(imported);
    expect(codes).toContain('st-field-coerced');
    // Entry 2 writes `key` as a lone string, `order` as "30" and `position` as
    // "before_char"; its fractional `probability` is NOT reported because
    // `useProbability: false` means the number is never read — it is kept instead.
    expect(findingsOf(imported, 'st-field-coerced').length).toBeGreaterThanOrEqual(3);

    const messy = importStWorldInfo(
      {
        entries: {
          '0': {
            uid: 0,
            key: ['lamp'],
            content: 'The lamp burns whale oil.',
            order: 'high',
            disable: 'yes',
            depth: -2,
            position: 7,
            probability: 150,
            useProbability: 'no',
          },
          '1': { uid: 1, key: ['tide'], content: 'The tide.', probability: 33.5 },
        },
      },
      OPTIONS,
    );
    expect(messy.ok).toBe(true);
    expect(codesOf(messy)).toContain('st-field-invalid');
    const entry = entryOf(messy, '0');
    expect(entry.priority).toBe(100);
    expect(entry.enabled).toBe(true);
    expect(entry.depth).toBe(0);
    expect(entry.position).toBe('pre_history');
    expect(entry.probability).toBe(100);
    // A fractional probability is rounded, and the rounding is reported.
    expect(entryOf(messy, '1').probability).toBe(34);
    expect(
      findingsOf(messy, 'st-field-coerced').some((finding) => finding.detail.includes('33.5')),
    ).toBe(true);
  });

  it('an entry id comes from the uid, else the map key, else the position — and says so', () => {
    const byKey = importStWorldInfo(
      { entries: { 'the-lamp': { key: ['lamp'], content: 'c' } } },
      OPTIONS,
    );
    expect(entriesOf(byKey).map((entry) => entry.id)).toEqual(['the-lamp']);
    expect(codesOf(byKey)).not.toContain('st-entry-id-missing');

    const anonymous = importStWorldInfo({ entries: [{ key: ['lamp'], content: 'c' }] }, OPTIONS);
    expect(entriesOf(anonymous).map((entry) => entry.id)).toEqual(['st-entry-0']);
    expect(codesOf(anonymous)).toContain('st-entry-id-missing');

    const minted = importStWorldInfo(ST_WORLD_INFO, {
      worldId: 'world-1',
      newId: (_identity, index) => `imported-${index}`,
    });
    expect(entriesOf(minted).map((entry) => entry.id)).toEqual([
      'imported-0',
      'imported-1',
      'imported-2',
    ]);
  });

  it('two entries that map to the same id are reported', () => {
    const imported = importStWorldInfo(
      { entries: { '0': { uid: 0, content: 'a' }, '1': { uid: 0, content: 'b' } } },
      OPTIONS,
    );
    expect(codesOf(imported)).toContain('st-entry-id-duplicate');
    expect(entriesOf(imported)).toHaveLength(2);
  });

  it('our own fields that ST cannot spell are reported on export', () => {
    const entry = WorldbookEntrySchema.parse({
      id: 'conditional',
      worldId: 'world-1',
      keywords: ['dawn'],
      content: 'The bell rings at dawn.',
      priority: 5,
      position: 'in_history',
      depth: 3,
      probability: 50,
      conditions: { timeOfDay: 'dawn' },
      enabled: true,
      extensions: { 'x-fixture.extra': true },
    });

    const worldInfo = exportStWorldInfo([entry]);
    const losses = findingsOf(worldInfo, 'st-field-no-home').map((finding) => finding.detail);
    expect(losses.some((detail) => detail.includes('conditions'))).toBe(true);
    expect(losses.some((detail) => detail.includes('extensions.x-fixture.extra'))).toBe(true);

    // A character_book position has only before_char/after_char, so in_history is
    // written as after_char — and the finding says exactly what that costs.
    const book = exportStCharacterBook([entry]);
    const position = findingsOf(book, 'st-field-no-home').find((finding) =>
      finding.detail.includes('after_char'),
    );
    expect(position?.detail).toContain('reads back as post_history');
  });

  it('a document that is not world info is refused with a finding, never a throw', () => {
    for (const value of [{}, { entries: 5 }, 'a string', [1, 2]]) {
      const imported = importStWorldInfo(value, OPTIONS);
      expect(imported.entries).toEqual([]);
      expect(imported.ok).toBe(false);
      expect(codesOf(imported)).toContain('st-worldbook-shape');
    }
    const notJson = parseStWorldInfo('not json at all', OPTIONS);
    expect(codesOf(notJson)).toEqual(['st-not-json']);
    expect(notJson.ok).toBe(false);
  });
});
