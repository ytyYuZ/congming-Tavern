/**
 * The wire contract between the desktop transport and the Rust side of the shell
 * (M0-T8). Kept in its own module because it is a CONTRACT, not an implementation:
 * the Rust enum in `src-tauri/src/stream.rs` is the other half, and the shared
 * fixture `./fixtures/llm-stream-events.json` is what fails loudly when the two
 * drift apart.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT DERIVED. Nothing generates Rust from TypeScript
 * (or the reverse) in this repo, and pulling in a code generator for four variants
 * would be a dependency the local-first rule of `docs/06-开发任务拆解.md` §9.2 does
 * not want. The fixture is the cheaper alarm: both sides assert against the same
 * JSON, so a rename on either side turns one of the two suites red.
 *
 * THE EVENTS ARE THE WHOLE PROTOCOL, and they are deliberately dumb:
 * - `response` is emitted for EVERY status, 401 and 429 included. Rust does not
 *   decide what a status means — `openai-compatible.ts` classifies failures, and
 *   duplicating that table on the Rust side would create a second source of truth.
 * - `chunk` carries RAW BYTES as base64. An SSE frame can split a multi-byte UTF-8
 *   character across two network chunks, so decoding per chunk would replace half
 *   of that character with U+FFFD; the bytes are reassembled by a streaming
 *   `TextDecoder` on this side instead (see `tauri-fetch.ts`).
 * - `error.kind` is TRANSPORT-level only: `network` | `timeout` | `cancelled` |
 *   `protocol`. Vendor errors are not in this vocabulary at all.
 */

/** The Rust `LlmStreamRequest` (serde `rename_all = "camelCase"`). */
export interface LlmStreamRequest {
  requestId: string;
  url: string;
  method: string;
  /**
   * Ordered pairs, not a record: a caller may legitimately send the same header
   * twice, and a record would silently drop one of them.
   */
  headers: [string, string][];
  body: string;
  /** Whole-request budget in milliseconds; `undefined` leaves it to the shell. */
  timeoutMs?: number;
}

/** Why a request failed, at the transport level only. */
export type TransportErrorKind = 'network' | 'timeout' | 'cancelled' | 'protocol';

/**
 * Every event the Rust side can put on the channel, discriminated by `type`.
 * These four variants are the exact JSON pinned by the shared fixture.
 */
export type LlmStreamEvent =
  | { type: 'response'; status: number; headers: [string, string][] }
  | { type: 'chunk'; dataBase64: string }
  | { type: 'end' }
  | { type: 'error'; kind: TransportErrorKind; message: string };

/** True for every member of {@link TransportErrorKind}; used to validate untrusted input. */
export function isTransportErrorKind(value: unknown): value is TransportErrorKind {
  return (
    value === 'network' || value === 'timeout' || value === 'cancelled' || value === 'protocol'
  );
}
