/**
 * The turn engine's public surface (docs/02 §5.6, docs/06 §2.4 M1-S5).
 *
 * WHAT IT IS. Who speaks next, as a pure function of data: the session's cast
 * (its roster pin), the recent transcript and the per-card limits. `planTurn`
 * validates a manual order or ranks the candidates and returns a `TurnSchedule`
 * whose reasons are structured facts - rendering them as catalog sentences stays
 * in `apps/web/src/session/scheduler-text.ts`, so this module needs no locale.
 *
 * WHAT IS NOT HERE, ON PURPOSE. The intervention state (`muted` / absent), the
 * per-round caps' defaults and the stored `TurnPlan` row are the session's, not
 * the engine's: the caller passes `castState` and the caps, and the app persists
 * `planDraftOf(...)`. Persisting, prompt injection and the approval UI are I/O.
 */

export * from './scheduler';
