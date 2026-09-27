import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { deflateRaw } from './deflate';
import { ZipError } from './errors';
import { readZip } from './read';

/**
 * One test per rejection rule in docs/04-分享格式规范.md §9 / §12 item 7 and
 * docs/06 §8.2 ("恶意 ZIP 全部被拒").
 *
 * Every malicious archive here is assembled byte by byte with `DataView` and
 * `Uint8Array` — deliberately *not* with `./write.ts`. A test that reuses the writer
 * can only prove the writer and reader agree with each other; hand-built fixtures
 * prove the reader stands on its own against a hostile producer.
 */

const encoder = new TextEncoder();

/* ─────────────────────────────── fixture builder ─────────────────────────── */

interface MaliciousEntry {
  /** Stored name; `/`-separated in the well-formed cases. */
  readonly path: string;
  /** Exactly the bytes placed after the local header, already compressed. */
  readonly payload: Uint8Array;
  /** Method field in both headers; defaults to 0 (store). */
  readonly method?: number;
  /** CRC-32 field in the central directory; defaults to the payload's real CRC. */
  readonly crc?: number;
  /** Size the central directory claims; defaults to the payload length. */
  readonly uncompressedSize?: number;
  /** Compressed size in both headers; defaults to the payload length. */
  readonly compressedSize?: number;
  /** General-purpose bit flag; defaults to the UTF-8 name bit. */
  readonly flags?: number;
  /** `version needed to extract`; defaults to 20. */
  readonly versionNeeded?: number;
  /** High 16 bits become the Unix file type in the external attributes. */
  readonly unixType?: number;
  /** Extra field bytes placed in both headers. */
  readonly extraField?: Uint8Array;
  /** Local header offset recorded in the central directory; defaults to the real one. */
  readonly declaredOffset?: number;
  /** Modification time; defaults to the fixed 0. */
  readonly dosTime?: number;
  /** Modification date; defaults to the fixed 0x0021 (1980-01-01). */
  readonly dosDate?: number;
}

interface MaliciousArchiveOptions {
  readonly entryCount?: number;
  readonly centralDirectorySize?: number;
  readonly centralDirectoryOffset?: number;
}

/** Assembles a ZIP whose every field can be made inconsistent on purpose. */
function buildMaliciousZip(
  entries: readonly MaliciousEntry[],
  options: MaliciousArchiveOptions = {},
): Uint8Array {
  const localParts: Uint8Array[] = [];
  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const extra = entry.extraField ?? new Uint8Array(0);
    const header = new Uint8Array(30 + name.byteLength + extra.byteLength);
    const view = new DataView(header.buffer);
    const compressedSize = entry.compressedSize ?? entry.payload.byteLength;
    const uncompressedSize = entry.uncompressedSize ?? entry.payload.byteLength;

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, entry.versionNeeded ?? 20, true);
    view.setUint16(6, entry.flags ?? 0x0800, true);
    view.setUint16(8, entry.method ?? 0, true);
    view.setUint16(10, entry.dosTime ?? 0, true);
    view.setUint16(12, entry.dosDate ?? 0x0021, true);
    view.setUint32(14, entry.crc ?? crc32(entry.payload), true);
    view.setUint32(18, compressedSize, true);
    view.setUint32(22, uncompressedSize, true);
    view.setUint16(26, name.byteLength, true);
    view.setUint16(28, extra.byteLength, true);
    header.set(name, 30);
    header.set(extra, 30 + name.byteLength);

    localOffsets.push(offset);
    localParts.push(header, entry.payload);
    offset += header.byteLength + entry.payload.byteLength;
  }

  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (const [index, entry] of entries.entries()) {
    const name = encoder.encode(entry.path);
    const extra = entry.extraField ?? new Uint8Array(0);
    const record = new Uint8Array(46 + name.byteLength + extra.byteLength);
    const view = new DataView(record.buffer);
    const compressedSize = entry.compressedSize ?? entry.payload.byteLength;
    const uncompressedSize = entry.uncompressedSize ?? entry.payload.byteLength;

    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // version made by (MS-DOS)
    view.setUint16(6, entry.versionNeeded ?? 20, true);
    view.setUint16(8, entry.flags ?? 0x0800, true);
    view.setUint16(10, entry.method ?? 0, true);
    view.setUint16(12, entry.dosTime ?? 0, true);
    view.setUint16(14, entry.dosDate ?? 0x0021, true);
    view.setUint32(16, entry.crc ?? crc32(entry.payload), true);
    view.setUint32(20, compressedSize, true);
    view.setUint32(24, uncompressedSize, true);
    view.setUint16(28, name.byteLength, true);
    view.setUint16(30, extra.byteLength, true);
    view.setUint16(32, 0, true); // file comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal attributes
    view.setUint32(38, (entry.unixType ?? 0) << 16, true);
    view.setUint32(42, entry.declaredOffset ?? (localOffsets[index] as number), true);
    record.set(name, 46);
    record.set(extra, 46 + name.byteLength);

    centralParts.push(record);
    centralSize += record.byteLength;
  }

  const localSize = localParts.reduce((total, part) => total + part.byteLength, 0);
  const centralOffset = options.centralDirectoryOffset ?? localSize;
  const centralDirectorySize = options.centralDirectorySize ?? centralSize;
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, options.entryCount ?? entries.length, true);
  eocdView.setUint16(10, options.entryCount ?? entries.length, true);
  eocdView.setUint32(12, centralDirectorySize, true);
  eocdView.setUint32(16, centralOffset, true);

  const parts = [...localParts, ...centralParts, eocd];
  const archive = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

/** A stored entry holding `text`. */
function stored(
  path: string,
  text: string,
  overrides: Partial<MaliciousEntry> = {},
): MaliciousEntry {
  const payload = encoder.encode(text);
  return { path, payload, ...overrides };
}

/** Asserts the reader refused the archive with a specific rule (and entry path). */
async function expectRejection(
  archive: Uint8Array,
  rule: string,
  path?: string,
  limits?: Parameters<typeof readZip>[1],
): Promise<void> {
  let thrown: unknown;
  try {
    await readZip(archive, limits);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected readZip to reject with rule "${rule}"`).toBeInstanceOf(ZipError);
  const failure = thrown as ZipError;
  expect(failure.context.rule, failure.message).toBe(rule);
  if (path !== undefined) expect(failure.context.path).toBe(path);
}

/* ──────────────────────────────── the tests ─────────────────────────────── */

describe('readZip — path traversal (docs/04 §9, §12 item 7)', () => {
  it('rejects a bare `..` segment', async () => {
    await expectRejection(
      buildMaliciousZip([stored('../evil.txt', 'x')]),
      'path-traversal',
      '../evil.txt',
    );
  });

  it('rejects `..` in the middle of a path (zip slip)', async () => {
    await expectRejection(
      buildMaliciousZip([stored('data/../../evil.txt', 'x')]),
      'path-traversal',
      'data/../../evil.txt',
    );
  });

  it('rejects a trailing `..` segment', async () => {
    await expectRejection(buildMaliciousZip([stored('data/..', 'x')]), 'path-traversal');
  });

  it('rejects an absolute path', async () => {
    await expectRejection(buildMaliciousZip([stored('/etc/passwd', 'x')]), 'absolute-path');
  });

  it('rejects a Windows drive letter', async () => {
    await expectRejection(
      buildMaliciousZip([stored('C:/Windows/system32/x.dll', 'x')]),
      'drive-letter',
    );
  });

  it('rejects backslashes', async () => {
    await expectRejection(buildMaliciousZip([stored('data\\evil.txt', 'x')]), 'backslash');
  });

  it('rejects an empty path', async () => {
    await expectRejection(buildMaliciousZip([stored('', 'x')]), 'empty-path');
  });

  it('rejects a path with a control character', async () => {
    await expectRejection(
      buildMaliciousZip([stored('data/ev\u0000il.txt', 'x')]),
      'control-character',
    );
  });

  it('rejects a path outside the docs/04 §2 character set', async () => {
    await expectRejection(buildMaliciousZip([stored('data/ev il.txt', 'x')]), 'path-charset');
  });
});

describe('readZip — entry kinds and flags', () => {
  it('rejects a symlink (Unix external attributes)', async () => {
    await expectRejection(
      buildMaliciousZip([stored('data/link', '/etc/passwd', { unixType: 0xa000 })]),
      'symlink',
      'data/link',
    );
  });

  it('rejects a directory entry', async () => {
    await expectRejection(
      buildMaliciousZip([stored('data/', '', { unixType: 0x4000 })]),
      'directory-entry',
    );
  });

  it('rejects a FIFO/device entry', async () => {
    await expectRejection(
      buildMaliciousZip([stored('data/fifo', '', { unixType: 0x1000 })]),
      'non-regular-file',
    );
  });

  it('rejects an encrypted entry', async () => {
    await expectRejection(
      buildMaliciousZip([stored('a.txt', 'x', { flags: 0x0801 })]),
      'encrypted',
    );
  });

  it('rejects AES-encrypted entries (method 99)', async () => {
    await expectRejection(buildMaliciousZip([stored('a.txt', 'x', { method: 99 })]), 'encrypted');
  });

  it('rejects a data descriptor', async () => {
    await expectRejection(
      buildMaliciousZip([stored('a.txt', 'x', { flags: 0x0808 })]),
      'data-descriptor',
    );
  });

  it('rejects a non-fixed timestamp', async () => {
    await expectRejection(
      buildMaliciousZip([stored('a.txt', 'x', { dosDate: 0x5a21, dosTime: 0x4000 })]),
      'unfixed-timestamp',
    );
  });
});

describe('readZip — unsupported container features', () => {
  for (const method of [1, 6, 12, 14, 93, 98]) {
    it(`rejects compression method ${method}`, async () => {
      await expectRejection(
        buildMaliciousZip([stored('a.txt', 'x', { method })]),
        'unsupported-method',
      );
    });
  }

  it('rejects an archive with a comment', async () => {
    const archive = buildMaliciousZip([stored('a.txt', 'x')]);
    const withComment = new Uint8Array(archive.byteLength + 5);
    withComment.set(archive);
    new DataView(withComment.buffer).setUint16(archive.byteLength - 2, 5, true);
    withComment.set(encoder.encode('hello'), archive.byteLength);
    await expectRejection(withComment, 'archive-comment');
  });

  it('rejects an archive with no EOCD at all', async () => {
    await expectRejection(new Uint8Array([1, 2, 3, 4, 5]), 'truncated');
  });

  it('rejects a central directory that is not where the EOCD says it is', async () => {
    const archive = buildMaliciousZip([stored('a.txt', 'x')], { centralDirectoryOffset: 999 });
    await expectRejection(archive, 'truncated');
  });

  it('rejects a central directory record with a bad signature', async () => {
    const archive = buildMaliciousZip([stored('a.txt', 'x')]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const eocd = archive.byteLength - 22;
    const centralOffset = view.getUint32(eocd + 16, true);
    view.setUint32(centralOffset, 0xdeadbeef, true);
    await expectRejection(archive, 'bad-central-header');
  });

  it('rejects a local header whose name disagrees with the central directory', async () => {
    const archive = buildMaliciousZip([stored('a.txt', 'x')]);
    // Rename only the local copy: same length, so no offset shifts.
    archive.set(encoder.encode('b.txt'), archive.indexOf(0x61));
    await expectRejection(archive, 'name-mismatch');
  });

  it('rejects a local header at an offset that holds no local header', async () => {
    await expectRejection(
      buildMaliciousZip([stored('a.txt', 'x', { declaredOffset: 1 })]),
      'bad-local-header',
    );
  });
});

describe('readZip — limits and bombs', () => {
  it('rejects more entries than the limit allows', async () => {
    const archive = buildMaliciousZip([
      stored('a.txt', 'a'),
      stored('b.txt', 'b'),
      stored('c.txt', 'c'),
    ]);
    await expectRejection(archive, 'too-many-entries', undefined, { maxEntryCount: 2 });
  });

  it('rejects an entry-count overflow declared only in the EOCD', async () => {
    const archive = buildMaliciousZip([stored('a.txt', 'a')], { entryCount: 5000 });
    await expectRejection(archive, 'too-many-entries', undefined, { maxEntryCount: 10 });
  });

  it('rejects an over-long path', async () => {
    const long = `data/${'p'.repeat(300)}.json`;
    await expectRejection(buildMaliciousZip([stored(long, 'x')]), 'path-too-long', long, {
      maxPathLength: 64,
    });
  });

  it('rejects an entry whose declared size exceeds the per-file limit', async () => {
    const archive = buildMaliciousZip([
      stored('a.txt', 'x', { compressedSize: 2_000_000, uncompressedSize: 2_000_000 }),
    ]);
    await expectRejection(archive, 'entry-bytes-exceeded', 'a.txt', {
      maxEntryBytes: 1024,
      maxTotalBytes: 10 * 1024 * 1024,
    });
  });

  it('cuts off a zip bomb whose real output exceeds the declared size', async () => {
    // Highly compressible: a few hundred compressed bytes that inflate to 1 MB.
    const payload = await deflateRaw(encoder.encode('A'.repeat(1_000_000)));
    expect(payload.byteLength).toBeLessThan(2048);
    const archive = buildMaliciousZip([
      {
        path: 'data/bomb.json',
        payload,
        method: 8,
        compressedSize: payload.byteLength,
        uncompressedSize: 10, // the lie: 10 bytes were promised, ~1 MB arrives
      },
    ]);
    await expectRejection(archive, 'declared-size-exceeded', 'data/bomb.json', {
      maxEntryBytes: 1024 * 1024,
    });
  });

  it('cuts off a zip bomb whose declared size also exceeds the per-file limit', async () => {
    const payload = await deflateRaw(encoder.encode('A'.repeat(1_000_000)));
    const archive = buildMaliciousZip([
      {
        path: 'data/bomb.json',
        payload,
        method: 8,
        compressedSize: payload.byteLength,
        uncompressedSize: 9_000_000,
      },
    ]);
    await expectRejection(archive, 'entry-bytes-exceeded', 'data/bomb.json', {
      maxEntryBytes: 4096,
      maxTotalBytes: 1024 * 1024,
    });
  });

  it('rejects an archive whose entries exceed the total limit', async () => {
    const payload = await deflateRaw(encoder.encode('B'.repeat(200_000)));
    const archive = buildMaliciousZip([
      {
        path: 'data/a.json',
        payload,
        method: 8,
        compressedSize: payload.byteLength,
        uncompressedSize: 200_000,
      },
    ]);
    await expectRejection(archive, 'total-bytes-exceeded', 'data/a.json', {
      maxEntryBytes: 1024 * 1024,
      maxTotalBytes: 100_000,
    });
  });
});

describe('readZip — integrity', () => {
  it('rejects a tampered payload (CRC-32 mismatch, docs/04 §12 item 3)', async () => {
    const entry = stored('data/worlds.json', '{"id":"w1"}');
    const archive = buildMaliciousZip([entry]);
    // Flip one payload byte; sizes and offsets stay valid.
    const payloadStart = 30 + encoder.encode('data/worlds.json').byteLength;
    archive[payloadStart] = (archive[payloadStart] ?? 0) ^ 0x01;
    await expectRejection(archive, 'crc-mismatch', 'data/worlds.json');
  });

  it('rejects a declared CRC that does not match the data', async () => {
    const entry = stored('a.txt', 'x');
    await expectRejection(buildMaliciousZip([{ ...entry, crc: 0x12345678 }]), 'crc-mismatch');
  });

  it('rejects a stored entry whose sizes disagree', async () => {
    await expectRejection(
      buildMaliciousZip([stored('a.txt', 'four', { uncompressedSize: 8 })]),
      'declared-size-mismatch',
    );
  });

  it('rejects a truncated payload', async () => {
    const archive = buildMaliciousZip([stored('a.txt', 'x', { compressedSize: 9999 })]);
    // The central directory claims more bytes than exist after the local header.
    await expectRejection(archive, 'overlapping-records');
  });

  it('rejects an inflated size that does not match the declaration', async () => {
    const payload = await deflateRaw(encoder.encode('C'.repeat(500)));
    const archive = buildMaliciousZip([
      {
        path: 'data/c.json',
        payload,
        method: 8,
        compressedSize: payload.byteLength,
        uncompressedSize: payload.byteLength, // wrong, but under every cap
      },
    ]);
    // Reported against the declaration rather than the cap: the directory promised a
    // size the data does not have, which is the fault a caller can act on.
    await expectRejection(archive, 'declared-size-exceeded', 'data/c.json');
  });
});

describe('readZip — ZIP64 markers', () => {
  it('rejects an entry that claims ZIP64 without the extra field', async () => {
    const archive = buildMaliciousZip([
      stored('a.txt', 'x', { uncompressedSize: 0xffffffff, versionNeeded: 45 }),
    ]);
    await expectRejection(archive, 'zip64-extra');
  });

  it('rejects a ZIP64 extra field that omits the size the field overflowed for', async () => {
    // Header id 0x0001 with a one-byte payload: long enough to be present, too short
    // to hold the 8-byte uncompressed size the 0xFFFFFFFF slot demands.
    const extraField = new Uint8Array([0x01, 0x00, 0x01, 0x00, 0x00]);
    const archive = buildMaliciousZip([
      stored('a.txt', 'x', {
        uncompressedSize: 0xffffffff,
        versionNeeded: 45,
        extraField,
      }),
    ]);
    await expectRejection(archive, 'zip64-extra');
  });
});
