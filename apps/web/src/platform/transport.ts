/**
 * The web half's transport — `FetchLike` over the platform `fetch` (M0-T8).
 *
 * WHY THIS IS A MODULE AND NOT `fetch` INLINE
 * `OpenAICompatibleProvider` defaults to `globalThis.fetch` itself, so this file
 * is not here to make the browser work: it is here to make the transport an
 * INJECTION POINT. `mountApp` takes an optional `transport` (`MountOptions`), the
 * desktop shell supplies a Rust-side HTTP client through it to dodge vendor CORS
 * (ADR-003, HANDOFF §9 item 9), and the tests supply a fake so a whole slice can
 * be driven without a socket. A single place to swap it is what keeps those three
 * callers from each reaching for a different global.
 *
 * THE BINDING MATTERS. `window.fetch` called as a bare reference throws "Illegal
 * invocation" in a browser, so the arrow is load-bearing rather than stylistic —
 * the same reason `openai-compatible.ts` writes one.
 */
import type { FetchLike } from '@smarttavern/providers';

/**
 * The platform transport. Throws only when the platform has no `fetch` at all:
 * that is a broken runtime, not a provider failure, and it must be loud rather
 * than turned into a fake `Response`.
 */
export function defaultTransport(): FetchLike {
  return (url, init) => {
    const implementation = globalThis.fetch;
    if (typeof implementation !== 'function') {
      throw new Error('this runtime has no fetch; pass MountOptions.transport instead');
    }
    return implementation(url, init);
  };
}
