/**
 * Tests for the shared primitives — the contract everything else is built on.
 *
 * The cases that matter most are the plugin-facing ones (rule 1-3 in the
 * `common.ts` header): an `x-` extension must survive a JSON round-trip, and a
 * non-namespaced key must be rejected so two plugins can never silently fight
 * over the same slot.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_KEY_PATTERN,
  ExtensionsSchema,
  JsonValueSchema,
  LocalizedTextSchema,
  openEnum,
  SamplingParamsSchema,
  UuidV7Schema,
} from './common';

const UUID_V7 = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b77';

describe('identity', () => {
  it('accepts UUIDv7 and rejects v4 / malformed ids where we mint them', () => {
    expect(UuidV7Schema.safeParse(UUID_V7).success).toBe(true);
    // version nibble 4, i.e. a UUIDv4 — time ordering would be lost.
    expect(UuidV7Schema.safeParse('0192f0a1-7c3d-4a4e-9b21-5c8f0d3a1b77').success).toBe(false);
    expect(UuidV7Schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('keeps every fixture literal in this repo consistent with the exported pattern', () => {
    expect(EXTENSION_KEY_PATTERN.test('x-mythos')).toBe(true);
    expect(EXTENSION_KEY_PATTERN.test('mythos')).toBe(false);
  });
});

describe('extensions: the plugin data channel', () => {
  it('round-trips a plugin payload through JSON without loss', () => {
    const value = {
      'x-mythos.sanity': { current: 7, max: 10, tags: ['shaken', null] },
      'x-mythos': 'namespace-only key is legal',
    };
    const parsed = ExtensionsSchema.parse(value);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(value);
  });

  it('rejects an un-namespaced key so plugins cannot collide with core fields', () => {
    const result = ExtensionsSchema.safeParse({ sanity: 7 });
    expect(result.success).toBe(false);
  });

  it('rejects non-JSON values (a plugin may not smuggle a class or a function)', () => {
    expect(JsonValueSchema.safeParse({ fn: undefined }).success).toBe(false);
    expect(JsonValueSchema.safeParse([1, 'a', true, null, { nested: [] }]).success).toBe(true);
  });
});

describe('openEnum', () => {
  const Kind = openEnum(['narration', 'dialogue'] as const);

  it('accepts known members and x- namespaced plugin members', () => {
    expect(Kind.safeParse('narration').success).toBe(true);
    expect(Kind.safeParse('x-mythos.monologue').success).toBe(true);
  });

  it('rejects unknown un-namespaced members', () => {
    expect(Kind.safeParse('soliloquy').success).toBe(false);
  });
});

describe('localized text', () => {
  it('accepts BCP-47 keys and rejects a typo that would be unreachable', () => {
    expect(LocalizedTextSchema.safeParse({ 'zh-CN': '聪明酒馆', en: 'SmartTavern' }).success).toBe(
      true,
    );
    expect(LocalizedTextSchema.safeParse({ ZH_cn: 'x' }).success).toBe(false);
  });
});

describe('sampling params', () => {
  it('requires the two universally supported knobs and allows the rest to be absent', () => {
    expect(SamplingParamsSchema.safeParse({ temperature: 0.8, topP: 0.95 }).success).toBe(true);
    expect(SamplingParamsSchema.safeParse({ topP: 0.95 }).success).toBe(false);
  });

  it('rejects out-of-range values instead of silently clamping them', () => {
    expect(SamplingParamsSchema.safeParse({ temperature: 3, topP: 0.9 }).success).toBe(false);
    expect(SamplingParamsSchema.safeParse({ temperature: 0.7, topP: 1.5 }).success).toBe(false);
  });
});
