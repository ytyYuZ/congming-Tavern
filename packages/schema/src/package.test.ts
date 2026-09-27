/**
 * Tests for the `.stpack` manifest contract (`docs/04` §3).
 *
 * What is being defended:
 * 1. the four self-identifying literals, and that `formatVersion` is exact —
 *    a v2 package must be REJECTED here (the "prompt the user to upgrade"
 *    message belongs to the reader, docs/04 §7 step 2);
 * 2. the fixed key sets of `counts` / `schemaVersions` (that is what makes two
 *    packages with the same content diff cleanly, docs/04 §12 item 15);
 * 3. cross-field consistency lives in `validateManifestConsistency()`, so a
 *    manifest can round-trip through the shape check and still be refused with a
 *    precise reason.
 */
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_PATH,
  PACKAGE_COUNT_KEYS,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  PACKAGE_SCHEMA_VERSION_KEYS,
  PackageCountsSchema,
  PackageManifestSchema,
  PackagePathSchema,
  PackageSchemaVersionsSchema,
  validateManifestConsistency,
} from './package';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const PACKAGE_ID = '0192f0a1-2222-7000-8000-000000000001';
const ASSET_SHA = 'a'.repeat(64);
const PAYLOAD_SHA = 'b'.repeat(64);

/** Every count key, all zero — the spec forbids omitting a key. */
const zeroCounts = (): Record<string, number> =>
  Object.fromEntries(PACKAGE_COUNT_KEYS.map((key) => [key, 0]));

/** A minimal, fully consistent world package: one payload file of 100 bytes. */
const minimalManifest = () => ({
  format: PACKAGE_FORMAT,
  formatVersion: PACKAGE_FORMAT_VERSION,
  kind: 'world',
  id: PACKAGE_ID,
  name: '银松镇',
  createdAt: '2026-09-27T10:00:00.000Z',
  generator: { app: 'SmartTavern', version: '0.1.0', platform: 'web' },
  license: 'CC-BY-4.0',
  schemaVersions: { world: 1 },
  contents: { counts: { ...zeroCounts(), worlds: 1 }, bytes: 100 },
  entries: [{ path: 'data/worlds.json', bytes: 100, sha256: PAYLOAD_SHA }],
  redaction: { apiKeys: 'excluded', absolutePaths: 'excluded' },
});

const fullManifest = () => ({
  ...minimalManifest(),
  i18n: { name: { 'zh-CN': '银松镇', en: 'Silverpine' } },
  description: '一个单场景世界。',
  source: {
    url: 'https://example.com/silverpine',
    author: '某位创作者',
    originalPackageId: 'silverpine',
  },
  tags: ['奇幻', 'zh-CN'],
  schemaVersions: { world: 1, asset: 1 },
  refs: [
    { kind: 'rulepack', id: 'dnd5e-srd', version: 1, requirement: 'optional' },
    { kind: 'x-mythos.sanity', id: 'sanity-track', requirement: 'embedded' },
  ],
  contents: { counts: { ...zeroCounts(), worlds: 1, assets: 1 }, bytes: 300 },
  entries: [
    { path: 'data/worlds.json', bytes: 100, sha256: PAYLOAD_SHA },
    { path: `assets/images/${ASSET_SHA}.png`, bytes: 200, sha256: ASSET_SHA },
  ],
  assets: [
    {
      path: `assets/images/${ASSET_SHA}.png`,
      sha256: ASSET_SHA,
      mime: 'image/png',
      width: 832,
      height: 1216,
      kind: 'sprite',
      meta: { characterId: '0192f0a1-2222-7000-8000-000000000002', expression: 'happy' },
    },
  ],
  signature: null,
  extensions: { 'x-mythos.mood': { current: 'tense' } },
});

type Parseable = { safeParse: (value: unknown) => { success: boolean } };

function expectRequired(schema: Parseable, fixture: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const broken: Record<string, unknown> = { ...fixture };
    delete broken[field];
    expect(`${field}:${schema.safeParse(broken).success}`).toBe(`${field}:false`);
  }
}

/* ───────────────────────────────── shape ─────────────────────────────────── */

describe('package manifest', () => {
  it('parses a minimal manifest', () => {
    expect(PackageManifestSchema.safeParse(minimalManifest()).success).toBe(true);
  });

  it('parses a fully populated manifest, including refs, assets and plugin data', () => {
    const result = PackageManifestSchema.safeParse(fullManifest());
    expect(result.success).toBe(true);
  });

  it('requires every field the spec marks as required', () => {
    expectRequired(PackageManifestSchema, minimalManifest(), [
      'format',
      'formatVersion',
      'kind',
      'id',
      'name',
      'createdAt',
      'generator',
      'license',
      'schemaVersions',
      'contents',
      'entries',
      'redaction',
    ]);
    expect(PackageManifestSchema.safeParse({ ...minimalManifest(), name: '' }).success).toBe(false);
    expect(PackageManifestSchema.safeParse({ ...minimalManifest(), entries: [] }).success).toBe(
      true,
    );
  });

  it('pins the self-identifying literals', () => {
    expect(PackageManifestSchema.safeParse({ ...minimalManifest(), format: 'x' }).success).toBe(
      false,
    );
    expect(
      PackageManifestSchema.safeParse({ ...minimalManifest(), formatVersion: 2 }).success,
    ).toBe(false);
  });

  it('rejects a non-UUIDv7 package id', () => {
    expect(
      PackageManifestSchema.safeParse({ ...minimalManifest(), id: 'silverpine' }).success,
    ).toBe(false);
  });

  it('requires createdAt to be ISO 8601 in UTC, ending in Z', () => {
    for (const stamp of ['2026-09-27T10:00:00.000Z', '2026-09-27T10:00:00Z']) {
      expect(
        `${stamp}:${PackageManifestSchema.safeParse({ ...minimalManifest(), createdAt: stamp }).success}`,
      ).toBe(`${stamp}:true`);
    }
    for (const stamp of ['2026-09-27T10:00:00+08:00', '2026-09-27 10:00:00Z', '2026-09-27']) {
      expect(
        PackageManifestSchema.safeParse({ ...minimalManifest(), createdAt: stamp }).success,
      ).toBe(false);
    }
  });

  it('accepts the three licence forms and rejects free text', () => {
    for (const license of ['user-provided', 'mixed', 'AGPL-3.0-only', 'CC-BY-4.0']) {
      expect(PackageManifestSchema.safeParse({ ...minimalManifest(), license }).success).toBe(true);
    }
    for (const license of ['', 'not a license']) {
      expect(PackageManifestSchema.safeParse({ ...minimalManifest(), license }).success).toBe(
        false,
      );
    }
  });

  it('keeps the extrinsic enums closed and the contributor-facing kind open', () => {
    expect(
      PackageManifestSchema.safeParse({
        ...minimalManifest(),
        generator: { app: 'a', version: '1', platform: 'toaster' },
      }).success,
    ).toBe(false);
    expect(
      PackageManifestSchema.safeParse({
        ...minimalManifest(),
        refs: [{ kind: 'world', id: 'w', requirement: 'someday' }],
      }).success,
    ).toBe(false);

    expect(
      PackageManifestSchema.safeParse({ ...minimalManifest(), kind: 'x-mythos.lore' }).success,
    ).toBe(true);
    expect(PackageManifestSchema.safeParse({ ...minimalManifest(), kind: 'lore' }).success).toBe(
      false,
    );
  });

  it('accepts any generator version string, because foreign tools use their own schemes', () => {
    expect(
      PackageManifestSchema.safeParse({
        ...minimalManifest(),
        generator: { app: 'other-tool', version: 'build 7 - nightly', platform: 'cli' },
      }).success,
    ).toBe(true);
  });

  it('only allows signature: null in v1', () => {
    expect(PackageManifestSchema.safeParse({ ...minimalManifest(), signature: null }).success).toBe(
      true,
    );
    expect(
      PackageManifestSchema.safeParse({ ...minimalManifest(), signature: { alg: 'ed25519' } })
        .success,
    ).toBe(false);
  });

  it('strips unknown fields and round-trips through JSON unchanged', () => {
    const parsed = PackageManifestSchema.parse({ ...fullManifest(), someFutureField: 1 });
    expect(parsed).not.toHaveProperty('someFutureField');
    const once = JSON.stringify(parsed);
    expect(JSON.stringify(PackageManifestSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips a plugin extension and rejects an un-namespaced key', () => {
    const parsed = PackageManifestSchema.parse(fullManifest());
    expect(parsed.extensions).toEqual({ 'x-mythos.mood': { current: 'tense' } });
    expect(
      PackageManifestSchema.safeParse({ ...minimalManifest(), extensions: { mood: 'tense' } })
        .success,
    ).toBe(false);
  });
});

/* ───────────────────────────── fixed key sets ────────────────────────────── */

describe('fixed key sets', () => {
  it('requires every counts key (a zero category must be written, not omitted)', () => {
    expect(Object.keys(PackageCountsSchema.shape)).toEqual([...PACKAGE_COUNT_KEYS]);
    for (const key of PACKAGE_COUNT_KEYS) {
      const broken = zeroCounts();
      delete broken[key];
      expect(`${key}:${PackageCountsSchema.safeParse(broken).success}`).toBe(`${key}:false`);
    }
  });

  it('rejects a negative or fractional count', () => {
    expect(PackageCountsSchema.safeParse({ ...zeroCounts(), messages: -1 }).success).toBe(false);
    expect(PackageCountsSchema.safeParse({ ...zeroCounts(), messages: 1.5 }).success).toBe(false);
  });

  it('offers exactly the schemaVersions key set and no other', () => {
    expect(Object.keys(PackageSchemaVersionsSchema.shape)).toEqual([
      ...PACKAGE_SCHEMA_VERSION_KEYS,
    ]);
    expect(PackageSchemaVersionsSchema.safeParse({ world: 1 }).success).toBe(true);
    expect(PackageSchemaVersionsSchema.safeParse({ planets: 1 }).success).toBe(true); // stripped
    expect(PackageSchemaVersionsSchema.safeParse({ world: 1 }).data).not.toHaveProperty('planets');
    expect(PackageSchemaVersionsSchema.safeParse({ world: 0 }).success).toBe(false);
  });
});

/* ───────────────────────────── path rules ───────────────────────────────── */

describe('package paths', () => {
  it('accepts the paths the format actually produces', () => {
    for (const path of [
      'data/worlds.json',
      'data/messages.jsonl',
      'assets/images/5d41402abc4b2a76b9719d911017c592.png',
      'LICENSE.txt',
      'README.txt',
    ]) {
      expect(`${path}:${PackagePathSchema.safeParse(path).success}`).toBe(`${path}:true`);
    }
  });

  it('rejects absolute, traversing, backslash and malformed paths', () => {
    for (const path of [
      '/etc/passwd',
      '../secrets.json',
      'data/../../x.json',
      'data\\worlds.json',
      'C:/windows/system32',
      'data//worlds.json',
      'assets/images/',
      '',
      'data/世界.json',
    ]) {
      expect(`${path}:${PackagePathSchema.safeParse(path).success}`).toBe(`${path}:false`);
    }
  });
});

/* ──────────────────── cross-field consistency (not the schema) ───────────── */

describe('validateManifestConsistency', () => {
  const parse = (patch: Record<string, unknown> = {}) =>
    PackageManifestSchema.parse({ ...minimalManifest(), ...patch });

  it('reports nothing for a consistent manifest', () => {
    expect(validateManifestConsistency(parse())).toEqual([]);
    expect(validateManifestConsistency(PackageManifestSchema.parse(fullManifest()))).toEqual([]);
  });

  it('refuses to list the manifest itself in entries[]', () => {
    const problems = validateManifestConsistency(
      parse({
        entries: [
          ...minimalManifest().entries,
          { path: MANIFEST_PATH, bytes: 1, sha256: ASSET_SHA },
        ],
        contents: { counts: { ...zeroCounts(), worlds: 1 }, bytes: 101 },
      }),
    );
    expect(problems.join('\n')).toContain(MANIFEST_PATH);
  });

  it('catches duplicate entries and unknown data payloads', () => {
    const entry = { path: 'data/worlds.json', bytes: 100, sha256: PAYLOAD_SHA };
    const problems = validateManifestConsistency(
      parse({
        entries: [entry, entry],
        contents: { counts: { ...zeroCounts(), worlds: 1 }, bytes: 200 },
      }),
    );
    expect(problems.join('\n')).toContain('duplicate');

    const unknown = validateManifestConsistency(
      parse({
        entries: [{ path: 'data/planets.json', bytes: 100, sha256: PAYLOAD_SHA }],
      }),
    );
    expect(unknown.join('\n')).toContain('unknown data payload');
  });

  it('requires a schemaVersions entry for every payload that is present', () => {
    const problems = validateManifestConsistency(
      parse({
        schemaVersions: {},
        entries: [{ path: 'data/worlds.json', bytes: 100, sha256: PAYLOAD_SHA }],
      }),
    );
    expect(problems.join('\n')).toContain('schemaVersions.world is missing');
  });

  it('checks the arithmetic behind contents.bytes', () => {
    const problems = validateManifestConsistency(
      parse({ contents: { counts: { ...zeroCounts(), worlds: 1 }, bytes: 99 } }),
    );
    expect(problems.join('\n')).toContain('entries[].bytes sums to 100');
  });

  it('checks that assets[] refers to real entries and agrees on the hash', () => {
    const missing = validateManifestConsistency(
      parse({
        assets: [
          {
            path: 'assets/images/x.png',
            sha256: ASSET_SHA,
            mime: 'image/png',
            width: 1,
            height: 1,
            kind: 'sprite',
          },
        ],
      }),
    );
    expect(missing.join('\n')).toContain('which is not in entries[]');

    const mismatched = validateManifestConsistency(
      parse({
        assets: [
          {
            path: 'data/worlds.json',
            sha256: ASSET_SHA,
            mime: 'image/png',
            width: 1,
            height: 1,
            kind: 'sprite',
          },
        ],
      }),
    );
    expect(mismatched.join('\n')).toContain('assets[].sha256 disagrees');
  });
});
