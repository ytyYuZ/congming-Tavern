/**
 * The language preference in the UI (M1-G1, docs/06-开发任务拆解.md §2.1) — the third
 * half of the Zustand state layer, next to `settings-store.ts` and `chat-store.ts`.
 *
 * WHY THE PREFERENCE LIVES IN A STORE AND NOT IN REACT STATE
 * "Switching the language takes effect across the whole interface" is a claim about
 * EVERY component, including ones that never see the picker. A store is the only thing
 * all of them can read without a provider wrapping the tree, and it is where the
 * persisted row is already addressed: `db/repository.ts` owns the storage dialect, this
 * module owns the in-memory preference, exactly as `settings-store.ts` does for BYO-Key.
 *
 * THE INITIAL VALUE, IN ORDER (M1-G1 — this is the documented contract)
 *   1. the stored `settings`/`locale` row, when it holds a supported tag;
 *   2. `resolveLocale(navigator.languages)`, i.e. the browser's own preference;
 *   3. `DEFAULT_LOCALE`.
 * A first run therefore FOLLOWS THE BROWSER rather than defaulting to zh-CN: the picker
 * is a preference, not the only way to get an interface you can read. Step 1 is the
 * database's answer (`readLocaleSetting`, which owns the row and validates it with
 * `isLocale`); steps 2 and 3 are `i18n/browser-locale.ts`'s `browserLocale()`, whose last
 * resort is `DEFAULT_LOCALE`. The chain is assembled HERE because this module is the
 * first place allowed to know both the storage layer and the i18n layer — and that
 * function sits in a LEAF module rather than in `i18n/translate.ts` precisely so this
 * import cannot close a cycle (`translate.ts` reads this store; see its header).
 *
 * WHY `setLocale` UPDATES STATE BEFORE AWAITING THE WRITE
 * The click and the switch must be one gesture. `await writeLocaleSetting(next)` first
 * would leave the UI in the old language until IndexedDB answered — on a cold start
 * that is a visible stall on every language change, and a user who clicks twice would
 * race two writes against a picker that has not moved. So state changes NOW and the row
 * is written after.
 *
 * WHY A FAILED WRITE IS REPORTED AND NOT THROWN
 * `setLocale` is called from a `<select>`'s change handler, which is a fire-and-forget
 * click: a rejection there becomes an unhandled promise rejection with no user-visible
 * outcome, and the language on screen would disagree with the one on disk in silence.
 * Instead the switch STANDS (the user asked for it; reverting is a second, surprising
 * change) and `error` records the failure so a caller can surface it. The write is
 * idempotent and the preference is re-read on the next load, so a failed write costs
 * one reload's worth of preference, never a lost click. WHAT is recorded — the error's
 * name, never its message — and why, lives in `state/write-error.ts`, which the
 * appearance store uses too (one rule, one implementation).
 *
 * WHY THE PERSISTED READ IS TOKENISED (`loadToken`)
 * `load()` is asynchronous, and the picker is live while it is in flight. An
 * unguarded `set({ locale: await readLocaleSetting() })` therefore RACES the user: a
 * click that lands first is silently reverted when the read answers, so the picker
 * visibly jumps back — or changes language under the user. `chat-store.ts` solves the
 * same problem for `open()` with an `openToken`; here `loadToken` is bumped by `load`,
 * by `setLocale` and by `resetLocaleStore`, and a read whose token is no longer current
 * discards its result. A user's choice always outranks a read that started before it.
 *
 * WHY `ready` IS ON THE STORE
 * `ready` starts false and becomes true once the persisted row has answered. It is NOT
 * a gate on rendering — the store's synchronous initial value is already a usable
 * locale, so the first paint is in a real language — but it lets a caller that cares
 * about the difference between "the browser's guess" and "the stored preference" wait
 * for the read to land.
 */
import type { Locale } from '@smarttavern/i18n';
import { create } from 'zustand';
import { readLocaleSetting, writeLocaleSetting } from '../db/repository';
import { browserLocale } from '../i18n/browser-locale';
import { writeErrorName } from './write-error';

/**
 * Which `load` is current. Bumped by everything that decides the locale on its own, so
 * a read that resolves after its view of the world changed can tell that it is stale.
 */
let loadToken = 0;

/**
 * What the first paint shows, and what a reset restores: steps 2 and 3 of the chain.
 *
 * A function rather than an inlined call so `resetLocaleStore` puts the store back into
 * exactly the state it was CONSTRUCTED in — a reset that left a different locale behind
 * would leak one test's choice into the next. The resolution rule itself lives in
 * `i18n/translate.ts`, so this module never spells a locale tag by hand.
 */
function initialState(): Pick<LocaleState, 'locale' | 'ready' | 'error'> {
  return { locale: browserLocale(), ready: false, error: undefined };
}

export interface LocaleState {
  /** The active language. Always a supported `Locale`, never a raw browser tag. */
  locale: Locale;
  /** True once the persisted preference has answered (see the header). */
  ready: boolean;
  /**
   * The last write failure, as a short machine-readable label (`'QuotaExceededError'`).
   * `undefined` while nothing has failed; cleared by a successful write.
   */
  error: string | undefined;

  /** Read the persisted preference and adopt it. */
  load: () => Promise<void>;
  /** Switch the language. Never rejects — see the header. */
  setLocale: (next: Locale) => Promise<void>;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  ...initialState(),

  async load(): Promise<void> {
    loadToken += 1;
    const token = loadToken;
    const stored = await readLocaleSetting();
    // A `setLocale` (the user's own click) or a `resetLocaleStore` (a test's teardown)
    // happened while this read was in flight: that decision is newer than the row this
    // read saw, so the result is dropped rather than applied over it.
    if (token !== loadToken) return;
    // Steps 2 and 3 of the documented chain, applied only when the row had nothing
    // usable — a corrupt row (`'EN'`) falls back rather than throwing.
    set({ locale: stored ?? browserLocale(), ready: true });
  },

  async setLocale(next: Locale): Promise<void> {
    // Bumped BEFORE the state change: this is a newer decision than any read in flight.
    loadToken += 1;
    set({ locale: next });
    try {
      await writeLocaleSetting(next);
      set({ error: undefined });
    } catch (cause) {
      // The error's NAME only, and the reason is `state/write-error.ts`'s: a storage
      // failure's message can quote the value that failed to store, and there is nothing
      // in a locale write worth quoting.
      set({ error: writeErrorName(cause, 'unknown locale write failure') });
    }
  },
}));

/** Test seam: forget everything this process loaded, exactly as the store started. */
export function resetLocaleStore(): void {
  loadToken += 1;
  useLocaleStore.setState({ ...initialState() });
}
