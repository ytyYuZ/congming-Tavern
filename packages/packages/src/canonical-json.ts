/**
 * Canonical JSON for `.stpack` payloads (M0-T3).
 *
 * WHY THIS FILE EXISTS
 * docs/04-分享格式规范.md §11 ("确定性打包要求", definition frozen in **v1-r3**)
 * requires package JSON to use a canonical form so two *different*
 * implementations writing the same content produce the same payload bytes. The
 * ZIP container itself is only byte-stable within one implementation (deflate
 * decides that — §9 "确定性的边界"), so the payload is where cross-implementation
 * diffing actually happens.
 *
 * THE FROZEN RULES, FROM §11 v1-r3
 * 1. object keys sorted **recursively in ASCII dictionary order** (nested objects
 *    too) — compared by code point, never with `localeCompare`, because locale
 *    collation differs between machines and would silently break reproducibility;
 * 2. **arrays keep their original order** and are never sorted;
 * 3. no pretty-printing (no indentation, no extra whitespace); strings escaped per
 *    JSON but **non-ASCII characters are NOT escaped** to `\uXXXX`, so the UTF-8
 *    payload stays human-readable;
 * 4. numbers use the shortest round-trip representation (as `JSON.stringify` does).
 *
 * FAIL LOUDLY, NEVER SILENTLY
 * The worst failure mode of a canonical serializer is emitting a payload that
 * parses back into something *different* from the input. `JSON.stringify` does
 * exactly that: it drops `undefined`/function/symbol-valued keys, turns those same
 * values inside arrays into `null`, turns `NaN`/`Infinity` into `null`, and
 * flattens `Date`/`Map`/class instances without complaint. So this module rejects
 * every value that is not JSON-representable instead of quietly losing data.
 *
 * SCOPE: pure, dependency-free, DOM-free — runs unchanged in Node and browsers.
 */

/* ────────────────────────────── error reporting ──────────────────────────── */

/**
 * Raised for any value that cannot be serialized as canonical JSON.
 *
 * `path` is a JSONPath-ish locator (`$.data.worlds[0].name`) so a caller can name
 * the offending field instead of guessing which of a thousand keys was a `BigInt`.
 */
export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.path = path;
  }
}

/* ────────────────────────────── the value space ──────────────────────────── */

/**
 * Anything JSON can hold, declared locally on purpose: `packages/schema` exports
 * the same shape, but this module is a self-contained algorithm that third parties
 * reuse, and a type-only import would tie the canonical form to a schema revision
 * it does not actually depend on.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/* ─────────────────────────────── internals ───────────────────────────────── */

/** One open container, flattened onto an explicit stack instead of recursing. */
interface Frame {
  readonly value: object;
  /** `true` for arrays (order preserved), `false` for objects (keys sorted). */
  readonly isArray: boolean;
  /** Member names in emission order: array indices, or sorted object keys. */
  readonly keys: readonly string[];
  /** Diagnostics only: the JSONPath of this container. */
  readonly path: string;
  index: number;
}

const ROOT_PATH = '$';

/** Shortest round-trip number representation; the `JSON.stringify` form (§11 rule 4). */
function numberLiteral(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(
      `non-finite number (${String(value)}) is not representable in JSON`,
      path,
    );
  }
  return JSON.stringify(value);
}

/**
 * JSON string escaping (§11 rule 3).
 *
 * `JSON.stringify` is the normative escaper: control characters, `"` and `\` get
 * escaped, while code points ≥ U+0080 are emitted verbatim. It happily emits *lone
 * surrogates* though — which are not valid UTF-8 and would be replaced by U+FFFD
 * the moment `canonicalJsonBytes` encodes them — so those are rejected.
 */
function stringLiteral(value: string, path: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError('lone high surrogate is not valid UTF-8', path);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError('lone low surrogate is not valid UTF-8', path);
    }
  }
  return JSON.stringify(value);
}

/** Serializes a leaf, or returns `undefined` when `value` is a container. */
function primitiveLiteral(value: unknown, path: string): string | undefined {
  switch (typeof value) {
    case 'string':
      return stringLiteral(value, path);
    case 'number':
      return numberLiteral(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new CanonicalJsonError('BigInt is not representable in JSON', path);
    case 'symbol':
      throw new CanonicalJsonError('symbol is not representable in JSON', path);
    case 'function':
      throw new CanonicalJsonError('function is not representable in JSON', path);
    case 'undefined':
      // Never a silent `null` and never a dropped key: dropping data is exactly the
      // failure this module exists to prevent.
      throw new CanonicalJsonError('undefined is not representable in JSON', path);
    default:
      return undefined;
  }
}

/**
 * A plain data object: `{}` or `Object.create(null)`. A `Date`, `Map`, `Set`,
 * `RegExp`, typed array or class instance carries state JSON cannot hold, so it is
 * rejected rather than flattened into `{}` or `"1970-01-01T00:00:00.000Z"`.
 */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** `key` rendered as a path segment for error messages. */
function appendKey(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Code-point ordering (§11 rule 1). `<` on strings compares UTF-16 code units,
 * which is code-point order for the BMP and is engine-independent — unlike
 * `localeCompare`, whose result depends on the machine's locale data.
 */
function byCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Member names of an object, sorted, rejecting shapes JSON cannot express. */
function sortedObjectKeys(value: object, path: string): string[] {
  const keys = Object.keys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // A getter can return a different value on each read, which would make
    // "canonical" meaningless; plain JSON data has no accessors.
    if (
      descriptor !== undefined &&
      (descriptor.get !== undefined || descriptor.set !== undefined)
    ) {
      throw new CanonicalJsonError(
        `accessor property ${JSON.stringify(key)} is not JSON data`,
        appendKey(path, key),
      );
    }
  }
  keys.sort(byCodePoint);
  return keys;
}

/* ──────────────────────────────── the API ────────────────────────────────── */

/**
 * Serializes `value` to canonical JSON (docs/04 §11 v1-r3).
 *
 * Deterministic and iterative: nested containers live on an explicit stack, so the
 * only depth cost is heap rather than the engine's call stack. That also means the
 * output is *not* depth-bounded — a caller parsing untrusted input should bound the
 * tree first (see `checkJsonTree` in `./limits`, docs/04 §9).
 *
 * @throws {CanonicalJsonError} for anything not representable in JSON: `undefined`,
 *   functions, symbols, `BigInt`, non-finite numbers, class instances (which would
 *   silently lose their prototype and non-enumerable state), lone surrogates, and
 *   circular references.
 */
export function canonicalJsonStringify(value: unknown): string {
  const chunks: string[] = [];
  const stack: Frame[] = [];
  // Descendants of the frames currently open. Re-entering one of them is a cycle;
  // meeting the same object again as a *sibling* is a legitimate DAG and must be
  // serialized twice, so ancestor membership — not a global visited set — is the
  // cycle test.
  const ancestors = new Set<object>();

  const open = (container: object, isArray: boolean, path: string): void => {
    const keys = isArray
      ? (container as unknown[]).map((_item, index) => String(index))
      : sortedObjectKeys(container, path);
    ancestors.add(container);
    stack.push({ value: container, isArray, keys, path, index: 0 });
    chunks.push(isArray ? '[' : '{');
  };

  const emit = (container: unknown, path: string): void => {
    if (container === null) {
      chunks.push('null');
      return;
    }
    const literal = primitiveLiteral(container, path);
    if (literal !== undefined) {
      chunks.push(literal);
      return;
    }
    if (typeof container !== 'object') {
      throw new CanonicalJsonError(`unsupported ${typeof container} value`, path);
    }
    if (ancestors.has(container)) {
      throw new CanonicalJsonError('circular reference', path);
    }
    const isArray = Array.isArray(container);
    if (!isArray && !isPlainObject(container)) {
      const name = (container as { constructor?: { name?: string } }).constructor?.name;
      throw new CanonicalJsonError(
        `class instance (${name ?? 'anonymous'}) would lose data in JSON`,
        path,
      );
    }
    open(container, isArray, path);
  };

  emit(value, ROOT_PATH);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.index >= frame.keys.length) {
      chunks.push(frame.isArray ? ']' : '}');
      ancestors.delete(frame.value);
      stack.pop();
      continue;
    }

    const key = frame.keys[frame.index] as string;
    if (frame.index > 0) chunks.push(',');
    frame.index += 1;

    if (frame.isArray) {
      emit((frame.value as unknown[])[Number(key)], `${frame.path}[${key}]`);
    } else {
      chunks.push(`${JSON.stringify(key)}:`);
      emit((frame.value as Record<string, unknown>)[key], appendKey(frame.path, key));
    }
  }

  return chunks.join('');
}

/**
 * Canonical JSON as UTF-8 bytes with **no BOM** (docs/04 §2 路径规则: every text file
 * is UTF-8 without BOM; a BOM would make payload bytes differ between
 * implementations that keep or strip it).
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(value));
}
