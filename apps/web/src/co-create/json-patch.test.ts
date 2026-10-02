/**
 * The patch engine (M1-W2) — the rules a proposal is held to, asserted on data.
 *
 * WHY THIS FILE IS PURE
 * `co-create/json-patch.ts` decides what a proposal may do to a card, and every rule it applies is a
 * fact about JSON: a pointer either addresses something or it does not, a value either matches the
 * type it replaces or it does not, and a document either survives `WorldDataSchema` or it does not.
 * None of that needs a database or a DOM, so none of it is asserted through one — the store and the
 * screen have their own files (`state/co-create-store.test.ts`, `co-create/panel.test.tsx`).
 */
/** @vitest-environment node */
import type { JsonValue, WorldData } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { blankWorldData } from '../cards/world';
import {
  applyWorldOps,
  arrayIndexOf,
  escapePointerToken,
  isJsonValue,
  MAX_WORLD_OPS,
  pointerTokens,
  readWorldOp,
  type WorldOp,
  worldOpIssues,
} from './json-patch';

/** A world with content to patch: the blank payload (schema-valid) plus one real field value. */
function world(): WorldData {
  return { ...blankWorldData('霜月群岛'), premise: '群岛在霜月下沉', era: '第三纪' };
}

/** The same world with two opening hooks, so an append / insert / remove has a list to work on. */
function worldWithHooks(): WorldData {
  return { ...world(), openingHooks: ['a', 'b'] };
}

/** The ops an answer would produce, read through the real reader (so a fixture cannot be illegal). */
function ops(...values: unknown[]): WorldOp[] {
  return values.map((value, index) => {
    const read = readWorldOp(value as JsonValue);
    if (!read.ok) throw new Error(`fixture ${index} is not an operation`);
    return read.op;
  });
}

describe('JSON Pointer parsing', () => {
  it('splits a pointer into tokens and unescapes ~1 before ~0', () => {
    expect(pointerTokens('/rulesOfNature/taboos')).toEqual(['rulesOfNature', 'taboos']);
    expect(pointerTokens('/customFields/a~1b')).toEqual(['customFields', 'a/b']);
    expect(pointerTokens('/customFields/t~0x')).toEqual(['customFields', 't~x']);
    // The RFC's ORDER matters: `~1` is unescaped first, so `~01` is the two characters `~1` and not
    // a `/`. (Reversing the two substitutions is the classic way to get this wrong.)
    expect(pointerTokens('/customFields/~01')).toEqual(['customFields', '~1']);
    expect(pointerTokens('')).toEqual([]);
  });

  it('refuses what is not a pointer, including the RFC’s append token', () => {
    expect(pointerTokens('premise')).toBeUndefined();
    // `-` is the RFC's "past the last element" token, and this engine refuses it: an append is spelled
    // with the operation's own `at` (absent = append), so `-` would be a second way to say one thing.
    expect(pointerTokens('/openingHooks/-')).toBeUndefined();
    expect(pointerTokens('/a/~2')).toBeUndefined();
    expect(arrayIndexOf('01')).toBeUndefined();
    expect(arrayIndexOf('1')).toBe(1);
  });

  it('round-trips a token through the escape the app builds pointers with', () => {
    for (const token of ['notes', 'a/b', 'x~y', '~1', '']) {
      const pointer = `/customFields/${escapePointerToken(token)}`;
      expect(pointerTokens(pointer)).toEqual(['customFields', token]);
    }
  });
});

describe('reading an untrusted operation', () => {
  it('reads the three verbs with their value and refuses anything else', () => {
    const replace = readWorldOp({ op: 'replace', path: '/premise', value: 'x' });
    expect(replace.ok && replace.op).toEqual({ op: 'replace', path: '/premise', value: 'x' });
    expect(readWorldOp({ op: 'move', path: '/premise' }).ok).toBe(false);
    expect(readWorldOp({ op: 'replace' }).ok).toBe(false);
    expect(readWorldOp('nope').ok).toBe(false);
    expect(readWorldOp([]).ok).toBe(false);
  });

  it('keeps an `at` only for `add`, and reports a value it cannot use', () => {
    const withAt = readWorldOp({ op: 'add', path: '/openingHooks', value: 'a', at: 0 });
    expect(withAt.ok && withAt.op.at).toBe(0);
    // `at` on a `replace` is not this engine's language: the verb carries no insertion point.
    const onReplace = readWorldOp({ op: 'replace', path: '/premise', value: 'x', at: 2 });
    expect(onReplace.ok && onReplace.op.at).toBeUndefined();
    const nulled = readWorldOp({ op: 'replace', path: '/premise', value: null });
    expect(nulled.ok && nulled.warnings).toEqual(['null-value']);
  });

  it('answers `isJsonValue` for what JSON can hold', () => {
    expect(isJsonValue({ a: [1, 'two', false, null] })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonValue({ a: undefined })).toBe(false);
  });
});

describe('applying a proposal’s operations', () => {
  it('replaces a leaf, and cannot set a string field to a number or to null', () => {
    expect(
      applyWorldOps(world(), ops({ op: 'replace', path: '/premise', value: '新的一句' })),
    ).toEqual({ ok: true, data: { ...world(), premise: '新的一句' } });
    expect(worldOpIssues(world(), ops({ op: 'replace', path: '/premise', value: 3 }))).toEqual([
      { index: 0, op: 'replace', path: '/premise', kind: 'type-mismatch' },
    ]);
    expect(worldOpIssues(world(), ops({ op: 'replace', path: '/premise', value: null }))).toEqual([
      { index: 0, op: 'replace', path: '/premise', kind: 'type-mismatch' },
    ]);
  });

  it('keeps a whole number where a number is expected and refuses a fraction', () => {
    const whole = applyWorldOps(world(), ops({ op: 'replace', path: '/startMinute', value: 90 }));
    expect(whole.ok && whole.data.startMinute).toBe(90);
    expect(
      worldOpIssues(world(), ops({ op: 'replace', path: '/startMinute', value: 1.5 })),
    ).toEqual([{ index: 0, op: 'replace', path: '/startMinute', kind: 'type-mismatch' }]);
  });

  it('appends to a list, inserts at `at`, and removes a member', () => {
    const appended = applyWorldOps(
      worldWithHooks(),
      ops({ op: 'add', path: '/openingHooks', value: '灯灭之前' }),
    );
    expect(appended.ok && appended.data.openingHooks).toEqual(['a', 'b', '灯灭之前']);

    const inserted = applyWorldOps(
      worldWithHooks(),
      ops({ op: 'add', path: '/openingHooks', value: 'x', at: 1 }),
    );
    expect(inserted.ok && inserted.data.openingHooks).toEqual(['a', 'x', 'b']);

    const removed = applyWorldOps(worldWithHooks(), ops({ op: 'remove', path: '/openingHooks/0' }));
    expect(removed.ok && removed.data.openingHooks).toEqual(['b']);

    // ...and an EMPTY list is the append case the form's 「添加」 produces, where `at` is absent.
    const intoEmpty = applyWorldOps(
      world(),
      ops({ op: 'add', path: '/openingHooks', value: 'first' }),
    );
    expect(intoEmpty.ok && intoEmpty.data.openingHooks).toEqual(['first']);
  });

  it('refuses an add onto an existing member — `replace` is the verb for that', () => {
    expect(worldOpIssues(world(), ops({ op: 'add', path: '/premise', value: 'x' }))).toEqual([
      { index: 0, op: 'add', path: '/premise', kind: 'member-exists' },
    ]);
    // ...and it CAN create a new custom field, which is the one place a new key is ordinary.
    const added = applyWorldOps(
      world(),
      ops({ op: 'add', path: '/customFields/Weather', value: '暴雪' }),
    );
    expect(added.ok && added.data.customFields).toEqual({ Weather: '暴雪' });
  });

  it('refuses a path that is not there, the root, and a list index out of range', () => {
    expect(worldOpIssues(world(), ops({ op: 'replace', path: '/nope', value: 'x' }))).toEqual([
      { index: 0, op: 'replace', path: '/nope', kind: 'path-missing' },
    ]);
    expect(worldOpIssues(world(), ops({ op: 'replace', path: '', value: 'x' }))).toEqual([
      { index: 0, op: 'replace', path: '', kind: 'root' },
    ]);
    // A list index that is not inside the list — on an EMPTY list, index 0 is already out of range,
    // which is why an insert into a list the world does not have yet is `add` on the LIST itself.
    expect(worldOpIssues(world(), ops({ op: 'remove', path: '/openingHooks/0' }))).toEqual([
      { index: 0, op: 'remove', path: '/openingHooks/0', kind: 'path-missing' },
    ]);
    // An `at` past the end of a list is not an insertion point this engine has.
    expect(
      worldOpIssues(worldWithHooks(), ops({ op: 'add', path: '/openingHooks', value: 'x', at: 5 })),
    ).toEqual([{ index: 0, op: 'add', path: '/openingHooks', kind: 'path-missing' }]);
  });

  it('reports the FIRST failing operation and checks the rest against its result', () => {
    const issues = worldOpIssues(
      world(),
      ops(
        { op: 'replace', path: '/premise', value: 'ok' },
        { op: 'replace', path: '/missing', value: 'x' },
        { op: 'replace', path: '/era', value: 'y' },
      ),
    );
    expect(issues).toEqual([{ index: 1, op: 'replace', path: '/missing', kind: 'path-missing' }]);
  });

  it('refuses a patch over the operation bound with its own reason', () => {
    const many: unknown[] = Array.from({ length: MAX_WORLD_OPS + 1 }, () => ({
      op: 'replace',
      path: '/premise',
      value: 'x',
    }));
    expect(worldOpIssues(world(), ops(...many))).toEqual([
      { index: 0, op: 'add', path: '', kind: 'too-many-ops' },
    ]);
  });

  it('refuses a legal patch whose RESULT is not a world, naming the schema path', () => {
    const result = applyWorldOps(world(), ops({ op: 'replace', path: '/name', value: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([]);
    expect(result.schemaPath).toBe('name');
  });

  it('never mutates the payload it was given — a rejected preview cannot move the draft', () => {
    const data = world();
    const before = JSON.stringify(data);
    applyWorldOps(data, ops({ op: 'replace', path: '/premise', value: 'changed' }));
    applyWorldOps(data, ops({ op: 'add', path: '/openingHooks', value: 'x' }));
    applyWorldOps(data, ops({ op: 'remove', path: '/openingHooks/0' }));
    expect(JSON.stringify(data)).toBe(before);
  });
});
