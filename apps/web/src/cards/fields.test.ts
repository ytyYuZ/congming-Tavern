/**
 * The shared primitives of the two card editors (M1-W1 / M1-C1): the tolerant readers, the
 * 增删改 list transitions, and the two JSON boundaries.
 *
 * WHAT THIS FILE IS DEFENDING
 * 1. A reader NEVER throws and NEVER invents. A damaged member falls back to the value the draft
 *    was based on, and `NaN` or `'12'` must not become a number a later comparison believes — a
 *    silent `Number('')` is how a cleared field turns into a valid-looking zero.
 * 2. A list transition returns a NEW array and leaves its input untouched. That is ADR-010's rule
 *    applied to the form's own state: a value a row already holds must not be edited in place.
 * 3. The line-oriented round trip is EXACT, including the empty list and a trailing blank line —
 *    the half-typed state a textarea passes through on the way to a second item.
 */
import { describe, expect, it } from 'vitest';
import {
  appendItem,
  asBoolean,
  asList,
  asNumber,
  asOptionalNumber,
  asString,
  asStringList,
  asStringRecord,
  itemsOfLines,
  jsonObject,
  linesOf,
  moveItem,
  removeItem,
  toJson,
  withItem,
} from './fields';

describe('jsonObject', () => {
  it('accepts an object and refuses everything that is not one', () => {
    expect(jsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(jsonObject({})).toEqual({});
    expect(jsonObject(null)).toBeUndefined();
    expect(jsonObject([])).toBeUndefined();
    expect(jsonObject('x')).toBeUndefined();
    expect(jsonObject(7)).toBeUndefined();
    expect(jsonObject(undefined)).toBeUndefined();
  });
});

describe('the typed readers', () => {
  const source = { text: 'ok', count: 3, ratio: 1.5, flag: true, list: ['a', 'b'] };

  it('reads the type it was written with', () => {
    expect(asString(source, 'text', 'fallback')).toBe('ok');
    expect(asNumber(source, 'count', 0)).toBe(3);
    expect(asBoolean(source, 'flag', false)).toBe(true);
    expect(asStringList(source, 'list', [])).toEqual(['a', 'b']);
  });

  it('falls back for a missing key and for the wrong type', () => {
    expect(asString(source, 'missing', 'fallback')).toBe('fallback');
    expect(asString(source, 'count', 'fallback')).toBe('fallback');
    expect(asNumber(source, 'text', -1)).toBe(-1);
    expect(asBoolean(source, 'text', false)).toBe(false);
    expect(asStringList(source, 'text', ['kept'])).toEqual(['kept']);
    expect(asOptionalNumber(source, 'text')).toBeUndefined();
    expect(asOptionalNumber(source, 'ratio')).toBe(1.5);
  });

  it('refuses a non-finite number instead of carrying it forward', () => {
    // `Infinity` cannot be stored in a `JsonValue` at all, and `NaN` would poison every later
    // comparison (`db/repository.ts`'s clock check makes the same point).
    expect(asNumber({ value: Number.NaN }, 'value', 0)).toBe(0);
    expect(asNumber({ value: Number.POSITIVE_INFINITY }, 'value', 0)).toBe(0);
  });

  it('drops non-string members of a list rather than coercing them', () => {
    expect(asStringList({ list: ['a', 1, null, 'b'] }, 'list', [])).toEqual(['a', 'b']);
    expect(asStringList({ list: [] }, 'list', ['fallback'])).toEqual([]);
  });

  it('reads a string record and refuses non-string members', () => {
    expect(asStringRecord({ fields: { a: 'x', b: 2 } }, 'fields', {})).toEqual({ a: 'x' });
    expect(asStringRecord({ fields: 'x' }, 'fields', { kept: 'yes' })).toEqual({ kept: 'yes' });
  });

  it('completes list members through a hydrator and drops what it refuses', () => {
    const lists = { rows: [{ name: 'a' }, 'not an object', { name: 'b' }] };
    const rows = asList(lists, 'rows', (member) => {
      const source_ = jsonObject(member);
      return source_ === undefined ? undefined : asString(source_, 'name', '');
    });
    expect(rows).toEqual(['a', 'b']);
  });

  it('falls back for a member that is not a list at all, but honours an empty one', () => {
    expect(asList({ rows: 'x' }, 'rows', () => 'kept', ['kept'])).toEqual(['kept']);
    expect(asList({}, 'rows', () => 'kept', ['kept'])).toEqual(['kept']);
    expect(asList({ rows: [] }, 'rows', () => 'kept', ['kept'])).toEqual([]);
  });
});

describe('the list transitions', () => {
  const items = ['a', 'b', 'c'];

  it('replaces, appends and removes without touching the input', () => {
    const replaced = withItem(items, 1, 'B');
    const appended = appendItem(items, 'd');
    const removed = removeItem(items, 1);
    expect(replaced).toEqual(['a', 'B', 'c']);
    expect(appended).toEqual(['a', 'b', 'c', 'd']);
    expect(removed).toEqual(['a', 'c']);
    // The INPUT is what a row may already hold: every transition returns a new array.
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('treats an out-of-range index as a no-op instead of a throw', () => {
    expect(withItem(items, 9, 'x')).toBe(items);
    expect(withItem(items, -1, 'x')).toBe(items);
    expect(removeItem(items, 9)).toBe(items);
    expect(removeItem(items, -1)).toBe(items);
  });

  it('moves one step in either direction and refuses to move past an end', () => {
    expect(moveItem(items, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(items, 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(items, 0, -1)).toBe(items);
    expect(moveItem(items, 2, 1)).toBe(items);
    expect(moveItem(items, 9, -1)).toBe(items);
  });
});

describe('the line-oriented lists', () => {
  it('round-trips an ordinary list', () => {
    expect(itemsOfLines(linesOf(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('round-trips the empty list and the half-typed trailing line', () => {
    // Both are states a user passes through on the way to a second item, and neither may lose
    // the caret's position or invent an item.
    expect(itemsOfLines(linesOf([]))).toEqual([]);
    expect(linesOf([])).toBe('');
    expect(itemsOfLines('a\n')).toEqual(['a', '']);
    expect(itemsOfLines(linesOf(['a', '']))).toEqual(['a', '']);
  });
});

describe('toJson', () => {
  it('drops absent optional members instead of asserting them', () => {
    const value = toJson({ kept: 'x', gone: undefined, nested: { alsoGone: undefined } });
    expect(value).toEqual({ kept: 'x', nested: {} });
  });

  it('produces a value that survives a JSON round trip unchanged', () => {
    const value = toJson({ list: ['a'], nested: { count: 2 } });
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});
