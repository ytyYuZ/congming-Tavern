/**
 * Minimal structural typings for the Web Streams compression APIs (M0-T3).
 *
 * WHY THIS FILE EXISTS
 * `packages/packages` must compile against both the DOM lib (apps/web) and a
 * DOM-free lib (a Node-side consumer), so it cannot *name* `CompressionStream` or
 * `ReadableStreamDefaultReader` in its public surface — those identifiers only
 * exist in one of the two worlds. It also must not inherit `lib.dom`'s
 * `Uint8Array<ArrayBuffer>` spellings, which have shifted between TypeScript
 * releases and would make the build depend on the lib version.
 *
 * So this module declares exactly the shape the code uses, structurally: the real
 * platform objects satisfy these interfaces, and so would a polyfill. Anything not
 * listed here — piping, `tee`, backpressure signals — is deliberately absent
 * because this package does not use it.
 *
 * SCOPE: types and the one `Uint8Array<ArrayBuffer>` bridge helper. No runtime
 * dependency on the DOM, on Node, or on any library.
 */

/**
 * `Uint8Array` whose backing store is known to be an `ArrayBuffer`.
 *
 * The distinction exists because `new Uint8Array(sharedArrayBuffer)` is a legal
 * `Uint8Array` that the Web Streams APIs refuse. Encoders and decoders here always
 * allocate fresh, non-shared buffers, so this type is a statement of fact rather
 * than a constraint on the input.
 */
export type ByteArray = Uint8Array<ArrayBuffer>;

/** A chunk read from a stream, mirroring `ReadableStreamReadResult`. */
export type StreamChunk =
  | { readonly done: false; readonly value: ByteArray }
  | { readonly done: true };

export interface StreamReader {
  read(): Promise<StreamChunk>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface StreamWriter {
  write(chunk: ByteArray): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface ReadableByteStream {
  getReader(): StreamReader;
}

export interface WritableByteStream {
  getWriter(): StreamWriter;
}

/** A `CompressionStream` / `DecompressionStream` instance. */
export interface TransformByteStream {
  readonly readable: ReadableByteStream;
  readonly writable: WritableByteStream;
}

/** The constructor shape shared by `CompressionStream` and `DecompressionStream`. */
export type TransformByteStreamConstructor = new (format: string) => TransformByteStream;

/**
 * Converts a `Uint8Array` to `ByteArray` without copying in the common case.
 *
 * A `Uint8Array` over a `SharedArrayBuffer` is the one shape Web Streams actually
 * refuses, and a `Buffer` view into a larger pool is the other reason to normalize;
 * both are cheap to fix with a copy, in a code path whose whole point is to be
 * boring.
 */
export function toByteArray(bytes: Uint8Array): ByteArray {
  const backed =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength;
  return backed ? (bytes as ByteArray) : (bytes.slice() as ByteArray);
}
