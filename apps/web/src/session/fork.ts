/**
 * Forking a session: the LINEAGE channel and the id-remap rule (M1-M2).
 *
 * THE ROW THIS IMPLEMENTS (docs/06-开发任务拆解.md §2.6)
 * `M1-M2 | 分叉 | 从任意存档点创建新时间线 | M1-M1 | 原时间线不受影响；新线引用一致`
 * So a fork is a NEW SESSION cut at a SAVE POINT, and its two acceptance clauses are the whole
 * design: the timeline it came from must be untouched, and every reference inside the new one
 * must be consistent (docs/02 §7: 消息树与分叉, "从任意节点复制祖先链创建新会话").
 *
 * WHY THE PURE HALF LIVES IN A MODULE OF ITS OWN
 * The interesting parts of a fork are decisions about DATA: which rows travel, what each row's
 * new id is, and which of its fields is a reference that has to follow. Those questions can be
 * answered without a database, so they are answered here and the repository
 * (`db/repository.ts`'s `forkSession`) is left with the one thing this module cannot do - read
 * the origin and write the copies inside ONE transaction. `planFork` therefore takes rows and a
 * `mintId` and returns the rows to write; it never reads, never writes and never mutates its
 * input, which is what makes the rules below table-testable.
 *
 * WHERE THE LINEAGE GOES, AND WHY IT IS NOT A FIELD ON THE ORIGIN (the decision the row asks for)
 * A fork records what it came from in `Session.extensions`, under three `x-smarttavern.forked-from.*`
 * keys (the origin session, the message the chain was cut at, the save point it was cut at). The
 * channel is `extensions` because that is the ONLY sanctioned place for data the core schema does
 * not define (`packages/schema/src/common.ts` rule 1), `Session.extensions` is the session's
 * plugin channel exactly as everywhere else, and a lineage is provenance rather than a domain
 * field. It is the same family of decision as the version lineage in
 * `packages/schema/src/versioning.ts`: there, a new version names its `parentId`/`parentVersion`;
 * here, a new session names the session and the position it was cut from.
 *
 * WHY THE ORIGIN GETS NOTHING (and the child gets everything)
 * 1. THE INVARIANT THE ROW NAMES. 原时间线不受影响 is a statement about the origin's ROWS. A
 *    "forks: []" field on the origin would have to be written by the fork, i.e. the act of
 *    forking would move bytes in the timeline it is supposed to leave alone - the fork would no
 *    longer be a read of the origin, and two tabs forking at once would be a lost update on a
 *    field recording history. A child that names its parent has no such write.
 * 2. IT IS THE SHAPE HISTORY ALREADY HAS. A version row carries `lineage.parentId`; a message
 *    carries `parentId`; a fork carries its origin. In every case the LATER row names the
 *    earlier one, the earlier one is immutable, and the direction of the graph is derivable
 *    (ADR-010: a published row is never edited in place).
 * 3. A BACK-POINTER WOULD BE A SECOND HOME. "Which sessions came from this one" is answerable
 *    from the forks themselves - one read of `sessions` and `forkLineageOf` - so a list on the
 *    origin would be a cache that can disagree with the rows that are the truth.
 * The reader is `forkLineageOf` below. Its first real consumer is docs/01 F4-12's timeline tree
 * (a P1 screen); until that exists the field is data with a test, not a decoration.
 *
 * NEW IDS, AND REFERENCES REMAPPED (the acceptance's 新线引用一致)
 * Every copied row gets a FRESH id from the injected `mintId` (`mintUuidV7`, docs/04 §4), and
 * every internal reference is rewritten to the new ids rather than left pointing at the origin's
 * rows: a message's `parentId`, the session's `headMessageId`, a checkpoint's `sessionId` and
 * `messageId`. The chain is a tree, so the edges are remapped in ONE pass while the new ids are
 * minted (a parent is always the ancestor that came before it in the chain).
 *
 * PIN IDS, NEVER VERSION NUMBERS AS IDENTITY (M1-I2's finding, applied here)
 * `Session.refs` is a set of `{id, version}` pins, and the fork copies them VERBATIM. It must:
 * a pin is the identity of an immutable version, and re-resolving "the latest version of world
 * X" (or of a card) for the new session would silently make a fork of an old timeline play a
 * newer build of its content than the transcript was written against. The version number is a
 * label on the pin, not the pin - the same trap `packages/importers` hit when a lookup by version
 * alone picked the wrong world.
 *
 * WHAT TRAVELS WITH A FORK, AND WHAT DELIBERATELY DOES NOT
 * Travels: the pinned refs, `schedulerMode`, the transcript up to the cut (content, roles,
 * speakers, kinds, emotions, tool calls, world-minute stamps and the debug `meta`), the anchor's
 * whole `SessionState` - clock, scene, vars, sheets, deadlines and the live cast - and every save
 * point the copied chain can still answer.
 * Does NOT travel, each for a stated reason:
 * - Messages AFTER the cut, and the siblings of chain messages: the fork is the cut chain, not a
 *   copy of the tree. The origin keeps them (nothing is deleted anywhere in this act).
 * - A save point whose `messageId` is a message the fork did not copy: its position does not
 *   exist in the new timeline, and copying it would store a reference the new session cannot
 *   resolve. (`messageId: null`, "saved before the first message", IS a position the fork can
 *   have, and it travels as `null`.)
 * - `turnPlans`: those rows are the origin's own scheduling decisions for rounds it played. The
 *   copied messages keep their `meta.turnPlanId` pointer, which is honest - it names the plan
 *   that really did decide that line, and the row is still there in the timeline it was played
 *   in - but the fork does not restate the decisions as its own.
 * - The origin session's `extensions` bag: it belongs to the origin ROW, and a foreign plugin's
 *   bag may hold ids of the origin we cannot remap (a plugin owns its schema, and this layer must
 *   not guess at it). A fork's bag carries the fork lineage and nothing else, which is the one
 *   thing this module can guarantee is about the fork.
 * - The session's `title` is not inherited: it is persisted copy and the caller composes it
 *   (`db/repository.ts` never chooses prose - ADR-030's addendum).
 */
import type {
  Checkpoint,
  Extensions,
  Id,
  Message,
  Session,
  SessionState,
  Timestamp,
} from '@smarttavern/schema';
import { copyCast, copyState } from './state-copy';

/* ───────────────────────────── the fork point ─────────────────────────────── */

/**
 * Where a new timeline is cut from. The row says 「从任意存档点」, so a save point is the
 * canonical answer and the live position is the other one: 「在当前进度分叉」 is the same act
 * with the state the session holds RIGHT NOW (`Session.state` + `Session.headMessageId`), which
 * is exactly what a save point taken this instant would snapshot - minus the write to the origin
 * that taking one would perform.
 *
 * WHY THERE IS NO 'message' VARIANT: a message carries no clock, no variables and no cast, so a
 * fork at an arbitrary message would have to invent the state it starts with - and the row gives
 * this act a save point precisely because a save point is what knows the state. A user who wants
 * "from this message" has 回溯 (`state/chat-store.ts`'s `switchBranch`): the head moves there
 * without a write to any message, and the fork at the head then cuts exactly there.
 */
export type ForkPoint =
  | { readonly kind: 'head' }
  | { readonly kind: 'checkpoint'; readonly checkpointId: Id };

/**
 * A fork point RESOLVED to the facts a plan needs: the message the chain is cut at (in the
 * ORIGIN's ids, `null` for a session whose chain is empty) and the state the new timeline starts
 * from. The repository resolves this from rows (`forkSession`), and `planFork` refuses an anchor
 * that is not the tip of the chain it was handed - see the guard there.
 */
export interface ForkAnchor {
  readonly messageId: Id | null;
  readonly state: SessionState;
  /** The save point forked from, when the fork point was one. Absent for a live-position fork. */
  readonly checkpointId?: Id;
}

/* ────────────────────────────── the lineage ───────────────────────────────── */

/**
 * What a fork came from, read back out of `Session.extensions`.
 *
 * `messageId` and `checkpointId` are absent rather than empty when they do not apply: a fork of
 * a session whose chain was empty has no message to name (`IdSchema` refuses `''`, exactly as
 * `Session.headMessageId` and `Checkpoint.messageId` do), and a live-position fork names no save
 * point. The ORIGIN's ids are recorded, never the new row's - the whole point of a lineage is
 * that it names the row it came from, which still exists and is still readable.
 */
export interface ForkLineage {
  readonly sessionId: Id;
  readonly messageId?: Id;
  readonly checkpointId?: Id;
}

/**
 * The extension keys a fork writes - one key per fact, so a reader never has to parse a
 * sentence out of a blob and a plugin's own `x-<ns>` keys cannot be confused with ours.
 *
 * The spelling follows `packages/importers/src/identity.ts`'s `x-smarttavern.origin-id`, including
 * its dot-separated lowercase segments: `common.ts`'s key pattern allows `[a-z0-9-]` per segment,
 * so a camelCase spelling could not be a key at all. `smarttavern` is the core's own namespace.
 */
export const FORK_LINEAGE_KEYS = {
  sessionId: 'x-smarttavern.forked-from.session-id',
  messageId: 'x-smarttavern.forked-from.message-id',
  checkpointId: 'x-smarttavern.forked-from.checkpoint-id',
} as const;

/**
 * The per-row provenance key: which ORIGIN row a copied row came from.
 *
 * WHY EVERY COPIED ROW CARRIES ONE, AND NOT ONLY THE SESSION. The session's lineage says where
 * the timeline was cut; this says which row each copy is. The two answer different questions the
 * moment a timeline has more than one fork, and "a copied row records the id it was copied from"
 * is what makes the remap auditable in the database instead of only inferable from position. It
 * is spelled exactly as the importer spells its own provenance key, because it is the same fact
 * (a local row that stands for a foreign one) and one spelling is one thing to grep.
 *
 * A copy of a copy records its IMMEDIATE origin, like `Lineage.parentId`: the lineage is the
 * chain of hops, and flattening it to the first ancestor would lose the hops.
 */
export const FORK_ORIGIN_ID_KEY = 'x-smarttavern.origin-id';

/** One extension value by key: a non-empty string, or `undefined`. */
function extensionText(extensions: Extensions | undefined, key: string): string | undefined {
  // A parameterised key is the spelling this workspace accepts for an index-signature read:
  // `noPropertyAccessFromIndexSignature` rejects dot access and Biome's `useLiteralKeys` rejects
  // the literal bracket form (`db/repository.ts`'s `stringField` records the same rule).
  const value = extensions?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The lineage of `row`, or `undefined` when it is not a fork (or its key is unusable). */
export function forkLineageOf(row: { readonly extensions?: Extensions }): ForkLineage | undefined {
  const sessionId = extensionText(row.extensions, FORK_LINEAGE_KEYS.sessionId);
  if (sessionId === undefined) return undefined;
  const messageId = extensionText(row.extensions, FORK_LINEAGE_KEYS.messageId);
  const checkpointId = extensionText(row.extensions, FORK_LINEAGE_KEYS.checkpointId);
  return {
    sessionId,
    ...(messageId === undefined ? {} : { messageId }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
  };
}

/** The origin row id of a copied row, or `undefined` when it was not copied from one. */
export function forkOriginIdOf(row: { readonly extensions?: Extensions }): Id | undefined {
  return extensionText(row.extensions, FORK_ORIGIN_ID_KEY);
}

/** The lineage as the `extensions` bag a session row carries. */
export function forkExtensions(lineage: ForkLineage): Extensions {
  return {
    [FORK_LINEAGE_KEYS.sessionId]: lineage.sessionId,
    ...(lineage.messageId === undefined
      ? {}
      : { [FORK_LINEAGE_KEYS.messageId]: lineage.messageId }),
    ...(lineage.checkpointId === undefined
      ? {}
      : { [FORK_LINEAGE_KEYS.checkpointId]: lineage.checkpointId }),
  };
}

/** A row's extensions with this row's origin recorded, keeping whatever else the bag held. */
function withOrigin(extensions: Extensions | undefined, originId: Id): Extensions {
  return { ...extensions, [FORK_ORIGIN_ID_KEY]: originId };
}

/* ──────────────────────────────── the plan ────────────────────────────────── */

/** The rows a fork writes: one new session, its chain, and the save points that travelled. */
export interface ForkPlan {
  readonly session: Session;
  readonly messages: readonly Message[];
  readonly checkpoints: readonly Checkpoint[];
}

/**
 * Plan a fork: the rows to write, with every id fresh and every reference remapped.
 *
 * THE GUARD IS THE ANCHOR: `anchor.messageId` must be the id of the chain's TIP. The caller read
 * the chain by walking `parentId` up from that very position, so a mismatch means the two do not
 * describe the same transcript - and there are two ways to reach that: a chain that STOPPED EARLY
 * (the anchor names a row that is not there any more, so the walk answered an empty or a shorter
 * path) or two reads a concurrent write landed between. Planning anyway would store a session
 * whose `headMessageId` is not the end of its own chain - a transcript with a tip pointing into
 * the middle of it, or at nothing at all - so the honest answer is `undefined` and no rows.
 *
 * IDS ARE MINTED IN ONE ORDER - the session, then the chain oldest-first, then the save points -
 * so a deterministic `mintId` produces a deterministic plan (`mintUuidV7` is injectable for the
 * same reason: `packages/schema/src/common.ts`).
 *
 * `initialClock` IS WHERE THE FORK BEGINS, not a copy of the origin's. ADR-012/ADR-032 keep the
 * field for "where this session started - a rollback, a package export and a derived default
 * state all need to know", and a new timeline starts at the minute it was cut at. Copying the
 * origin's start minute instead would say the fork began before the first message it contains.
 */
export function planFork(input: {
  readonly origin: Session;
  readonly anchor: ForkAnchor;
  readonly chain: readonly Message[];
  readonly checkpoints: readonly Checkpoint[];
  readonly title: string;
  readonly at: Timestamp;
  readonly mintId: () => Id;
}): ForkPlan | undefined {
  const tip = input.chain[input.chain.length - 1];
  if ((tip?.id ?? null) !== input.anchor.messageId) return undefined;

  const sessionId = input.mintId();

  // One pass: mint every copy's id first, so the second pass can rewrite a `parentId` without
  // caring about the order the chain was handed in.
  const copies: { readonly origin: Message; readonly id: Id }[] = [];
  for (const message of input.chain) copies.push({ origin: message, id: input.mintId() });
  const ids = new Map<Id, Id>(copies.map((copy) => [copy.origin.id, copy.id]));

  const messages: Message[] = copies.map((copy) => ({
    ...copy.origin,
    id: copy.id,
    sessionId,
    // The edge follows the copy. A parent the walk could NOT resolve (a row the origin itself
    // does not have, so the origin's chain carries the same dangling edge) is kept verbatim:
    // inventing a parent, or silently re-rooting the message, would be a worse lie than the one
    // dangling id the origin already stores.
    parentId:
      copy.origin.parentId === null
        ? null
        : (ids.get(copy.origin.parentId) ?? copy.origin.parentId),
    extensions: withOrigin(copy.origin.extensions, copy.origin.id),
  }));

  const last = copies[copies.length - 1];
  const session: Session = {
    id: sessionId,
    title: input.title,
    refs: copyRefs(input.origin.refs),
    initialClock: input.anchor.state.clock,
    state: copyState(input.anchor.state),
    schedulerMode: input.origin.schedulerMode,
    headMessageId: last === undefined ? null : last.id,
    createdAt: input.at,
    updatedAt: input.at,
    extensions: forkExtensions({
      sessionId: input.origin.id,
      ...(input.anchor.messageId === null ? {} : { messageId: input.anchor.messageId }),
      ...(input.anchor.checkpointId === undefined
        ? {}
        : { checkpointId: input.anchor.checkpointId }),
    }),
  };

  const checkpoints: Checkpoint[] = [];
  for (const checkpoint of input.checkpoints) {
    // A save point is a POSITION, and the fork only has the positions it copied. `null` (a save
    // taken before the first message) is one of them; anything else must be a message that
    // travelled, or the row would point at a message the new timeline does not contain.
    const at = checkpoint.messageId === null ? null : ids.get(checkpoint.messageId);
    if (at === undefined) continue;
    checkpoints.push({
      ...checkpoint,
      id: input.mintId(),
      sessionId,
      messageId: at,
      // Both state values are copied for the reason `session/state-copy.ts` gives: a save point
      // is a snapshot, and a snapshot that aliased the row it came from would stop being "then".
      state: copyState(checkpoint.state),
      castState: copyCast(checkpoint.castState),
      extensions: withOrigin(checkpoint.extensions, checkpoint.id),
    });
  }

  return { session, messages, checkpoints };
}

/**
 * The pinned references, copied pin by pin.
 *
 * WHY A COPY AND NOT THE ORIGIN'S OBJECT: the plan's output is what the repository writes, and a
 * value that aliased the parsed origin row would make the stored row share an object graph with
 * a reader's copy of another row - the aliasing rule `createSession` follows when it copies the
 * pins a caller passed. The pins themselves are NOT re-resolved: see the header on identity.
 */
function copyRefs(refs: Session['refs']): Session['refs'] {
  const params = refs.modelConfig.params;
  return {
    world: { ...refs.world },
    playerCharacter: { ...refs.playerCharacter },
    cast: refs.cast.map((pin) => ({ ...pin })),
    promptPreset: { ...refs.promptPreset },
    ...(refs.rulePack === undefined ? {} : { rulePack: { ...refs.rulePack } }),
    modelConfig: {
      ...refs.modelConfig,
      params: { ...params, ...(params.stop === undefined ? {} : { stop: [...params.stop] }) },
    },
  };
}
