/**
 * @smarttavern/providers — workspace entry point.
 *
 * BOUNDARY: an adapter layer package. It may import `@smarttavern/schema` and
 * `@smarttavern/core` (its ports) and must never import a sibling adapter
 * (storage / rules / packages / importers) or the UI.
 *
 * M0-T6 adds `llm/openai-compatible.ts` — streaming, cancellation and the four
 * error mappings (auth / rate limit / network / content moderation) — plus the
 * hand-written SSE parser it streams through. Keys handled here must never reach
 * packages, logs or message metadata (HANDOFF §4.1 invariant 6).
 */
export const PROVIDERS_PACKAGE = '@smarttavern/providers' as const;

/**
 * LLM adapters. `./llm/sse` is exported too: it is the one piece of wire
 * knowledge a second adapter (Anthropic, Gemini — docs/02 §6) will need, and a
 * private copy per adapter is exactly the drift this repo forbids.
 */
export * from './llm/openai-compatible';
export * from './llm/sse';
