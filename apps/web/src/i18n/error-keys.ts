/**
 * Adapter error code -> catalog key (M1-G1, docs/06-开发任务拆解.md §2.1; ADR-019).
 *
 * WHY THE MAPPING LIVES HERE AND NOT IN `state/chat-store.ts`
 * The store's job is to carry the FACTS of a failed turn: `ChatError.code` is the
 * stable adapter vocabulary and `ChatError.message` is the provider's own sentence for
 * logs. Which SENTENCE a person reads is a presentation decision, and a state module
 * that also owns prose is a state module that has to be edited to translate the app —
 * exactly the coupling `packages/i18n` exists to remove. So the codes stay in the store,
 * the sentences stay in the catalogs, and this module is the one place that joins them.
 *
 * WHY `messageKeyForCode` MUST TOTAL
 * A future vendor code (`insufficient_quota`, `context_length_exceeded`) reaches this
 * function before anyone has written a catalog key for it. Returning `undefined` there
 * is an empty error banner: the turn failed, the user is told nothing, and the bug looks
 * like a provider outage rather than a missing translation. Falling back to
 * `error.unknown` means a vendor code with no copy is still a sentence a person can act
 * on, and the code itself is untouched in the store for whoever adds the key later.
 *
 * WHY THE TABLE IS ANNOTATED `Record<string, MessageKey>` AND NOT KEYED BY
 * `LLMErrorCode`
 * The keys of this table are UNTRUSTED: `StreamEvent['error'].code` is a string the
 * adapter produced, and a lookup with an arbitrary string must be expressible so the
 * fallback branch is reachable (and testable) rather than dead code behind a cast. The
 * VALUES are typed, which is where the guarantee belongs: a key that does not exist in
 * the catalog is a compile error.
 *
 * WHY THE TWO IMPORTS COME FROM TWO PACKAGES
 * `LLM_ERROR_CODES` is the ADAPTER's vocabulary (`@smarttavern/providers`), and
 * `MessageKey` is the CATALOG's (`@smarttavern/i18n`). `packages/i18n` is dependency-free
 * and framework-free by design, so it must not learn a vendor's error codes — and this
 * module is the only place in the app where the two vocabularies legitimately meet.
 * That meeting point is the whole reason this file exists.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { LLM_ERROR_CODES } from '@smarttavern/providers';

/**
 * The code `state/chat-store.ts` sets when a turn cannot even be attempted because the
 * settings row has no endpoint or model. Deliberately NOT in `LLM_ERROR_CODES`: the
 * adapter never emits it, so putting it in the providers package would be inventing a
 * vendor vocabulary member for a UI-state fact.
 */
export const NOT_CONFIGURED_CODE = 'not_configured';

/**
 * The code `chat/send-turn.ts` sets when the prompt composer says the assembly does
 * not fit the token budget (`ComposeFailure.error`). Also NOT in `LLM_ERROR_CODES`:
 * the request never leaves the device, so no vendor vocabulary describes it. It gets
 * its own code because the user CAN act on it (docs/02 §5.1 requires the suggestion),
 * whereas `error.unknown` would read as a bug in the app.
 */
export const PROMPT_BUDGET_CODE = 'prompt_budget_exceeded';

/**
 * The code `state/chat-store.ts` sets when a key IS stored but this tab has not unlocked
 * it (M1-G3), so the turn is refused before any request is built.
 *
 * WHY IT IS NOT `NOT_CONFIGURED_CODE` AND NOT AN ADAPTER CODE: the configuration is
 * complete — endpoint, model and a key all exist — and the adapter is never reached, so
 * neither vocabulary describes it. Sending anyway would omit the `Authorization` header
 * and the provider would answer `auth`, i.e. the user would be told their key is wrong
 * when it is merely locked. Its own code is what lets the banner say the one thing that
 * fixes it.
 */
export const KEY_LOCKED_CODE = 'key_locked';

/** The sentence for anything the table does not know, including `'unknown'`. */
export const GENERIC_ERROR_KEY: MessageKey = 'error.unknown';

/** Every recognised code, and the catalog key whose sentence it shows. */
export const ERROR_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  [LLM_ERROR_CODES.auth]: 'error.auth',
  [LLM_ERROR_CODES.rateLimit]: 'error.rateLimit',
  [LLM_ERROR_CODES.network]: 'error.network',
  [LLM_ERROR_CODES.contentFilter]: 'error.contentFilter',
  [LLM_ERROR_CODES.invalidRequest]: 'error.invalidRequest',
  [LLM_ERROR_CODES.invalidResponse]: 'error.invalidResponse',
  /**
   * Not an adapter code (see above): "nothing is configured yet" is a local failure with
   * its own sentence rather than a provider one. It is a distinct code so the banner can
   * say what is actually wrong instead of the generic catch-all.
   */
  [NOT_CONFIGURED_CODE]: 'error.notConfigured',
  /** Not an adapter code either: the composer refused before a request was built. */
  [PROMPT_BUDGET_CODE]: 'error.promptBudget',
  /** Not an adapter code either: nothing was sent because this tab has not unlocked the key. */
  [KEY_LOCKED_CODE]: 'error.keyLocked',
};

/** The catalog key whose sentence `code` should render. Never `undefined`. */
export function messageKeyForCode(code: string): MessageKey {
  return ERROR_MESSAGE_KEYS[code] ?? GENERIC_ERROR_KEY;
}
