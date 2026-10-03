/**
 * BYO-Key settings in the UI (M0-T8, ADR-017; the key sealed at rest by M1-G3; the provider
 * LIST by ADR-034) — the settings half of the Zustand state layer.
 *
 * THE STORE IS A CACHE OF THE `settings` ROWS, NOT A SECOND SOURCE OF TRUTH
 * `load()` hydrates from `db/repository.ts` and every mutation goes back through
 * it, so a reload shows exactly what was saved. Nothing here reaches for Dexie
 * directly: the state layer knows a repository, not a database (ADR-017).
 *
 * WHY THE API KEY IS REACHABLE FROM THIS STORE AND STILL KEEPS INVARIANT 6
 * The user has to be able to type and re-read their own key — there is no backend
 * to hide it behind (ADR-003), and `HANDOFF §4.1` #6 forbids the key reaching
 * EXPORTED PACKAGES, LOGS and MESSAGE METADATA, not the local settings row the
 * user configured. So: each provider's key is persisted only in that provider's
 * `settings` row, is never copied onto a `Session` or a `Message`, and nothing in
 * this module logs.
 *
 * M1-G3 SPLIT THAT ONE FACT INTO TWO FIELDS, ON PURPOSE
 * `provider` is the ACTIVE ROW: base URL, model, and the key SLOT — which is an envelope
 * once the user set a passphrase, and is what a read of the database answers.
 * `key` is the plaintext key of THIS TAB for that row, and it exists only while the row's
 * key is readable: absent while an encrypted row is locked, present after an unlock or for
 * a plaintext row. Keeping them apart is what makes the UI able to say "there is a
 * key here and I cannot read it" instead of quietly behaving like "there is no key",
 * which is the failure the milestone names. It is also why `provider` alone is safe
 * to put in a bug report: it holds ciphertext, never the credential.
 *
 * ADR-034 ADDED A LIST, AND IT DID NOT ADD A SECOND SOURCE OF TRUTH FOR A TURN
 * `providers` is every `provider.<id>` row (plus the adopted legacy `provider` row) and
 * `activeId` is which one this screen edits; `provider`/`key`/`locked` are that row's, so every
 * pre-ADR-034 reader keeps working unchanged. What the list does NOT become is "the provider a
 * turn uses": a session pins one by id (`refs.modelConfig.provider`) and the play path sends
 * with the ACTIVE row's endpoint and key, exactly as before — this task is about keys, not
 * about request routing (`db/repository.ts` records why the pin is metadata). `activeId` is
 * also the answer to "which row should a NEW session pin", which the repository's
 * `provider.default` row stores for a reload.
 *
 * WHY `activeId` SURVIVES A RELOAD AND THE TAB'S UNLOCKED KEY DOES NOT
 * `activeId` is a fact about the LIBRARY (which configuration the user is working on), so it is
 * the `provider.default` row. The unlocked key is a fact about THIS TAB, so it is memory —
 * unless the user opted into 「在这台设备上记住解锁」 for that row, in which case `load()`
 * adopts the remembered DERIVED key (`secrets/unlock-memory.ts`; never the passphrase).
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
 *
 * WHY A REFUSED DELETE IS A RETURN VALUE AND NOT A SENTENCE
 * ADR-034 requires the refusal to NAME the sessions that pin the row, and a sentence is the
 * i18n layer's (ADR-030), which this module may not import. So `remove` answers
 * `{ kind: 'pinned', sessions }` and the view renders it — the same division `SecretIntent`
 * and the failure kinds already use.
 */
import { mintUuidV7 } from '@smarttavern/schema';
import { create } from 'zustand';
import {
  ADOPTED_PROVIDER_ID,
  deleteProviderSettings,
  EMPTY_PROVIDER_SETTINGS,
  listProviderSettings,
  listSessionsPinningProvider,
  PROVIDER_ROW_PREFIX,
  type ProviderEntry,
  type ProviderSettings,
  readProviderSettingsById,
  resolveProviderId,
  type StoredProviderSecret,
  writeDefaultProviderId,
  writeProviderSettings,
} from '../db/repository';
import {
  adoptRememberedSecret,
  adoptUnprotectedKey,
  forgetAllSessions,
  lockProviderSecret,
  migrateStoredSecret,
  resealWithSession,
  revokeRememberedUnlock,
  sealNewSecret,
  unlockedKeyFor,
  unlockProviderSecret,
} from '../secrets/provider-secret';
import {
  type EncryptedSecret,
  type SecretFailureKind,
  secretFailureKind,
} from '../secrets/secret-crypto';
import { rememberedProviderIds } from '../secrets/unlock-memory';
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

/**
 * WHICH row a write names: the active one, or an explicit id.
 *
 * An explicit id is what `add`/`switch`/`remove` and the DOM tests use — "write THIS row" has
 * to be expressible or the list could not be exercised without racing the active row.
 */
export type ProviderTarget = 'active' | { readonly id: string };

/** The row id a target names, given the active one. `undefined` when nothing is configured. */
function targetId(target: ProviderTarget | undefined, activeId: string | undefined): string {
  if (target === undefined || target === 'active') return activeId ?? ADOPTED_PROVIDER_ID;
  return target.id;
}

/** What `remove` answers. A refusal carries the sessions that pin the row (ADR-034). */
export type RemoveProviderOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'pinned';
      readonly sessions: readonly { readonly id: string; readonly title: string }[];
    }
  | { readonly kind: 'storage' };

export interface SettingsState {
  /** Every stored provider configuration, in row order (ADR-034). */
  providers: readonly ProviderEntry[];
  /** Which entry `provider`/`key`/`locked` describe, and which a new session pins. */
  activeId: string | undefined;
  /** The ACTIVE row. `settings.secret` is an envelope, never a decrypted key. */
  provider: ProviderSettings;
  /** The key this tab can send with for the active row; absent while locked or when none. */
  key: string | undefined;
  /** True when the active row's key IS stored under a passphrase and this tab cannot read it. */
  locked: boolean;
  /** The row ids this DEVICE holds a remembered unlock for (ADR-034 + the opt-in). */
  remembered: readonly string[];
  /** Derived from `provider`; drives the play view's disabled state. */
  ready: boolean;
  /** True once `load()` has answered, so the form can wait for stored values. */
  loaded: boolean;
  /** The last failure, as a short machine-readable label (see `state/write-error.ts`). */
  error: string | undefined;
  load: () => Promise<void>;
  /**
   * Write one row: the form's endpoint and model, plus whatever `intent` says the key
   * slot becomes. Never rejects; `undefined` means it landed.
   */
  save: (
    values: { baseUrl: string; model: string },
    intent: SecretIntent,
    target?: ProviderTarget,
  ) => Promise<SecretSaveFailureKind | undefined>;
  /** Open a row's encrypted key with a passphrase. Never rejects. */
  unlock: (
    passphrase: string,
    options?: { readonly target?: ProviderTarget; readonly remember?: boolean },
  ) => Promise<SecretSaveFailureKind | undefined>;
  /** Forget the ACTIVE row's key in this tab. The stored rows are untouched. */
  lock: () => void;
  /** Revoke the remembered unlock of one row. The ciphertext is untouched. */
  forgetRemembered: (providerId?: string) => Promise<void>;
  /**
   * Encrypt the key that is ALREADY stored in one row — the M0 plaintext row's migration.
   * Never rejects.
   */
  encryptStored: (
    passphrase: string,
    target?: ProviderTarget,
  ) => Promise<SecretSaveFailureKind | undefined>;
  /** Start a NEW provider row: it becomes the active one and the default for new sessions. */
  add: () => Promise<string>;
  /** Make one row the active one, and remember that choice for a reload. */
  switch: (providerId: string) => Promise<void>;
  /** Delete one row, refusing while any session pins it (ADR-034). Never rejects. */
  remove: (providerId: string) => Promise<RemoveProviderOutcome>;
}

/**
 * Bring this tab's session for one row in line with the row that was just read.
 *
 * A plaintext row's key is adopted (nothing protects it, so there is nothing to ask
 * for), and an ABSENT key clears the session. An ENCRYPTED row is only opened when the user
 * asked for that row's unlock to be remembered on this device — otherwise it is deliberately
 * left alone, because an unlock in progress must not be undone by a re-read, which is what
 * makes "unlock, navigate away, come back" keep working. The remembered path is safe to run
 * here for the same reason: it only ever OPENS a row whose own record asks for it.
 */
async function adoptRow(id: string, secret: StoredProviderSecret): Promise<void> {
  if (secret.kind === 'plaintext') {
    adoptUnprotectedKey(secret.apiKey, id);
    return;
  }
  if (secret.kind === 'none') {
    adoptUnprotectedKey(undefined, id);
    return;
  }
  await adoptRememberedSecret(id, secret);
}

/** The key slot's next value, for one intent. May seal, so it can refuse. */
async function resolveSecret(intent: SecretIntent, id: string): Promise<StoredProviderSecret> {
  switch (intent.kind) {
    case 'keep':
      return (await readProviderSettingsById(id)).secret;
    case 'clear':
      adoptUnprotectedKey(undefined, id);
      return { kind: 'none' };
    case 'plain': {
      adoptUnprotectedKey(intent.apiKey, id);
      return intent.apiKey === '' ? { kind: 'none' } : { kind: 'plaintext', apiKey: intent.apiKey };
    }
    case 'seal': {
      // Encrypting nothing is storing nothing: an empty key sends no header either way,
      // and an envelope around it would make the UI claim a protection with no subject.
      if (intent.apiKey === '') {
        adoptUnprotectedKey(undefined, id);
        return { kind: 'none' };
      }
      const envelope =
        intent.passphrase === undefined || intent.passphrase === ''
          ? await resealWithSession(intent.apiKey, id)
          : await sealNewSecret(intent.apiKey, intent.passphrase, id);
      return { kind: 'encrypted', envelope };
    }
  }
}

/** What the first paint (and a reset) shows: no rows, nothing unlocked. */
function initialState(): Pick<
  SettingsState,
  | 'providers'
  | 'activeId'
  | 'provider'
  | 'key'
  | 'locked'
  | 'remembered'
  | 'ready'
  | 'loaded'
  | 'error'
> {
  return {
    providers: [],
    activeId: undefined,
    provider: { ...EMPTY_PROVIDER_SETTINGS },
    key: undefined,
    locked: false,
    remembered: [],
    ready: false,
    loaded: false,
    error: undefined,
  };
}

/** The provider ids this device holds a remembered unlock for, in one read. */
async function rememberedIds(): Promise<string[]> {
  return [...(await rememberedProviderIds())];
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initialState(),

  async load(): Promise<void> {
    const providers = await listProviderSettings();
    const activeId = (await resolveProviderId()) ?? providers[0]?.id;
    // Nothing configured yet: the empty value, and no session to adopt.
    if (activeId === undefined) {
      set({
        providers,
        activeId: undefined,
        provider: { ...EMPTY_PROVIDER_SETTINGS },
        key: undefined,
        locked: false,
        remembered: await rememberedIds(),
        ready: false,
        loaded: true,
      });
      return;
    }
    const provider = await readProviderSettingsById(activeId);
    await adoptRow(activeId, provider.secret);
    set({
      providers,
      activeId,
      provider,
      key: unlockedKeyFor(activeId),
      // Computed from the ROW plus the session rather than remembered: a flag that could
      // drift from those two would let the UI offer an unlock for a key it can already
      // read, or hide the one it needs.
      locked: provider.secret.kind === 'encrypted' && unlockedKeyFor(activeId) === undefined,
      remembered: await rememberedIds(),
      ready: isProviderReady(provider),
      loaded: true,
    });
  },

  async save(values, intent, target): Promise<SecretSaveFailureKind | undefined> {
    const id = targetId(target, get().activeId);
    let secret: StoredProviderSecret;
    try {
      secret = await resolveSecret(intent, id);
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
      await writeProviderSettings({ baseUrl: values.baseUrl, model: values.model, secret }, id);
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown settings write failure') });
      // The row still holds the OLD secret, so the session must not claim the new one.
      // `load()` re-adopts a plaintext row and leaves an encrypted one locked.
      lockProviderSecret(id);
      await get().load();
      return 'storage';
    }

    set({ error: undefined });
    await get().load();
    return undefined;
  },

  async unlock(passphrase, options): Promise<SecretSaveFailureKind | undefined> {
    const id = targetId(options?.target, get().activeId);
    const secret = (await readProviderSettingsById(id)).secret;
    const outcome = await unlockProviderSecret(secret, passphrase, {
      providerId: id,
      remember: options?.remember === true,
    });
    if (!outcome.ok) return outcome.failure;
    // Re-read the rows rather than hand-setting `key`: one place decides what the session
    // holds (`load`), and a second place would be a second rule. The remembered list is
    // re-read there too, so the checkbox's effect is visible without a reload.
    await get().load();
    return undefined;
  },

  lock(): void {
    const id = get().activeId;
    if (id === undefined || get().provider.secret.kind !== 'encrypted') {
      // Nothing is protected, so "locking" a plaintext key would only stop the app from
      // working while changing nothing about who can read the row. The screen says the
      // key is unencrypted instead (`app/routes/setup.tsx`).
      return;
    }
    lockProviderSecret(id);
    set({ key: undefined, locked: true });
  },

  async forgetRemembered(providerId): Promise<void> {
    const id = targetId(undefined, providerId ?? get().activeId);
    await revokeRememberedUnlock(id);
    // The session in memory is deliberately KEPT (`secrets/provider-secret.ts` records why):
    // revoking a convenience must not lock a tab that is already unlocked.
    set({ remembered: await rememberedIds() });
  },

  async encryptStored(passphrase, target): Promise<SecretSaveFailureKind | undefined> {
    const id = targetId(target, get().activeId);
    const current = await readProviderSettingsById(id);
    // Annotated rather than inferred: `let` without a type would be an implicit `any` (Biome's
    // `noImplicitAnyLet`), and the value is assigned in a `try` the checker cannot see through.
    let envelope: EncryptedSecret;
    try {
      envelope = await migrateStoredSecret(current.secret, passphrase, id);
    } catch (cause) {
      const failure = secretFailureKind(cause);
      if (failure !== undefined) return failure;
      set({ error: writeErrorName(cause, 'unknown secret failure') });
      return 'storage';
    }

    try {
      await writeProviderSettings(
        {
          baseUrl: current.baseUrl,
          model: current.model,
          secret: { kind: 'encrypted', envelope },
        },
        id,
      );
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

  async add(): Promise<string> {
    const id = `${PROVIDER_ROW_PREFIX}${mintUuidV7()}`;
    // The new row is written EMPTY immediately, and it becomes the default. Writing it here
    // rather than waiting for a save is what makes the list honest: an entry the user just
    // added exists, and a reload before they fill it in still shows it. An empty row is also
    // exactly what "nothing configured" means (`EMPTY_PROVIDER_SETTINGS`), so it is a value
    // the reader already understands rather than a half-made state.
    await writeProviderSettings({ ...EMPTY_PROVIDER_SETTINGS }, id);
    await writeDefaultProviderId(id);
    await get().load();
    return id;
  },

  async switch(providerId): Promise<void> {
    await writeDefaultProviderId(providerId);
    await get().load();
  },

  async remove(providerId): Promise<RemoveProviderOutcome> {
    // ADR-034's load-bearing rule: because the pin has no version, a session follows the row's
    // CURRENT content, and deleting the row is the only act that can break the link. A dangling
    // pin is exactly what `docs/04` §12 calls a defect, so the delete is refused and the caller
    // names the sessions that hold it.
    const pinned = await listSessionsPinningProvider(providerId);
    if (pinned.length > 0) {
      return {
        kind: 'pinned',
        sessions: pinned.map((session) => ({ id: session.id, title: session.title })),
      };
    }
    try {
      const removed = await deleteProviderSettings(providerId);
      if (!removed) return { kind: 'missing' };
      // The remembered record is device state about THAT row, so it goes with it — the key
      // must not outlive the lock it opens.
      await revokeRememberedUnlock(providerId);
    } catch (cause) {
      set({ error: writeErrorName(cause, 'unknown settings write failure') });
      return { kind: 'storage' };
    }
    await get().load();
    return { kind: 'removed' };
  },
}));

/**
 * Test seam: forget everything this process loaded, including every tab-unlocked key.
 *
 * The sessions live outside the store (`secrets/provider-secret.ts` records why), so a
 * reset that only cleared the store would leak one test's unlock into the next. The
 * REMEMBERED records are device state in their own database and are deliberately NOT cleared
 * here: a test that writes one has to revoke it (or use its own database name), because
 * silently wiping a user's opt-in on a store reset is not something this seam may do.
 */
export function resetSettingsStore(): void {
  forgetAllSessions();
  useSettingsStore.setState({ ...initialState() });
}
