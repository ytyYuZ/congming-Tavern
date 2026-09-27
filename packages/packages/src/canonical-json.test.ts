import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJsonBytes, canonicalJsonStringify } from './canonical-json';

/**
 * Tests for docs/04-分享格式规范.md §11 v1-r3 ("稳定键序" = canonical JSON).
 *
 * Each block maps to one of the four frozen rules, and the last block pins the
 * "fail loudly" behaviour that `JSON.stringify` gets wrong. No network, no
 * fixtures — the format is small enough to state inline.
 */

describe('canonicalJsonStringify — rule 1: recursive ASCII key order', () => {
  it('sorts top-level object keys by code point', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts nested object keys too', () => {
    expect(canonicalJsonStringify({ z: { beta: 1, alpha: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"alpha":2,"beta":1}}',
    );
  });

  it('sorts objects inside arrays', () => {
    expect(canonicalJsonStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('orders by code point, not by locale collation', () => {
    // `localeCompare` puts uppercase A before lowercase z in some locales and not in
    // others; code-point order is fixed: uppercase < lowercase < punctuation-free.
    expect(canonicalJsonStringify({ z: 1, A: 2, a: 3, Z: 4 })).toBe('{"A":2,"Z":4,"a":3,"z":1}');
    // U+007E (tilde) < U+00E9 (é) < U+4E2D (中): a locale-aware sort could interleave
    // these differently, a code-point sort cannot.
    expect(canonicalJsonStringify({ 中: 1, é: 2, '~': 3 })).toBe('{"~":3,"é":2,"中":1}');
  });

  it('is insensitive to the insertion order of the input', () => {
    const first = canonicalJsonStringify({ b: [1, { d: 1, c: 2 }], a: 'x' });
    const second = canonicalJsonStringify({ a: 'x', b: [1, { c: 2, d: 1 }] });
    expect(first).toBe(second);
  });
});

describe('canonicalJsonStringify — rule 2: arrays keep their order', () => {
  it('never sorts array elements', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJsonStringify(['b', 'a'])).toBe('["b","a"]');
  });

  it('preserves the order of message-like objects in a list', () => {
    const messages = [
      { id: 'm2', parentId: 'm1' },
      { id: 'm1', parentId: null },
    ];
    expect(canonicalJsonStringify(messages)).toBe(
      '[{"id":"m2","parentId":"m1"},{"id":"m1","parentId":null}]',
    );
  });
});

describe('canonicalJsonStringify — rule 3: no whitespace, non-ASCII stays readable', () => {
  it('emits no whitespace at all', () => {
    const json = canonicalJsonStringify({ a: [1, { b: 2 }], c: 'x' });
    expect(json).toBe('{"a":[1,{"b":2}],"c":"x"}');
    expect(json).not.toMatch(/[\n\t]/);
    expect(json.replace(/"(?:[^"\\]|\\.)*"/g, '""')).not.toContain(' ');
  });

  it('leaves non-ASCII characters unescaped', () => {
    expect(canonicalJsonStringify({ 名字: '霜月十二日 · 银松镇之夜' })).toBe(
      '{"名字":"霜月十二日 · 银松镇之夜"}',
    );
    expect(canonicalJsonStringify('emoji 🎲 and é')).toBe('"emoji 🎲 and é"');
  });

  it('still escapes what JSON requires', () => {
    expect(canonicalJsonStringify('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJsonStringify('line\nbreak\ttab')).toBe('"line\\nbreak\\ttab"');
    expect(canonicalJsonStringify('\u0000\u001f')).toBe('"\\u0000\\u001f"');
    // Escaping a key must not change the sort key: the raw key decides the order.
    expect(canonicalJsonStringify({ 'b"': 1, a: 2 })).toBe('{"a":2,"b\\"":1}');
  });

  it('round-trips through JSON.parse', () => {
    const value = { 中: [1, { b: 'é', a: null }], a: true };
    expect(JSON.parse(canonicalJsonStringify(value))).toEqual(value);
  });
});

describe('canonicalJsonStringify — rule 4: shortest round-trip numbers', () => {
  it('matches JSON.stringify for every finite number', () => {
    for (const value of [0, -0, 0.1, 1 / 3, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 42, -7]) {
      expect(canonicalJsonStringify(value)).toBe(JSON.stringify(value));
    }
  });

  it('serializes integers without a decimal point', () => {
    expect(canonicalJsonStringify({ n: 1758902400000 })).toBe('{"n":1758902400000}');
  });
});

describe('canonicalJsonStringify — primitives and shape', () => {
  it('handles every JSON scalar', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify('')).toBe('""');
    expect(canonicalJsonStringify(0)).toBe('0');
  });

  it('handles empty containers', () => {
    expect(canonicalJsonStringify({})).toBe('{}');
    expect(canonicalJsonStringify([])).toBe('[]');
    expect(canonicalJsonStringify({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  it('accepts null-prototype objects as plain JSON data', () => {
    const bag = Object.create(null) as { b: number; a: number };
    bag.b = 1;
    bag.a = 2;
    expect(canonicalJsonStringify(bag)).toBe('{"a":2,"b":1}');
  });

  it('serializes a shared (non-cyclic) subtree twice rather than once', () => {
    const shared = { a: 1 };
    expect(canonicalJsonStringify({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('does not overflow the stack on deeply nested input', () => {
    let deep: unknown = 0;
    for (let index = 0; index < 20_000; index += 1) deep = [deep];
    const json = canonicalJsonStringify(deep);
    expect(json.length).toBe(40_000 + 1);
    expect(json.startsWith('[[[')).toBe(true);
  });
});

describe('canonicalJsonStringify — rejects what JSON cannot represent', () => {
  const expectRejection = (value: unknown, message: RegExp, path?: string): void => {
    try {
      canonicalJsonStringify(value);
      throw new Error('expected a CanonicalJsonError');
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      const failure = error as CanonicalJsonError;
      expect(failure.message).toMatch(message);
      if (path !== undefined) expect(failure.path).toBe(path);
    }
  };

  it('rejects undefined instead of dropping the key', () => {
    expectRejection(undefined, /undefined is not representable/, '$');
    expectRejection({ a: undefined }, /undefined is not representable/, '$.a');
    expectRejection({ a: [1, undefined] }, /undefined is not representable/, '$.a[1]');
  });

  it('rejects functions and symbols', () => {
    expectRejection({ fn: () => 1 }, /function is not representable/, '$.fn');
    expectRejection({ sym: Symbol('x') }, /symbol is not representable/, '$.sym');
  });

  it('rejects BigInt', () => {
    expectRejection({ big: 1n }, /BigInt is not representable/, '$.big');
  });

  it('rejects NaN and Infinity instead of writing null', () => {
    expectRejection({ n: Number.NaN }, /non-finite number/, '$.n');
    expectRejection({ n: Number.POSITIVE_INFINITY }, /non-finite number/, '$.n');
    expectRejection(-Number.MAX_VALUE * 2, /non-finite number/, '$');
  });

  it('rejects class instances that would silently lose data', () => {
    class NotJson {
      readonly a = 1;
      b(): number {
        return 2;
      }
    }
    expectRejection({ when: new Date(0) }, /class instance \(Date\)/, '$.when');
    expectRejection({ map: new Map([['a', 1]]) }, /class instance \(Map\)/, '$.map');
    expectRejection({ set: new Set([1]) }, /class instance \(Set\)/, '$.set');
    expectRejection({ re: /x/ }, /class instance \(RegExp\)/, '$.re');
    expectRejection({ bytes: new Uint8Array(2) }, /class instance \(Uint8Array\)/, '$.bytes');
    expectRejection({ o: new NotJson() }, /class instance \(NotJson\)/, '$.o');
  });

  it('rejects circular references', () => {
    interface Node {
      name?: string;
      me?: Node;
      b?: Node;
      a?: Node;
    }
    const self: Node = { name: 'x' };
    self.me = self;
    expectRejection(self, /circular reference/, '$.me');

    const array: unknown[] = [1];
    array.push(array);
    expectRejection(array, /circular reference/, '$[1]');

    const a: Node = {};
    const b: Node = { a };
    a.b = b;
    expectRejection(a, /circular reference/, '$.b.a');
  });

  it('rejects lone surrogates, which are not valid UTF-8', () => {
    expectRejection({ s: '\ud800' }, /lone high surrogate/, '$.s');
    expectRejection({ s: '\udc00' }, /lone low surrogate/, '$.s');
    // A well-formed pair is fine.
    expect(canonicalJsonStringify({ s: '\ud83c\udfb2' })).toBe('{"s":"🎲"}');
  });

  it('rejects accessor properties, whose value is not stable across reads', () => {
    const value: Record<string, unknown> = { a: 1 };
    Object.defineProperty(value, 'b', { get: () => 2, enumerable: true });
    expectRejection(value, /accessor property "b"/, '$.b');
  });
});

describe('canonicalJsonBytes', () => {
  it('encodes UTF-8 without a BOM', () => {
    const bytes = canonicalJsonBytes({ 名字: '霜月' });
    expect(Array.from(bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes[0]).toBe(0x7b); // `{`
    expect(new TextDecoder('utf-8').decode(bytes)).toBe('{"名字":"霜月"}');
  });

  it('is byte-identical for equal values regardless of key insertion order', () => {
    const first = canonicalJsonBytes({ b: 1, a: [1, 2] });
    const second = canonicalJsonBytes({ a: [1, 2], b: 1 });
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('encodes multi-byte characters as UTF-8, not as \\u escapes', () => {
    const bytes = canonicalJsonBytes('中');
    expect(Array.from(bytes)).toEqual([0x22, 0xe4, 0xb8, 0xad, 0x22]);
  });

  it('propagates rejection instead of writing a BOM or a partial document', () => {
    expect(() => canonicalJsonBytes({ a: undefined })).toThrow(CanonicalJsonError);
  });
});
