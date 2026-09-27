/**
 * The time engine's public surface (docs/02 §5.7, docs/06 §2.5 M1-T1).
 *
 * WHAT THE ENGINE IS. A set of pure functions over `EpochMinute` (ADR-012) and
 * the world's `Calendar`. No DOM, no I/O, no `Date`, no locale: the same
 * functions serve the UI clock, an exported session package and a test.
 *
 * WHAT IT OWNS OF §5.7'S 副作用链. Step 1 (`advance` + `crossedSegments`), step 2
 * (`fireDue` + `nextRepeat`), step 3 (`expireDue`) and step 5's value
 * (`ClockState`). Steps 4, 6 and 7 are worldbook re-evaluation, autosave and
 * prompt injection — I/O and prompt assembly, which core does not do.
 *
 * WHAT IS NOT HERE, ON PURPOSE.
 * - `innerClock` (combat rounds/turns). §5.7 says the narrative clock SUSPENDS
 *   during a fight and is reconciled afterwards; that reconciliation needs the
 *   session's `secondsPerRound` and an explicit "combat ended" signal, so it
 *   belongs to the session engine (M3-R9), not to a pure minute mapper. The
 *   schema for it already exists (`entities/session.ts` `InnerClock`).
 * - The `timeRhythm` advance policy (implicit every N turns, and the AI
 *   `advance_time` auto/ask/deny choice with its "over one day forces ask"
 *   rule). That is a policy over WHO may call `advance` and is enforced at the
 *   call site, where the approval UI lives; a pure function cannot ask.
 *
 * Modules, in dependency order: `types` -> `calendar` -> `segments` ->
 * `crossings` -> `clock` / `scheduler` / `deadlines`.
 */

export * from './calendar';
export * from './clock';
export * from './crossings';
export * from './deadlines';
export * from './scheduler';
export * from './segments';
export * from './types';
