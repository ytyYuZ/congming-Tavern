/**
 * @smarttavern/rules — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: adapter layer. May import `@smarttavern/schema` and
 * `@smarttavern/core`; never a sibling adapter and never the UI.
 *
 * Later tasks add the dice engine helpers, check resolution and retrieval, plus
 * the built-in rule-pack data. Rule content must use open licences only
 * (D&D 5e SRD is CC-BY-4.0 and requires attribution — HANDOFF decision 007),
 * and rolling stays locally authoritative (decision 013).
 */
export const RULES_PACKAGE = '@smarttavern/rules' as const;
