/**
 * Deterministic ZIP writer for `.stpack` (M0-T3, ADR-018).
 *
 * WHY THIS FILE EXISTS
 * docs/04-分享格式规范.md §2 and §11 demand a container whose bytes are reproducible:
 * the manifest first, everything else in path order, a fixed timestamp, no
 * "whatever the library felt like" metadata. ADR-018 records why that is self-built
 * rather than delegated to a general-purpose zip library: the *rejection* surface
 * (docs/04 §9) has to be written by hand anyway, so the container may as well be
 * narrow and fully controlled, with zero new dependencies.
 *
 * WHAT THIS WRITER DELIBERATELY DOES NOT EMIT
 * - no data descriptors (sizes are known before writing, so bit 3 stays clear);
 * - no archive/entry comments and no extra fields other than ZIP64;
 * - no timestamps other than the fixed `1980-01-01 00:00:00` DOS stamp, because
 *   "now" would make two packs of the same content differ.
 * The result is the smallest set of records the format allows.
 *
 * SCOPE: caller supplies entry order and bytes; this module does no I/O, touches no
 * DOM, and never uses `Buffer`. The `manifest.json`-first rule is the caller's
 * responsibility (it is an archive-layout policy, enforced in `pack.ts`).
 */

import { crc32 } from './crc32';
import { deflateRaw } from './deflate';
import { ZipError } from './errors';

/* ───────────────────────────── format constants ──────────────────────────── */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;

/** ZIP64 extended information extra field header id. */
const ZIP64_EXTRA_FIELD_ID = 0x0001;

/** 0xFFFFFFFF is ZIP's "the real value is in the ZIP64 extra field" marker. */
const ZIP64_MARKER = 0xffff_ffff;

/** Classic ZIP's 16-bit ceiling for entry counts and disk numbers. */
const CLASSIC_COUNT_LIMIT = 0xffff;

/**
 * General-purpose bit 11: the filename is UTF-8 (docs/04 §2 paths are UTF-8).
 *
 * The only flag this writer sets. Bit 3 (data descriptor) and bit 0 (encryption) are
 * deliberately absent: sizes and the CRC are known before the payload is written, and
 * `./read.ts` refuses archives that claim either.
 */
const FLAG_UTF8_NAMES = 0x0800;

/**
 * Fixed DOS date/time for every entry: `1980-01-01 00:00:00`
 * (docs/04 §2 "所有条目使用固定时间戳 `1980-01-01`"; §11 repeats it).
 *
 * Encoding: date = ((year - 1980) << 9) | (month << 5) | day = 0x0021,
 * time = (hour << 11) | (minute << 5) | (second >> 1) = 0x0000. 1980-01-01 is the
 * lowest value the DOS format can represent, which is why the spec picked it.
 */
export const FIXED_DOS_DATE = 0x0021;
export const FIXED_DOS_TIME = 0x0000;

/** `version needed to extract` for a plain store/deflate entry (ZIP 2.0). */
const VERSION_NEEDED = 20;
/** `version needed to extract` when ZIP64 records are present (ZIP 4.5). */
const VERSION_NEEDED_ZIP64 = 45;
/** `version made by`: MS-DOS / FAT, so no Unix permission bits are implied. */
const VERSION_MADE_BY = 20;

const STORE = 0;
const DEFLATE = 8;

/* ────────────────────────────────── types ───────────────────────────────── */

/** One file to place in the archive. */
export interface ZipWriteEntry {
  /**
   * Path inside the archive, `/`-separated. Written verbatim: validating it against
   * docs/04 §2 (no `..`, no drive letter, `[A-Za-z0-9._/-]` only) belongs to the
   * caller/reader, and second-guessing it here would produce archives that fail to
   * reopen.
   */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** `'store'` (method 0) or `'deflate'` (method 8); defaults to `'deflate'`. */
  readonly method?: 'store' | 'deflate';
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/** Little-endian 32-bit writer with bounds growth, so no `DataView` bookkeeping. */
class ByteSink {
  #bytes = new Uint8Array(1024);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  #ensure(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#bytes.length) return;
    let capacity = this.#bytes.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }

  u8(value: number): void {
    this.#ensure(1);
    this.#bytes[this.#length] = value & 0xff;
    this.#length += 1;
  }

  u16(value: number): void {
    this.#ensure(2);
    this.#bytes[this.#length] = value & 0xff;
    this.#bytes[this.#length + 1] = (value >>> 8) & 0xff;
    this.#length += 2;
  }

  /** 32-bit field; callers pass `ZIP64_MARKER` when the real value went to ZIP64. */
  u32(value: number): void {
    this.#ensure(4);
    this.#bytes[this.#length] = value & 0xff;
    this.#bytes[this.#length + 1] = (value >>> 8) & 0xff;
    this.#bytes[this.#length + 2] = (value >>> 16) & 0xff;
    this.#bytes[this.#length + 3] = Math.floor(value / 0x1_0000_00) & 0xff;
    this.#length += 4;
  }

  /**
   * 64-bit little-endian. Written as two 32-bit halves: JavaScript's `<<`/`>>>`
   * coerce to signed 32-bit, which silently corrupts any value at or above 2 GB —
   * exactly the sizes ZIP64 exists for — so the high half is extracted with
   * arithmetic instead.
   */
  u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new ZipError(`value ${value} cannot be encoded as a ZIP64 64-bit field`, {
        rule: 'zip64-range',
      });
    }
    this.u32(value % 0x1_0000_0000);
    this.u32(Math.floor(value / 0x1_0000_0000));
  }

  raw(bytes: Uint8Array): void {
    this.#ensure(bytes.byteLength);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.byteLength;
  }

  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}

/** Fields of one entry that the local header and the central directory disagree on. */
interface PreparedEntry {
  readonly pathBytes: Uint8Array;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly needsZip64: boolean;
}

/**
 * Encodes a ZIP64 extended information extra field.
 *
 * Order is fixed by the format: uncompressed size, compressed size, then local
 * header offset (then disk start number). Only fields whose 32-bit slot holds
 * `0xFFFFFFFF` are present, and a reader walks them positionally — so the caller
 * must pass `hasOffset` for exactly the entries whose offset overflowed.
 */
function zip64ExtraField(
  hasUncompressed: boolean,
  hasCompressed: boolean,
  hasOffset: boolean,
  uncompressedSize: number,
  compressedSize: number,
  localHeaderOffset: number,
): Uint8Array {
  const field = new ByteSink();
  field.u16(ZIP64_EXTRA_FIELD_ID);
  let dataLength = 0;
  if (hasUncompressed) dataLength += 8;
  if (hasCompressed) dataLength += 8;
  if (hasOffset) dataLength += 8;
  field.u16(dataLength);
  if (hasUncompressed) field.u64(uncompressedSize);
  if (hasCompressed) field.u64(compressedSize);
  if (hasOffset) field.u64(localHeaderOffset);
  return field.finish();
}

/* ──────────────────────────────── the API ───────────────────────────────── */

/**
 * Builds a ZIP archive from `entries`, in the order given.
 *
 * Deterministic by construction: identical input produces identical bytes. That is
 * true even for `deflate`, because the compressed stream comes from the same
 * single-shot platform call every time (verified on this host, see `./deflate.ts`).
 *
 * Emits ZIP64 records only where the classic fields would overflow: an entry at or
 * above 4 GB (either size), a local header offset at or above 4 GB, or more than
 * 65535 entries (docs/04 §9 "实现必须支持读写 ZIP64 扩展字段，不得仅因体积直接失败").
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Uint8Array> {
  const local = new ByteSink();
  const prepared: PreparedEntry[] = [];

  for (const entry of entries) {
    const pathBytes = new TextEncoder().encode(entry.path);
    const methodName = entry.method ?? 'deflate';
    if (methodName !== 'store' && methodName !== 'deflate') {
      throw new ZipError(`unsupported compression method ${String(methodName)}`, {
        path: entry.path,
        rule: 'unsupported-method',
      });
    }

    const payload = methodName === 'store' ? entry.bytes : await deflateRaw(entry.bytes);
    const method = methodName === 'store' ? STORE : DEFLATE;
    const crc = crc32(entry.bytes);
    const uncompressedSize = entry.bytes.byteLength;
    const compressedSize = payload.byteLength;
    const localHeaderOffset = local.length;

    const needsZip64 =
      uncompressedSize >= ZIP64_MARKER ||
      compressedSize >= ZIP64_MARKER ||
      localHeaderOffset >= ZIP64_MARKER;
    const extra = needsZip64
      ? zip64ExtraField(
          uncompressedSize >= ZIP64_MARKER,
          compressedSize >= ZIP64_MARKER,
          localHeaderOffset >= ZIP64_MARKER,
          uncompressedSize,
          compressedSize,
          localHeaderOffset,
        )
      : undefined;

    local.u32(LOCAL_FILE_HEADER_SIGNATURE);
    local.u16(needsZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED);
    local.u16(FLAG_UTF8_NAMES);
    local.u16(method);
    local.u16(FIXED_DOS_TIME);
    local.u16(FIXED_DOS_DATE);
    local.u32(crc);
    local.u32(compressedSize >= ZIP64_MARKER ? ZIP64_MARKER : compressedSize);
    local.u32(uncompressedSize >= ZIP64_MARKER ? ZIP64_MARKER : uncompressedSize);
    local.u16(pathBytes.byteLength);
    local.u16(extra?.byteLength ?? 0);
    local.raw(pathBytes);
    if (extra !== undefined) local.raw(extra);
    // Stored BEFORE the payload, so the offset stays valid regardless of method.
    local.raw(payload);

    prepared.push({
      pathBytes,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      needsZip64,
    });
  }

  const centralDirectoryOffset = local.length;
  const central = new ByteSink();

  for (const entry of prepared) {
    const sizeOverflows =
      entry.compressedSize >= ZIP64_MARKER || entry.uncompressedSize >= ZIP64_MARKER;
    const offsetOverflows = entry.localHeaderOffset >= ZIP64_MARKER;
    const extra = entry.needsZip64
      ? zip64ExtraField(
          entry.uncompressedSize >= ZIP64_MARKER,
          entry.compressedSize >= ZIP64_MARKER,
          offsetOverflows,
          entry.uncompressedSize,
          entry.compressedSize,
          entry.localHeaderOffset,
        )
      : undefined;

    central.u32(CENTRAL_FILE_HEADER_SIGNATURE);
    central.u16(entry.needsZip64 ? VERSION_NEEDED_ZIP64 : VERSION_MADE_BY);
    central.u16(entry.needsZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED);
    central.u16(FLAG_UTF8_NAMES);
    central.u16(entry.method);
    central.u16(FIXED_DOS_TIME);
    central.u16(FIXED_DOS_DATE);
    central.u32(entry.crc);
    central.u32(sizeOverflows ? ZIP64_MARKER : entry.compressedSize);
    central.u32(sizeOverflows ? ZIP64_MARKER : entry.uncompressedSize);
    central.u16(entry.pathBytes.byteLength);
    central.u16(extra?.byteLength ?? 0);
    central.u16(0); // file comment length
    central.u16(0); // disk number start
    central.u16(0); // internal file attributes
    // External attributes 0: MS-DOS made-by, so no Unix mode is implied — in
    // particular no symlink bit for a reader to (rightly) reject.
    central.u32(0);
    central.u32(offsetOverflows ? ZIP64_MARKER : entry.localHeaderOffset);
    central.raw(entry.pathBytes);
    if (extra !== undefined) central.raw(extra);
  }

  const centralDirectorySize = central.length;
  const entryCount = prepared.length;
  const out = local;
  out.raw(central.finish());

  const needsZip64End =
    entryCount > CLASSIC_COUNT_LIMIT ||
    centralDirectorySize >= ZIP64_MARKER ||
    centralDirectoryOffset >= ZIP64_MARKER;

  if (needsZip64End) {
    const zip64EndOffset = out.length;
    out.u32(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
    out.u64(44); // size of the remainder of this record
    out.u16(VERSION_MADE_BY);
    out.u16(VERSION_NEEDED_ZIP64);
    out.u32(0); // this disk number
    out.u32(0); // disk with the central directory
    out.u64(entryCount);
    out.u64(entryCount);
    out.u64(centralDirectorySize);
    out.u64(centralDirectoryOffset);

    out.u32(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE);
    out.u32(0); // disk holding the ZIP64 EOCD
    out.u64(zip64EndOffset);
    out.u32(1); // total number of disks
  }

  out.u32(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  out.u16(0); // this disk number
  out.u16(0); // disk with the central directory
  out.u16(Math.min(entryCount, CLASSIC_COUNT_LIMIT));
  out.u16(Math.min(entryCount, CLASSIC_COUNT_LIMIT));
  out.u32(Math.min(centralDirectorySize, ZIP64_MARKER));
  out.u32(Math.min(centralDirectoryOffset, ZIP64_MARKER));
  out.u16(0); // archive comment length — no comments, ever

  return out.finish();
}
