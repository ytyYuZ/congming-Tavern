/**
 * The appearance preferences in the UI (M1-G2, docs/06-开发任务拆解.md §2.1) — theme,
 * font scale and message width, next to `settings-store.ts` (BYO-Key) and
 * `locale-store.ts` (language).
 *
 * WHY ONE STORE HOLDS THREE ROWS
 * The three ROWS are separate on purpose (see `appearance/appearance.ts`: different
 * lifetimes, different writers, and a font-size change must not rewrite the theme row),
 * but they are one SCREEN's worth of state: the setup view edits all three at once, one
 * `load()` reads them together, and a caller that wants to know "what does the interface
 * look like" has one subscription instead of three. The store therefore writes exactly
 * one row per action — the separation is preserved where it matters (storage), not
 * duplicated where it does not (memory).
 *
 * THE INITIAL VALUE, IN ORDER (M1-G2 — this is the documented contract)
 *   1. `DEFAULT_APPEARANCE` — `system` / 1 / 85, the values the feature documents;
 *   2. the stored `settings` rows, which REFINE step 1 once they answer.
 * There is no browser-derived step, unlike the locale store's: the browser's own
 * preference IS `system`, and `app.css` follows it through `prefers-color-scheme` before
 * any JavaScript runs. So the first paint is already right, and the read only narrows it.
 * The parsers in `appearance/appearance.ts` are what makes step 2 total: a missing,
 * wrong-typed or out-of-range row lands on the documented default (or the nearest bound)
 * instead of throwing or rendering an unusable size.
 *
 * WHY THIS STORE DOES NOT TOUCH THE DOM
 * The values here are plain data, which is what makes them assertable without a render.
 * Projecting them onto `document.documentElement` needs a LIFETIME — the
 * `prefers-color-scheme` listener must be installed when the theme is `system` and
 * removed when it is not, or when the shell unmounts — and a store has no unmount.
 * `appearance/use-appearance-effect.ts` owns that, and its React cleanup is the one
 * place the listener can be guaranteed to come off.
 *
 * WHY `set*` UPDATES STATE BEFORE AWAITING THE WRITE
 * The click and the change must be one gesture (`state/locale-store.ts` records the full
 * argument): `await write…()` first would leave the interface at the old size until
 * IndexedDB answered, and a slider dragged twice would race two writes against a value
 * that has not moved. So state changes NOW and the row is written after.
 *
 * WHY A FAILED WRITE IS REPORTED AND NOT THROWN
 * These actions are called from change handlers, which are fire-and-forget: a rejection
 * there is an unhandled promise rejection with no user-visible outcome. The change STANDS
 * (the user asked for it; reverting is a second, surprising change) and `error` records
 * the failure's NAME — see `state/write-error.ts`, which owns the rule and the reason the
 * message is deliberately dropped.
 *
 * WHY THE PERSISTED READ IS TOKENISED (`loadToken`)
 * `load()` is asynchronous and the controls are live while it is in flight. An unguarded
 * `set(await …)` would RACE the user: a change that lands first is silently reverted when
 * the read answers, so the slider visibly jumps back. `loadToken` is bumped by `load`, by
 * every `set*` and by `resetAppearanceStore`, and a read whose token is no longer current
 * discards its result. A user's choice always outranks a read that started before it.
 *
 * WHY `ready` IS ON THE STORE
 * `ready` starts false and becomes true once the rows have answered. It is NOT a gate on
 * rendering — the constructed value is already a usable appearance, so the setup view
 * renders its controls immediately — but it lets a caller that cares about the difference
 * between "the defaults" and "what is stored" wait for the read.
 *
 * WHY EVERY ACTION IS TOTAL OVER ITS INPUT
 * The actions are typed, but a value can still arrive from outside TypeScript (a stored
 * row read elsewhere, a future caller). Each one therefore runs its argument through the
 * same parser the repository uses, so a row this store writes can never be one the reader
 * would refuse — the invariant "what we write is what we can read" is enforced in one
 * direction by construction.
 */
import { create } from 'zustand';
import {
  clampFontScale,
  clampMessageWidth,
  DEFAULT_APPEARANCE,
  type FontScale,
  type MessageWidth,
  parseTheme,
  type Theme,
} from '../appearance/appearance';
import {
  readFontScaleSetting,
  readMessageWidthSetting,
  readThemeSetting,
  writeFontScaleSetting,
  writeMessageWidthSetting,
  writeThemeSetting,
} from '../db/repository';
import { writeErrorName } from './write-error';

/**
 * Which `load` is current. Bumped by everything that decides the appearance on its own,
 * so a read that resolves after its view of the world changed can tell that it is stale.
 */
let loadToken = 0;

/**
 * What the first paint shows, and what a reset restores: step 1 of the documented chain.
 *
 * A function rather than a shared object so each store construction gets its own copy —
 * `DEFAULT_APPEARANCE` is a module constant and a store that mutated it would change the
 * default for every later test in the process.
 */
function initialState(): Pick<
  AppearanceState,
  'theme' | 'fontScale' | 'messageWidth' | 'ready' | 'error'
> {
  return { ...DEFAULT_APPEARANCE, ready: false, error: undefined };
}

export interface AppearanceState {
  /** The active theme PREFERENCE (`system` follows the OS live). */
  theme: Theme;
  /** The active font-size multiplier, within the documented bounds. */
  fontScale: FontScale;
  /** The active bubble width, in percent of the transcript column. */
  messageWidth: MessageWidth;
  /** True once the persisted rows have answered (see the header). */
  ready: boolean;
  /**
   * The last write failure, as a short machine-readable label (`'QuotaExceededError'`).
   * `undefined` while nothing has failed; cleared by a successful write.
   */
  error: string | undefined;

  /** Read the persisted rows and adopt them. */
  load: () => Promise<void>;
  /** Choose a theme. Never rejects — see the header. */
  setTheme: (next: Theme) => Promise<void>;
  /** Set the font-size multiplier. Out-of-range input is clamped. Never rejects. */
  setFontScale: (next: FontScale) => Promise<void>;
  /** Set the bubble width in percent. Out-of-range input is clamped. Never rejects. */
  setMessageWidth: (next: MessageWidth) => Promise<void>;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  ...initialState(),

  async load(): Promise<void> {
    loadToken += 1;
    const token = loadToken;
    // One read per row, in PARALLEL: the rows are independent, so startup costs the
    // slowest read rather than the sum of the three.
    const [theme, fontScale, messageWidth] = await Promise.all([
      readThemeSetting(),
      readFontScaleSetting(),
      readMessageWidthSetting(),
    ]);
    // A `set*` (the user's own change) or a `resetAppearanceStore` (a test's teardown)
    // happened while this read was in flight: that decision is newer than the rows this
    // read saw, so the result is dropped rather than applied over it.
    if (token !== loadToken) return;
    set({ theme, fontScale, messageWidth, ready: true });
  },

  async setTheme(next: Theme): Promise<void> {
    const theme = parseTheme(next);
    // Bumped BEFORE the state change: this is a newer decision than any read in flight.
    loadToken += 1;
    set({ theme });
    try {
      await writeThemeSetting(theme);
      set({ error: undefined });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown appearance write failure') });
    }
  },

  async setFontScale(next: FontScale): Promise<void> {
    const fontScale = clampFontScale(next);
    loadToken += 1;
    set({ fontScale });
    try {
      await writeFontScaleSetting(fontScale);
      set({ error: undefined });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown appearance write failure') });
    }
  },

  async setMessageWidth(next: MessageWidth): Promise<void> {
    const messageWidth = clampMessageWidth(next);
    loadToken += 1;
    set({ messageWidth });
    try {
      await writeMessageWidthSetting(messageWidth);
      set({ error: undefined });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown appearance write failure') });
    }
  },
}));

/** Test seam: forget everything this process loaded, exactly as the store started. */
export function resetAppearanceStore(): void {
  loadToken += 1;
  useAppearanceStore.setState({ ...initialState() });
}
