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
 */
import { COLLECTIONS, type Collection, type RowBase, type Tx } from '@smarttavern/core';
import { isLocale, type Locale } from '@smarttavern/i18n';
import {
  type Id,
  type JsonValue,
  type Message,
  MessageSchema,
  mintUuidV7,
  type Session,
  SessionSchema,
} from '@smarttavern/schema';
import {
  type FontScale,
  type MessageWidth,
  parseFontScale,
  parseMessageWidth,
  parseTheme,
  type Theme,
} from '../appearance/appearance';
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

/** The BYO-Key configuration as it is stored (M0-T8: base URL, key, model). */
export interface ProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** What a first run starts from: no endpoint, no key, no model. */
export const EMPTY_PROVIDER_SETTINGS: ProviderSettings = { baseUrl: '', apiKey: '', model: '' };

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
    return { ...EMPTY_PROVIDER_SETTINGS };
  }
  return {
    baseUrl: stringField(value, 'baseUrl') ?? '',
    apiKey: stringField(value, 'apiKey') ?? '',
    model: stringField(value, 'model') ?? '',
  };
}

/** A string member of a parsed JSON object; `undefined` for anything else. */
function stringField(value: { [key: string]: JsonValue }, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
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

/** Store the provider configuration. The key goes in this row and nowhere else. */
export async function writeProviderSettings(settings: ProviderSettings): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = {
      id: PROVIDER_SETTINGS_ID,
      value: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model },
    };
    await settingsOf(tx).put(row);
  });
}

/* ──────────────────────────────── sessions ───────────────────────────────── */

/**
 * The built-in placeholder pins (docs/06 §8.5 决定 1).
 *
 * `PromptPreset`, world content and character selection are all M1, but
 * `Session.refs.world` / `playerCharacter` / `promptPreset` are REQUIRED and are
 * `{id, version}` pins that are NOT foreign-key validated. So M0 writes a
 * well-formed placeholder pin and the default prompt assembly (`chat/prompt.ts`)
 * is what actually runs — exactly the consequence §8.5 decision 1 records.
 * Nothing migrates later: the refs are already the right shape and simply point at
 * content M1 will create.
 */
const PLACEHOLDER_PIN = { id: 'builtin-default', version: 1 } as const;

/** The provider id recorded before the user has configured anything. */
const PLACEHOLDER_PROVIDER = 'openai-compatible';

/** Sampling defaults that satisfy the frozen `SamplingParamsSchema`. */
const DEFAULT_SAMPLING = { temperature: 0.7, topP: 1 } as const;

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
 * The clock, the scheduler mode and the model config are all required by the
 * frozen `SessionSchema`, so a session created before BYO-Key is configured still
 * has to carry values. They are placeholders in the literal sense — the first turn
 * overwrites `refs.modelConfig` with what the user actually configured
 * (`recordSessionModel`) — and the alternative (refusing to create a session until
 * a key exists) would make 「新建会话」 the thing that blocks the wizard.
 */
export async function createSession(options: { title: string }): Promise<Session> {
  const timestamp = Date.now();
  const session: Session = {
    id: mintUuidV7(),
    title: options.title,
    refs: {
      world: { ...PLACEHOLDER_PIN },
      playerCharacter: { ...PLACEHOLDER_PIN },
      cast: [],
      promptPreset: { ...PLACEHOLDER_PIN },
      modelConfig: {
        provider: PLACEHOLDER_PROVIDER,
        model: PLACEHOLDER_PROVIDER,
        params: { ...DEFAULT_SAMPLING },
      },
    },
    // 0 is the calendar epoch. The live clock is `SessionState.clock`, which is an
    // M1/M3 concern; the session only has to remember where it started.
    initialClock: 0,
    schedulerMode: 'user',
    headMessageId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await write(async (tx) => {
    await sessionsOf(tx).put(session);
  });
  return session;
}

/** One session, or `undefined` when the id was never stored (or was deleted). */
export async function getSession(sessionId: Id): Promise<Session | undefined> {
  const row = await readTable<Session>(COLLECTIONS.sessions).get(sessionId);
  return row === undefined ? undefined : SessionSchema.parse(row);
}

/** Newest first — `sessions.createdAt` is the index docs/02 §7 gives for this. */
export async function listSessions(): Promise<Session[]> {
  const rows = await readTable<Session>(COLLECTIONS.sessions)
    .orderBy('createdAt')
    .reverse()
    .toArray();
  return rows.map((row) => SessionSchema.parse(row));
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
    const session = SessionSchema.parse(row);
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
  meta?: Message['meta'];
  extensions?: Message['extensions'];
}): Promise<Message> {
  const message: Message = {
    id: mintUuidV7(),
    sessionId: input.sessionId,
    parentId: input.parentId,
    role: input.role,
    kind: 'dialogue',
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

/** Advance the transcript tip. `null` means "the transcript is empty again". */
export async function setHeadMessageId(sessionId: Id, headMessageId: Id | null): Promise<void> {
  await write(async (tx) => {
    const row = await sessionsOf(tx).get(sessionId);
    if (row === undefined) return;
    const session = SessionSchema.parse(row);
    await sessionsOf(tx).put({ ...session, headMessageId, updatedAt: Date.now() });
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
