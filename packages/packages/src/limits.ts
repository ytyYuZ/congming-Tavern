/**
 * Numeric limits for `.stpack` packing and unpacking (M0-T3).
 *
 * WHY THIS FILE EXISTS
 * docs/04-分享格式规范.md §9 ("校验与安全") sets three families of bound on an
 * *untrusted* package — a size cap, a ZIP structure cap, and a JSON structure cap —
 * but only names the first two numbers. The rest are fixed here, exported by name,
 * and cited back to the sentence they come from, so that "the default" is a single
 * reviewable constant instead of a literal sprinkled across the container reader,
 * the validator and the CLI (docs/06-开发任务拆解.md §8.2).
 *
 * WHERE THE UNSPECIFIED NUMBERS COME FROM (recorded, per HANDOFF: undocumented
 * choices must be written down, not silently made):
 * - `entryCount` 65535 is the largest value a classic ZIP can *represent*
 *   (the EOCD count fields are 16-bit). An archive above it is not automatically
 *   invalid — ZIP64 exists for that — but it is far outside what a shareable
 *   roleplay pack needs, so the default refuses it and a caller that genuinely
 *   ships a bigger archive can pass `limits` (docs/04 §9 makes the caps
 *   configurable: "单文件上限与总大小上限可配置").
 * - `pathLength` 1024 keeps every path usable on Windows hosts, whose default
 *   path limit is 260 characters even with long-path support enabled by policy.
 * - `jsonDepth` / `jsonNodeCount` follow §9's "JSON 解析设置深度与节点数上限，防止
 *   构造的恶意结构导致内存爆炸" with numbers generous enough for a large
 *   conversation tree but far below what a decompression-bomb-style JSON payload
 *   would need (1e6 nodes is ~50 MB of parsed objects at worst).
 *
 * SCOPE: pure data — no I/O, no DOM, no Node API.
 */

/* ─────────────────────────────── byte budgets ────────────────────────────── */

/** Single-file cap, default 64 MB — docs/04 §9 "默认单文件 64 MB". */
export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Total package cap, default 2 GB — docs/04 §9 "总量 2 GB" (and §9's ZIP64 note). */
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/* ────────────────────────────── ZIP structure ────────────────────────────── */

/** Entry-count cap; see the file header for why 65535 (the classic ZIP ceiling). */
export const DEFAULT_MAX_ENTRY_COUNT = 65535;

/** Path-length cap in UTF-16 code units; see the file header (Windows MAX_PATH). */
export const DEFAULT_MAX_PATH_LENGTH = 1024;

/* ────────────────────────────── JSON structure ───────────────────────────── */

/**
 * Nesting cap for parsed payload JSON, from docs/04 §9 "JSON 解析设置深度与节点数上限，
 * 防止构造的恶意结构导致内存爆炸".
 */
export const DEFAULT_MAX_JSON_DEPTH = 512;

/** Node-count cap for parsed payload JSON, from the same docs/04 §9 sentence. */
export const DEFAULT_MAX_JSON_NODE_COUNT = 1_000_000;

/* ────────────────────────────── the options bag ──────────────────────────── */

/**
 * Every cap a caller may override. Callers pass a `Partial`; `resolveLimits` fills
 * the gaps, because a half-populated options object reaching the container reader
 * is how "the limit was 0" bugs get shipped.
 */
export interface PackageLimits {
  /** Largest single entry, compressed or inflated (default {@link DEFAULT_MAX_ENTRY_BYTES}). */
  readonly maxEntryBytes: number;
  /** Largest sum of all inflated entry bytes in one archive (default {@link DEFAULT_MAX_TOTAL_BYTES}). */
  readonly maxTotalBytes: number;
  /** Largest number of entries in one archive (default {@link DEFAULT_MAX_ENTRY_COUNT}). */
  readonly maxEntryCount: number;
  /** Longest entry path in UTF-16 code units (default {@link DEFAULT_MAX_PATH_LENGTH}). */
  readonly maxPathLength: number;
  /** Deepest nesting allowed in payload JSON (default {@link DEFAULT_MAX_JSON_DEPTH}). */
  readonly maxJsonDepth: number;
  /** Largest number of values allowed in payload JSON (default {@link DEFAULT_MAX_JSON_NODE_COUNT}). */
  readonly maxJsonNodeCount: number;
}

/** The caps as callers may supply them: unnamed fields fall back to the defaults. */
export type PartialPackageLimits = Partial<PackageLimits>;

/** The full default cap set, frozen so a reader cannot be mutated out from under a caller. */
export const DEFAULT_LIMITS: PackageLimits = Object.freeze({
  maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxEntryCount: DEFAULT_MAX_ENTRY_COUNT,
  maxPathLength: DEFAULT_MAX_PATH_LENGTH,
  maxJsonDepth: DEFAULT_MAX_JSON_DEPTH,
  maxJsonNodeCount: DEFAULT_MAX_JSON_NODE_COUNT,
});

/** Fills in every cap a caller left out. */
export function resolveLimits(limits?: PartialPackageLimits): PackageLimits {
  if (limits === undefined) return DEFAULT_LIMITS;
  return {
    maxEntryBytes: limits.maxEntryBytes ?? DEFAULT_LIMITS.maxEntryBytes,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
    maxEntryCount: limits.maxEntryCount ?? DEFAULT_LIMITS.maxEntryCount,
    maxPathLength: limits.maxPathLength ?? DEFAULT_LIMITS.maxPathLength,
    maxJsonDepth: limits.maxJsonDepth ?? DEFAULT_LIMITS.maxJsonDepth,
    maxJsonNodeCount: limits.maxJsonNodeCount ?? DEFAULT_LIMITS.maxJsonNodeCount,
  };
}

/* ────────────────────────── JSON structure checks ────────────────────────── */

/** Outcome of a structural scan: either within budget, or the first violation found. */
export type JsonTreeCheck =
  | { readonly ok: true; readonly depth: number; readonly nodes: number }
  | {
      readonly ok: false;
      readonly reason: 'depth' | 'nodes';
      readonly path: string;
      readonly limit: number;
    };

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Walks an already-parsed JSON value and enforces the two structural caps from
 * docs/04 §9. Iterative, so the *check itself* cannot overflow the stack on the
 * hostile input it is meant to reject; breaks out at the first violation rather
 * than scanning the rest of the bomb.
 *
 * Call this **before** handing untrusted JSON to the domain schemas: Zod's
 * recursive refinement would recurse as deeply as the payload asks.
 */
export function checkJsonTree(value: unknown, limits?: PartialPackageLimits): JsonTreeCheck {
  const resolved = resolveLimits(limits);
  const maxDepth = resolved.maxJsonDepth;
  const maxNodes = resolved.maxJsonNodeCount;

  let nodes = 0;
  let depth = 0;
  const pending: { readonly value: unknown; readonly depth: number; readonly path: string }[] = [
    { value, depth: 1, path: '$' },
  ];

  while (pending.length > 0) {
    const current = pending.pop() as { value: unknown; depth: number; path: string };
    nodes += 1;
    if (nodes > maxNodes) {
      return { ok: false, reason: 'nodes', path: current.path, limit: maxNodes };
    }
    if (current.depth > depth) depth = current.depth;
    if (current.depth > maxDepth) {
      return { ok: false, reason: 'depth', path: current.path, limit: maxDepth };
    }

    const candidate = current.value;
    if (candidate !== null && typeof candidate === 'object') {
      if (Array.isArray(candidate)) {
        for (let index = candidate.length - 1; index >= 0; index -= 1) {
          pending.push({
            value: candidate[index],
            depth: current.depth + 1,
            path: `${current.path}[${index}]`,
          });
        }
      } else {
        const keys = Object.keys(candidate as Record<string, unknown>);
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index] as string;
          pending.push({
            value: (candidate as Record<string, unknown>)[key],
            depth: current.depth + 1,
            path: childPath(current.path, key),
          });
        }
      }
    }
  }

  return { ok: true, depth, nodes };
}
