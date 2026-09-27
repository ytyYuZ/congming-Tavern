import { describe, expect, it } from 'vitest';
import {
  checkJsonTree,
  DEFAULT_LIMITS,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_ENTRY_COUNT,
  DEFAULT_MAX_JSON_DEPTH,
  DEFAULT_MAX_JSON_NODE_COUNT,
  DEFAULT_MAX_PATH_LENGTH,
  DEFAULT_MAX_TOTAL_BYTES,
  resolveLimits,
} from './limits';

/**
 * The limits are the defaults docs/04 §9 and docs/06 §8.2 hand to the container
 * reader and the validator, so their *values* are part of the contract too: a
 * silent change here would change which archives a release accepts.
 */

describe('limits — the documented defaults', () => {
  it('matches docs/04 §9 (单文件 64 MB, 总量 2 GB)', () => {
    expect(DEFAULT_MAX_ENTRY_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it('uses the classic ZIP ceiling for the entry count', () => {
    expect(DEFAULT_MAX_ENTRY_COUNT).toBe(65535);
  });

  it('keeps paths short enough for Windows hosts', () => {
    expect(DEFAULT_MAX_PATH_LENGTH).toBe(1024);
  });

  it('bounds JSON structure instead of only bounding bytes (docs/04 §9)', () => {
    expect(DEFAULT_MAX_JSON_DEPTH).toBe(512);
    expect(DEFAULT_MAX_JSON_NODE_COUNT).toBe(1_000_000);
  });

  it('exposes the same values through DEFAULT_LIMITS', () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
      maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
      maxEntryCount: DEFAULT_MAX_ENTRY_COUNT,
      maxPathLength: DEFAULT_MAX_PATH_LENGTH,
      maxJsonDepth: DEFAULT_MAX_JSON_DEPTH,
      maxJsonNodeCount: DEFAULT_MAX_JSON_NODE_COUNT,
    });
  });
});

describe('resolveLimits', () => {
  it('returns the defaults when nothing is supplied', () => {
    expect(resolveLimits()).toBe(DEFAULT_LIMITS);
    expect(resolveLimits(undefined)).toBe(DEFAULT_LIMITS);
  });

  it('fills in every gap, so no caller can observe an undefined cap', () => {
    expect(resolveLimits({ maxEntryBytes: 10 })).toEqual({
      ...DEFAULT_LIMITS,
      maxEntryBytes: 10,
    });
  });

  it('honours a full override', () => {
    const limits = resolveLimits({
      maxEntryBytes: 1,
      maxTotalBytes: 2,
      maxEntryCount: 3,
      maxPathLength: 4,
      maxJsonDepth: 5,
      maxJsonNodeCount: 6,
    });
    expect(limits).toEqual({
      maxEntryBytes: 1,
      maxTotalBytes: 2,
      maxEntryCount: 3,
      maxPathLength: 4,
      maxJsonDepth: 5,
      maxJsonNodeCount: 6,
    });
  });

  it('does not mutate the defaults', () => {
    resolveLimits({ maxEntryBytes: 1 });
    expect(DEFAULT_LIMITS.maxEntryBytes).toBe(DEFAULT_MAX_ENTRY_BYTES);
  });
});

describe('checkJsonTree', () => {
  it('reports depth and node count for a small tree', () => {
    expect(checkJsonTree({ a: [1, 2], b: 'x' })).toEqual({ ok: true, depth: 3, nodes: 5 });
  });

  it('counts scalars, including null, as nodes', () => {
    expect(checkJsonTree(null)).toEqual({ ok: true, depth: 1, nodes: 1 });
    expect(checkJsonTree([null, true, 0])).toEqual({ ok: true, depth: 2, nodes: 4 });
  });

  it('accepts a tree exactly at the depth limit and rejects one level deeper', () => {
    let atLimit: unknown = 'leaf';
    for (let level = 1; level < DEFAULT_MAX_JSON_DEPTH; level += 1) atLimit = [atLimit];
    const exact = checkJsonTree(atLimit);
    expect(exact.ok).toBe(true);

    let tooDeep: unknown = atLimit;
    tooDeep = [tooDeep];
    const over = checkJsonTree(tooDeep);
    expect(over).toMatchObject({ ok: false, reason: 'depth', limit: DEFAULT_MAX_JSON_DEPTH });
  });

  it('rejects an over-deep tree without recursing on it', () => {
    // 100k levels: a recursive checker would blow the stack before reporting.
    let deep: unknown = 0;
    for (let index = 0; index < 100_000; index += 1) deep = [deep];
    const result = checkJsonTree(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('depth');
  });

  it('rejects a tree over the node limit and names where it stopped', () => {
    const wide = { items: new Array(50).fill(0) };
    const result = checkJsonTree(wide, { maxJsonNodeCount: 10 });
    expect(result).toMatchObject({ ok: false, reason: 'nodes', limit: 10 });
    if (!result.ok) expect(result.path.startsWith('$.items')).toBe(true);
  });

  it('honours a custom depth limit', () => {
    expect(checkJsonTree({ a: { b: 1 } }, { maxJsonDepth: 2 })).toMatchObject({
      ok: false,
      reason: 'depth',
      limit: 2,
    });
  });

  it('handles non-object input, which the pack reader may hand it on a bad payload', () => {
    expect(checkJsonTree('scalar')).toEqual({ ok: true, depth: 1, nodes: 1 });
    expect(checkJsonTree(undefined)).toEqual({ ok: true, depth: 1, nodes: 1 });
  });
});
