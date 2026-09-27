/**
 * BYO-Key settings in the UI (M0-T8, ADR-017; the key sealed at rest by M1-G3) — the
 * settings half of the Zustand state layer.
 *
 * THE STORE IS A CACHE OF THE `settings` ROW, NOT A SECOND SOURCE OF TRUTH
 * `load()` hydrates from `db/repository.ts` and every mutation goes back through
 * it, so a reload shows exactly what was saved. Nothing here reaches for Dexie
 * directly: the state layer knows a repository, not a database (ADR-017).
 *
 * WHY THE API KEY IS REACHABLE FROM THIS STORE AND STILL KEEPS INVARIANT 6
 * The user has to be able to type and re-read their own key — there is no backend
 * to hide it behind (ADR-003), and `HANDOFF §4.1` #6 forbids the key reaching
 * EXPORTED PACKAGES, LOGS and MESSAGE METADATA, not the local settings row the
 * user configured. So: the key is persisted only in `settings/provider`, is never
 * copied onto a `Session` or a `Message`, and nothing in this module logs.
 *
 * M1-G3 SPLIT THAT ONE FACT INTO TWO FIELDS, ON PURPOSE
 * `provider` is the ROW: base URL, model, and the key SLOT — which is an envelope
 * once the user set a passphrase, and is what a read of the database answers.
 * `key` is the plaintext key of THIS TAB, and it exists only while the row's key is
 * readable: absent while an encrypted row is locked, present after an unlock or for
 * a plaintext row. Keeping them apart is what makes the UI able to say "there is a
 * key here and I cannot read it" instead of quietly behaving like "there is no key",
 * which is the failure the milestone names. It is also why `provider` alone is safe
 * to put in a bug report: it holds ciphertext, never the credential.
 *
 * `ready` MEANS "A TURN CAN BE ATTEMPTED"
 * It is derived from the configuration, never set by hand: an endpoint and a model
 * are both required to make a request. The key is deliberately NOT part of it —
 * an empty key is the documented way to reach a local Ollama or vLLM
 * (`OpenAICompatibleOptions.apiKey`), so requiring one would block the very setup
 * the port supports. `locked` is the separate fact "a key is stored and this tab
 * cannot read it", and the send path checks it because "send no Authorization header"
 * would be a wrong explanation of the refusal (`state/chat-store.ts`).
 *
 * WHO DECIDES TO ENCRYPT
 * The CALLER, through a `SecretIntent` — never this store on its own. Encryption needs
 * a passphrase, and a passphrase can only come from the user, so a store that decided
 * to encrypt would either invent one (losing the key) or silently leave plaintext
 * (claiming a protection it did not apply). The intent union is that decision, spelled
 * out, and `secrets/provider-secret.ts` is where the policy behind it is recorded.
 *
 * WHY A FAILED WRITE IS REPORTED AND HOW THE SESSION HANDLES IT
 * `save` reports a storage failure through `error` (the error's NAME — see
 * `state/write-error.ts`) and returns the failure to the caller instead of rejecting:
 * the caller is a form submit, and an unhandled rejection there leaves the user with a
 * spinner and no sentence. When the write fails, the row still holds the OLD secret, so
 * this tab's session is closed and re-read from the row — a session that claims a key
 * the database never accepted is exactly the "silently broken key" to avoid.
 *
 * WHY `error` IS THE HOME FOR BOTH KINDS OF FAILURE
 * A bad passphrase and a quota error need different sentences, so `save`/`unlock`/
 * `encryptStored` return a typed `SecretSaveFailureKind` for the caller to render, while
 * `error` keeps the machine-readable label a diagnostic can print. The two are not
 * interchangeable: the returned kind is UI copy selection, `error` is a log field.
 */
import { create } from 'zustand';
import {
  EMPTY_PROVIDER_SETTINGS,
  type ProviderSettings,
  readProviderSettings,
  type StoredProviderSecret,
  writeProviderSettings,
} from '../db/repository';
import {
  adoptUnprotectedKey,
  lockProviderSecret,
  migrateStoredSecret,
  resealWithSession,
  sealNewSecret,
  unlockedKey,
  unlockProviderSecret,
} from '../secrets/provider-secret';
import {
  type EncryptedSecret,
  type SecretFailureKind,
  secretFailureKind,
} from '../secrets/secret-crypto';
import { writeErrorName } from './write-error';

export type { ProviderSettings };

/**
 * Everything that can refuse a settings action.
 *
 * `SecretFailureKind` is the crypto half (a wrong passphrase, an insecure context);
 * `'storage'` is the database half (a write that did not land). One union because the
 * form renders one notice: the user does not care which layer said no, only which
 * sentence applies.
 */
export type SecretSaveFailureKind = SecretFailureKind | 'storage';

/** True when the configuration can produce a request at all. */
export function isProviderReady(settings: Pick<ProviderSettings, 'baseUrl' | 'model'>): boolean {
  return settings.baseUrl.trim() !== '' && settings.model.trim() !== '';
}

/**
 * What the form wants the key SLOT to become.
 *
 * WHY THIS IS AN ARGUMENT AND NOT A BOOLEAN
 * "Keep", "clear", "store unencrypted" and "seal under a passphrase" are four different
 * user gestures that a single "the apiKey field changed" flag cannot tell apart — and
 * conflating two of them is how a key ends up unprotected while the screen says it is
 * protected. The form computes exactly one of these (the fields it shows are the fields
 * it can express) and this store executes it.
 */
export type SecretIntent =
  /** Leave the stored slot exactly as it is. */
  | { readonly kind: 'keep' }
  /** Store no key at all (a local endpoint that needs none). */
  | { readonly kind: 'clear' }
  /** Store `apiKey` unencrypted — the documented fallback. */
  | { readonly kind: 'plain'; readonly apiKey: string }
  /**
   * Store `apiKey` under a passphrase. An absent `passphrase` means "re-seal with the
   * passphrase already open in this tab", which is only valid while unlocked; a
   * present one is a NEW passphrase (or the same one retyped by a user replacing a key).
   */
  | { readonly kind: 'seal'; readonly apiKey: string; readonly passphrase?: string };

export interface SettingsState {
  /** The stored row. `provider.secret` is an envelope, never a decrypted key. */
  provider: ProviderSettings;
  /** The key this tab can send with; `undefined` while locked or when none is stored. */
  key: string | undefined;
  /** True when a key IS stored under a passphrase and this tab cannot read it. */
  locked: boolean;
  /** Derived from `provider`; drives the play view's disabled state. */
  ready: boolean;
  /** True once `load()` has answered, so the form can wait for stored values. */
  loaded: boolean;
  /** The last failure, as a short machine-readable label (see `state/write-error.ts`). */
  error: string | undefined;
  load: () => Promise<void>;
  /**
   * Write the row: the form's endpoint and model, plus whatever `intent` says the key
   * slot becomes. Never rejects; `undefined` means it landed.
   */
  save: (
    values: { baseUrl: string; model: string },
    intent: SecretIntent,
  ) => Promise<SecretSaveFailureKind | undefined>;
  /** Open an encrypted row with a passphrase. Never rejects. */
  unlock: (passphrase: string) => Promise<SecretSaveFailureKind | undefined>;
  /** Forget the key in this tab. The stored row is untouched. */
  lock: () => void;
  /**
   * Encrypt the key that is ALREADY stored — the M0 plaintext row's migration.
   * Never rejects.
   */
  encryptStored: (passphrase: string) => Promise<SecretSaveFailureKind | undefined>;
}

/**
 * Bring this tab's session in line with a row that was just read.
 *
 * A plaintext row's key is adopted (nothing protects it, so there is nothing to ask
 * for), and an ABSENT key clears the session. An ENCRYPTED row is deliberately left
 * alone: an unlock in progress must not be undone by a re-read, which is what makes
 * "unlock, navigate away, come back" keep working.
 */
function adoptRow(secret: StoredProviderSecret): void {
  if (secret.kind === 'plaintext') {
    adoptUnprotectedKey(secret.apiKey);
    return;
  }
  if (secret.kind === 'none') adoptUnprotectedKey(undefined);
}

/** The key slot's next value, for one intent. May seal, so it can refuse. */
async function resolveSecret(intent: SecretIntent): Promise<StoredProviderSecret> {
  switch (intent.kind) {
    case 'keep':
      return useSettingsStore.getState().provider.secret;
    case 'clear':
      adoptUnprotectedKey(undefined);
      return { kind: 'none' };
    case 'plain': {
      adoptUnprotectedKey(intent.apiKey);
      return intent.apiKey === '' ? { kind: 'none' } : { kind: 'plaintext', apiKey: intent.apiKey };
    }
    case 'seal': {
      // Encrypting nothing is storing nothing: an empty key sends no header either way,
      // and an envelope around it would make the UI claim a protection with no subject.
      if (intent.apiKey === '') {
        adoptUnprotectedKey(undefined);
        return { kind: 'none' };
      }
      const envelope =
        intent.passphrase === undefined || intent.passphrase === ''
          ? await resealWithSession(intent.apiKey)
          : await sealNewSecret(intent.apiKey, intent.passphrase);
      return { kind: 'encrypted', envelope };
    }
  }
}

/** What the first paint (and a reset) shows: nothing stored, nothing unlocked. */
function initialState(): Pick<
  SettingsState,
  'provider' | 'key' | 'locked' | 'ready' | 'loaded' | 'error'
> {
  return {
    provider: { ...EMPTY_PROVIDER_SETTINGS },
    key: undefined,
    locked: false,
    ready: false,
    loaded: false,
    error: undefined,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initialState(),

  async load(): Promise<void> {
    const provider = await readProviderSettings();
    adoptRow(provider.secret);
    set({
      provider,
      key: unlockedKey(),
      // Computed from the ROW plus the session rather than remembered: a flag that could
      // drift from those two would let the UI offer an unlock for a key it can already
      // read, or hide the one it needs.
      locked: provider.secret.kind === 'encrypted' && unlockedKey() === undefined,
      ready: isProviderReady(provider),
      loaded: true,
    });
  },

  async save(values, intent): Promise<SecretSaveFailureKind | undefined> {
    let secret: StoredProviderSecret;
    try {
      secret = await resolveSecret(intent);
    } catch (cause) {
      // The row is untouched: sealing failed, so nothing is written and the user's
      // existing key is still exactly where it was.
      const failure = secretFailureKind(cause);
      if (failure !== undefined) return failure;
      set({ error: writeErrorName(cause, 'unknown secret failure') });
      return 'storage';
    }

    try {
      // ONE write for the whole row (repository.ts records why): the endpoint, the model
      // and the new key slot land together or not at all.
      await writeProviderSettings({ baseUrl: values.baseUrl, model: values.model, secret });
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown settings write failure') });
      // The row still holds the OLD secret, so the session must not claim the new one.
      // `load()` re-adopts a plaintext row and leaves an encrypted one locked.
      lockProviderSecret();
      await get().load();
      return 'storage';
    }

    set({ error: undefined });
    await get().load();
    return undefined;
  },

  async unlock(passphrase): Promise<SecretSaveFailureKind | undefined> {
    const outcome = await unlockProviderSecret(get().provider.secret, passphrase);
    if (!outcome.ok) return outcome.failure;
    // Re-read the row rather than hand-setting `key`: one place decides what the session
    // holds (`load`), and a second place would be a second rule.
    await get().load();
    return undefined;
  },

  lock(): void {
    if (get().provider.secret.kind !== 'encrypted') {
      // Nothing is protected, so "locking" a plaintext key would only stop the app from
      // working while changing nothing about who can read the row. The screen says the
      // key is unencrypted instead (`app/routes/setup.tsx`).
      return;
    }
    lockProviderSecret();
    set({ key: undefined, locked: true });
  },

  async encryptStored(passphrase): Promise<SecretSaveFailureKind | undefined> {
    const current = get().provider;
    // Annotated rather than inferred: `let` without a type would be an implicit `any` (Biome's
    // `noImplicitAnyLet`), and the value is assigned in a `try` the checker cannot see through.
    let envelope: EncryptedSecret;
    try {
      envelope = await migrateStoredSecret(current.secret, passphrase);
    } catch (cause) {
      const failure = secretFailureKind(cause);
      if (failure !== undefined) return failure;
      set({ error: writeErrorName(cause, 'unknown secret failure') });
      return 'storage';
    }

    try {
      await writeProviderSettings({
        baseUrl: current.baseUrl,
        model: current.model,
        secret: { kind: 'encrypted', envelope },
      });
    } catch (cause) {
      // The plaintext row is still there, so the key is NOT lost — the one outcome this
      // migration must never produce.
      set({ error: writeErrorName(cause, 'unknown settings write failure') });
      return 'storage';
    }

    set({ error: undefined });
    await get().load();
    return undefined;
  },
}));

/**
 * Test seam: forget everything this process loaded, including the tab's unlocked key.
 *
 * The session lives outside the store (`secrets/provider-secret.ts` records why), so a
 * reset that only cleared the store would leak one test's unlock into the next.
 */
export function resetSettingsStore(): void {
  lockProviderSecret();
  useSettingsStore.setState({ ...initialState() });
}
