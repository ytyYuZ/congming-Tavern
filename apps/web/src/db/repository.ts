/**
 * Every read and write the app performs on the storage port (M0-T8, ADR-017).
 *
 * WHY THERE IS A REPOSITORY AT ALL
 * ADR-017 puts Dexie behind a repository so the state layer (`state/*`) never
 * speaks a storage dialect. `db/database.ts` owns the Dexie instance and the two
 * access shapes; this module owns the ROW SHAPES and the QUERIES — the two things
 * that would otherwise be spelled out in every component.
 *
 * WHICH DOOR A CALL USES (and why it is not a detail)
 * - `write()` wraps every WRITE in one transaction, because docs/02 §5.3 requires
 *   each state change to be atomic.
 * - `readTable()` serves reads — including every read a `liveQuery` subscription
 *   depends on. A read-write transaction inside a querier is refused by Dexie
 *   (`ReadOnlyError`) and the subscription then never emits, so the subscription
 *   path reads the table directly. `db/database.ts` records the measurement.
 *
 * WHAT "REBUILD THE CHAIN" MEANS (the one non-obvious query)
 * `Session.headMessageId` is the tip of the message TREE (docs/02 §7), not a
 * cursor: a linear chat is the degenerate tree, and branching is "which child
 * does the head point at". Reconstructing the transcript is therefore a WALK from
 * the head up `parentId` to a root, reversed — never "everything in the session",
 * which would splice a discarded branch into the middle of the conversation. The
 * walk is bounded, and a `visited` set stops a corrupted cycle at the first
 * repetition rather than after the bound.
 *
 * THE WALK IS SHARED WITH THE FORK (M1-M2), which needs the same path read INSIDE its own write
 * transaction (it copies the chain and the session row, and the two must be one instant) while
 * `getChain` must read through `readTable` (a `liveQuery` querier may not open a read-write
 * transaction — see the two doors above). So `walkChain` takes the row read as a parameter and
 * both callers supply their own; one bound, one cycle rule, one parse.
 *
 * WHY EVERY ROW IS PARSED WITH ITS SCHEMA ON THE WAY IN
 * `IdSchema` is a plain string and `TimestampSchema` a plain number, so a row read
 * back from IndexedDB is structurally indistinguishable from an unvalidated
 * object. Parsing at this boundary is what makes the persisted shape the schema's
 * shape (ADR-016) instead of "whatever the last writer put there", and it strips
 * unknown fields exactly as HANDOFF §4.1 invariant 5 requires of every reader.
 *
 * THE API KEY (HANDOFF §4.1 invariant 6)
 * The key lives in ONE row: `settings`/`provider`, alongside the base URL and the
 * model, because the user has to be able to configure it and this app has no
 * backend (ADR-003). It is deliberately NOT copied into a `Session`, a `Message`,
 * a `MessageMeta` or an `extensions` blob, and nothing in this module logs.
 *
 * WHAT ADR-034 CHANGED ABOUT THAT SENTENCE
 * "ONE row" became "one row PER provider": N `settings` rows keyed `provider.<id>` plus a
 * `provider.default` marker, which is the `(key, value)` mechanism ADR-022 already froze
 * rather than a nineteenth collection. The row key IS the pin a session holds
 * (`refs.modelConfig.provider`, a bare string with no version), which is why the delete of
 * a referenced row is refused here (`listSessionsPinningProvider`) instead of leaving a
 * dangling reference. The M0/M1 row keyed `provider` is ADOPTED BY THE READER —
 * `listProviderSettings` reports it as an ordinary first entry and writes nothing — the
 * same rule `completeState` follows for an absent `Session.state` (ADR-032).
 *
 * WHAT M1-G3 CHANGED ABOUT THAT ROW, AND WHAT IT DID NOT
 * The row's `apiKey` field now holds either the legacy plaintext STRING or an
 * encrypted envelope (`secrets/secret-crypto.ts`), and this module parses that
 * difference the same way it parses every other field: at the boundary, into a
 * discriminated `StoredProviderSecret`. It does NOT encrypt or derive anything
 * itself — it stores what it is given and reports what it finds, which is what keeps
 * "the row is the only copy" (a claim about STORAGE) separable from "the copy is
 * sealed" (a claim about CRYPTO). `secrets/provider-secret.ts` owns the second claim
 * and is the only caller that ever builds an `encrypted` value. Each row's envelope is
 * its own (ADR-034: the envelope is per row), so no key is shared between rows and an
 * error about one row can never name another's.
 *
 * The import below is a LEAF (`secrets/secret-crypto.ts` imports nothing from the
 * app), which is why it is allowed here: this module must not import the i18n layer
 * or the state layer (ADR-030's addendum — `i18n/translate.ts` ->
 * `state/locale-store.ts` -> here is already a path in one direction, and closing it
 * makes a module half-evaluated). A leaf has no such path to close.
 */
import { COLLECTIONS, type Collection, type RowBase, type Tx } from '@smarttavern/core';
import { isLocale, type Locale } from '@smarttavern/i18n';
import {
  type Character,
  type CharacterData,
  CharacterDataSchema,
  CharacterSchema,
  type CharacterVersion,
  CharacterVersionSchema,
  type Checkpoint,
  CheckpointSchema,
  defaultSessionState,
  type EntityPin,
  type Extensions,
  type Id,
  type JsonValue,
  type Message,
  MessageSchema,
  mintUuidV7,
  type Session,
  SessionSchema,
  type SessionState,
  SessionStateSchema,
  type TurnPlan,
  TurnPlanSchema,
  type VersionNumber,
  type World,
  type WorldData,
  WorldDataSchema,
  WorldSchema,
  type WorldVersion,
  WorldVersionSchema,
} from '@smarttavern/schema';
import {
  type FontScale,
  type MessageWidth,
  parseFontScale,
  parseMessageWidth,
  parseTheme,
  type Theme,
} from '../appearance/appearance';
import {
  type CharacterDraft,
  characterDraftValue,
  readCharacterDraft as readCharacterDraftValue,
  readWorldDraft as readWorldDraftValue,
  type WorldDraft,
  worldDraftValue,
} from '../cards/draft';
import { planCharacterVersion, planWorldVersion, type VersionAnchor } from '../cards/versions';
import {
  type EncryptedSecret,
  encryptedSecretToJson,
  isEncryptedSecret,
} from '../secrets/secret-crypto';
import { type ForkAnchor, type ForkPoint, planFork } from '../session/fork';
import type { TurnPlanDraft } from '../session/scheduler';
import { copyState } from '../session/state-copy';
import { readTable, write } from './database';

/* ─────────────────────────────── identifiers ─────────────────────────────── */

// A hand-rolled UUIDv7 minter used to live here — `crypto.randomUUID` yields v4, which is
// not time-ordered, and M0-T8 allowed no new dependency. It moved to
// `@smarttavern/schema`'s `mintUuidV7` once `packages/packages` turned out to have minted
// manifest ids with its own copy and a different entropy source: one rule (docs/04 §4),
// one implementation.

/* ───────────────────────────── settings rows ─────────────────────────────── */

/**
 * The `settings` collection is `(key, value)` in docs/02 §7, and ADR-022 fixes the
 * port's single addressing rule: `id` holds the KEY. There is one settings row
 * today, so the key is a constant; a second one (theme, locale) is a second id and
 * no schema change.
 *
 * WHAT ADR-034 CHANGED, AND WHAT IT DELIBERATELY DID NOT
 * "How many provider configurations" is now "how many rows", keyed `provider.<id>`,
 * which is the mechanism ADR-022 already provided — no nineteenth collection. This
 * constant is therefore the LEGACY key: the single row M0/M1 wrote, which the READER
 * below adopts as the first `provider.<id>` entry (the `completeState` precedent, ADR-032:
 * the read boundary is where an old row becomes a trusted value, and a migration row is
 * for a change of MEANING, which this is not).
 */
export const LEGACY_PROVIDER_SETTINGS_ID = 'provider';

/**
 * The prefix of a provider row's key: `provider.<id>`.
 *
 * The id inside is a `mintUuidV7()` — measured, not assumed: `IdSchema` is
 * `string().min(1).max(200)` with NO charset constraint, so a prefixed id is a legal row
 * key, and `Session.refs.modelConfig.provider` is a bare `string` (not a `UuidV7`, not a
 * versioned `Ref`), so the row KEY is the pin and no second id field is needed.
 */
export const PROVIDER_ROW_PREFIX = 'provider.';

/**
 * The settings key whose VALUE names the provider a NEW session pins.
 *
 * ADR-034's second point: "which provider is in use" is not a global the play screen needs —
 * `Session.refs.modelConfig` already pins one per session — so the only question left is
 * which row a NEW session should pin, and that is this default fact. It is stored in its own
 * `settings` row so that adding, switching or deleting a provider cannot rewrite the row
 * that holds an API key envelope.
 */
export const PROVIDER_DEFAULT_SETTINGS_ID = 'provider.default';

/** The row key of one provider: `provider.<id>`. The one place that spelling is built. */
export function providerSettingsId(providerId: string): string {
  return `${PROVIDER_ROW_PREFIX}${providerId}`;
}

/** A `settings` row: the port's `RowBase` plus the JSON payload §7 specifies. */
export interface SettingsRow extends RowBase {
  value: JsonValue;
}

/**
 * What the provider row holds about the API key — the three states that exist.
 *
 * WHY A UNION RATHER THAN A NULLABLE STRING
 * "No key" (a local Ollama), "a key, unencrypted" (the M0 row, and the documented
 * fallback when WebCrypto is unavailable) and "a key under a passphrase" are three
 * different facts, and every caller has to branch on them: a form must not show a
 * lock it cannot open, a send must not treat a locked key as an absent one, and a
 * migration must be able to tell exactly which row needs encrypting. Encoding the
 * three in one field name (`apiKey`) with a discriminant keeps the stored shape
 * honest — an empty plaintext string is normalised to `none`, because "no header" is
 * what both mean on the wire.
 */
export type StoredProviderSecret =
  | { readonly kind: 'none' }
  | { readonly kind: 'plaintext'; readonly apiKey: string }
  | { readonly kind: 'encrypted'; readonly envelope: EncryptedSecret };

/** The BYO-Key configuration as it is stored (M0-T8: base URL, model; M1-G3: sealed key). */
export interface ProviderSettings {
  baseUrl: string;
  model: string;
  secret: StoredProviderSecret;
}

/** What a first run starts from: no endpoint, no key, no model. */
export const EMPTY_PROVIDER_SETTINGS: ProviderSettings = {
  baseUrl: '',
  model: '',
  secret: { kind: 'none' },
};

/**
 * Narrow an untrusted `JsonValue` back to the settings shape, field by field.
 *
 * WHY `stringField` AND NOT `value.baseUrl`: this workspace compiles with
 * `noPropertyAccessFromIndexSignature`, so dot access on a JSON object is a type
 * error, while Biome's `useLiteralKeys` flags the literal `value['baseUrl']` form.
 * A parameterised key is the one spelling both accept.
 */
function toProviderSettings(value: JsonValue | undefined): ProviderSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { baseUrl: '', model: '', secret: { kind: 'none' } };
  }
  return {
    baseUrl: stringField(value, 'baseUrl') ?? '',
    model: stringField(value, 'model') ?? '',
    secret: toStoredSecret(jsonField(value, 'apiKey')),
  };
}

/**
 * The key slot of a stored row, as one of the three states.
 *
 * A string is the M0 row (and any row written before a passphrase existed); an
 * object is read through `isEncryptedSecret`, so a row that is neither — a number, a
 * half-written envelope, a leftover from another version — is `none` rather than a
 * decrypt attempt on garbage. Silently reporting `none` is the honest answer for a
 * row nobody can use, and it is recoverable: the user types the key again.
 */
function toStoredSecret(value: JsonValue | undefined): StoredProviderSecret {
  if (typeof value === 'string') {
    return value === '' ? { kind: 'none' } : { kind: 'plaintext', apiKey: value };
  }
  if (isEncryptedSecret(value)) return { kind: 'encrypted', envelope: value };
  return { kind: 'none' };
}

/** A string member of a parsed JSON object; `undefined` for anything else. */
function stringField(value: { [key: string]: JsonValue }, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

/** Any member of a parsed JSON object; `undefined` when the key is absent. */
function jsonField(value: { [key: string]: JsonValue }, key: string): JsonValue | undefined {
  return value[key];
}

function settingsOf(tx: Tx): Collection<SettingsRow> {
  return tx.collection<SettingsRow>(COLLECTIONS.settings);
}

function sessionsOf(tx: Tx): Collection<Session> {
  return tx.collection<Session>(COLLECTIONS.sessions);
}

function messagesOf(tx: Tx): Collection<Message> {
  return tx.collection<Message>(COLLECTIONS.messages);
}

/**
 * The language row's id. Its OWN row rather than a field on `settings/provider`
 * (ADR-022's `(key, value)` port): the two preferences have different lifetimes and
 * different writers, and a language switch must not have to rewrite the row that
 * holds the API key.
 */
export const LOCALE_SETTINGS_ID = 'locale';

/**
 * The stored language preference, or `undefined` when there is not a usable one.
 *
 * THE FALLBACK CHAIN IS APPLIED BY THE CALLER, AND THAT IS THE POINT
 * M1-G1 fixes the order — stored preference, then `resolveLocale(navigator.languages)`,
 * then `DEFAULT_LOCALE` — but only the FIRST step is storage. Steps 2 and 3 need
 * `navigator` and `resolveLocale`, which live in the i18n layer, and this module must not
 * import that layer: `i18n/translate.ts` -> `state/locale-store.ts` -> here is already a
 * path in one direction, so importing it back closes an import cycle whose only symptom
 * is `translate is not a function` while a module is half-evaluated. `state/locale-store
 * .ts` therefore runs the full chain (`readLocaleSetting() ?? browserLocale()`, whose
 * last resort `resolveLocale` supplies as `DEFAULT_LOCALE`) and this function answers the
 * one question the database can answer.
 *
 * WHY `isLocale` AND NOT A LOOSE CHECK: the row was written by this app, so `'EN'` or
 * `'zh'` is a bug in the writer rather than a fuzzy browser tag. Silently accepting it
 * would hide that bug, and `undefined` sends the caller to the browser's own list, which
 * is the honest answer for a row nobody can use.
 */
export async function readLocaleSetting(): Promise<Locale | undefined> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(LOCALE_SETTINGS_ID);
  const stored = row?.value;
  return isLocale(stored) ? stored : undefined;
}

/**
 * Store the language preference.
 *
 * The repository owns the ROW, not the fallback: it writes exactly the locale it is
 * given, because a preference the user chose must be readable back verbatim (that is
 * what the persistence test asserts).
 */
export async function writeLocaleSetting(locale: Locale): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = { id: LOCALE_SETTINGS_ID, value: locale };
    await settingsOf(tx).put(row);
  });
}

/**
 * The appearance rows (M1-G2, docs/06-开发任务拆解.md §2.1): `theme`, `fontScale` and
 * `messageWidth`, each its OWN row for the reason the locale row gives below — and one
 * more: a slider drag writes its row dozens of times, so the font scale must be able to
 * change without rewriting the row that remembers the theme, and a corrupt font scale
 * must not discard a perfectly good theme. One object per screen would couple three
 * independent failures together.
 *
 * WHY THE FALLBACK IS APPLIED HERE AND NOWHERE ELSE
 * `readLocaleSetting` returns `undefined` and lets `state/locale-store.ts` run the
 * documented chain, because two of that chain's three steps need `navigator`, which this
 * module must not reach for. The appearance fallback has no browser half — the default IS
 * a constant in `appearance/appearance.ts` — so the honest place to apply it is the read:
 * a caller cannot forget it, and a stored `'BLUE'`, `NaN` or `999` becomes `system` /
 * `1` / `1.5` before it ever reaches the store. The parsers it uses are the same ones
 * `state/appearance-store.ts` runs on its way IN, so a row this app writes is always a
 * row this app can read.
 */
export const THEME_SETTINGS_ID = 'theme';

/** The font-size row's id. See the block comment above for why it is its own row. */
export const FONT_SCALE_SETTINGS_ID = 'fontScale';

/** The message-width row's id. See the block comment above for why it is its own row. */
export const MESSAGE_WIDTH_SETTINGS_ID = 'messageWidth';

/** The stored theme preference; `system` when the row is missing or unusable. */
export async function readThemeSetting(): Promise<Theme> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(THEME_SETTINGS_ID);
  return parseTheme(row?.value);
}

/** Store the theme preference, exactly as given (a value the parser accepted). */
export async function writeThemeSetting(theme: Theme): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = { id: THEME_SETTINGS_ID, value: theme };
    await settingsOf(tx).put(row);
  });
}

/** The stored font-size multiplier, clamped into the documented band. */
export async function readFontScaleSetting(): Promise<FontScale> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    FONT_SCALE_SETTINGS_ID,
  );
  return parseFontScale(row?.value);
}

/** Store the font-size multiplier, exactly as given (a value the clamp produced). */
export async function writeFontScaleSetting(fontScale: FontScale): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = { id: FONT_SCALE_SETTINGS_ID, value: fontScale };
    await settingsOf(tx).put(row);
  });
}

/** The stored bubble width in percent, clamped into the documented band. */
export async function readMessageWidthSetting(): Promise<MessageWidth> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    MESSAGE_WIDTH_SETTINGS_ID,
  );
  return parseMessageWidth(row?.value);
}

/** Store the bubble width, exactly as given (a value the clamp produced). */
export async function writeMessageWidthSetting(messageWidth: MessageWidth): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = { id: MESSAGE_WIDTH_SETTINGS_ID, value: messageWidth };
    await settingsOf(tx).put(row);
  });
}

/**
 * The one application-level feature switch (ADR-037, docs/05-决策记录.md §757-774): the
 * time-advance and multi-speaker scheduling half of play, keyed `feature.timeAndScheduling`.
 *
 * WHY THERE IS NO MIGRATION ROW AND NO PARSER: ADR-037 fixes the 口径 as 缺席即关闭，读取处
 * 就是判定处. A library written before this switch existed has no such row, and an upgraded app
 * must not silently start advancing the clock and handing turns to a scheduler; so `absent`,
 * `false` and anything not exactly `true` all read as OFF, and THIS read is the only place the
 * decision is made. Nothing is backfilled — one click on the setup page writes the row.
 *
 * WHY THE KEY IS NAMESPACED: unlike the appearance rows above it is not a display preference —
 * it changes what a turn is made of, so it gets a flag-like name rather than a bare noun.
 */
export const TIME_AND_SCHEDULING_SETTINGS_ID = 'feature.timeAndScheduling';

/** The stored feature switch; `false` when the row is missing or unusable (ADR-037). */
export async function readTimeAndSchedulingSetting(): Promise<boolean> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    TIME_AND_SCHEDULING_SETTINGS_ID,
  );
  return row?.value === true;
}

/** Store the feature switch, exactly as given. */
export async function writeTimeAndSchedulingSetting(enabled: boolean): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = { id: TIME_AND_SCHEDULING_SETTINGS_ID, value: enabled };
    await settingsOf(tx).put(row);
  });
}

/**
 * The browser's preferred BCP-47 tags, or `[]` when it has none.
 *
 * `navigator.languages` is read through a parameterised key because this workspace
 * compiles with `noPropertyAccessFromIndexSignature` (which rejects dot access on the
 * `Navigator` index signature) while Biome's `useLiteralKeys` rejects the literal
 * bracket form — the same parameterised-key spelling `stringField` above uses.
 */

/* ────────────────────────────── settings I/O ─────────────────────────────── */

/**
 * One provider configuration row: the id that PINS it plus the payload.
 *
 * The id is what `Session.refs.modelConfig.provider` holds (ADR-034: the pin is a bare
 * string and the row key IS that string's other half), so a caller that lists providers is
 * listing the set of values a session may pin.
 */
export interface ProviderEntry {
  /** The `provider.<id>` row's id, i.e. the value a session pins. */
  readonly id: string;
  /** That row's payload: endpoint, model, key slot. */
  readonly settings: ProviderSettings;
}

/**
 * True for a row id that holds a provider configuration (`provider`, `provider.<id>`).
 *
 * The `provider.default` marker is EXCLUDED, and that exclusion is the whole reason this is a
 * function rather than a `startsWith` at each call site: `provider.default` shares the prefix, so a
 * reader that only matched the prefix would report the default marker as a provider with an empty
 * endpoint — a phantom entry in the list, and one whose deletion would look like a provider delete.
 */
function isProviderRowId(id: string): boolean {
  if (id === PROVIDER_DEFAULT_SETTINGS_ID) return false;
  return id === LEGACY_PROVIDER_SETTINGS_ID || id.startsWith(PROVIDER_ROW_PREFIX);
}

/**
 * The id of the provider row M0/M1 wrote, as it appears in a LIST.
 *
 * WHY IT NEEDS AN ID AT ALL: a session's pin is the row key, and the legacy row's key is
 * `provider` — so the honest answer is that the legacy row's id IS `provider`, and a session
 * created before this change that pins `'openai-compatible'` is not pointing at it (that
 * string was a placeholder for a row that never existed; `createSession` records why).
 * Inventing a uuid here would make the adopted row unaddressable by the one caller that has
 * to name it again (the default key, and the delete refusal).
 */
export const ADOPTED_PROVIDER_ID = LEGACY_PROVIDER_SETTINGS_ID;

/**
 * Read one provider configuration row; a missing row answers empty strings.
 *
 * This is the LOW-LEVEL read (one key, exactly as stored). `readProviderSettings` is the
 * caller-facing one: it resolves "the provider this app should edit" — the stored default,
 * the adopted legacy row, or the first row — so that a first run, an M0 database and an
 * ADR-034 database all answer something usable without the caller knowing which it is.
 */
export async function readProviderSettingsById(providerId: string): Promise<ProviderSettings> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(providerId);
  return toProviderSettings(row?.value);
}

/** Read the stored default provider id, or `undefined` when there is not a usable one. */
export async function readDefaultProviderId(): Promise<string | undefined> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    PROVIDER_DEFAULT_SETTINGS_ID,
  );
  return typeof row?.value === 'string' && row.value !== '' ? row.value : undefined;
}

/**
 * Store which provider a NEW session pins.
 *
 * Its own row, and a plain string: the default is a FACT ("this is the one to use next"),
 * not a second copy of a provider, and a value that names a row nobody has is reported as
 * absent by the reader that resolves it rather than being repaired here — the honest answer
 * for a dangling default is "there is no default", which the list's first entry then fills.
 */
export async function writeDefaultProviderId(providerId: string): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = { id: PROVIDER_DEFAULT_SETTINGS_ID, value: providerId };
    await settingsOf(tx).put(row);
  });
}

/** Every provider row's id, WITHOUT the default marker (`provider.default` is not a provider). */
async function providerRowIds(): Promise<string[]> {
  const rows = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).toArray();
  return (
    rows
      .map((row) => row.id)
      .filter(isProviderRowId)
      // The adopted legacy row comes FIRST: it is the oldest configuration a database can
      // hold, and a list that put a later row above it would make "add a provider" look like
      // it reordered the user's existing one.
      .sort((left, right) => {
        if (left === right) return 0;
        if (left === ADOPTED_PROVIDER_ID) return -1;
        if (right === ADOPTED_PROVIDER_ID) return 1;
        // `provider.<uuidv7>` ids embed a millisecond timestamp, so a string compare is
        // creation order for rows this app minted (docs/04 §4) and a stable, arbitrary order
        // for anything else a reader finds there.
        return left < right ? -1 : 1;
      })
  );
}

/**
 * Every stored provider configuration, in row order — THE ADOPTION BOUNDARY (ADR-034).
 *
 * The M0/M1 row keyed `provider` is reported as an ordinary entry whose id is `provider`, and
 * nothing is written: no migration row, no rewritten key. According to ADR-032's precedent, the
 * read is where an old row becomes a trusted value, and writing a new `provider.<uuid>` copy
 * would create the one state this app must never be in — the same key existing twice, in two
 * rows, one of which a later save would leave behind.
 */
export async function listProviderSettings(): Promise<ProviderEntry[]> {
  const ids = await providerRowIds();
  return Promise.all(ids.map(async (id) => ({ id, settings: await readProviderSettingsById(id) })));
}

/**
 * Which provider row the app edits and a new session pins: the stored default when it names a
 * row that EXISTS, else the adopted legacy row, else the first row, else `undefined` (a first
 * run with nothing configured).
 */
export async function resolveProviderId(): Promise<string | undefined> {
  const ids = await providerRowIds();
  const stored = await readDefaultProviderId();
  // A default that names a row nobody has is IGNORED rather than repaired: the row may be
  // coming back (a slow write, another tab), and rewriting the user's choice here would be a
  // write on a read path. `deleteProviderSettings` is where a stale default is really fixed.
  if (stored !== undefined && ids.includes(stored)) return stored;
  return ids[0];
}

/**
 * Read the provider configuration this app should edit — the resolved default row.
 *
 * A first run answers empty strings, exactly as it did before ADR-034: the interface of this
 * function is unchanged, which is what keeps the play path, the co-creation panel and the
 * settings form reading ONE resolved provider instead of each learning the row list.
 */
export async function readProviderSettings(): Promise<ProviderSettings> {
  const id = await resolveProviderId();
  return id === undefined ? toProviderSettings(undefined) : readProviderSettingsById(id);
}

/**
 * Store one provider configuration — the WHOLE row, key slot included, in ONE write.
 *
 * WHY ONE PUT AND NOT TWO ("write the config", "write the secret")
 * The user's save is one gesture, and the failure mode of splitting it is the one
 * M1-G3 must not have: a base URL written while the key write fails leaves a row
 * whose secret is the OLD one, and the user has no way to tell. One `put` replaces
 * the row atomically (docs/02 §5.3), which is also what makes the plaintext ->
 * encrypted migration safe: the replacing value is the whole row, so the plaintext
 * string has nowhere to survive in. The caller composes the new secret — often the
 * one it just read, unchanged — and this module stores exactly that.
 *
 * WHAT IT DOES NOT DO: it does not encrypt. A caller that wants an encrypted row
 * passes an `encrypted` secret, which only `secrets/provider-secret.ts` builds.
 *
 * `providerId` OMITTED means "the row this app edits" (`resolveProviderId`), which is what
 * keeps every pre-ADR-034 caller writing to the row it just read. A caller that names an id
 * writes THAT row and nothing else — the property ADR-034 is built on.
 */
export async function writeProviderSettings(
  settings: ProviderSettings,
  providerId?: string,
): Promise<void> {
  const id = providerId ?? (await resolveProviderId()) ?? ADOPTED_PROVIDER_ID;
  await write(async (tx) => {
    const row: SettingsRow = {
      id,
      value: {
        baseUrl: settings.baseUrl,
        model: settings.model,
        // `none` is written as an ABSENT field rather than as `''`: the row then says
        // "there is no key" in the same way the reader means it, and no future reader
        // has to know that an empty string once meant the same thing.
        ...(settings.secret.kind === 'none' ? {} : { apiKey: secretToJson(settings.secret) }),
      },
    };
    await settingsOf(tx).put(row);
  });
}

/**
 * Remove one provider row. Reports whether a row was there, so a caller can tell a delete
 * from a no-op instead of claiming it removed something.
 *
 * A dangling default is fixed HERE and not on the read path: after the removal, a
 * `provider.default` that named this row is pointed at whatever row remains (or cleared when
 * none does). That is a real meaning change on a write the user asked for, which is where it
 * belongs.
 *
 * The caller is responsible for the REFUSAL half — ADR-034's "a pinned provider cannot be
 * deleted" is decided by `listSessionsPinningProvider` below, because naming the pinning
 * sessions is a UI sentence and this module may not import the i18n layer (ADR-030).
 */
export async function deleteProviderSettings(providerId: string): Promise<boolean> {
  // Never the default marker: `provider.default` is not a provider, and deleting it through
  // this door would be a silent "clear the default" that reads like a provider deletion.
  if (!isProviderRowId(providerId)) return false;
  return write(async (tx) => {
    const rows = settingsOf(tx);
    const existing = await rows.get(providerId);
    if (existing === undefined) return false;
    await rows.remove(providerId);
    const defaultRow = await rows.get(PROVIDER_DEFAULT_SETTINGS_ID);
    if (defaultRow === undefined || defaultRow.value !== providerId) return true;
    const remaining = (await rows.list())
      .map((row) => row.id)
      .filter((id) => isProviderRowId(id) && id !== providerId);
    if (remaining.length === 0) {
      await rows.remove(PROVIDER_DEFAULT_SETTINGS_ID);
    } else {
      // The adopted legacy row sorts first in `listProviderSettings`, so a database that
      // still holds one falls back to it rather than to an arbitrary survivor.
      const next = remaining.includes(ADOPTED_PROVIDER_ID)
        ? ADOPTED_PROVIDER_ID
        : (remaining[0] as string);
      await rows.put({ id: PROVIDER_DEFAULT_SETTINGS_ID, value: next });
    }
    return true;
  });
}

/**
 * The sessions that PIN a provider row — ADR-034's load-bearing rule.
 *
 * The pin has no version (`Session.refs.modelConfig.provider` is a bare string), so a session
 * follows the row's CURRENT content; deleting the row is the only act that can break that
 * link, and a dangling pin is the defect `docs/04` §12 defines elsewhere as "an exported
 * package that references something it does not carry". So the delete is refused and the
 * caller names these sessions.
 *
 * Read as rows and parsed, like every other read here: `modelConfig` is schema-required, but a
 * row written by an older version — or by a package import — is still untrusted input, and a
 * missing `refs` must be "no pin" rather than a crash.
 */
export async function listSessionsPinningProvider(providerId: string): Promise<Session[]> {
  const rows = await readTable<Session & RowBase>(COLLECTIONS.sessions).toArray();
  const pinned: Session[] = [];
  for (const row of rows) {
    const parsed = SessionSchema.safeParse({ ...row, state: completeState(row) });
    if (parsed.success && parsed.data.refs.modelConfig.provider === providerId) {
      pinned.push(parsed.data);
    }
  }
  return pinned;
}

/** The stored form of a present secret: the legacy string, or the envelope's JSON. */
function secretToJson(secret: Exclude<StoredProviderSecret, { kind: 'none' }>): JsonValue {
  return secret.kind === 'plaintext' ? secret.apiKey : encryptedSecretToJson(secret.envelope);
}

/* ──────────────────────────────── sessions ───────────────────────────────── */

/**
 * The provider id recorded before the user has configured anything, and the sampling
 * defaults that satisfy the frozen `SamplingParamsSchema`.
 *
 * WHY THESE SURVIVE AS DEFAULTS WHILE THE WORLD/CHARACTER PINS DID NOT (M1-S1): a
 * session created before BYO-Key is configured still has to be PLAYABLE — the first
 * turn records the endpoint the transcript actually came from
 * (`recordSessionModel`), and refusing to create a session until a key exists would
 * make 「新建会话」 the thing that blocks the setup wizard. There is no such argument
 * for a world, a card or a preset: those ARE the choice a session is, so they are
 * arguments (`NewSessionRefs` below), not defaults this module may invent.
 *
 * WHAT ADR-034 CHANGED HERE, AND WHY IT IS STILL A DEFAULT: the placeholder is used only
 * when the caller does NOT name a provider row (`NewSessionRefs.providerId`). A caller that
 * knows the resolved default passes it, so a new session pins a row that EXISTS — the pin
 * is what the delete refusal and the provider list read. The placeholder stays for the
 * caller that has no settings row to pin (a test, a first run before anything is
 * configured), because a session row must still be writable then.
 */
const PLACEHOLDER_PROVIDER = 'openai-compatible';

/** Sampling defaults that satisfy the frozen `SamplingParamsSchema`. */
const DEFAULT_SAMPLING = { temperature: 0.7, topP: 1 } as const;

/**
 * The pinned references a new session carries — `SessionRefs` without `modelConfig`.
 *
 * WHY `modelConfig` IS NOT A PARAMETER: see the provider default above. It is the one
 * part of `refs` a session legitimately starts without knowing, and the one part the
 * user configures on another screen entirely.
 *
 * WHY `cast` IS `readonly` AND COPIED: the caller's array is the form's selection; the
 * stored row must not alias it, or a later edit of that list would rewrite a session
 * that had already been created (the same aliasing rule `copyState` exists for).
 */
export interface NewSessionRefs {
  readonly world: EntityPin;
  readonly playerCharacter: EntityPin;
  readonly cast: readonly EntityPin[];
  readonly promptPreset: EntityPin;
  /** Absent means "this session binds no rule pack", which is what the optional field means. */
  readonly rulePack?: EntityPin;
  /**
   * The provider row this session pins (ADR-034), when the caller knows it.
   *
   * WHY IT IS OPTIONAL AND NOT REQUIRED: a session's pin is METADATA about which endpoint
   * produced the transcript — it decides nothing about a turn (`state/chat-store.ts` sends
   * with the provider the user is editing). Requiring it would make every existing caller
   * — and every test whose subject is a transcript, not a provider — invent a row id,
   * which is the placeholder churn M1-S1 deleted on the world side. Required would ALSO
   * force the create form to refuse when nothing is configured, and "create a session
   * before you have a key" is the flow BYO-Key is documented to allow.
   */
  readonly providerId?: string;
}

/**
 * Create a session and persist it.
 *
 * WHY THE TITLE IS THE CALLER'S DECISION (M1-G1)
 * A new session's title is PERSISTED DATA — written once, in whatever language was
 * active at creation time, and deliberately not re-translated by a later language switch
 * (`home.defaultSessionTitle`'s catalog comment records the same decision). Deciding it
 * HERE would mean this module reading the catalogs, i.e. the storage layer importing the
 * UI layer, and `i18n/translate.ts` -> `state/locale-store.ts` -> this module is already
 * a path in the other direction: the import would close a cycle whose only observable
 * symptom is `translate is not a function` at module-evaluation time. So the caller (the
 * chat store, which may import the i18n layer) passes the sentence it wants stored, and
 * this module stays a database module.
 *
 * WHY THE PINS AND THE CLOCK ARE ARGUMENTS (M1-S1)
 * A session IS a choice of what to play: `world` / `playerCharacter` / `cast` /
 * `promptPreset` are VERSIONED pins (`EntityPinSchema`, ADR-010 — an unpinned world would
 * make an old save re-render differently after an edit), and `initialClock` is the chosen
 * world version's own `startMinute` (ADR-012), which the session copies so it owns its
 * origin. This module can choose none of them: it knows no rows, no catalog and no form.
 * The placeholder pin the M0 path wrote is therefore GONE — a session that named a world
 * nobody created was a stand-in for the create flow, and that flow now exists
 * (`session/roster.ts` + `app/routes/new-session.tsx`).
 *
 * THE LIVE STATE STARTS AS THE ORIGIN (ADR-032): `state` is required, and a brand-new
 * session has nothing recorded, so it is `defaultSessionState(initialClock)` — the scene
 * unnamed, the clock at the world's start minute. That is a real value from the first turn
 * on, which is what lets a restart find the clock again.
 *
 * The row is parsed before it is written, like `appendMessage`: the persisted shape is then
 * the schema's shape (ADR-016) instead of "whatever the caller passed", which is what makes
 * an unpinned or zero-versioned reference a loud failure rather than a row no reader can use.
 */
export async function createSession(options: {
  title: string;
  refs: NewSessionRefs;
  initialClock: number;
}): Promise<Session> {
  const timestamp = Date.now();
  const session: Session = {
    id: mintUuidV7(),
    title: options.title,
    refs: {
      world: { ...options.refs.world },
      playerCharacter: { ...options.refs.playerCharacter },
      cast: options.refs.cast.map((pin) => ({ ...pin })),
      promptPreset: { ...options.refs.promptPreset },
      ...(options.refs.rulePack === undefined ? {} : { rulePack: { ...options.refs.rulePack } }),
      modelConfig: {
        provider: options.refs.providerId ?? PLACEHOLDER_PROVIDER,
        model: PLACEHOLDER_PROVIDER,
        params: { ...DEFAULT_SAMPLING },
      },
    },
    initialClock: options.initialClock,
    state: defaultSessionState(options.initialClock),
    schedulerMode: 'user',
    headMessageId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const parsed = SessionSchema.parse(session);
  await write(async (tx) => {
    await sessionsOf(tx).put(parsed);
  });
  return parsed;
}

/**
 * Complete one stored session row at the READ boundary (ADR-032's addendum).
 *
 * WHY THE READER DOES THIS AND NOT A `migrations` ROW
 * `Session.state` became required in ADR-032, but rows written before that (M0 /
 * early M1) have no `state` field, and a session without a clock, a scene or
 * variables cannot be played. This is the same rule `readLocaleSetting` follows for
 * a corrupt locale: the reader is where an untrusted row becomes a trustworthy
 * value, so an absent — or unusable — `state` is COMPLETED with
 * `defaultSessionState(initialClock)` instead of rejecting the whole row and
 * taking the transcript down with it. It is a derivation, not a meaning change,
 * which is why no migration row is needed; the next write persists the completed
 * value naturally (`writeSessionState`, `setHeadMessageId`).
 *
 * WHAT M1-S4 ADDED, AND WHY IT COMPLETES A FIELD RATHER THAN A ROW
 * `SessionState.cast` (the live mute / presence state) is a field that arrived later
 * than `state` itself, so a row can carry a valid state WITHOUT it — and the same
 * argument applies one level down: an absent entry already means "present and not
 * muted" (`packages/schema/src/entities/session.ts`), so an absent RECORD means the
 * same for every member and is completed with `{}` here. Replacing such a state with
 * a fresh default would be the bug this function exists to prevent, one field over:
 * it would discard the clock, the variables and the scene of a session that was
 * perfectly readable. That is also why this completion is a merge and not a repair.
 *
 * WHY THIS TAKES A LOOSE SHAPE AND NOT A `Session`
 * The whole point is that the incoming row is NOT a trustworthy `Session` — that is
 * what "written before the field existed" means — so declaring the parameter as one
 * would be the same lie this function disproves. Two optional `unknown` fields are
 * the honest description of "a row that may or may not carry a state and a clock",
 * and a real `Session` still satisfies it.
 */
function completeState(row: { state?: unknown; initialClock?: unknown }): SessionState {
  const parsed = SessionStateSchema.safeParse(row.state);
  if (parsed.success) {
    // An absent `cast` is completed rather than replaced: see the block above for why
    // discarding the rest of a readable state would be the wrong repair. A spread is the
    // spelling this module uses for "this value, with one field filled in"
    // (`writeSessionState` and `setHeadMessageId` do the same one level up).
    return { ...parsed.data, cast: parsed.data.cast ?? {} };
  }
  // The clock is read defensively because this helper exists for rows nobody
  // validated: a row whose `initialClock` is itself broken gets the epoch rather
  // than a `NaN` that would silently poison every later comparison. A row that
  // KEEPS a malformed state is repaired rather than merged field by field — a
  // half-trusted state is exactly the "app shows a stale clock" bug this prevents.
  return defaultSessionState(
    typeof row.initialClock === 'number' && Number.isFinite(row.initialClock)
      ? row.initialClock
      : 0,
  );
}

/** One session, or `undefined` when the id was never stored (or was deleted). */
export async function getSession(sessionId: Id): Promise<Session | undefined> {
  const row = await readTable<Record<string, unknown>>(COLLECTIONS.sessions).get(sessionId);
  if (row === undefined) return undefined;
  return SessionSchema.parse({ ...row, state: completeState(row) });
}

/** Newest first — `sessions.createdAt` is the index docs/02 §7 gives for this. */
export async function listSessions(): Promise<Session[]> {
  const rows = await readTable<Record<string, unknown>>(COLLECTIONS.sessions)
    .orderBy('createdAt')
    .reverse()
    .toArray();
  return rows.map((row) => SessionSchema.parse({ ...row, state: completeState(row) }));
}

/**
 * Store a session's live state (ADR-032) — the write half of the pair whose read
 * half is `getSession`.
 *
 * WHY IT READS THE ROW FIRST: a session row is written whole (`put` replaces it),
 * so a writer must not lose the fields it is not changing — `refs`, `headMessageId`
 * and `createdAt` are not this function's business. The row is completed through
 * `completeState` on the way in for the same reason as on the way out: a state
 * write on a pre-ADR-032 row must not be the operation that makes it unreadable.
 *
 * WHY IT IS NOT PART OF `setHeadMessageId`: the two are different facts written at
 * different moments (a turn advances the transcript tip; the clock and variables
 * move when the engine says so), and a caller that only moves the head must not
 * have to invent a state to do it. Both are one `put` in one transaction.
 */
export async function writeSessionState(sessionId: Id, state: SessionState): Promise<void> {
  await write(async (tx) => {
    const row = await sessionsOf(tx).get(sessionId);
    if (row === undefined) return;
    const session = SessionSchema.parse({ ...row, state: completeState(row) });
    await sessionsOf(tx).put({ ...session, state, updatedAt: Date.now() });
  });
}

/**
 * Give a session a new title (M1-T1) — the write behind the play screen's rename form.
 *
 * WHY IT READS THE ROW FIRST: the same reason `writeSessionState` above does. A session row is
 * written whole, so a rename must not lose `refs`, `state`, `headMessageId` or `createdAt` — none
 * of which is this function's business. The row goes through `completeState` on the way in for the
 * same reason as on the way out: a rename of a pre-ADR-032 row must not be the operation that
 * makes it unreadable.
 *
 * WHY IT HANDS THE ROW BACK: the caller has to show the new name immediately, in the breadcrumb
 * and in the list behind it (`state/chat-store.ts`'s `rename`), and an id alone would make that a
 * second read or an echo of the input. Returning the row that was just written means the screen
 * and the database cannot disagree, `createSession`'s shape.
 *
 * WHY THE TITLE ARRIVES ALREADY DECIDED: this module may not read the catalogs (ADR-030 — the
 * import would close a cycle back into `i18n/translate.ts`), so whoever wants the default sentence
 * picks it, exactly as `createSession`'s caller does. This function also does NOT trim or cap:
 * `session/title.ts` is the one rule that says what a name is, and a second opinion here would be
 * a second answer to a question the screen has already answered.
 *
 * Resolves `undefined` when no such row exists — nothing was written.
 */
export async function renameSession(sessionId: Id, title: string): Promise<Session | undefined> {
  return write(async (tx) => {
    const row = await sessionsOf(tx).get(sessionId);
    if (row === undefined) return undefined;
    const session = SessionSchema.parse({ ...row, state: completeState(row) });
    // The FINAL row is parsed (not only the row that was read): the title has to pass
    // `min(1).max(200)` here too, so a caller that skipped `session/title.ts` fails before the put
    // rather than storing a row nobody can read back.
    const renamed = SessionSchema.parse({ ...session, title, updatedAt: Date.now() });
    await sessionsOf(tx).put(renamed);
    return renamed;
  });
}

/**
 * Record which provider/model this session is played with.
 *
 * WHY THIS IS NOT PART OF `createSession`: the user configures BYO-Key in a
 * different step, and the pin on the session has to reflect the endpoint the
 * transcript actually came from — a transcript generated by one model and labelled
 * with another is a debugging trap (the M1 debug panel reads `MessageMeta.model`
 * against this).
 */
export async function recordSessionModel(
  sessionId: Id,
  config: { provider: string; model: string },
): Promise<void> {
  await write(async (tx) => {
    const row = await sessionsOf(tx).get(sessionId);
    if (row === undefined) return;
    const session = SessionSchema.parse({ ...row, state: completeState(row) });
    await sessionsOf(tx).put({
      ...session,
      refs: {
        ...session.refs,
        // Only the two identifying fields are overwritten: which sampling the user
        // picked belongs to a provider-selection UI that M1 owns.
        modelConfig: {
          ...session.refs.modelConfig,
          provider: config.provider,
          model: config.model,
        },
      },
      updatedAt: Date.now(),
    });
  });
}

/* ──────────────────────────────── messages ───────────────────────────────── */

/**
 * Store a message node. The caller supplies the content and gets back the stored
 * row, so the streaming path does not have to know the schema's field list.
 *
 * `meta` is built by the caller rather than guessed here: `MessageSchema` requires
 * it, and an empty object is the documented "nothing to explain" value. The API key
 * never reaches this argument (HANDOFF §4.1 invariant 6) — the store passes only
 * the model id, the token count a vendor reported, and the finish reason.
 */
export async function appendMessage(input: {
  sessionId: Id;
  parentId: Id | null;
  role: Message['role'];
  content: string;
  /**
   * The presentation kind, for the callers that HAVE one (M1-S2's edit, which must not
   * relabel a narration as ordinary dialogue). Omitted means `'dialogue'`, which is what
   * every turn written so far is.
   */
  kind?: Message['kind'];
  /** Which card spoke, when the caller knows (an edited message keeps its speaker). */
  speakerId?: Message['speakerId'];
  meta?: Message['meta'];
  extensions?: Message['extensions'];
}): Promise<Message> {
  const message: Message = {
    id: mintUuidV7(),
    sessionId: input.sessionId,
    parentId: input.parentId,
    role: input.role,
    ...(input.speakerId === undefined ? {} : { speakerId: input.speakerId }),
    kind: input.kind ?? 'dialogue',
    content: input.content,
    meta: input.meta ?? {},
    createdAt: Date.now(),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  };
  const parsed = MessageSchema.parse(message);
  await write(async (tx) => {
    await messagesOf(tx).put(parsed);
  });
  return parsed;
}

/** One message node by id. */
export async function getMessage(messageId: Id): Promise<Message | undefined> {
  const row = await readTable<Message>(COLLECTIONS.messages).get(messageId);
  return row === undefined ? undefined : MessageSchema.parse(row);
}

/**
 * Whether `messageId` has a child, i.e. whether it is the LEAF of its branch (M1-S2).
 *
 * WHY IT EXISTS BESIDE `deleteLeafMessage`: the delete's rule and the delete's AFFORDANCE
 * are two facts, and the second one is wanted before the click. A row that can tell its user
 * "there is more after this" up front does not have to be told after a confirmation, and the
 * write itself still re-checks inside its own transaction — a UI that read this a moment ago
 * cannot make the write unsafe. This is the read `play.tsx`'s `MessageBubble` uses to label
 * the delete control.
 */
export async function hasChildren(sessionId: Id, messageId: Id): Promise<boolean> {
  return (await listChildren(sessionId, messageId)).length > 0;
}

/**
 * Advance the transcript tip. `null` means "the transcript is empty again".
 *
 * The row is completed through `completeState` first, exactly like `writeSessionState`:
 * this write happens on EVERY turn, so it is also the write that persists a default
 * derived at the read boundary (ADR-032) — and it must never be the write that
 * rejects a row written before `Session.state` existed.
 */
export async function setHeadMessageId(sessionId: Id, headMessageId: Id | null): Promise<void> {
  await write(async (tx) => {
    const row = await sessionsOf(tx).get(sessionId);
    if (row === undefined) return;
    const session = SessionSchema.parse({ ...row, state: completeState(row) });
    await sessionsOf(tx).put({ ...session, headMessageId, updatedAt: Date.now() });
  });
}

/**
 * The children of one node — the SIBLINGS a message is chosen among (M1-S2).
 *
 * WHY THIS READS THE TABLE AND NOT THE CHAIN: the chain is ONE path from the head to a
 * root, so it can never hold two messages with the same `parentId` — the sibling that is
 * NOT on the active path is precisely the one the user wants to switch to, and it exists
 * only in the table.
 *
 * WHY THE SCAN IS NARROWED BY `sessionId` AND THEN FILTERED, INSTEAD OF USING THE
 * `(sessionId, parentId)` INDEX DIRECTLY: the port's `Query.where` is an equality map on
 * the fields of ONE index, and `messages_sessionId_parentId` is compound — a query naming
 * only `parentId` would have to be answered by a full table scan, and a query naming both
 * could not express the ROOT case (`parentId: null`), which is a real query the switcher
 * asks (the siblings of the first message).
 *
 * WHY `null` IS READ WITHOUT ANY INDEX AT ALL, MEASURED RATHER THAN ASSUMED: a row whose
 * `parentId` is `null` is absent from the compound index — an indexed scan narrowed by
 * `sessionId` returns the OTHER rows of the session and silently drops the root, which is
 * the worst shape of bug (a query that answers "no roots" for a session that has one). So
 * the root case scans the table, and the in-memory filter is what decides, always. A
 * dedicated single-field `parentId` index would make both cases a range scan and would need
 * a schema version bump in `packages/core`'s index table, which is not this task's file to
 * change; recorded here so the trade is visible rather than guessed at.
 *
 * The rows are parsed on the way in like every other reader (ADR-016).
 */
export async function listChildren(sessionId: Id, parentId: Id | null): Promise<Message[]> {
  const rows = await readTable<Message>(COLLECTIONS.messages).toArray();
  return rows
    .filter((row) => row.sessionId === sessionId && row.parentId === parentId)
    .map((row) => MessageSchema.parse(row));
}

/**
 * Remove ONE message row (M1-S2).
 *
 * WHY THE CALLER MUST HAVE ESTABLISHED THAT IT IS A LEAF, AND WHY THAT IS NOT CHECKED HERE
 * This function is the raw row removal; `deleteLeafMessage` below is the RULE. The two are
 * separate because the rule can then be TESTED as a rule (a table of child/no-child cases)
 * rather than only through the database, and because the one caller that needs the answer
 * to be atomic (the delete path) gets it from the combined function below. It is
 * idempotent, as `Collection.remove` documents, so a double-click is not an error.
 */
export async function removeMessage(messageId: Id): Promise<void> {
  await write(async (tx) => {
    await messagesOf(tx).remove(messageId);
  });
}

/**
 * Delete a message that is a LEAF, and report whether anything was removed (M1-S2).
 *
 * THE DELETE RULE, IN ONE PLACE
 * A message that has children is REFUSED (`false`): deleting it would either orphan its
 * replies or rewrite their `parentId`, and docs/02 §7 defines this tree as the record of
 * what was generated from what — a "delete the middle of a branch" that promotes the
 * children silently re-parents every one of them, which is a shape no screen can show and
 * no reader can predict. A leaf has no such consequence: the row goes, the tree stays a
 * tree, and nothing else points at it (`Message.parentId` is the tree's only edge; a
 * `Session.headMessageId` or `Checkpoint.messageId` that names it is a POINTER, and
 * repairing that is the caller's move — see `state/chat-store.ts`'s `deleteMessage`).
 *
 * The check and the removal happen in ONE transaction so the answer cannot be stale: two
 * tabs deleting the last two children of a node at the same moment must not both be told
 * they removed a leaf.
 */
export async function deleteLeafMessage(sessionId: Id, messageId: Id): Promise<boolean> {
  return write(async (tx) => {
    const rows = await messagesOf(tx).list({ where: { sessionId } }, 'messages_sessionId_parentId');
    if (rows.some((row) => row.parentId === messageId)) return false;
    await messagesOf(tx).remove(messageId);
    return true;
  });
}

/**
 * How far the chain walk will follow `parentId`. Far beyond any real transcript (a
 * 4000-turn conversation) and low enough that a corrupted tree is a bug report
 * rather than a frozen tab.
 */
const CHAIN_LIMIT = 10_000;

/**
 * Walk `parentId` from `headMessageId` up to a root and return the path in chronological
 * order, or `[]` when the head is `null`.
 *
 * Termination: `CHAIN_LIMIT` bounds how far a corrupted row can drag the walk, and
 * a `visited` set catches a cycle at the first repetition instead of after the
 * bound. Both are needed — the bound alone would still return a plausible-looking
 * duplicate chain.
 *
 * WHY THE READ IS A PARAMETER (M1-M2)
 * The identical walk is needed on both sides of the port's doors: `getChain` reads through
 * `readTable` because a `liveQuery` querier must not open a read-write transaction
 * (`db/database.ts` measures that), while a fork reads INSIDE its own write transaction, because
 * the chain it copies and the session row it copies from must be one instant. The two callers
 * differ only in how they fetch a row, so the walk - and with it the bound, the cycle rule and
 * the parse - lives here once and the caller supplies the read.
 */
async function walkChain(
  headMessageId: Id | null,
  read: (messageId: Id) => Promise<Message | undefined>,
): Promise<Message[]> {
  const reversed: Message[] = [];
  const visited = new Set<Id>();
  let cursor: Id | null = headMessageId;

  for (let step = 0; cursor !== null && step < CHAIN_LIMIT; step += 1) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const row = await read(cursor);
    if (row === undefined) break;
    // Parsed on the way in like every other reader (ADR-016): the walk needs a trustworthy
    // `parentId`, and a fork copies these very values.
    const message = MessageSchema.parse(row);
    reversed.push(message);
    cursor = message.parentId;
  }

  return reversed.reverse();
}

export async function getChain(sessionId: Id): Promise<Message[]> {
  const session = await getSession(sessionId);
  if (session === undefined || session.headMessageId === null) return [];
  const messages = readTable<Message>(COLLECTIONS.messages);
  return walkChain(session.headMessageId, (messageId) => messages.get(messageId));
}

/* ─────────────────────────────── checkpoints ─────────────────────────────── */

/**
 * One stored save point (M1-M1 / M1-T4, docs/04 §6, docs/02 §7, ADR-032).
 *
 * A CHECKPOINT IS **ONE ROW**, AND THAT IS A CONSEQUENCE OF ADR-032
 * `packages/core/src/ports/storage.ts` motivates its single `transaction` entry point
 * with "a checkpoint writes clock + agenda status + cast state", i.e. it describes a
 * checkpoint as a MULTI-COLLECTION write. That sentence predates ADR-032, which gave
 * the live state its persistence slot: `Session.state` is now ONE field holding the
 * scene, BOTH clocks, `vars`, `sheets` and `deadlines`, and `CheckpointSchema.state`
 * is that very type. So a save point is `{state, messageId, castState, agendaStatus,
 * summary}` in one `checkpoints` row, and reading a save back is one `get`.
 *
 * The port's comment is still TRUE of the port — `transaction` remains the only entry
 * point, and a compound write (an import, a migration) still needs it — so it is NOT
 * edited here. What has changed is only which write this feature happens to perform:
 * one row, one `put`, in one transaction. Recorded rather than silently rewritten
 * because a future reader who trusts that example would look for a second collection
 * that no longer participates.
 *
 * WHY `state` IS WRITTEN AS A COPY
 * `createCheckpoint` snapshots the session's OWN `state` value, and objects are
 * references: a checkpoint that aliased the live state would silently follow every
 * later clock advance and stop being "then" at all. `savedState`/`copyState` below
 * are what make the stored value an independent snapshot, and the repository test
 * asserts BOTH directions of that (mutating the live value must not move the save,
 * and mutating a read-back save must not move the live value).
 */
export type CheckpointRow = Checkpoint & RowBase;

function checkpointsOf(tx: Tx): Collection<CheckpointRow> {
  return tx.collection<CheckpointRow>(COLLECTIONS.checkpoints);
}

/*
 * The card libraries' collections (M1-W1 / M1-C1). Both kinds are a head row plus immutable
 * version rows (`docs/02` §7), so these four helpers are the only places those names appear.
 */
function worldsOf(tx: Tx): Collection<World> {
  return tx.collection<World>(COLLECTIONS.worlds);
}

function worldVersionsOf(tx: Tx): Collection<WorldVersion> {
  return tx.collection<WorldVersion>(COLLECTIONS.worldVersions);
}

function charactersOf(tx: Tx): Collection<Character> {
  return tx.collection<Character>(COLLECTIONS.characters);
}

function characterVersionsOf(tx: Tx): Collection<CharacterVersion> {
  return tx.collection<CharacterVersion>(COLLECTIONS.characterVersions);
}

/*
 * THE STATE COPY MOVED; THE RULE DID NOT (M1-M2)
 * `copyState` / `copyCast` / `copySheets` used to be declared here. They now live in
 * `../session/state-copy.ts`, and the reason is the fork: a new timeline starts from a COPY of
 * the save point it came from (`session/fork.ts`), and a pure module must not import the
 * database layer to reach one function. One rule, one home — every snapshot in this file
 * (`createCheckpoint`, `restoreCheckpoint`) imports it from there, and so does the fork.
 */

/**
 * Everything a save point captures, read from the session row — the "one instant".
 *
 * WHY THIS READS THE SESSION INSIDE THE CALLER'S TRANSACTION
 * A save is TWO facts that must have coexisted: the live state (clock, vars, scene)
 * and `headMessageId` (how far the transcript had got). Reading them in two separate
 * reads — or reading the clock now and the head after an await — can record a pair
 * that never was: the clock of a turn whose messages are not in the chain, or a
 * transcript tip from after an advance the state does not contain. Restoring such a
 * pair is a rollback to a moment that never existed, which is exactly the class of bug
 * docs/02 §5.7's "读档即回滚时钟" is meant to make inexpressible. So both are read in
 * ONE `getSession`-equivalent `get` inside ONE transaction, and the row is completed
 * through `completeState` for the same reason every other reader does it (ADR-032):
 * a save taken on a pre-`state` row must not be the operation that fails.
 */
function snapshotOf(
  row: Record<string, unknown> | undefined,
): { state: SessionState; headMessageId: Id | null } | undefined {
  if (row === undefined) return undefined;
  const session = SessionSchema.parse({ ...row, state: completeState(row) });
  return { state: copyState(session.state), headMessageId: session.headMessageId };
}

/**
 * Save the current instant under a label.
 *
 * The label is the CALLER's decision for the reason `createSession`'s title is: a
 * default like "save point" is PERSISTED copy and must be written in the language that
 * was active when the user pressed the button, and this module must not import the i18n
 * layer (ADR-030's addendum). `label` is required by `CheckpointSchema`, so the caller
 * supplies a real sentence.
 *
 * `castState` is an argument rather than something this function derives, and since M1-S4
 * the caller HAS a live value to pass: `Session.state.cast` is the live cast state
 * (ADR-032), and `session/cast.ts`'s `checkpointCastOf` copies it for exactly this
 * argument — so a save point records the intervention that was in force when it was
 * taken. It stays an ARGUMENT rather than being read from the session here because the
 * snapshot must be a COPY of the live record, and a repository that copied it while
 * reading the row would be doing the app layer's job: the default is the empty map,
 * which is the honest "nothing recorded" value for the callers that have no cast (a
 * test, or a session whose roster is empty).
 *
 * `agendaStatus` and `summary` are the two fields docs/04 §6's payload lists that no
 * engine writes yet (the agenda state machine and rolling summaries are later
 * milestones). They are written as their empty values rather than omitted, so the stored
 * row is a complete `Checkpoint` from the first save on and a later writer fills them in.
 *
 * Returns the STORED row (id and `createdAt` included) so a caller does not have to
 * re-read the list to show what it just saved. Returns `undefined` when the session id is
 * unknown — the same silent no-op `writeSessionState` and `setHeadMessageId` perform,
 * and the honest answer for "there is nothing to snapshot".
 *
 * A SAVE POINT BEFORE THE FIRST MESSAGE IS A SAVE POINT (the nullable `messageId`)
 * `CheckpointSchema.messageId` is `IdSchema.nullable()`, mirroring `Session.headMessageId`
 * (ADR-032): a session begins with no messages, and "let me put a save point at minute
 * zero" is an ordinary act — the state (clock, scene, vars) is already worth snapshotting
 * even when the transcript is empty. So the snapshot's null head is stored as `null`
 * rather than refused, and restoring it moves the head back to `null` (an empty chain),
 * which is the position the checkpoint names. It was a non-empty `Id` for one milestone
 * and could not express that act at all; `''` was never an alternative — `IdSchema`
 * refuses it, and a reader would then have two spellings of "no message".
 */
export async function createCheckpoint(input: {
  sessionId: Id;
  label: string;
  castState?: Checkpoint['castState'];
}): Promise<CheckpointRow | undefined> {
  return write(async (tx) => {
    const row = await sessionsOf(tx).get(input.sessionId);
    const snapshot = snapshotOf(row === undefined ? undefined : { ...row });
    if (snapshot === undefined) return undefined;
    const stored: CheckpointRow = {
      id: mintUuidV7(),
      sessionId: input.sessionId,
      label: input.label,
      messageId: snapshot.headMessageId,
      auto: false,
      state: snapshot.state,
      agendaStatus: [],
      summary: '',
      castState: { ...(input.castState ?? {}) },
      createdAt: Date.now(),
    };
    // Parsed BEFORE the put, like `appendMessage`: the persisted shape is then the
    // schema's shape (ADR-016) instead of "whatever this function happened to build".
    await checkpointsOf(tx).put(CheckpointSchema.parse(stored) as CheckpointRow);
    return stored;
  });
}

/**
 * A session's save points, NEWEST FIRST.
 *
 * `sessions`/`messages` have `readTable` helpers because a `liveQuery` watches them;
 * nothing subscribes to checkpoints yet, so this is a plain read. It goes through the
 * port's own collection (`tx.collection(...).list`) rather than Dexie directly, which
 * keeps "which index answers this" next to the port's index table — the compound
 * `(sessionId, createdAt)` index is what makes it a range scan instead of a table scan.
 */
export async function listCheckpoints(sessionId: Id): Promise<CheckpointRow[]> {
  return write(async (tx) =>
    checkpointsOf(tx).list(
      {
        where: { sessionId },
        field: 'createdAt',
        order: 'desc',
      },
      'checkpoints_sessionId_createdAt',
    ),
  );
}

/** One save point by id, or `undefined` when it was deleted (or never existed). */
export async function getCheckpoint(checkpointId: Id): Promise<CheckpointRow | undefined> {
  const row = await readTable<Record<string, unknown>>(COLLECTIONS.checkpoints).get(checkpointId);
  if (row === undefined) return undefined;
  // Parsed on the way in for the reason every other reader parses: the row is
  // structurally indistinguishable from an unvalidated object, and parsing strips
  // unknown fields exactly as HANDOFF §4.1 invariant 5 requires.
  return CheckpointSchema.parse(row) as CheckpointRow;
}

/**
 * Remove one save point. Idempotent — `Collection.remove` documents that — so a
 * double-click on 「删除」 is not an error.
 */
export async function deleteCheckpoint(checkpointId: Id): Promise<void> {
  await write(async (tx) => {
    await checkpointsOf(tx).remove(checkpointId);
  });
}

/**
 * Roll the session back to a save point.
 *
 * WHAT A ROLLBACK IS: TWO WRITES IN ONE TRANSACTION.
 * 1. `Session.state` becomes the checkpoint's `state` — the clock, the scene, `vars`,
 *    the cast, the sheets and the deadlines all move back TOGETHER, which is the
 *    acceptance sentence for M1-T4 ("读档后时钟与状态一致回滚"). Doing it field by field
 *    was the bug ADR-032 makes inexpressible: a checkpoint holds ONE state value, so
 *    there is no way to restore "the clock from the save and the vars from now".
 * 2. `headMessageId` moves to the checkpoint's message position.
 *
 * THE CAST MOVES WITH IT (M1-S4), AND THAT IS WHY IT LIVES IN `state`
 * `Session.state.cast` is a field of the value this function assigns, so a rollback
 * restores the mutes and the presences that were in force at the save point. Nothing
 * extra is written for it: the field travels because it is part of ONE state value.
 * The checkpoint's OWN `castState` is not read here — it is the snapshot
 * `createCheckpoint` took from that same live record (`session/cast.ts`'s
 * `checkpointCastOf`), i.e. a self-contained copy for a reader of the ROW, while the
 * value this function restores is the state the row also holds. Two moments of one
 * fact, and the restore takes the LIVE one.
 *
 * MESSAGES ARE NEVER TOUCHED (ADR-010). A rollback is a POINTER MOVE, not a delete:
 * the rows after the save point stay exactly where they are, the branch that was live
 * a moment ago is still a sibling of the restored one, and re-loading the save — or
 * taking the other branch again — is therefore possible. Deleting them would make the
 * rollback irreversible, which is the opposite of what a save point is for.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: the world / character / preset pins
 * (`Session.refs`). A save point is a position in a scene, not a different build of the
 * content: a card edited or a preset swapped after the save is a CHANGE THE USER MADE
 * to the session, and silently reverting it would discard work the checkpoint never
 * recorded. The pins are pinned per session (ADR-010), so they cannot drift under a
 * rollback anyway — which is the fact that makes this a decision rather than an
 * omission.
 *
 * The row is completed through `completeState` on the way in for the same reason every
 * other writer does it, and the checkpoint is parsed on the way out so a malformed row
 * is refused instead of half-applied.
 *
 * The message position is `Id | null` on BOTH sides now (`CheckpointSchema.messageId` and
 * `Session.headMessageId`), so nothing here maps an empty string back to `null` and
 * nothing refuses a save point taken before the first message: a rollback to "no
 * messages" is the empty chain the head already expresses.
 */
export async function restoreCheckpoint(
  checkpointId: Id,
): Promise<{ sessionId: Id; headMessageId: Id | null } | undefined> {
  const checkpoint = await getCheckpoint(checkpointId);
  if (checkpoint === undefined) return undefined;
  const restoredState = copyState(checkpoint.state);
  const headMessageId: Id | null = checkpoint.messageId;
  await write(async (tx) => {
    const row = await sessionsOf(tx).get(checkpoint.sessionId);
    if (row === undefined) return;
    const session = SessionSchema.parse({ ...row, state: completeState(row) });
    await sessionsOf(tx).put({
      ...session,
      state: restoredState,
      headMessageId,
      updatedAt: Date.now(),
    });
  });
  return { sessionId: checkpoint.sessionId, headMessageId };
}

/* ──────────────────────────────── forking ────────────────────────────────── */

/**
 * Create a NEW session that continues `input.sessionId` from a save point (or from right now),
 * and leave the session it came from completely untouched (M1-M2).
 *
 * WHAT THIS FUNCTION OWNS, AND WHAT `session/fork.ts` OWNS
 * `session/fork.ts`'s `planFork` decides what travels, mints the new ids and rewrites every
 * internal reference. What it cannot do is what this function does: read the origin's rows and
 * write the copies in ONE transaction, so the session row, the chain and the save points the
 * fork is planned from are one instant rather than four reads that a concurrent write could land
 * between. Nothing here mutates an origin row - the fork writes NEW rows and nothing else, which
 * is exactly the acceptance's 原时间线不受影响.
 *
 * WHY THE ORIGIN IS RE-READ INSIDE THE TRANSACTION
 * The caller holds a `Session` for the screen, and it can be a turn behind (a head the last turn
 * moved, a table another tab wrote). The fork point must be resolved against the rows as this
 * transaction sees them, and the anchor's message must be the tip of the chain built from the
 * same rows - the two facts `planFork` re-checks. A fork planned from a stale pair would store a
 * session whose `headMessageId` is not the end of its own transcript.
 *
 * WHY `undefined` AND NOT A THROW FOR A MISSING ROW
 * A save point that was deleted, a save point of ANOTHER session, or an origin that no longer
 * exists are all "there is no fork to make here" - the same silent no-op `writeSessionState`,
 * `setHeadMessageId` and `createCheckpoint` answer with. The title is the one input the schema
 * can refuse (empty, or over its ceiling), and that refusal is a throw from the `parse` below,
 * which rolls the whole transaction back rather than storing a session the schema rejects
 * (`appendMessage` and `createSession` fail the same way on a payload they cannot parse).
 *
 * The message rows and the save points are written with `putMany`: a fork is one act, and the
 * port's bulk write is what the import path already uses for the same shape of work.
 */
export async function forkSession(input: {
  sessionId: Id;
  forkPoint: ForkPoint;
  /**
   * The new session's title. The CALLER chooses it, for the reason `createSession`'s title
   * records: it is PERSISTED copy, written in the language that was active at the fork, and this
   * module must not import the i18n layer (ADR-030's addendum).
   */
  title: string;
}): Promise<Session | undefined> {
  return write(async (tx) => {
    const row = await sessionsOf(tx).get(input.sessionId);
    if (row === undefined) return undefined;
    const origin = SessionSchema.parse({ ...row, state: completeState(row) });
    const anchor = await forkAnchorOf(tx, origin, input.forkPoint);
    if (anchor === undefined) return undefined;

    const messages = messagesOf(tx);
    const chain = await walkChain(anchor.messageId, (messageId) => messages.get(messageId));
    // Every save point of the origin, and `planFork` keeps the ones this fork can answer: a
    // checkpoint whose message did not travel has no position in the new timeline.
    const checkpoints = await checkpointsOf(tx).list(
      { where: { sessionId: origin.id } },
      'checkpoints_sessionId_createdAt',
    );

    const plan = planFork({
      origin,
      anchor,
      chain,
      checkpoints,
      title: input.title,
      at: Date.now(),
      mintId: mintUuidV7,
    });
    if (plan === undefined) return undefined;

    const session = SessionSchema.parse(plan.session);
    await sessionsOf(tx).put(session);
    if (plan.messages.length > 0) {
      await messagesOf(tx).putMany(plan.messages.map((message) => MessageSchema.parse(message)));
    }
    if (plan.checkpoints.length > 0) {
      await checkpointsOf(tx).putMany(
        plan.checkpoints.map((checkpoint) => CheckpointSchema.parse(checkpoint) as CheckpointRow),
      );
    }
    return session;
  });
}

/**
 * Resolve a `ForkPoint` to the facts `planFork` needs, inside the caller's transaction.
 *
 * A live-position fork takes the session's own `state` and `headMessageId` - the same pair a save
 * point taken at this instant would snapshot, which is why it needs no row of its own.
 *
 * A save-point fork takes the checkpoint's `state` and `messageId`, and REFUSES a checkpoint that
 * belongs to another session: its `messageId` is a position in a different transcript, so copying
 * this session's chain "up to" it would produce a head that resolves nowhere (`state/chat-store
 * .ts`'s `restoreCheckpoint` refuses the same cross-session case for the same reason).
 */
async function forkAnchorOf(
  tx: Tx,
  origin: Session,
  point: ForkPoint,
): Promise<ForkAnchor | undefined> {
  if (point.kind === 'head') {
    return { messageId: origin.headMessageId, state: origin.state };
  }
  const row = await checkpointsOf(tx).get(point.checkpointId);
  if (row === undefined) return undefined;
  const checkpoint = CheckpointSchema.parse(row);
  if (checkpoint.sessionId !== origin.id) return undefined;
  return { messageId: checkpoint.messageId, state: checkpoint.state, checkpointId: checkpoint.id };
}

/* ──────────────────────────────── turn plans ─────────────────────────────── */

/**
 * One stored turn plan (M1-S5; docs/02 §7's `turnPlans`, ADR-011).
 *
 * WHY THE PLAN IS STORED AT ALL, AND WHY IT IS ONE `put`
 * The milestone's acceptance says the TurnPlan 落库, and the schema already says what the row
 * is FOR: `MessageMeta.turnPlanId` ("the local plan that decided who spoke"), plus the
 * `excluded` list that docs/06 §2.5's M1-S5 row and `packages/schema`'s `turn.ts` both call
 * the explanation of a silence. It is ONE row in ONE transaction, like a save point: the
 * entries and the exclusions are one decision, and a reader must never see half of it.
 *
 * WHY `TurnPlanDraft` COMES FROM `session/scheduler.ts`
 * The id and the timestamp are minted HERE, exactly as `appendMessage` and `createCheckpoint`
 * mint theirs, so there is one minter for this collection. Everything else is the rule's
 * output, and `session/scheduler.ts` owns it (`planDraftOf` is where the structured reasons
 * become the row's locale-free fact strings) — this module only persists what it is handed.
 */
export type TurnPlanRow = TurnPlan & RowBase;

function turnPlansOf(tx: Tx): Collection<TurnPlanRow> {
  return tx.collection<TurnPlanRow>(COLLECTIONS.turnPlans);
}

/**
 * Store one round's decision and hand back the row that was written.
 *
 * The row is parsed BEFORE the put, like every other writer here (ADR-016), so a draft the
 * schema refuses is a thrown error at the write rather than a row no reader can parse. The
 * entry and exclusion objects are copied first: the caller's schedule is a value the SCREEN
 * is still rendering, and a stored row aliasing it would move under the user (`copyState`
 * exists in this file for the same reason).
 */
export async function writeTurnPlan(draft: TurnPlanDraft): Promise<TurnPlanRow> {
  const stored: TurnPlanRow = {
    ...draft,
    entries: draft.entries.map((entry) => ({ ...entry, reasons: [...entry.reasons] })),
    excluded: draft.excluded.map((entry) => ({ ...entry })),
    id: mintUuidV7(),
    createdAt: Date.now(),
  };
  const parsed = TurnPlanSchema.parse(stored) as TurnPlanRow;
  await write(async (tx) => {
    await turnPlansOf(tx).put(parsed);
  });
  return parsed;
}

/**
 * A session's plans for one round, oldest round first.
 *
 * The `(sessionId, round)` index is what docs/02 §7 gives this collection, so the query names
 * both fields. Plans accumulate (one per decision), which is deliberate: the index is
 * non-unique, and "what did the scheduler decide before the user stepped in" is a question
 * that only an accumulating row can answer.
 */
export async function listTurnPlans(sessionId: Id): Promise<TurnPlanRow[]> {
  return write(async (tx) =>
    turnPlansOf(tx).list(
      { where: { sessionId }, field: 'round', order: 'asc' },
      'turnPlans_sessionId_round',
    ),
  );
}

/* ─────────────────────────────── live queries ────────────────────────────── */

/**
 * `liveQuery` payload for the transcript.
 *
 * Exported as a READ rather than as a subscription because the subscription itself
 * lives in `db/database.ts` (`subscribe`): one module owns the Dexie instance and
 * the other owns what to read, and neither has to know both.
 */
export async function readChain(sessionId: Id): Promise<Message[]> {
  return getChain(sessionId);
}

/** `liveQuery` payload for the home view: every session, newest first. */
export async function readSessions(): Promise<Session[]> {
  return listSessions();
}

/* ──────────────── the card libraries: worlds and characters ─────────────── */

/**
 * Worlds and characters — the rows M1-W1 / M1-C1 edit, and the DRAFT rows their autosave writes.
 *
 * THE THREE READS AND THE THREE WRITES ARE NOT SYMMETRIC, AND THAT IS ADR-010
 * - `list*` and `get*` read the HEAD rows, which are a mutable index: name, `headVersion`, tags.
 * - `latest*Version` reads the newest IMMUTABLE payload, which is what an editor opens with.
 * - `create*` writes a head AND version 1 in ONE transaction; `publish*` writes a new version and
 *   moves the head, and does BOTH inside the transaction that read the head — so the version
 *   number cannot be minted from a stale copy (two writers would collide on the `(worldId,
 *   version)` unique index rather than quietly overwrite each other's history).
 * - The DRAFT is not a version and is not in either of the two versioned collections: it is one
 *   `settings` row per card (`cards/draft.ts` records why), and `publish*` deletes it in the same
 *   transaction that writes the version — "the draft became a version" is one atomic fact.
 *
 * WHY THE HEAD IS RE-READ INSIDE THE TRANSACTION AND THE PAYLOAD IS NOT TRUSTED
 * `planWorldVersion` is handed the head row as this transaction sees it, which is what makes the
 * new version number monotonic over the PERSISTED value. The incoming payload is parsed with the
 * entity schema first (`safeParse`, so a refusal is a return value rather than a thrown error
 * inside a transaction) — the same "parse on the way in" rule every other writer here follows
 * (ADR-016), applied as a gate because the editor has already shown the user what is wrong.
 */

/** One `worlds` row by id. */
export async function getWorld(worldId: Id): Promise<World | undefined> {
  const row = await readTable<Record<string, unknown>>(COLLECTIONS.worlds).get(worldId);
  return row === undefined ? undefined : WorldSchema.parse(row);
}

/**
 * Every world, by name.
 *
 * WHY THIS IS A `readTable` SCAN AND NOT A PORT QUERY: `worlds_name` indexes one field, but this
 * is the library's whole list — there is nothing to narrow it by — and `listSessions` above reads
 * the same way for the same reason. Ordering by the indexed field is what the index exists for,
 * and it happens in the storage engine.
 */
export async function listWorlds(): Promise<World[]> {
  const rows = await readTable<World>(COLLECTIONS.worlds).orderBy('name').toArray();
  return rows.map((row) => WorldSchema.parse(row));
}

/** One immutable version of one world, or `undefined` when it was never written. */
export async function getWorldVersion(
  worldId: Id,
  version: VersionNumber,
): Promise<WorldVersion | undefined> {
  return write(async (tx) => {
    const rows = await worldVersionsOf(tx).list(
      { where: { worldId, version } },
      'worldVersions_worldId_version',
    );
    const row = rows[0];
    return row === undefined ? undefined : WorldVersionSchema.parse(row);
  });
}

/**
 * The newest version of a world — what an editor opens with.
 *
 * WHY THE WHOLE TABLE IS SCANNED AND FILTERED IN MEMORY: the `(worldId, version)` index is
 * COMPOUND, and this adapter only uses one when every field it covers is constrained
 * (`packages/storage`'s adapter says so; `listChildren` above reaches the same conclusion). A
 * query that named only `worldId` would fall back to a table scan anyway, so the scan is written
 * where a reader can see it — and version rows are counted in tens, not millions.
 *
 * It is `listWorldVersions`'s first answer rather than a second scan of its own, so the two
 * reads cannot disagree about what "newest" means.
 */
export async function latestWorldVersion(worldId: Id): Promise<WorldVersion | undefined> {
  return (await listWorldVersions(worldId))[0];
}

/**
 * Every version of a world, NEWEST FIRST — what the create-session flow chooses among (M1-S1).
 *
 * WHY A LIST AND NOT ONLY `latestWorldVersion`: docs/06 §2.5's first step is 「选世界版本」, and a
 * flow that silently pinned the latest whatever the user picked would not be that step. The
 * ordering is by `version` (the monotonic counter, `cards/versions.ts`), not by `createdAt`: two
 * versions published in the same millisecond still have one order, and it is the one the
 * `(worldId, version)` index is built on.
 */
export async function listWorldVersions(worldId: Id): Promise<WorldVersion[]> {
  const rows = await readTable<WorldVersion>(COLLECTIONS.worldVersions).toArray();
  return rows
    .filter((row) => row.worldId === worldId)
    .map((row) => WorldVersionSchema.parse(row))
    .sort((left, right) => right.version - left.version);
}

/** The `settings` key a world's draft row lives under (see `cards/draft.ts`). */
export function worldDraftId(worldId: Id): string {
  return `draft.world.${worldId}`;
}

/**
 * A world's stored draft, completed against the version the editor opened with.
 *
 * `undefined` means "there is no draft" — which is also what a row nobody can read degrades to,
 * so the editor falls back to the published payload instead of failing (`readLocaleSetting` above
 * applies the same rule to a corrupt locale).
 */
export async function readWorldDraft(
  worldId: Id,
  base: WorldVersion,
): Promise<WorldDraft | undefined> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    worldDraftId(worldId),
  );
  return row === undefined ? undefined : readWorldDraftValue(row.value, base);
}

/** Store a world draft. One `settings` row, one transaction, written as given. */
export async function writeWorldDraft(worldId: Id, draft: WorldDraft): Promise<void> {
  await write(async (tx) => {
    await settingsOf(tx).put({ id: worldDraftId(worldId), value: worldDraftValue(draft) });
  });
}

/** Drop a world draft, so the next open shows the published version again. */
export async function clearWorldDraft(worldId: Id): Promise<void> {
  await write(async (tx) => {
    await settingsOf(tx).remove(worldDraftId(worldId));
  });
}

/**
 * Create a world: a head row and version 1, in ONE transaction.
 *
 * The caller supplies the whole blank payload (`cards/world.ts`'s `blankWorldData`) rather than a
 * name this module would have to turn into content: what a new world contains is the editor's
 * decision, and a storage module that invented a calendar would be a second owner of that data
 * (`createSession`'s title makes the same split for the same reason).
 *
 * A payload the schema refuses is a REFUSAL (`undefined`), not a thrown error: the caller is a
 * click on 「新建」, and an exception inside a transaction is a rejection at the UI with nothing to
 * show. The editor validates first; this is the backstop.
 */
export async function createWorld(input: {
  name: string;
  data: WorldData;
  extensions?: Extensions;
}): Promise<{ world: World; version: WorldVersion } | undefined> {
  const parsed = WorldDataSchema.safeParse(input.data);
  if (!parsed.success) return undefined;
  return write(async (tx) => {
    const at = Date.now();
    // `headVersion: 0` is the "no version yet" head the planner turns into version 1 — the same
    // code path an iteration takes, which is what keeps a first version from forgetting the head.
    const head: World = {
      id: mintUuidV7(),
      name: input.name,
      headVersion: 0,
      tags: [...parsed.data.genre],
      createdAt: at,
      updatedAt: at,
    };
    const plan = planWorldVersion({
      head,
      base: undefined,
      data: parsed.data,
      extensions: input.extensions,
      id: mintUuidV7(),
      at,
    });
    const world = WorldSchema.parse(plan.world);
    const version = WorldVersionSchema.parse(plan.version);
    await worldsOf(tx).put(world);
    await worldVersionsOf(tx).put(version);
    return { world, version };
  });
}

/**
 * Publish a draft as a new world version.
 *
 * THE TRANSACTION IS THE RULE: the head is read HERE, so `version` is `head.headVersion + 1` as
 * the database has it, and the anchor the draft names is resolved HERE too — a version row cannot
 * disappear (versions are immutable and never deleted), so the lineage is exact even when another
 * tab published while this editor was open.
 *
 * WHAT IT WRITES: the new version row, the head row that points at it, and the removal of the
 * draft. All three in one transaction, so there is no instant in which a version exists whose
 * draft also does or a head points at a row that is not there.
 *
 * WHAT IT DOES NOT DO: it never touches an existing version row, and it never deletes one. The
 * `(worldId, version)` unique index is the last guard against a duplicated version number.
 */
export async function publishWorld(input: {
  worldId: Id;
  data: WorldData;
  extensions?: Extensions;
  /** The version the draft was edited from (`cards/draft.ts`'s `baseVersion`). */
  baseVersion: VersionNumber;
  /** The lineage sentence, in the language active at the save. */
  reason: string;
}): Promise<{ world: World; version: WorldVersion } | undefined> {
  const parsed = WorldDataSchema.safeParse(input.data);
  if (!parsed.success) return undefined;
  return write(async (tx) => {
    const row = await worldsOf(tx).get(input.worldId);
    if (row === undefined) return undefined;
    const head = WorldSchema.parse(row);
    const anchor = await findWorldVersion(tx, input.worldId, input.baseVersion);
    const plan = planWorldVersion({
      head,
      base: anchor === undefined ? undefined : { anchor, reason: input.reason },
      data: parsed.data,
      extensions: input.extensions,
      id: mintUuidV7(),
      at: Date.now(),
    });
    const world = WorldSchema.parse(plan.world);
    const version = WorldVersionSchema.parse(plan.version);
    await worldVersionsOf(tx).put(version);
    await worldsOf(tx).put(world);
    await settingsOf(tx).remove(worldDraftId(input.worldId));
    return { world, version };
  });
}

/** One `characterVersions` row by number: the lineage anchor, resolved inside a transaction. */
async function findWorldVersion(
  tx: Tx,
  worldId: Id,
  version: VersionNumber,
): Promise<VersionAnchor | undefined> {
  const rows = await worldVersionsOf(tx).list(
    { where: { worldId, version } },
    'worldVersions_worldId_version',
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, version: row.version };
}

/* ──────────────────────────────── characters ─────────────────────────────── */

/** One `characters` row by id. */
export async function getCharacter(characterId: Id): Promise<Character | undefined> {
  const row = await readTable<Record<string, unknown>>(COLLECTIONS.characters).get(characterId);
  return row === undefined ? undefined : CharacterSchema.parse(row);
}

/** Every character card, by name (see `listWorlds` for why this is a table read). */
export async function listCharacters(): Promise<Character[]> {
  const rows = await readTable<Character>(COLLECTIONS.characters).orderBy('name').toArray();
  return rows.map((row) => CharacterSchema.parse(row));
}

/** One immutable version of one card. */
export async function getCharacterVersion(
  characterId: Id,
  version: VersionNumber,
): Promise<CharacterVersion | undefined> {
  return write(async (tx) => {
    const rows = await characterVersionsOf(tx).list(
      { where: { characterId, version } },
      'characterVersions_characterId_version',
    );
    const row = rows[0];
    return row === undefined ? undefined : CharacterVersionSchema.parse(row);
  });
}

/** The newest version of a card — what the editor opens with. See `latestWorldVersion`. */
export async function latestCharacterVersion(
  characterId: Id,
): Promise<CharacterVersion | undefined> {
  const rows = await readTable<CharacterVersion>(COLLECTIONS.characterVersions).toArray();
  const mine = rows
    .filter((row) => row.characterId === characterId)
    .map((row) => CharacterVersionSchema.parse(row))
    .sort((left, right) => right.version - left.version);
  return mine[0];
}

/** The `settings` key a card's draft row lives under. */
export function characterDraftId(characterId: Id): string {
  return `draft.character.${characterId}`;
}

/** A card's stored draft, completed against the opened version (`readWorldDraft`). */
export async function readCharacterDraft(
  characterId: Id,
  base: CharacterVersion,
): Promise<CharacterDraft | undefined> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    characterDraftId(characterId),
  );
  return row === undefined ? undefined : readCharacterDraftValue(row.value, base);
}

/** Store a card draft. */
export async function writeCharacterDraft(characterId: Id, draft: CharacterDraft): Promise<void> {
  await write(async (tx) => {
    await settingsOf(tx).put({
      id: characterDraftId(characterId),
      value: characterDraftValue(draft),
    });
  });
}

/** Drop a card draft. */
export async function clearCharacterDraft(characterId: Id): Promise<void> {
  await write(async (tx) => {
    await settingsOf(tx).remove(characterDraftId(characterId));
  });
}

/** Create a character card: a head row and version 1, in one transaction (`createWorld`). */
export async function createCharacter(input: {
  name: string;
  data: CharacterData;
  extensions?: Extensions;
}): Promise<{ character: Character; version: CharacterVersion } | undefined> {
  const parsed = CharacterDataSchema.safeParse(input.data);
  if (!parsed.success) return undefined;
  return write(async (tx) => {
    const at = Date.now();
    const head: Character = {
      id: mintUuidV7(),
      name: input.name,
      headVersion: 0,
      tags: [...parsed.data.tags],
      createdAt: at,
      updatedAt: at,
    };
    const plan = planCharacterVersion({
      head,
      base: undefined,
      data: parsed.data,
      extensions: input.extensions,
      id: mintUuidV7(),
      at,
    });
    const character = CharacterSchema.parse(plan.character);
    const version = CharacterVersionSchema.parse(plan.version);
    await charactersOf(tx).put(character);
    await characterVersionsOf(tx).put(version);
    return { character, version };
  });
}

/** Publish a card draft as a new version (`publishWorld`, including the same transaction rules). */
export async function publishCharacter(input: {
  characterId: Id;
  data: CharacterData;
  extensions?: Extensions;
  baseVersion: VersionNumber;
  reason: string;
}): Promise<{ character: Character; version: CharacterVersion } | undefined> {
  const parsed = CharacterDataSchema.safeParse(input.data);
  if (!parsed.success) return undefined;
  return write(async (tx) => {
    const row = await charactersOf(tx).get(input.characterId);
    if (row === undefined) return undefined;
    const head = CharacterSchema.parse(row);
    const anchor = await findCharacterVersion(tx, input.characterId, input.baseVersion);
    const plan = planCharacterVersion({
      head,
      base: anchor === undefined ? undefined : { anchor, reason: input.reason },
      data: parsed.data,
      extensions: input.extensions,
      id: mintUuidV7(),
      at: Date.now(),
    });
    const character = CharacterSchema.parse(plan.character);
    const version = CharacterVersionSchema.parse(plan.version);
    await characterVersionsOf(tx).put(version);
    await charactersOf(tx).put(character);
    await settingsOf(tx).remove(characterDraftId(input.characterId));
    return { character, version };
  });
}

/** One `characterVersions` row's anchor, resolved inside the publishing transaction. */
async function findCharacterVersion(
  tx: Tx,
  characterId: Id,
  version: VersionNumber,
): Promise<VersionAnchor | undefined> {
  const rows = await characterVersionsOf(tx).list(
    { where: { characterId, version } },
    'characterVersions_characterId_version',
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, version: row.version };
}
