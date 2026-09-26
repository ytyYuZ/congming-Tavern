/**
 * @smarttavern/ui — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: shared PRESENTATIONAL components only — no business logic, no
 * engine calls (docs/02-技术架构.md §3). UI components subscribe to state that
 * lives in `core`; they never own it.
 *
 * docs/02-技术架构.md D2 fixes Svelte 5 + Tailwind for the shells; this package
 * stays framework-agnostic until the ADR-005 decision is formally closed, so it
 * currently declares no framework dependency.
 */
export const UI_PACKAGE = '@smarttavern/ui' as const;
