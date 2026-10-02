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
 * WHAT M1-G3 CHANGED ABOUT THAT ROW, AND WHAT IT DID NOT
 * The row's `apiKey` field now holds either the legacy plaintext STRING or an
 * encrypted envelope (`secrets/secret-crypto.ts`), and this module parses that
 * difference the same way it parses every other field: at the boundary, into a
 * discriminated `StoredProviderSecret`. It does NOT encrypt or derive anything
 * itself — it stores what it is given and reports what it finds, which is what keeps
 * "the row is the only copy" (a claim about STORAGE) separable from "the copy is
 * sealed" (a claim about CRYPTO). `secrets/provider-secret.ts` owns the second claim
 * and is the only caller that ever builds an `encrypted` value.
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
import type { TurnPlanDraft } from '../session/scheduler';
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
 */
export const PROVIDER_SETTINGS_ID = 'provider';

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
 * The browser's preferred BCP-47 tags, or `[]` when it has none.
 *
 * `navigator.languages` is read through a parameterised key because this workspace
 * compiles with `noPropertyAccessFromIndexSignature` (which rejects dot access on the
 * `Navigator` index signature) while Biome's `useLiteralKeys` rejects the literal
 * bracket form — the same parameterised-key spelling `stringField` above uses.
 */

/* ────────────────────────────── settings I/O ─────────────────────────────── */

/** Read the stored provider configuration; a first run answers empty strings. */
export async function readProviderSettings(): Promise<ProviderSettings> {
  const row = await readTable<SettingsRow & RowBase>(COLLECTIONS.settings).get(
    PROVIDER_SETTINGS_ID,
  );
  return toProviderSettings(row?.value);
}

/**
 * Store the provider configuration — the WHOLE row, key slot included, in ONE write.
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
 */
export async function writeProviderSettings(settings: ProviderSettings): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = {
      id: PROVIDER_SETTINGS_ID,
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
        provider: PLACEHOLDER_PROVIDER,
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
 * Walk `parentId` from `session.headMessageId` up to a root and return the path in
 * chronological order, or `[]` when the session has no head yet.
 *
 * Termination: `CHAIN_LIMIT` bounds how far a corrupted row can drag the walk, and
 * a `visited` set catches a cycle at the first repetition instead of after the
 * bound. Both are needed — the bound alone would still return a plausible-looking
 * duplicate chain.
 */
export async function getChain(sessionId: Id): Promise<Message[]> {
  const session = await getSession(sessionId);
  if (session === undefined || session.headMessageId === null) return [];
  const messages = readTable<Message>(COLLECTIONS.messages);
  const reversed: Message[] = [];
  const visited = new Set<Id>();
  let cursor: Id | null = session.headMessageId;

  for (let step = 0; cursor !== null && step < CHAIN_LIMIT; step += 1) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const row = await messages.get(cursor);
    if (row === undefined) break;
    const message = MessageSchema.parse(row);
    reversed.push(message);
    cursor = message.parentId;
  }

  return reversed.reverse();
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

/**
 * A DEEP-ENOUGH COPY OF A SESSION STATE — the one place the snapshot's independence is
 * created.
 *
 * WHY NOT `structuredClone`: it exists in every browser this app targets, but it is a
 * global that `biome.json` bans for `packages/core` and that this workspace has not
 * adopted elsewhere; the state's shape is fixed by `SessionStateSchema` (a scene
 * object, the clock, the cast, four flat records, one array of flat objects), so an
 * explicit copy is shorter than the argument for the global and cannot throw on a
 * value the schema already forbids. A field-by-field copy also states, in code,
 * exactly which parts are shared by reference when they are not copied — `sheets`'
 * values are `unknown` to core, so they are the one place a nested mutation could
 * still be observed; that is called out at `copySheets` rather than hidden.
 *
 * `cast` IS COPIED ENTRY BY ENTRY (M1-S4): a save point's `castState` is taken from the
 * live record, and a copy that shared it would follow every later mute — the same
 * "then must not move" rule the whole function exists for, applied to the field the
 * user edits most often. The ENTRIES are copied one level deep: an entry's fields are
 * all primitives by schema, so there is nothing below them to share.
 */
function copyState(state: SessionState): SessionState {
  return {
    scene: { ...state.scene },
    clock: state.clock,
    ...(state.innerClock === undefined ? {} : { innerClock: { ...state.innerClock } }),
    cast: copyCast(state.cast),
    vars: { ...state.vars },
    sheets: copySheets(state.sheets),
    deadlines: state.deadlines.map((deadline) => ({ ...deadline })),
  };
}

/** One new entry per cast member; see `copyState` for why this is a copy at all. */
function copyCast(cast: SessionState['cast']): SessionState['cast'] {
  const copy: NonNullable<SessionState['cast']> = {};
  for (const [characterId, entry] of Object.entries(cast ?? {})) {
    copy[characterId] = { ...entry };
  }
  return copy;
}

/**
 * A new object per sheet, and a new object per row inside it.
 *
 * The CELLS are copied one level deep and no further: a sheet cell is `unknown`
 * because the rule pack owns its schema, and a copy that recursed into it would be
 * guessing at a shape this layer must not know. So a cell that holds an OBJECT is
 * still shared — the same limitation `structuredClone` would not have — and it is
 * recorded here rather than discovered: nothing in M1 writes such a cell (`vars` is
 * primitives by schema and no rule pack ships yet).
 */
function copySheets(sheets: SessionState['sheets']): SessionState['sheets'] {
  const copy: SessionState['sheets'] = {};
  for (const [actorId, row] of Object.entries(sheets)) copy[actorId] = { ...row };
  return copy;
}

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
