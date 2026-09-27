/**
 * Canonical JSON for the payloads this package writes (`docs/04` §11, definition
 * frozen in v1-r3).
 *
 * WHY THIS PACKAGE HAS ITS OWN SERIALISER: `PackageWriteEntry` carries BYTES
 * (`@smarttavern/core` `ports/package.ts`), so whoever builds a payload decides
 * its byte form — and §11 requires canonical JSON there. The reference
 * implementation lives in `packages/packages`, which this package may not import:
 * `biome.json`'s adapter override and `tools/scripts/check-dependency-direction.mjs`
 * allow `packages/importers` to see `packages/schema` and `packages/core` only.
 * The two implementations are pinned TO EACH OTHER by
 * `tools/stpack-cli/src/import.test.ts`, which serialises one fixture with both
 * and compares the bytes — a drift here fails that test rather than shipping two
 * "canonical" forms.
 *
 * THE RULES (§11 v1-r3): object keys sorted recursively in code-point order (`<`
 * on strings, never `localeCompare`, whose result depends on the machine's locale
 * data); arrays keep their order; no whitespace; non-ASCII emitted verbatim;
 * numbers rendered the way `JSON.stringify` renders them. Anything JSON cannot
 * hold (`undefined`, functions, symbols, `BigInt`, non-finite numbers, class
 * instances) THROWS: a payload that parses back into something different is worse
 * than a loud failure.
 *
 * DEPTH: this walk is recursive. Payloads come from `JSON.parse` of data the
 * reader already bounded (`docs/04` §9's JSON limits), so the depth is a value the
 * format cap decided, not an attacker's.
 */

/** Raised instead of silently changing a value JSON cannot represent. */
export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

/** Code-point ordering: engine-independent, unlike `localeCompare`. */
function byCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** A leaf as JSON text, `undefined` when the value is a container. */
function leafLiteral(value: unknown, path: string): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number (${String(value)})`, path);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      throw new CanonicalJsonError('undefined is not representable in JSON', path);
    case 'bigint':
      throw new CanonicalJsonError('BigInt is not representable in JSON', path);
    case 'symbol':
      throw new CanonicalJsonError('symbol is not representable in JSON', path);
    case 'function':
      throw new CanonicalJsonError('function is not representable in JSON', path);
    default:
      return undefined;
  }
}

function pathOfKey(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${key}]`;
}

function write(value: unknown, path: string): string {
  const leaf = leafLiteral(value, path);
  if (leaf !== undefined) return leaf;

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => write(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new CanonicalJsonError(`unsupported ${typeof value} value`, path);
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    throw new CanonicalJsonError(`class instance (${name ?? 'anonymous'}) would lose data`, path);
  }

  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort(byCodePoint)
    .map((key) => `${JSON.stringify(key)}:${write(record[key], pathOfKey(path, key))}`);
  return `{${members.join(',')}}`;
}

/** Canonical JSON text for `value` (`docs/04` §11 v1-r3). */
export function canonicalJsonStringify(value: unknown): string {
  return write(value, '$');
}

/** Canonical JSON as UTF-8 bytes, no BOM (`docs/04` §2 path rules). */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(value));
}
