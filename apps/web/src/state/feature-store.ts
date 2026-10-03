/**
 * The application-level feature switches in the UI (ADR-037, docs/05-决策记录.md §758-775),
 * next to the other preference stores: `appearance-store.ts` (look), `locale-store.ts`
 * (language) and `settings-store.ts` (BYO-Key).
 *
 * TODAY THERE IS EXACTLY ONE: `feature.timeAndScheduling`, the time-advance and multi-speaker
 * scheduling half of play. Its OFF side is the interesting one — the play screen stops offering
 * the advance controls, the world clock leaves the assembled prompt, and the scheduler stops
 * naming speakers — so this store holds a SWITCH, not a preference: it changes what a turn is
 * made of, and the read/write pair in `db/repository.ts` is where its row lives.
 *
 * THE INITIAL VALUE, IN ORDER (ADR-037 — this is the documented contract)
 *   1. OFF — `缺席即关闭，读取处就是判定处`: a library that predates this switch has no row,
 *      and an upgraded app must not silently begin advancing clocks and scheduling speakers;
 *   2. the stored `settings` row REFINES step 1 once it answers.
 * Step 1 is also why the constant below is exported: the store's value before the read and the
 * repository's answer for an absent row are two spellings of one decision, and the switch's own
 * test asserts they agree, so they cannot drift into "renders one way, sends another".
 *
 * WHY A SWITCH IS NOT A RENDER GATE (`ready`)
 * `ready` starts false and becomes true once the row has answered, but it is NOT a gate: step 1
 * is already a complete, usable answer, so the play screen and the setup control render
 * immediately from `timeAndScheduling` — waiting for `ready` would flash the enabled layout on
 * every startup for a switch that is off by default. `ready` only lets a caller tell "the
 * default" from "what is stored".
 *
 * WHY THE PERSISTED READ IS TOKENISED (`loadToken`)
 * `load()` is asynchronous and the control is live while it is in flight. An unguarded
 * `set(await …)` would RACE the user: clicking the box ON while startup's read is still in
 * flight is silently reverted when the read answers (the read saw the state BEFORE the write),
 * and for this switch that means a turn that quietly starts advancing the clock again. The
 * token is bumped by `load`, by `setTimeAndScheduling` and by `resetFeatureStore`, and a read
 * whose token is no longer current discards its result: a user's decision always outranks a
 * read that started before it.
 *
 * WHY A FAILED WRITE IS REPORTED AND NOT THROWN
 * The action is called from a change handler, which is fire-and-forget: a rejection there is an
 * unhandled promise rejection with no user-visible outcome. The change STANDS (the user asked
 * for it) and `error` records the failure's NAME — see `state/write-error.ts`, which owns the
 * rule and the reason the message is deliberately dropped. A switch whose row failed to write
 * therefore reads ON for this session and OFF at the next startup, which is the honest outcome
 * of a failed write rather than a silent revert mid-session.
 */
import { create } from 'zustand';
import { readTimeAndSchedulingSetting, writeTimeAndSchedulingSetting } from '../db/repository';
import { writeErrorName } from './write-error';

/**
 * What the first paint shows, and what a reset restores: step 1 of the documented chain.
 *
 * It is a named constant because the switch's own test pins it to the repository's answer for
 * an absent row, and because the play screen's OFF layout is the default one.
 */
export const DEFAULT_TIME_AND_SCHEDULING = false;

/**
 * Which `load` is current. Bumped by everything that decides a switch on its own, so a read
 * that resolves after its view of the world changed can tell that it is stale.
 */
let loadToken = 0;

/**
 * The constructed state. A function rather than a shared object so each store construction and
 * each reset gets its own copy, exactly as `appearance-store.ts`'s does.
 */
function initialState(): Pick<FeatureState, 'timeAndScheduling' | 'ready' | 'error'> {
  return { timeAndScheduling: DEFAULT_TIME_AND_SCHEDULING, ready: false, error: undefined };
}

export interface FeatureState {
  /** ADR-037's switch: when false, time does not advance and the scheduler names nobody. */
  timeAndScheduling: boolean;
  /** True once the persisted row has answered (see the header — not a render gate). */
  ready: boolean;
  /**
   * The last write failure, as a short machine-readable label (`'QuotaExceededError'`).
   * `undefined` while nothing has failed; cleared by a successful write.
   */
  error: string | undefined;

  /** Read the persisted row and adopt it. */
  load: () => Promise<void>;
  /** Turn time-and-scheduling on or off. Never rejects — see the header. */
  setTimeAndScheduling: (next: boolean) => Promise<void>;
}

export const useFeatureStore = create<FeatureState>((set) => ({
  ...initialState(),

  async load(): Promise<void> {
    loadToken += 1;
    const token = loadToken;
    const timeAndScheduling = await readTimeAndSchedulingSetting();
    // A `setTimeAndScheduling` (the user's own click) or a `resetFeatureStore` (a test's
    // teardown) happened while this read was in flight: that decision is newer than the row
    // this read saw, so the result is dropped rather than applied over it.
    if (token !== loadToken) return;
    set({ timeAndScheduling, ready: true });
  },

  async setTimeAndScheduling(next: boolean): Promise<void> {
    // Total over its input by the same spelling the read uses (`row?.value === true`), so a
    // value that reached here from outside TypeScript means OFF in both directions rather
    // than "truthy here, not exactly `true` there".
    const timeAndScheduling = next === true;
    // Bumped BEFORE the state change: this is a newer decision than any read in flight.
    loadToken += 1;
    set({ timeAndScheduling });
    try {
      await writeTimeAndSchedulingSetting(timeAndScheduling);
      set({ error: undefined });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown feature write failure') });
    }
  },
}));

/** Test seam: forget everything this process loaded, exactly as the store started. */
export function resetFeatureStore(): void {
  loadToken += 1;
  useFeatureStore.setState({ ...initialState() });
}
