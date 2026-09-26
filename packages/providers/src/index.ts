/**
 * @smarttavern/providers — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: an adapter layer package. It may import `@smarttavern/schema` and
 * `@smarttavern/core` (its ports) and must never import a sibling adapter
 * (storage / rules / packages / importers) or the UI.
 *
 * M0-T6 adds `llm/openai-compatible.ts` — streaming, cancellation and the four
 * error mappings (auth / rate limit / network / content moderation) — tested
 * against a fake server with msw. Keys handled here must never reach packages,
 * logs or message metadata (HANDOFF §4.1 invariant 6).
 */
export const PROVIDERS_PACKAGE = '@smarttavern/providers' as const;
