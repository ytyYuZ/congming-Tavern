/**
 * Strict ZIP reader for `.stpack` — the untrusted side of the container (M0-T3,
 * ADR-018).
 *
 * WHY THIS FILE EXISTS
 * `docs/04-分享格式规范.md` §9 and §12 items 3 and 7 make an imported package
 * hostile input by default: it may be truncated, encrypted, zip-bombed, or carry a
 * path that escapes the target directory. ADR-018 keeps this container self-built
 * precisely so the rejection surface is explicit and small. This module therefore
 * enumerates the reasons to refuse rather than the reasons to accept.
 *
 * HOW IT READS
 * Everything comes from the **central directory**, never from the local headers:
 * a local header is written before its payload and is the easiest thing for a
 * crafted archive to lie about, while the central directory is what the format
 * defines as authoritative. Local headers are still checked (signature and name
 * must agree with the central directory) because a mismatch means the two halves
 * describe different files.
 *
 * WHAT IS REFUSED (each rule names the entry, per §9 "指出具体条目")
 * - encryption (general-purpose bit 0, or method 99 AES);
 * - any compression method other than store(0) and deflate(8) — no nested archives,
 *   no implied unpacking (§9 "不解压嵌套压缩包", §8.2 decision 1);
 * - path traversal (`..` segments), absolute paths, Windows drive letters,
 *   backslashes, empty/`.` paths, and control characters;
 * - symlinks and other non-regular Unix file types (external attributes);
 * - multi-disk archives, archive comments, entry comments and data descriptors,
 *   none of which this writer produces and all of which widen the parser;
 * - timestamps other than the fixed `1980-01-01 00:00:00` (determinism check);
 * - entry count, path length, per-entry size and archive total over the caps;
 * - a local header whose name or method disagrees with the central directory;
 * - **a zip bomb, cut off mid-inflate**: output is streamed and reading stops the
 *   moment the declared size or a cap is crossed (§8.2 decision 4), then the size
 *   and CRC-32 are verified so a bit-flip is caught here rather than later as a
 *   SHA-256 mismatch.
 *
 * SCOPE: never touches disk and returns bytes only. No `Buffer`, no DOM, no
 * `node:` import — this file runs unchanged in Node and browsers.
 */

import type { PackageLimits, PartialPackageLimits } from '../limits';
import { resolveLimits } from '../limits';
import { crc32 } from './crc32';
import { inflateRaw } from './deflate';
import { ZipError } from './errors';

/* ───────────────────────────── format constants ──────────────────────────── */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;

const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP64_MARKER = 0xffff_ffff;
const CLASSIC_COUNT_LIMIT = 0xffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8_NAMES = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Fixed DOS stamp written by `./write.ts`; comparing it is a determinism check. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

/** Size of a central directory record up to (not including) its name and extras. */
const CENTRAL_HEADER_BYTES = 46;
/** Size of a local file header up to (not including) its name and extras. */
const LOCAL_HEADER_BYTES = 30;

/** Only mode bits are meaningful in the high 16 bits of external attributes. */
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_TYPE_DIRECTORY = 0x4000;
const UNIX_TYPE_REGULAR = 0x8000;
const UNIX_TYPE_SYMLINK = 0xa000;

/** docs/04 §2: filenames are `[A-Za-z0-9._/-]`. */
const ALLOWED_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
/** docs/04 §2: paths are `/`-separated and must not contain a `..` segment. */
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * True when `value` contains a C0 control or DEL.
 *
 * A loop rather than `/[\u0000-\u001f\u007f]/`, so the rule is visible instead of
 * hidden in escape sequences — and because `noControlCharactersInRegex` (rightly)
 * treats a pattern like that as suspicious.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/* ────────────────────────────────── types ───────────────────────────────── */

/** One file recovered from the archive. */
export interface ZipReadEntry {
  /** Path exactly as stored in the central directory. */
  readonly path: string;
  /** Entry payload, already inflated when the method is deflate. */
  readonly bytes: Uint8Array;
  /** ZIP compression method: 0 (store) or 8 (deflate). */
  readonly method: number;
}

/* ──────────────────────────── bounds-checked view ────────────────────────── */

/** Little-endian reader over a `Uint8Array` that refuses to read past the end. */
class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  set offset(value: number) {
    this.#offset = value;
  }

  get length(): number {
    return this.#bytes.byteLength;
  }

  /** True when `count` more bytes can be read without leaving the buffer. */
  canRead(count: number): boolean {
    return this.#offset + count <= this.#bytes.byteLength;
  }

  u8(): number {
    this.#need(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  u16(): number {
    this.#need(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    this.#need(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  /**
   * 64-bit little-endian. Values above `Number.MAX_SAFE_INTEGER` are unreachable in
   * practice (an archive that large cannot be held in one `Uint8Array`) and are
   * refused rather than silently rounded — a rounded offset is a wrong offset.
   */
  u64(field: string): number {
    const low = this.u32();
    const high = this.u32();
    if (high > 0x001f_ffff) {
      throw new ZipError(`ZIP64 ${field} exceeds the exactly-representable range`, {
        offset: this.#offset - 8,
        rule: 'zip64-range',
      });
    }
    return high * 0x1_0000_0000 + low;
  }

  bytes(count: number): Uint8Array {
    this.#need(count);
    const slice = this.#bytes.subarray(this.#offset, this.#offset + count);
    this.#offset += count;
    return slice;
  }

  #need(count: number): void {
    if (this.#offset + count > this.#bytes.byteLength) {
      throw new ZipError(`archive truncated: ${count} byte(s) needed at this position`, {
        offset: this.#offset,
        rule: 'truncated',
      });
    }
  }
}

/* ─────────────────────────────── validation ──────────────────────────────── */

/**
 * Validates one entry path against docs/04 §2 ("一律使用 `/` 分隔；不得包含 `..`、
 * 绝对路径、驱动器号") and §9 (path traversal and absolute paths are rejected).
 *
 * Checked before anything is inflated and before the bytes could reach a caller's
 * filesystem: unpacking a path like `../../.ssh/authorized_keys` is the classic
 * zip-slip attack, and it is cheaper to refuse the name than to sanitize it.
 */
function assertSafePath(path: string, limits: PackageLimits): void {
  if (path.length === 0) {
    throw new ZipError('empty entry path', { rule: 'empty-path' });
  }
  if (path.length > limits.maxPathLength) {
    throw new ZipError(
      `entry path is ${path.length} characters, over the ${limits.maxPathLength} character limit`,
      { path, rule: 'path-too-long' },
    );
  }
  if (path.includes('\\')) {
    throw new ZipError('entry path contains a backslash (docs/04 §2 requires `/`)', {
      path,
      rule: 'backslash',
    });
  }
  if (path.startsWith('/')) {
    throw new ZipError('absolute entry path', { path, rule: 'absolute-path' });
  }
  if (DRIVE_LETTER.test(path)) {
    throw new ZipError('entry path carries a Windows drive letter', {
      path,
      rule: 'drive-letter',
    });
  }
  if (PARENT_SEGMENT.test(path)) {
    throw new ZipError('entry path contains a `..` segment (zip slip)', {
      path,
      rule: 'path-traversal',
    });
  }
  if (path === '.') {
    throw new ZipError('entry path is `.`', { path, rule: 'dot-path' });
  }
  if (hasControlCharacter(path)) {
    throw new ZipError('entry path contains a control character', {
      path,
      rule: 'control-character',
    });
  }
  if (!ALLOWED_PATH_CHARS.test(path)) {
    // Deliberately stricter than "no traversal": docs/04 §2 fixes the allowed
    // character set, and a name outside it cannot be round-tripped by other
    // implementations even if it is harmless on this host.
    throw new ZipError('entry path contains characters outside `[A-Za-z0-9._/-]` (docs/04 §2)', {
      path,
      rule: 'path-charset',
    });
  }
  if (path.endsWith('/')) {
    throw new ZipError('directory entry — a `.stpack` carries files only', {
      path,
      rule: 'directory-entry',
    });
  }
}

/** Refuses Unix file types other than a regular file. */
function assertRegularFile(externalAttributes: number, path: string): void {
  const unixType = (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_TYPE_SYMLINK) {
    throw new ZipError('symlink entry (Unix external attributes)', {
      path,
      rule: 'symlink',
    });
  }
  if (unixType === UNIX_TYPE_DIRECTORY) {
    throw new ZipError('directory entry (Unix external attributes)', {
      path,
      rule: 'directory-entry',
    });
  }
  if (unixType !== 0 && unixType !== UNIX_TYPE_REGULAR) {
    throw new ZipError(`non-regular Unix file type 0x${unixType.toString(16)}`, {
      path,
      rule: 'non-regular-file',
    });
  }
}

/** Decodes the stored name; invalid UTF-8 is a malformed archive, not a guess. */
function decodeEntryName(rawName: Uint8Array, flags: number, offset: number): string {
  if ((flags & FLAG_UTF8_NAMES) !== 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      throw new ZipError('entry name is flagged UTF-8 but is not valid UTF-8', {
        offset,
        rule: 'name-encoding',
      });
    }
  }
  // CP437 would be the nominal fallback; the ASCII range is identical in both, and
  // docs/04 §2 only permits ASCII, so anything else is refused by `assertSafePath`.
  return new TextDecoder('latin1').decode(rawName);
}

/**
 * Reads the ZIP64 extended information extra field.
 *
 * Only the values whose 32-bit slot holds `0xFFFFFFFF` are present, and they appear
 * in a fixed order (uncompressed size, compressed size, local header offset, disk
 * start), so presence must be decoded from the overflowed *fields*, not from the
 * extra field's own length.
 */
function parseZip64Extra(
  extra: Uint8Array,
  needs: { readonly uncompressed: boolean; readonly compressed: boolean; readonly offset: boolean },
  path: string,
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  const reader = new ByteReader(extra);
  while (reader.offset + 4 <= reader.length) {
    const headerId = reader.u16();
    const dataSize = reader.u16();
    if (reader.offset + dataSize > reader.length) {
      throw new ZipError('extra field runs past the end of the central directory record', {
        path,
        rule: 'extra-field',
      });
    }
    if (headerId !== ZIP64_EXTRA_FIELD_ID) {
      // Unknown extra fields are skipped: docs/04 §1 requires readers to ignore
      // what they do not understand, and none of them may change a size or offset.
      reader.offset += dataSize;
      continue;
    }

    const field = new ByteReader(extra, reader.offset);
    const result: {
      uncompressedSize?: number;
      compressedSize?: number;
      localHeaderOffset?: number;
    } = {};
    if (needs.uncompressed) {
      if (field.offset + 8 > reader.offset + dataSize) {
        throw new ZipError('ZIP64 extra field is missing the uncompressed size', {
          path,
          rule: 'zip64-extra',
        });
      }
      result.uncompressedSize = field.u64('uncompressed size');
    }
    if (needs.compressed) {
      if (field.offset + 8 > reader.offset + dataSize) {
        throw new ZipError('ZIP64 extra field is missing the compressed size', {
          path,
          rule: 'zip64-extra',
        });
      }
      result.compressedSize = field.u64('compressed size');
    }
    if (needs.offset) {
      if (field.offset + 8 > reader.offset + dataSize) {
        throw new ZipError('ZIP64 extra field is missing the local header offset', {
          path,
          rule: 'zip64-extra',
        });
      }
      result.localHeaderOffset = field.u64('local header offset');
    }
    return result;
  }
  return {};
}

/* ────────────────────────────── end of archive ───────────────────────────── */

interface ArchiveSummary {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  /**
   * Difference between where the EOCD says the central directory sits and where it
   * actually is. Non-zero for a *self-extracting* archive, which has a stub before
   * the first local header. Tolerated because it changes nothing about the entries,
   * and refusing it would reject archives that other tools consider valid.
   */
  readonly shift: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array): { eocdOffset: number; reader: ByteReader } {
  if (bytes.byteLength < 22) {
    throw new ZipError('not a ZIP archive: shorter than an end-of-central-directory record', {
      offset: 0,
      rule: 'truncated',
    });
  }
  // The EOCD is at the very end unless an archive comment follows it; the comment
  // length field is 16-bit, so 22 + 65535 bytes is the furthest it can start.
  const earliest = Math.max(0, bytes.byteLength - (22 + CLASSIC_COUNT_LIMIT));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== bytes.byteLength) continue; // false positive
    return { eocdOffset: offset, reader: new ByteReader(bytes, offset) };
  }
  throw new ZipError('not a ZIP archive: no end-of-central-directory record found', {
    offset: earliest,
    rule: 'no-eocd',
  });
}

function readArchiveSummary(bytes: Uint8Array, limits: PackageLimits): ArchiveSummary {
  const { eocdOffset, reader } = findEndOfCentralDirectory(bytes);
  reader.u32(); // signature, already matched
  const diskNumber = reader.u16();
  const centralDirectoryDisk = reader.u16();
  const entriesThisDisk = reader.u16();
  const entryCountField = reader.u16();
  const centralDirectorySizeField = reader.u32();
  const centralDirectoryOffsetField = reader.u32();
  const commentLength = reader.u16();

  if (commentLength !== 0) {
    throw new ZipError('archive comment is not allowed (this writer never emits one)', {
      rule: 'archive-comment',
    });
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new ZipError('multi-disk archives are not supported', { rule: 'multi-disk' });
  }
  // Read the entry count from the EOCD *before* trusting it enough to allocate.
  if (entryCountField > limits.maxEntryCount) {
    throw new ZipError(
      `archive declares ${entryCountField} entries, over the ${limits.maxEntryCount} entry limit`,
      { rule: 'too-many-entries' },
    );
  }

  let entryCount = entryCountField;
  let centralDirectorySize = centralDirectorySizeField;
  let centralDirectoryOffset = centralDirectoryOffsetField;
  /**
   * Where the records *after* the central directory begin: the ZIP64 EOCD record
   * when there is one, otherwise the classic EOCD. `shift` is measured against this
   * rather than against the EOCD, or the 76 bytes of ZIP64 trailers would look like
   * a prepended stub.
   */
  let endRecordsOffset = eocdOffset;

  if (
    entryCountField === CLASSIC_COUNT_LIMIT ||
    centralDirectorySizeField === ZIP64_MARKER ||
    centralDirectoryOffsetField === ZIP64_MARKER
  ) {
    const zip64 = readZip64EndOfCentralDirectory(bytes, eocdOffset, limits);
    entryCount = zip64.entryCount;
    centralDirectorySize = zip64.centralDirectorySize;
    centralDirectoryOffset = zip64.centralDirectoryOffset;
    endRecordsOffset = zip64.recordOffset;
  }

  if (entriesThisDisk !== entryCountField) {
    throw new ZipError('end-of-central-directory record disagrees with itself on the entry count', {
      rule: 'no-eocd',
    });
  }
  if (entryCount > limits.maxEntryCount) {
    throw new ZipError(
      `archive declares ${entryCount} entries, over the ${limits.maxEntryCount} entry limit`,
      { rule: 'too-many-entries' },
    );
  }
  if (centralDirectorySize > bytes.byteLength || centralDirectoryOffset > bytes.byteLength) {
    throw new ZipError('central directory extends past the end of the archive', {
      offset: eocdOffset,
      rule: 'truncated',
    });
  }
  // A central directory cannot start after the EOCD that describes it.
  if (centralDirectoryOffset > endRecordsOffset) {
    throw new ZipError('central directory offset points past the end-of-central-directory record', {
      offset: centralDirectoryOffset,
      rule: 'truncated',
    });
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.byteLength) {
    throw new ZipError('central directory extends past the end of the archive', {
      offset: centralDirectoryOffset,
      rule: 'truncated',
    });
  }

  // Anything between the end of the central directory and the first end-of-archive
  // record is a prefix (a self-extracting stub, or junk). Tolerated because it
  // changes nothing about the entries; the offsets below are shifted by it.
  const shift = endRecordsOffset - centralDirectorySize - centralDirectoryOffset;
  if (shift < 0) {
    throw new ZipError('central directory overlaps the end-of-central-directory record', {
      offset: centralDirectoryOffset,
      rule: 'overlapping-records',
    });
  }

  return { entryCount, centralDirectoryOffset, centralDirectorySize, shift };
}

function readZip64EndOfCentralDirectory(
  bytes: Uint8Array,
  eocdOffset: number,
  limits: PackageLimits,
): {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
  recordOffset: number;
} {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) {
    throw new ZipError('ZIP64 end-of-central-directory locator is missing', {
      offset: eocdOffset,
      rule: 'zip64-locator',
    });
  }
  const locator = new ByteReader(bytes, locatorOffset);
  if (locator.u32() !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    throw new ZipError('ZIP64 end-of-central-directory locator is missing', {
      offset: locatorOffset,
      rule: 'zip64-locator',
    });
  }
  const zip64Disk = locator.u32();
  const zip64Offset = locator.u64('ZIP64 EOCD offset');
  const totalDisks = locator.u32();
  if (zip64Disk !== 0 || totalDisks !== 1) {
    throw new ZipError('multi-disk archives are not supported', { rule: 'multi-disk' });
  }

  const candidate = zip64Offset === ZIP64_MARKER ? locatorOffset - 56 : zip64Offset;
  if (candidate < 0 || candidate + 56 > bytes.byteLength) {
    throw new ZipError('ZIP64 end-of-central-directory record lies outside the archive', {
      offset: zip64Offset,
      rule: 'zip64-eocd',
    });
  }
  const record = new ByteReader(bytes, candidate);
  if (record.u32() !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    throw new ZipError('ZIP64 end-of-central-directory record not found at the declared offset', {
      offset: candidate,
      rule: 'zip64-eocd',
    });
  }
  const recordSize = record.u64('ZIP64 EOCD size');
  if (recordSize !== 44) {
    throw new ZipError(`unexpected ZIP64 end-of-central-directory record size ${recordSize}`, {
      offset: candidate,
      rule: 'zip64-eocd',
    });
  }
  record.u16(); // version made by
  record.u16(); // version needed to extract
  const thisDisk = record.u32();
  const centralDirectoryDisk = record.u32();
  const entriesThisDisk = record.u64('entries on this disk');
  const entryCount = record.u64('total entries');
  const centralDirectorySize = record.u64('central directory size');
  const centralDirectoryOffset = record.u64('central directory offset');

  if (thisDisk !== 0 || centralDirectoryDisk !== 0) {
    throw new ZipError('multi-disk archives are not supported', { rule: 'multi-disk' });
  }
  if (entriesThisDisk !== entryCount) {
    throw new ZipError('ZIP64 record disagrees with itself on the entry count', {
      rule: 'no-eocd',
    });
  }
  if (entryCount > limits.maxEntryCount) {
    throw new ZipError(
      `archive declares ${entryCount} entries, over the ${limits.maxEntryCount} entry limit`,
      { rule: 'too-many-entries' },
    );
  }
  return { entryCount, centralDirectorySize, centralDirectoryOffset, recordOffset: candidate };
}

/* ──────────────────────────────── the API ───────────────────────────────── */

/**
 * Reads every entry of a `.stpack` archive.
 *
 * Returns bytes and nothing else — no extraction to disk, no evaluation of package
 * content (docs/04 §9 "不执行包内任何脚本、模板或宏"; §8.2 decision 4). Callers that
 * do write files are responsible for treating these validated paths as already
 * checked, and for nothing more.
 *
 * @param limits overrides for the caps in `../limits` (docs/04 §9 makes the size
 *   caps configurable; the structural ones are configurable here too so a
 *   third-party caller with different needs is not forced to patch this module).
 * @throws {ZipError} for every rejection listed in the file header.
 */
export async function readZip(
  bytes: Uint8Array,
  limits?: PartialPackageLimits,
): Promise<ZipReadEntry[]> {
  const resolved = resolveLimits(limits);
  const summary = readArchiveSummary(bytes, resolved);

  const entries: ZipReadEntry[] = [];
  const reader = new ByteReader(bytes, summary.centralDirectoryOffset + summary.shift);
  const centralDirectoryEnd = reader.offset + summary.centralDirectorySize;
  let totalUncompressed = 0;

  for (let index = 0; index < summary.entryCount; index += 1) {
    if (reader.offset + CENTRAL_HEADER_BYTES > centralDirectoryEnd) {
      throw new ZipError(
        `central directory ended after ${index} of ${summary.entryCount} declared entries`,
        { offset: reader.offset, rule: 'truncated' },
      );
    }

    const recordOffset = reader.offset;
    const signature = reader.u32();
    if (signature !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw new ZipError(`central directory record ${index} has a bad signature`, {
        offset: recordOffset,
        rule: 'bad-central-header',
      });
    }
    const versionMadeBy = reader.u16();
    const versionNeeded = reader.u16();
    const flags = reader.u16();
    const method = reader.u16();
    const dosTime = reader.u16();
    const dosDate = reader.u16();
    const expectedCrc = reader.u32();
    const compressedSizeField = reader.u32();
    const uncompressedSizeField = reader.u32();
    const nameLength = reader.u16();
    const extraLength = reader.u16();
    const commentLength = reader.u16();
    const diskStart = reader.u16();
    const internalAttributes = reader.u16();
    const externalAttributes = reader.u32();
    const localHeaderOffsetField = reader.u32();
    const rawName = reader.bytes(nameLength);
    const extra = reader.bytes(extraLength);
    reader.bytes(commentLength); // bounds-checked skip; a non-zero length is rejected below

    const path = decodeEntryName(rawName, flags, recordOffset);

    if ((flags & FLAG_ENCRYPTED) !== 0 || method === 99) {
      throw new ZipError('encrypted entries are not supported', { path, rule: 'encrypted' });
    }
    if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) {
      throw new ZipError(
        'data descriptors are not allowed (this reader trusts the central directory)',
        {
          path,
          rule: 'data-descriptor',
        },
      );
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError(
        `unsupported compression method ${method} (only store/0 and deflate/8 are allowed)`,
        { path, rule: 'unsupported-method' },
      );
    }
    if (commentLength !== 0) {
      throw new ZipError('entry comment is not allowed', { path, rule: 'entry-comment' });
    }
    if (diskStart !== 0) {
      throw new ZipError('multi-disk archives are not supported', { path, rule: 'multi-disk' });
    }
    if (dosTime !== FIXED_DOS_TIME || dosDate !== FIXED_DOS_DATE) {
      const year = 1980 + ((dosDate >> 9) & 0x7f);
      const month = (dosDate >> 5) & 0x0f;
      const day = dosDate & 0x1f;
      throw new ZipError(
        `entry timestamp is not the fixed 1980-01-01T00:00:00 (got ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String((dosTime >> 11) & 0x1f).padStart(2, '0')}:${String((dosTime >> 5) & 0x3f).padStart(2, '0')}:${String((dosTime & 0x1f) * 2).padStart(2, '0')}) — docs/04 §11 requires a fixed timestamp so packing is deterministic`,
        { path, rule: 'unfixed-timestamp' },
      );
    }
    if (internalAttributes !== 0) {
      // Bit 0 means "apparently text"; it carries no information a reader needs and
      // is not part of this writer's output.
      throw new ZipError('unexpected internal file attributes', {
        path,
        rule: 'internal-attributes',
      });
    }
    // `versionMadeBy` is not validated: the Unix file-type bits below are the only
    // part of it that changes behaviour, and the writer's DOS-made-by value is 20.
    void versionMadeBy;
    assertSafePath(path, resolved);
    assertRegularFile(externalAttributes, path);

    // A ZIP64 extra field may also be present on an entry that does not need one;
    // it is then ignored, exactly as §1's forward-compatibility rule requires.
    const needsZip64 =
      uncompressedSizeField === ZIP64_MARKER ||
      compressedSizeField === ZIP64_MARKER ||
      localHeaderOffsetField === ZIP64_MARKER;
    if (versionNeeded >= 45 && !needsZip64 && extraLength === 0) {
      throw new ZipError(
        `entry requires ZIP 4.5 features (version needed ${versionNeeded}) but carries no ZIP64 extra field`,
        { path, rule: 'unsupported-zip64' },
      );
    }
    const zip64 = parseZip64Extra(
      extra,
      {
        uncompressed: uncompressedSizeField === ZIP64_MARKER,
        compressed: compressedSizeField === ZIP64_MARKER,
        offset: localHeaderOffsetField === ZIP64_MARKER,
      },
      path,
    );

    const uncompressedSize =
      uncompressedSizeField === ZIP64_MARKER
        ? (zip64.uncompressedSize ?? failMissingZip64(path, 'uncompressed size'))
        : uncompressedSizeField;
    const compressedSize =
      compressedSizeField === ZIP64_MARKER
        ? (zip64.compressedSize ?? failMissingZip64(path, 'compressed size'))
        : compressedSizeField;
    const declaredOffset =
      localHeaderOffsetField === ZIP64_MARKER
        ? (zip64.localHeaderOffset ?? failMissingZip64(path, 'local header offset'))
        : localHeaderOffsetField;

    // Cheap rejections before any allocation or inflation happens.
    assertSizesFit(path, compressedSize, uncompressedSize, resolved, totalUncompressed);

    const dataOffset = payloadOffset(bytes, {
      declaredOffset,
      shift: summary.shift,
      centralDirectoryStart: summary.centralDirectoryOffset + summary.shift,
      path,
      method,
      compressedSize,
      uncompressedSize,
    });
    const payload = bytes.subarray(dataOffset, dataOffset + compressedSize);

    const inflated =
      method === METHOD_STORE
        ? copyStored(payload, compressedSize, uncompressedSize, path)
        : await inflateRaw(payload, {
            declaredSize: uncompressedSize,
            maxOutputBytes: resolved.maxEntryBytes,
            maxTotalBytes: resolved.maxTotalBytes,
            path,
            totalAfter: totalUncompressed,
          });

    if (inflated.byteLength !== uncompressedSize) {
      throw new ZipError(
        `entry declares ${uncompressedSize} bytes but ${inflated.byteLength} were recovered (docs/04 §9 大小不符)`,
        { path, rule: 'declared-size-mismatch' },
      );
    }
    const actualCrc = crc32(inflated);
    if (actualCrc !== expectedCrc) {
      throw new ZipError(
        `CRC-32 mismatch: central directory says 0x${expectedCrc.toString(16).padStart(8, '0')}, the data hashes to 0x${actualCrc.toString(16).padStart(8, '0')} (corrupt or tampered entry)`,
        { path, rule: 'crc-mismatch' },
      );
    }

    totalUncompressed += inflated.byteLength;
    if (totalUncompressed > resolved.maxTotalBytes) {
      throw new ZipError(
        `archive exceeds the ${resolved.maxTotalBytes} byte total limit (docs/04 §9 总量上限)`,
        { path, rule: 'total-bytes-exceeded' },
      );
    }

    entries.push({ path, bytes: inflated, method });
  }

  return entries;
}

/** Keeps the ZIP64 "marker without an extra field" case from becoming `undefined`. */
function failMissingZip64(path: string, field: string): never {
  throw new ZipError(`field is 0xFFFFFFFF but the ZIP64 extra field has no ${field}`, {
    path,
    rule: 'zip64-extra',
  });
}

/** Inputs for {@link payloadOffset}, grouped so the call site stays readable. */
interface PayloadLocation {
  readonly declaredOffset: number;
  readonly shift: number;
  /** Where the central directory actually begins, used as an upper bound. */
  readonly centralDirectoryStart: number;
  readonly path: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

/**
 * Validates the local header that precedes the payload, then returns the payload's
 * byte offset.
 *
 * The central directory is authoritative for sizes and offsets (see the file
 * header), but the local header still has to agree with it: if the two describe
 * different files, no later check can rescue the parse. Disagreement here is
 * reported as corruption rather than resolved in either direction — unlike a
 * general-purpose reader, this one has no reason to accept archives that two
 * writers produced in pieces.
 */
function payloadOffset(bytes: Uint8Array, location: PayloadLocation): number {
  const { path } = location;
  const offset = location.declaredOffset + location.shift;
  if (offset < 0 || offset + LOCAL_HEADER_BYTES > bytes.byteLength) {
    throw new ZipError('local file header lies outside the archive', {
      path,
      offset: location.declaredOffset,
      rule: 'truncated',
    });
  }
  if (offset >= location.centralDirectoryStart) {
    throw new ZipError('local file header overlaps the central directory', {
      path,
      offset,
      rule: 'overlapping-records',
    });
  }

  const reader = new ByteReader(bytes, offset);
  if (reader.u32() !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipError('no local file header at the offset given by the central directory', {
      path,
      offset,
      rule: 'bad-local-header',
    });
  }
  reader.u16(); // version needed
  const flags = reader.u16();
  const method = reader.u16();
  reader.u16(); // modification time
  reader.u16(); // modification date
  reader.u32(); // CRC-32 (the central directory copy is the one that is checked)
  // `0xFFFFFFFF` here means "see the ZIP64 extra field", which is why these are not
  // compared against the central directory sizes.
  const compressedSize = reader.u32();
  const uncompressedSize = reader.u32();
  const nameLength = reader.u16();
  const extraLength = reader.u16();
  const rawName = reader.bytes(nameLength);
  reader.bytes(extraLength); // bounds-checked skip; ZIP64 data lives in the CD copy

  const localName = decodeEntryName(rawName, flags, offset);
  if (localName !== path) {
    throw new ZipError(
      `local header names the entry ${JSON.stringify(localName)} while the central directory says ${JSON.stringify(path)}`,
      { path, offset, rule: 'name-mismatch' },
    );
  }
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new ZipError('encrypted entries are not supported', { path, rule: 'encrypted' });
  }
  if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) {
    throw new ZipError('data descriptors are not allowed', {
      path,
      offset,
      rule: 'data-descriptor',
    });
  }
  if (method !== location.method) {
    throw new ZipError(
      `local header says compression method ${method} while the central directory says ${location.method}`,
      { path, offset, rule: 'method-mismatch' },
    );
  }
  if (compressedSize !== 0xffff_ffff && compressedSize !== location.compressedSize) {
    throw new ZipError(
      `local header says ${compressedSize} compressed bytes while the central directory says ${location.compressedSize}`,
      { path, offset, rule: 'size-mismatch' },
    );
  }
  if (uncompressedSize !== 0xffff_ffff && uncompressedSize !== location.uncompressedSize) {
    throw new ZipError(
      `local header says ${uncompressedSize} uncompressed bytes while the central directory says ${location.uncompressedSize}`,
      { path, offset, rule: 'size-mismatch' },
    );
  }
  if (reader.offset + location.compressedSize > location.centralDirectoryStart) {
    throw new ZipError('entry payload overlaps the central directory', {
      path,
      offset: reader.offset,
      rule: 'overlapping-records',
    });
  }
  return reader.offset;
}

/** Per-entry size gates, before anything is inflated or copied. */
function assertSizesFit(
  path: string,
  compressedSize: number,
  uncompressedSize: number,
  limits: PackageLimits,
  totalSoFar: number,
): void {
  if (compressedSize > limits.maxEntryBytes) {
    throw new ZipError(
      `compressed size ${compressedSize} exceeds the ${limits.maxEntryBytes} byte per-entry limit (docs/04 §9 单文件上限)`,
      { path, rule: 'entry-bytes-exceeded' },
    );
  }
  if (uncompressedSize > limits.maxEntryBytes) {
    throw new ZipError(
      `declared size ${uncompressedSize} exceeds the ${limits.maxEntryBytes} byte per-entry limit (docs/04 §9 单文件上限)`,
      { path, rule: 'entry-bytes-exceeded' },
    );
  }
  if (totalSoFar + uncompressedSize > limits.maxTotalBytes) {
    throw new ZipError(
      `entry would push the archive past the ${limits.maxTotalBytes} byte total limit (docs/04 §9 总量上限)`,
      { path, rule: 'total-bytes-exceeded' },
    );
  }
  if (compressedSize > limits.maxTotalBytes) {
    throw new ZipError(
      `compressed size ${compressedSize} exceeds the ${limits.maxTotalBytes} byte total limit`,
      { path, rule: 'total-bytes-exceeded' },
    );
  }
}

/** Method 0: the payload *is* the bytes; the declared sizes must agree. */
function copyStored(
  payload: Uint8Array,
  compressedSize: number,
  uncompressedSize: number,
  path: string,
): Uint8Array {
  if (payload.byteLength !== compressedSize) {
    throw new ZipError('stored entry is truncated', { path, rule: 'truncated' });
  }
  if (compressedSize !== uncompressedSize) {
    throw new ZipError(
      `stored entry declares ${compressedSize} compressed and ${uncompressedSize} uncompressed bytes`,
      { path, rule: 'declared-size-mismatch' },
    );
  }
  // A copy, not a view: callers must not be able to alias archive bytes, and a
  // view would keep the whole archive alive.
  return payload.slice();
}
