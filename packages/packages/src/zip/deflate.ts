/**
 * Raw DEFLATE (RFC 1951) in and out — the ONLY file in `packages/packages` that
 * touches a compression API (M0-T3, ADR-018 decision 3).
 *
 * WHY IT IS ISOLATED
 * `packages/packages` is an adapter-layer workspace that must run in Node *and* in
 * browsers (Web/PWA is a first-class target, docs/06 §8.2) and must stay
 * dependency-free. The platform answer is `CompressionStream('deflate-raw')` /
 * `DecompressionStream('deflate-raw')`, shipped by Node ≥18 and modern browsers.
 * Node also offers `node:zlib` at the same byte level, so the fallback lives in
 * this one module as a dynamic import: bundlers never see a static `node:`
 * specifier, and every other module in the workspace stays platform-neutral.
 *
 * VERIFIED ON THIS HOST (Node v24.17.0): `deflate-raw` round-trips, three
 * consecutive calls on the same input produce identical bytes, and those bytes are
 * identical to `zlib.deflateRawSync` — so the fallback never fired here.
 *
 * WHY `deflate-raw` AND NOT `deflate`: the latter is the zlib *wrapper* format
 * (RFC 1950) with a 2-byte header and an Adler-32 trailer. ZIP stores a bare
 * DEFLATE stream, so the wrapped form would produce an archive no other reader
 * accepts.
 *
 * DETERMINISM: docs/04 §9 and ADR-018 promise byte-identical output only *within
 * one implementation* — the compressed bytes are whatever the host zlib produced.
 * This module therefore promises nothing across runtimes; it only guarantees it
 * calls the platform API the same way every time.
 */

import { ZipError } from './errors';
import type {
  ByteArray,
  ReadableByteStream,
  StreamReader,
  TransformByteStream,
  TransformByteStreamConstructor,
} from './stream-types';
import { toByteArray } from './stream-types';

/**
 * Bound on inflated output.
 *
 * `docs/04` §9 sets a per-file cap, and `docs/06` §8.2 requires a zip bomb to be
 * *cut off* rather than detected after the fact. Both numbers are therefore
 * enforced while inflating: `maxOutputBytes` stops a single entry, `totalAfter` +
 * `maxTotalBytes` stops the archive once the running total would cross the 2 GB
 * package cap, and `declaredSize` catches a central directory that lied.
 */
export interface InflateLimits {
  /** Hard ceiling for this one entry, in bytes. */
  readonly maxOutputBytes?: number;
  /** Bytes already inflated from earlier entries, for the running archive total. */
  readonly totalAfter?: number;
  /** Hard ceiling for the whole archive, in bytes. */
  readonly maxTotalBytes?: number;
  /** Size the central directory declared for this entry, checked against the output. */
  readonly declaredSize?: number;
  /** Path of the entry, so every rejection names the file (docs/04 §9). */
  readonly path?: string;
}

/** How the compressed bytes were produced; surfaced for diagnostics and tests. */
export type DeflateBackend = 'CompressionStream' | 'node:zlib';

/** Reads a stream to the end, invoking `onChunk` before each chunk is retained. */
async function collect(
  stream: ReadableByteStream,
  onChunk?: (chunk: ByteArray, total: number) => void,
): Promise<ByteArray> {
  const reader: StreamReader = stream.getReader();
  const chunks: ByteArray[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: Awaited<ReturnType<StreamReader['read']>>;
      try {
        step = await reader.read();
      } catch (cause) {
        throw new ZipError(
          `deflate stream failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { rule: 'deflate' },
        );
      }
      if (step.done) break;
      chunks.push(step.value);
      total += step.value.byteLength;
      onChunk?.(step.value, total);
    }
  } finally {
    // `releaseLock` is a no-op we do not depend on; if a runtime disagrees it must
    // not mask the real error.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return concat(chunks, total);
}

/** Joins chunks into one contiguous buffer. */
function concat(chunks: readonly ByteArray[], total: number): ByteArray {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/* ────────────────────────── platform capability probe ────────────────────── */

interface DeflateConstructors {
  readonly CompressionStream: TransformByteStreamConstructor;
  readonly DecompressionStream: TransformByteStreamConstructor;
}

let platformCache: DeflateConstructors | null | undefined;

/**
 * Resolves the platform streams, once.
 *
 * Mere existence is not enough: `CompressionStream` exists in runtimes that accept
 * only `'gzip'` / `'deflate'` and throw on `'deflate-raw'`, and it is better to
 * learn that here (and fall back) than halfway through writing an archive.
 */
function platformDeflate(): DeflateConstructors | null {
  if (platformCache !== undefined) return platformCache;
  platformCache = null;
  try {
    // `globalThis` is narrowed to `unknown` first: under `lib.dom` it is typed as
    // `Window`, which would make this a type assertion about real DOM members.
    const scope = globalThis as unknown as {
      CompressionStream?: TransformByteStreamConstructor;
      DecompressionStream?: TransformByteStreamConstructor;
    };
    const compression = scope.CompressionStream;
    const decompression = scope.DecompressionStream;
    if (typeof compression === 'function' && typeof decompression === 'function') {
      // Probe the `deflate-raw` format itself, not just the constructor.
      new compression('deflate-raw');
      new decompression('deflate-raw');
      platformCache = { CompressionStream: compression, DecompressionStream: decompression };
    }
  } catch {
    platformCache = null;
  }
  return platformCache;
}

/** Which backend {@link deflateRaw} / {@link inflateRaw} are currently using. */
export function activeDeflateBackend(): DeflateBackend {
  return platformDeflate() !== null ? 'CompressionStream' : 'node:zlib';
}

/* ──────────────────────────── the node:zlib fallback ─────────────────────── */

interface ZlibModule {
  deflateRawSync(data: Uint8Array): Uint8Array;
  inflateRawSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
}

let zlibPromise: Promise<ZlibModule> | undefined;

/**
 * Loads `node:zlib` lazily.
 *
 * The specifier is assembled from a variable so no bundler can statically resolve
 * it into a browser graph; in a browser the import rejects and the caller gets a
 * clear "no DEFLATE backend" error instead of a build-time failure. This is the
 * only `node:` reference in the workspace, and it is unreachable whenever the
 * platform streams exist.
 */
function loadNodeZlib(): Promise<ZlibModule> {
  if (zlibPromise === undefined) {
    const specifier = 'node:z' + 'lib';
    zlibPromise = import(/* @vite-ignore */ specifier).then(
      (module: unknown) => module as ZlibModule,
      (cause: unknown) => {
        throw new ZipError(
          `no DEFLATE backend: CompressionStream('deflate-raw') is unavailable and node:zlib could not be loaded (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
          { rule: 'deflate-backend' },
        );
      },
    );
  }
  return zlibPromise;
}

/* ──────────────────────────────── the API ───────────────────────────────── */

/**
 * Deflates `bytes` into a bare DEFLATE stream (the method 8 payload).
 *
 * `CompressionStream` is one-shot and single-use, so a fresh stream is created per
 * call — which is also what keeps repeated packing byte-identical.
 */
export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const platform = platformDeflate();
  if (platform !== null) {
    const stream = new platform.CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    let writeFailed: Promise<void> | undefined;
    try {
      // Not awaited before reading: a stream with a bounded queue resolves the write
      // only as the reader drains, so awaiting first would deadlock.
      writeFailed = writer.write(toByteArray(bytes)).then(
        () => writer.close(),
        (cause: unknown) => {
          throw new ZipError(
            `deflate write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { rule: 'deflate' },
          );
        },
      );
      const deflated = await collect(stream.readable);
      await writeFailed;
      return deflated;
    } catch (cause) {
      await Promise.allSettled([writer.abort(cause), writeFailed ?? Promise.resolve()]);
      throw cause;
    } finally {
      writer.releaseLock();
    }
  }

  const zlib = await loadNodeZlib();
  return zlib.deflateRawSync(bytes);
}

/**
 * Inflates a bare DEFLATE stream.
 *
 * Unlike {@link deflateRaw} this one is bounded on purpose: `docs/06` §8.2 requires
 * a zip bomb to be cut off, so the output is streamed and the consumer stops
 * reading the moment the declared size or a cap is crossed. Returning early also
 * lets the stream's queue drop instead of buffering gigabytes already rejected.
 *
 * @throws {ZipError} when the stream is malformed, when the output exceeds
 *   `declaredSize`/`maxOutputBytes`, or when it would push the archive past
 *   `maxTotalBytes`.
 */
export async function inflateRaw(bytes: Uint8Array, opts: InflateLimits = {}): Promise<Uint8Array> {
  const path = opts.path;
  const maxOutputBytes = opts.maxOutputBytes;
  const declaredSize = opts.declaredSize;
  const platform = platformDeflate();
  const hardLimit = Math.min(
    maxOutputBytes ?? Number.MAX_SAFE_INTEGER,
    declaredSize ?? Number.MAX_SAFE_INTEGER,
  );

  if (platform === null) return inflateWithZlib(bytes, hardLimit, path);

  const stream: TransformByteStream = new platform.DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const entryCap = (limit: number, rule: string): ZipError => {
    if (rule === 'total') {
      return new ZipError(
        `archive total exceeds ${limit} bytes after inflating this entry (docs/04 §9 总量上限)`,
        { path, rule: 'total-bytes-exceeded' },
      );
    }
    if (rule === 'declared') {
      return new ZipError(
        `inflated size exceeds the ${limit} bytes declared in the central directory (docs/04 §9 大小不符)`,
        { path, rule: 'declared-size-exceeded' },
      );
    }
    return new ZipError(
      `inflated size exceeds the ${limit} byte per-entry cap (docs/04 §9 单文件上限)`,
      { path, rule: 'entry-bytes-exceeded' },
    );
  };

  const totalAfter = opts.totalAfter ?? 0;
  const maxTotalBytes = opts.maxTotalBytes;

  try {
    // As with deflate, do not await the write before reading: the write resolves only
    // as the reader drains. Nothing can fail on a plain `Uint8Array` input, and a
    // failure here would surface through the read side anyway, so the promises are
    // explicitly dropped rather than left to become unhandled rejections.
    void writer.write(toByteArray(bytes)).catch(() => undefined);
    void writer.close().catch(() => undefined);

    const chunks: ByteArray[] = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > hardLimit) {
        // Reported as a declaration violation when the central directory promised a
        // smaller size, because that is the *real* fault: the entry lied.
        if (declaredSize !== undefined && total > declaredSize) {
          throw entryCap(declaredSize, 'declared');
        }
        throw entryCap(hardLimit, 'entry');
      }
      if (maxTotalBytes !== undefined && totalAfter + total > maxTotalBytes) {
        throw entryCap(maxTotalBytes, 'total');
      }
      chunks.push(step.value);
    }
    return concat(chunks, total);
  } catch (cause) {
    // Deliberately does NOT call `reader.cancel()`.
    //
    // Cancelling a Node-backed `DecompressionStream` while a write is still in
    // flight makes the Node↔web-streams adapter destroy the underlying duplex with
    // the abort reason, and that rejection lands on an internal promise no caller
    // can attach a handler to. It showed up as `AbortError` unhandled rejections on
    // Linux CI — Vitest fails the run on those even though every assertion passed —
    // and it does not reproduce on every platform, because it depends on whether the
    // rejection is delivered while the worker is still alive.
    //
    // Dropping the stream instead costs at most the compressed input this call
    // already holds, on a path that is about to throw anyway, and it never destroys
    // something behind the caller's back.
    if (cause instanceof ZipError) throw cause;
    throw new ZipError(
      `inflate failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        path,
        rule: 'deflate',
      },
    );
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

/**
 * Fallback inflation through `node:zlib`.
 *
 * `maxOutputLength` is zlib's own bomb guard: it stops inflating instead of
 * allocating past the cap. The check afterwards is belt-and-braces, because zlib
 * throws a generic `ERR_BUFFER_TOO_LARGE` that we want translated into the specific
 * rule violation and entry path docs/04 §9 asks for.
 */
async function inflateWithZlib(
  bytes: Uint8Array,
  hardLimit: number,
  path: string | undefined,
): Promise<Uint8Array> {
  const zlib = await loadNodeZlib();
  const bounded = Number.isSafeInteger(hardLimit) && hardLimit < Number.MAX_SAFE_INTEGER;
  let inflated: Uint8Array;
  try {
    inflated = zlib.inflateRawSync(bytes, bounded ? { maxOutputLength: hardLimit + 1 } : undefined);
  } catch (cause) {
    if (bounded) {
      throw new ZipError(
        `inflated size exceeds the ${hardLimit} byte cap (docs/04 §9 单文件上限)`,
        { path, rule: 'entry-bytes-exceeded' },
      );
    }
    throw new ZipError(
      `inflate failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { path, rule: 'deflate' },
    );
  }
  if (inflated.byteLength > hardLimit) {
    throw new ZipError(`inflated size exceeds the ${hardLimit} byte cap (docs/04 §9 单文件上限)`, {
      path,
      rule: 'entry-bytes-exceeded',
    });
  }
  return inflated;
}
