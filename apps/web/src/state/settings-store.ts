/**
 * BYO-Key settings in the UI (M0-T8, ADR-017) — the settings half of the Zustand
 * state layer.
 *
 * THE STORE IS A CACHE OF THE `settings` ROW, NOT A SECOND SOURCE OF TRUTH
 * `load()` hydrates from `db/repository.ts` and every mutation goes back through
 * it, so a reload shows exactly what was saved. Nothing here reaches for Dexie
 * directly: the state layer knows a repository, not a database (ADR-017).
 *
 * WHY THE API KEY IS IN THIS STORE AND STILL KEEPS INVARIANT 6
 * The user has to be able to type and re-read their own key — there is no backend
 * to hide it behind (ADR-003), and `HANDOFF §4.1` #6 forbids the key reaching
 * EXPORTED PACKAGES, LOGS and MESSAGE METADATA, not the local settings row the
 * user configured. So: the key is persisted only in `settings/provider`, is never
 * copied onto a `Session` or a `Message`, and nothing in this module logs. Every
 * value in the state object is plain data, so a state snapshot (Zustand devtools,
 * a bug report) can never contain a credential the user did not already own.
 *
 * `ready` MEANS "A TURN CAN BE ATTEMPTED"
 * It is derived from the configuration, never set by hand: an endpoint and a model
 * are both required to make a request. The key is deliberately NOT part of it —
 * an empty key is the documented way to reach a local Ollama or vLLM
 * (`OpenAICompatibleOptions.apiKey`), so requiring one would block the very setup
 * the port supports.
 */
import { create } from 'zustand';
import {
  EMPTY_PROVIDER_SETTINGS,
  type ProviderSettings,
  readProviderSettings,
  writeProviderSettings,
} from '../db/repository';

export type { ProviderSettings };

/** True when the configuration can produce a request at all. */
export function isProviderReady(settings: ProviderSettings): boolean {
  return settings.baseUrl.trim() !== '' && settings.model.trim() !== '';
}

export interface SettingsState {
  provider: ProviderSettings;
  /** Derived from `provider`; drives the play view's disabled state. */
  ready: boolean;
  /** True once `load()` has answered, so the form can wait for stored values. */
  loaded: boolean;
  load: () => Promise<void>;
  save: (provider: ProviderSettings) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  provider: { ...EMPTY_PROVIDER_SETTINGS },
  ready: false,
  loaded: false,

  async load(): Promise<void> {
    const provider = await readProviderSettings();
    set({ provider, ready: isProviderReady(provider), loaded: true });
  },

  async save(provider: ProviderSettings): Promise<void> {
    await writeProviderSettings(provider);
    // Re-read rather than trusting the argument: the repository decides what a
    // stored configuration IS (it fills missing fields), and a form that shows
    // something other than the stored row is the bug this avoids.
    await get().load();
  },
}));

/** Test seam: forget everything this process loaded. */
export function resetSettingsStore(): void {
  useSettingsStore.setState({
    provider: { ...EMPTY_PROVIDER_SETTINGS },
    ready: false,
    loaded: false,
  });
}
