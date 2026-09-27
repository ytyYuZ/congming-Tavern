import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { activeDeflateBackend, deflateRaw, inflateRaw } from './deflate';
import { ZipError } from './errors';
import { readZip } from './read';
import { FIXED_DOS_DATE, FIXED_DOS_TIME, writeZip } from './write';

/**
 * Container round-trip tests for the self-built `.stpack` ZIP (M0-T3, ADR-018).
 *
 * These cover the container half of docs/04 §12 item 1 (determinism, manifest first,
 * path order) and of §9/§11 (fixed timestamp, ZIP64 support). Rejection rules live
 * in `read-rejects.test.ts`; the adversarial fixtures there are built by hand.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** `docs/04` §2 puts `manifest.json` first and the rest in ASCII path order. */
const ORDERED_ENTRIES = [
  { path: 'manifest.json', bytes: encoder.encode('{"format":"smarttavern.package"}') },
  { path: 'data/characters.json', bytes: encoder.encode('[{"id":"c1"}]') },
  { path: 'data/worlds.json', bytes: encoder.encode('[{"id":"w1"}]') },
  { path: 'LICENSE.txt', bytes: encoder.encode('AGPL-3.0-only\n') },
  { path: 'README.txt', bytes: encoder.encode('霜月十二日 · 银松镇之夜\n') },
] as const;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Index helper: `noUncheckedIndexedAccess` makes every subscript optional, and a
 * failed lookup here should fail the test loudly rather than assert `undefined`.
 */
function required<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${index}`);
  return item;
}

/** The fields of a local file header these tests assert on. */
function localHeaderAt(
  bytes: Uint8Array,
  offset: number,
): {
  flag: number;
  method: number;
  time: number;
  date: number;
  nameLength: number;
  extraLength: number;
} {
  const view = viewOf(bytes);
  expect(view.getUint32(offset, true)).toBe(0x04034b50);
  return {
    flag: view.getUint16(offset + 6, true),
    method: view.getUint16(offset + 8, true),
    time: view.getUint16(offset + 10, true),
    date: view.getUint16(offset + 12, true),
    nameLength: view.getUint16(offset + 26, true),
    extraLength: view.getUint16(offset + 28, true),
  };
}

describe('deflate backend', () => {
  it("uses the platform CompressionStream('deflate-raw') on this host", () => {
    // If this ever reports the zlib fallback, the environment lost the platform API
    // and the report must say so (docs/06 §8.2 decision 2).
    expect(activeDeflateBackend()).toBe('CompressionStream');
  });

  it('round-trips arbitrary bytes', async () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 64]);
    const inflated = await inflateRaw(await deflateRaw(original));
    expect(Array.from(inflated)).toEqual(Array.from(original));
  });

  it('round-trips the empty input', async () => {
    const deflated = await deflateRaw(new Uint8Array(0));
    expect(Array.from(await inflateRaw(deflated))).toEqual([]);
  });

  it('produces identical bytes for identical input (same-implementation determinism)', async () => {
    const payload = encoder.encode(`{"name":"${'霜月'.repeat(50)}"}`);
    const [first, second, third] = await Promise.all([
      deflateRaw(payload),
      deflateRaw(payload),
      deflateRaw(payload),
    ]);
    expect(Array.from(first as Uint8Array)).toEqual(Array.from(second as Uint8Array));
    expect(Array.from(second as Uint8Array)).toEqual(Array.from(third as Uint8Array));
  });

  it('cuts off a bomb instead of inflating it (docs/06 §8.2 decision 4)', async () => {
    const bomb = await deflateRaw(encoder.encode('A'.repeat(2_000_000)));
    expect(bomb.byteLength).toBeLessThan(10_000); // highly compressible by design
    await expect(inflateRaw(bomb, { maxOutputBytes: 1024, path: 'data/x.json' })).rejects.toThrow(
      /per-entry cap/,
    );
  });

  it('stops when the central directory declared a smaller size', async () => {
    const bomb = await deflateRaw(encoder.encode('B'.repeat(100_000)));
    await expect(
      inflateRaw(bomb, {
        declaredSize: 32,
        maxOutputBytes: 64 * 1024 * 1024,
        path: 'data/x.json',
      }),
    ).rejects.toThrow(/declared in the central directory/);
  });

  it('refuses a corrupt deflate stream', async () => {
    await expect(inflateRaw(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(ZipError);
  });
});

describe('writeZip', () => {
  it('produces identical bytes on two calls with the same input (docs/04 §12 item 1)', async () => {
    const first = await writeZip(ORDERED_ENTRIES);
    const second = await writeZip(ORDERED_ENTRIES);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('is insensitive to when it runs (no archive timestamp anywhere)', async () => {
    const before = await writeZip(ORDERED_ENTRIES);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await writeZip(ORDERED_ENTRIES);
    expect(Array.from(before)).toEqual(Array.from(after));
  });

  it('writes the fixed 1980-01-01 00:00:00 DOS stamp on every local header', async () => {
    expect(FIXED_DOS_TIME).toBe(0x0000);
    expect(FIXED_DOS_DATE).toBe(0x0021);
    const archive = await writeZip(ORDERED_ENTRIES);
    const header = localHeaderAt(archive, 0);
    expect(header.time).toBe(FIXED_DOS_TIME);
    expect(header.date).toBe(FIXED_DOS_DATE);
    // 0x0021 = year 1980, month 1, day 1.
    expect(1980 + ((header.date >> 9) & 0x7f)).toBe(1980);
    expect((header.date >> 5) & 0x0f).toBe(1);
    expect(header.date & 0x1f).toBe(1);
  });

  it('sets the UTF-8 name flag and writes no extra fields for small entries', async () => {
    const archive = await writeZip([ORDERED_ENTRIES[0]]);
    const header = localHeaderAt(archive, 0);
    expect(header.flag & 0x0800).toBe(0x0800);
    expect(header.flag & 0x0008).toBe(0); // no data descriptor
    expect(header.flag & 0x0001).toBe(0); // no encryption
    expect(header.extraLength).toBe(0);
  });

  it('writes a well-formed EOCD with no comment', async () => {
    const archive = await writeZip(ORDERED_ENTRIES);
    const view = viewOf(archive);
    const eocd = archive.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(ORDERED_ENTRIES.length);
    expect(view.getUint16(eocd + 10, true)).toBe(ORDERED_ENTRIES.length);
    expect(view.getUint16(eocd + 20, true)).toBe(0);
    expect(eocd + 22).toBe(archive.byteLength);
  });

  it('stores the payload verbatim for method 0', async () => {
    const bytes = encoder.encode('plain');
    const archive = await writeZip([{ path: 'a.txt', bytes, method: 'store' }]);
    expect(localHeaderAt(archive, 0).method).toBe(0);
    // The payload starts right after the 30-byte header + 5-byte name.
    expect(decoder.decode(archive.slice(30 + 5, 30 + 5 + bytes.byteLength))).toBe('plain');
  });

  it('rejects an unsupported method instead of silently storing', async () => {
    await expect(
      writeZip([{ path: 'a.txt', bytes: new Uint8Array(1), method: 'bzip2' as 'store' }]),
    ).rejects.toThrow(ZipError);
  });
});

describe('readZip', () => {
  it('round-trips every entry, in the order the caller supplied', async () => {
    const archive = await writeZip(ORDERED_ENTRIES);
    const entries = await readZip(archive);
    expect(entries.map((entry) => entry.path)).toEqual(ORDERED_ENTRIES.map((entry) => entry.path));
    expect(entries[0]?.path).toBe('manifest.json');
    for (const [index, entry] of entries.entries()) {
      expect(decoder.decode(entry.bytes)).toBe(
        decoder.decode(required(ORDERED_ENTRIES, index).bytes),
      );
    }
  });

  it('preserves the caller order even when it is not sorted', async () => {
    // Ordering is the caller's job (docs/04 §2, docs/06 §8.2 decision 3); the
    // container must not reorder anything behind its back.
    const archive = await writeZip([
      { path: 'manifest.json', bytes: encoder.encode('{}') },
      { path: 'z.txt', bytes: encoder.encode('z') },
      { path: 'a.txt', bytes: encoder.encode('a') },
    ]);
    expect((await readZip(archive)).map((entry) => entry.path)).toEqual([
      'manifest.json',
      'z.txt',
      'a.txt',
    ]);
  });

  it('round-trips stored and deflated entries in one archive', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(5000) });
    const archive = await writeZip([
      { path: 'manifest.json', bytes: encoder.encode('{}'), method: 'store' },
      { path: 'data/big.json', bytes: encoder.encode(big) },
    ]);
    const entries = await readZip(archive);
    expect(entries.map((entry) => entry.method)).toEqual([0, 8]);
    expect(decoder.decode(required(entries, 1).bytes)).toBe(big);
  });

  it('round-trips an empty entry and an empty archive', async () => {
    const archive = await writeZip([{ path: 'manifest.json', bytes: new Uint8Array(0) }]);
    const entries = await readZip(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.bytes.byteLength).toBe(0);

    const empty = await writeZip([]);
    expect(await readZip(empty)).toEqual([]);
  });

  it('round-trips binary payloads byte-for-byte', async () => {
    const bytes = new Uint8Array(1024);
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (index * 37) % 256;
    const archive = await writeZip([{ path: 'assets/images/x.png', bytes }]);
    const entries = await readZip(archive);
    expect(Array.from(required(entries, 0).bytes)).toEqual(Array.from(bytes));
  });

  it('writes the UTF-8 byte length of the name, not its UTF-16 length', async () => {
    // Regression guard: `path.length` would write 16 here, the format wants 18. A
    // reader would then step past the name and reject an archive we wrote ourselves.
    const path = '数据/角色.json';
    const archive = await writeZip([{ path, bytes: encoder.encode('[]') }]);
    const header = localHeaderAt(archive, 0);
    expect(header.nameLength).toBe(encoder.encode(path).byteLength);
    expect(header.nameLength).toBe(18);
    expect(encoder.encode(path).byteLength).not.toBe(path.length);
  });

  it('rejects a non-ASCII path at read time (docs/04 §2 restricts paths to ASCII)', async () => {
    // The container encodes and flags the name correctly; the *format* rule that
    // package paths are `[A-Za-z0-9._/-]` is enforced by the reader. This is the one
    // place where docs/04 §2 (ASCII paths) and the UTF-8 flag requirement meet, and
    // the ASCII rule wins for anything that claims to be a `.stpack`.
    const archive = await writeZip([{ path: '数据/角色.json', bytes: encoder.encode('[]') }]);
    await expect(readZip(archive, { maxPathLength: 64 })).rejects.toMatchObject({
      context: { rule: 'path-charset', path: '数据/角色.json' },
    });
  });

  it('respects caller-supplied limits', async () => {
    const archive = await writeZip([
      { path: 'manifest.json', bytes: encoder.encode('{}') },
      { path: 'data/worlds.json', bytes: encoder.encode('[1,2,3]') },
    ]);
    await expect(readZip(archive, { maxEntryCount: 1 })).rejects.toMatchObject({
      context: { rule: 'too-many-entries' },
    });
  });

  it('reads an archive with a prepended stub (all offsets shifted)', async () => {
    // A self-extracting archive has bytes before the first local header. docs/04 does
    // not forbid them, and the central directory is still authoritative once the
    // shift is accounted for — but a ZIP64 trailer must not be mistaken for one.
    const plain = await writeZip(ORDERED_ENTRIES);
    const stub = encoder.encode('MZ-stub-bytes');
    const embedded = new Uint8Array(stub.byteLength + plain.byteLength);
    embedded.set(stub);
    embedded.set(plain, stub.byteLength);

    const entries = await readZip(embedded);
    expect(entries.map((entry) => entry.path)).toEqual(ORDERED_ENTRIES.map((entry) => entry.path));
    expect(decoder.decode(required(entries, 0).bytes)).toBe(
      decoder.decode(required(ORDERED_ENTRIES, 0).bytes),
    );
  });

  it('pack → unpack → pack is byte-identical (docs/04 §12 item 1)', async () => {
    const first = await writeZip(ORDERED_ENTRIES);
    const unpacked = await readZip(first);
    const second = await writeZip(
      unpacked.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    );
    expect(Array.from(second)).toEqual(Array.from(first));
  });
});

describe('crc32', () => {
  it('matches the IEEE 802.3 check value', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for an empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('detects a single flipped bit', () => {
    expect(crc32(encoder.encode('payload'))).not.toBe(crc32(encoder.encode('payloae')));
  });
});

/* ───────────────────────────────── ZIP64 ─────────────────────────────────── */

/**
 * Builds a *classic* archive whose entry sizes live in a ZIP64 extended
 * information extra field instead of the 32-bit slots.
 *
 * This is the shape a writer produces for a ≥4 GB entry, reproduced at 18 bytes so
 * the read path can be tested without allocating 4 GB. The local header offset stays
 * in its 32-bit slot (only the sizes are marked `0xFFFFFFFF`), which the format
 * permits: each ZIP64 field is present only when its own slot overflowed.
 */
function buildZip64EntryArchive(path: string, payload: Uint8Array): Uint8Array {
  const name = encoder.encode(path);
  const extra = new Uint8Array(4 + 16); // header id/size + uncompressed + compressed
  const extraView = new DataView(extra.buffer);
  extraView.setUint16(0, 0x0001, true);
  extraView.setUint16(2, 16, true);
  extraView.setUint32(4, payload.byteLength, true); // low half of uncompressed size
  extraView.setUint32(8, 0, true); // high half
  extraView.setUint32(12, payload.byteLength, true); // low half of compressed size
  extraView.setUint32(16, 0, true); // high half

  const local = new Uint8Array(30 + name.byteLength + extra.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 45, true); // version needed: ZIP64
  localView.setUint16(6, 0x0800, true);
  localView.setUint16(8, 0, true); // store
  localView.setUint16(10, 0, true);
  localView.setUint16(12, 0x0021, true);
  localView.setUint32(14, crc32(payload), true);
  localView.setUint32(18, 0xffffffff, true); // compressed size -> extra field
  localView.setUint32(22, 0xffffffff, true); // uncompressed size -> extra field
  localView.setUint16(26, name.byteLength, true);
  localView.setUint16(28, extra.byteLength, true);
  local.set(name, 30);
  local.set(extra, 30 + name.byteLength);

  const central = new Uint8Array(46 + name.byteLength + extra.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 45, true);
  centralView.setUint16(6, 45, true);
  centralView.setUint16(8, 0x0800, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint16(12, 0, true);
  centralView.setUint16(14, 0x0021, true);
  centralView.setUint32(16, crc32(payload), true);
  centralView.setUint32(20, 0xffffffff, true);
  centralView.setUint32(24, 0xffffffff, true);
  centralView.setUint16(28, name.byteLength, true);
  centralView.setUint16(30, extra.byteLength, true);
  centralView.setUint32(38, 0, true); // external attributes: regular file
  centralView.setUint32(42, 0, true); // local header offset
  central.set(name, 46);
  central.set(extra, 46 + name.byteLength);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.byteLength, true);
  eocdView.setUint32(16, local.byteLength + payload.byteLength, true);

  const archive = new Uint8Array(
    local.byteLength + payload.byteLength + central.byteLength + eocd.byteLength,
  );
  let cursor = 0;
  for (const part of [local, payload, central, eocd]) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

describe('ZIP64', () => {
  it('reads sizes from the ZIP64 extra field when the 32-bit slots say 0xFFFFFFFF', async () => {
    const payload = encoder.encode('{"kind":"zip64"}');
    const archive = buildZip64EntryArchive('data/worlds.json', payload);
    const entries = await readZip(archive);
    expect(entries.map((entry) => entry.path)).toEqual(['data/worlds.json']);
    expect(decoder.decode(required(entries, 0).bytes)).toBe('{"kind":"zip64"}');
  });

  it('still applies the per-entry cap to a ZIP64 entry', async () => {
    const payload = encoder.encode('x'.repeat(512));
    const archive = buildZip64EntryArchive('data/worlds.json', payload);
    await expect(readZip(archive, { maxEntryBytes: 64 })).rejects.toMatchObject({
      context: { rule: 'entry-bytes-exceeded' },
    });
  });

  it('emits ZIP64 end-of-central-directory records past the 65535-entry ceiling', async () => {
    // docs/04 §9: ZIP64 must be implemented, not merely requested; the classic EOCD
    // count fields are 16-bit, so an archive this size cannot be described without it.
    const entries = Array.from({ length: 65_536 }, (_unused, index) => ({
      path: `data/${index}.json`,
      bytes: encoder.encode('0'),
      method: 'store' as const,
    }));
    const archive = await writeZip(entries);
    const view = viewOf(archive);
    const eocd = archive.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(0xffff); // saturated
    expect(view.getUint16(eocd + 10, true)).toBe(0xffff);
    // ZIP64 locator immediately before the EOCD, record immediately before that.
    expect(view.getUint32(eocd - 20, true)).toBe(0x07064b50);
    expect(view.getUint32(eocd - 76, true)).toBe(0x06064b50);

    const entriesBack = await readZip(archive, { maxEntryCount: 100_000 });
    expect(entriesBack).toHaveLength(65_536);
    expect(entriesBack[0]?.path).toBe('data/0.json');
    expect(entriesBack[65_535]?.path).toBe('data/65535.json');
  }, 30_000);

  it('rejects a ZIP64 archive over the default entry-count limit', async () => {
    const entries = Array.from({ length: 65_536 }, (_unused, index) => ({
      path: `data/${index}.json`,
      bytes: encoder.encode('0'),
      method: 'store' as const,
    }));
    const archive = await writeZip(entries);
    await expect(readZip(archive)).rejects.toMatchObject({
      context: { rule: 'too-many-entries' },
    });
  }, 30_000);
});
