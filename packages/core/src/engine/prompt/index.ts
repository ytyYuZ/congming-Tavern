/**
 * `engine/prompt` — the prompt composer (M1-G4; docs/02-技术架构.md §5.1, ADR-029).
 *
 * WHAT THIS MODULE OWNS OF §5.1
 * - Assembly in the §5.1 order: `pre_history` blocks, history, `in_history`
 *   blocks at their `depth`, `post_history` blocks, the current user input.
 * - The macro registry and `expandMacros`.
 * - The token budget and the low-to-high priority trim, with an explicit
 *   failure when `required` blocks alone do not fit.
 *
 * WHAT IT DOES NOT OWN, on purpose:
 * - The BLOCK SHAPE — `PromptBlockSchema` in `@smarttavern/schema` (ADR-029).
 * - Trimming the conversation history (docs/02 §5.2 L0/L1/L2: the MemoryManager
 *   summarises and drops turns; a composer that also dropped them would hide a
 *   memory failure inside a token count).
 * - `{{roll}}`/`{{random}}`/`{{pick}}` — the M3-R1 dice engine and a seeded RNG
 *   are not core's business yet, so those macros stay verbatim and are reported.
 * - File formats: nothing here reads or writes anything (HANDOFF §4.1
 *   invariant 1 — no DOM, no I/O, no clock reads).
 *
 * Modules, in dependency order: `estimate` -> `macros` -> `types` -> `budget` ->
 * `compose`.
 */

export * from './budget';
export * from './compose';
export * from './estimate';
export * from './macros';
export * from './types';
