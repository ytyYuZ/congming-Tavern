/**
 * The co-creation panel (M1-W2): the conversation on the left, the LIVE PREVIEW of the proposed card
 * on the right, and the acts the acceptance is stated over — now also the two controls M1-W3 and
 * M1-W4 add (生成模式 and 字段级 AI 操作).
 *
 * WHAT THIS COMPONENT DECIDES, AND WHAT IT DOES NOT
 * It decides where the panes are, which catalog key each line reads, and WHICH STEP of a generation is
 * the next one to show. It decides NO transition: every gesture is a value handed to
 * `state/co-create-store.ts`, which owns the conversation, the generation walk and the four acts, and
 * every write goes through `state/content-store.ts`'s autosave. It also decides no PATCH ARITHMETIC:
 * the preview's payload comes from `co-create/proposal.ts`'s `previewWorldProposal`, which is the same
 * function the store persists, and what a turn is ALLOWED to write comes from the scope the store
 * built.
 *
 * WHY THE PREVIEW IS COMPUTED FROM THE PROPOSAL AND NOT FROM THE DRAFT
 * That is the whole point of a preview: the right pane has to show what the card would BECOME, or the
 * author is being asked to accept a change they have not seen. The payload rendered below is
 * `previewWorldProposal(draft.data, proposal)` — never `draft.data` — and the pane says so in words
 * (`co-create.previewHint`) rather than relying on the reader inferring it from the JSON.
 *
 * WHY THE PROPOSED PAYLOAD IS SHOWN AS JSON AND NOT AS A SECOND COPY OF THE FORM
 * The card's forty controls are the EDITOR's job. Re-rendering them here would be a second renderer of
 * the same document, which is exactly the drift `previewWorldProposal` exists to prevent; and the
 * author's question at this moment is "what would my card say", which the payload answers directly.
 * The operations are also listed one sentence each, in the form's own field labels.
 *
 * WHY THE STEP LIST IS ON SCREEN AND NOT BURIED IN A MESSAGE
 * M1-W3's acceptance is that the AI works in STRUCTURE — a plan of steps, one request each, accepted
 * one at a time — and a structure the author cannot see is indistinguishable from a model that
 * happened to answer in pieces. So the whole plan is listed, each step carries its own state
 * (待生成 / 已采纳 / 已否决 / 已跳过), and the step being generated NOW is marked separately: 「which step
 * is next」 and 「what is already accepted」 are the two facts the acceptance is about.
 *
 * WHY THE FIELD LIST IS A COPY OF `WORLD_PATCH_PATHS` AND NOT A LIST OF CONTROLS
 * A field-level action has to name a PAYLOAD PATH, because that is what the scope gate compares and
 * what the model is sent. `WORLD_PATCH_PATHS` is already derived from the editor's own descriptor
 * tables (`proposal.ts` records that derivation), so the list here cannot name a field the form does
 * not render, and cannot miss one it does. The label is the form's own, so the author reads the same
 * word here as beside the control.
 *
 * WHY 「撤销」 SITS IN THE PREVIEW PANE'S FOOTER
 * Because it undoes what was APPLIED, and what was applied is what the card now contains. Putting it
 * beside 采纳 / 否决 would make it look like a third answer to the pending proposal — the confusion
 * `docs/06` §2.2's 「补丁可回退」 must not create: 否决 is "do not apply this", 撤销 is "take back the
 * one I applied".
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { Id, WorldData } from '@smarttavern/schema';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from '../i18n/use-translation';
import type { CoCreateGeneration, GenerationStepState } from '../state/co-create-store';
import { useCoCreateStore } from '../state/co-create-store';
import { useContentStore } from '../state/content-store';
import type { PatchVerb, WorldOp } from './json-patch';
import {
  opPathText,
  opTargetLabel,
  type ProposalPreview,
  type ProposalRefusal,
  previewWorldProposal,
  WORLD_PATCH_PATHS,
} from './proposal';
import type { FieldOpKind } from './scope';

/** The verbs as catalog keys. One table, so a second spelling cannot appear in the markup. */
const VERB_KEYS: Readonly<Record<PatchVerb, MessageKey>> = {
  add: 'co-create.verbAdd',
  remove: 'co-create.verbRemove',
  replace: 'co-create.verbReplace',
};

/** M1-W4's three gestures, as the labels of the three buttons each field offers. */
const FIELD_OP_KEYS: readonly { readonly op: FieldOpKind; readonly label: MessageKey }[] = [
  { op: 'rewrite', label: 'co-create.fieldRewrite' },
  { op: 'expand', label: 'co-create.fieldExpand' },
  { op: 'condense', label: 'co-create.fieldCondense' },
];

/** What became of a step, as the word the plan list prints beside it. */
const STEP_STATE_KEYS: Readonly<Record<GenerationStepState, MessageKey>> = {
  pending: 'co-create.stepStatePending',
  accepted: 'co-create.stepStateAccepted',
  rejected: 'co-create.stepStateRejected',
  skipped: 'co-create.stepStateSkipped',
};

/** What the panel needs: which card the conversation is about, and the payload as it stands. */
export interface CoCreatePanelProps {
  /** The open world's id. The conversation is dropped when it changes — see the effect below. */
  readonly worldId: Id;
  /** The same value the editor's form is rendering — the card as it stands right now. */
  readonly data: WorldData;
}

export function CoCreatePanel({ worldId, data }: CoCreatePanelProps) {
  const { t } = useTranslation();
  const turns = useCoCreateStore((state) => state.turns);
  const proposals = useCoCreateStore((state) => state.proposals);
  const pendingId = useCoCreateStore((state) => state.pendingId);
  const undoable = useCoCreateStore((state) => state.undoable);
  const busy = useCoCreateStore((state) => state.busy);
  const finding = useCoCreateStore((state) => state.finding);
  const generation = useCoCreateStore((state) => state.generation);
  const fieldOp = useCoCreateStore((state) => state.fieldOp);
  const startGeneration = useCoCreateStore((state) => state.startGeneration);
  const startFieldGeneration = useCoCreateStore((state) => state.startFieldGeneration);
  const generateStep = useCoCreateStore((state) => state.generateStep);
  const skipStep = useCoCreateStore((state) => state.skipStep);
  const cancelGeneration = useCoCreateStore((state) => state.cancelGeneration);
  const askFieldOp = useCoCreateStore((state) => state.askFieldOp);
  const send = useCoCreateStore((state) => state.send);
  const accept = useCoCreateStore((state) => state.accept);
  const reject = useCoCreateStore((state) => state.reject);
  const undoAccept = useCoCreateStore((state) => state.undoAccept);
  const reset = useCoCreateStore((state) => state.reset);
  const [input, setInput] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);

  /*
   * ONE CONVERSATION PER CARD. The store's state is in memory (its header records why), so a proposal
   * computed against world A would otherwise still be on screen — and still 采纳-able — after the user
   * navigated to world B.
   *
   * WHY THE GUARD READS `worldId` INSIDE THE EFFECT rather than resetting unconditionally with
   * `worldId` merely listed as a dependency: React runs the cleanup of the OLD effect before the new
   * one only when the dependencies CHANGE, so an unconditional cleanup already runs exactly on a world
   * change — but a dependency the effect never reads is a dependency the linter (rightly) refuses, and
   * a future refactor could drop it silently. Comparing the id the effect was created for against the
   * id that is current makes the rule "reset only when the CARD changed" explicit, and it keeps a
   * panel that is toggled shut and open — a remount with the SAME id — holding its conversation.
   */
  useEffect(() => {
    return () => {
      if (useContentStore.getState().world?.id !== worldId) reset();
    };
  }, [worldId, reset]);

  // The pending proposal, read from the list rather than held as a second copy: `send` installs it
  // and `accept` / `reject` move its status in the same list.
  const pending = proposals.find((entry) => entry.proposal.id === pendingId);
  const preview = pending === undefined ? undefined : previewWorldProposal(data, pending.proposal);
  // Whether the plan still has a step to offer. A stopped walk, a refused step and a plan that has not
  // started all keep the control visible: the author is the one who decides to keep going.
  const nextStep = generation === undefined ? undefined : nextPendingStep(generation);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const text = input.trim();
    if (busy || text === '') return;
    setInput('');
    void send(text);
  };

  const toggleChosen = (path: string): void => {
    setChosen((current) =>
      current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path],
    );
  };

  return (
    <section className="co-create" aria-labelledby="co-create-title" data-panel="co-create">
      <h3 className="section-title" id="co-create-title">
        {t('co-create.title')}
      </h3>

      {/*
        生成模式 (M1-W3) and 字段级 AI 操作 (M1-W4). ABOVE the conversation because they are entrances
        to it rather than parts of it: each one starts a request of its own, and the proposal it
        produces is answered in the pane below by the same 采纳 / 否决 pair as any other turn.
      */}
      <GenerationControls
        generation={generation}
        busy={busy}
        pending={pending !== undefined}
        nextStep={nextStep}
        fieldOp={fieldOp}
        chosen={chosen}
        onStart={() => {
          void startGeneration();
        }}
        onFieldSetStart={() => {
          void startFieldGeneration(chosen);
        }}
        onGenerateStep={() => {
          void generateStep();
        }}
        onSkipStep={skipStep}
        onCancel={cancelGeneration}
        onFieldOp={(path, op) => {
          void askFieldOp(path, op);
        }}
        onToggleChosen={toggleChosen}
      />

      <div className="co-create-columns">
        <div className="co-create-chat">
          <p className="muted">{t('co-create.hint')}</p>
          {turns.length === 0 ? (
            <p className="muted" data-status="co-create-empty">
              {t('co-create.empty')}
            </p>
          ) : (
            <ul className="co-create-turns" data-list="co-create-turns">
              {turns.map((turn) => (
                <li
                  className={`bubble co-create-turn co-create-turn-${turn.role}`}
                  key={turn.id}
                  data-turn={turn.role}
                >
                  {/* A finding REPLACES the text: an answer that could not be read as a proposal has
                      nothing to show, and the sentence is what the author acts on. */}
                  {turn.finding === undefined ? (
                    <p className="bubble-text">{turn.text}</p>
                  ) : (
                    <p className="notice notice-error" data-status="co-create-finding">
                      {t(turn.finding.code, { detail: turn.finding.detail ?? '' })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {finding === undefined ? null : (
            <p className="notice notice-error" data-status="co-create-error">
              {t(finding.code, { detail: finding.detail ?? '' })}
            </p>
          )}

          <form className="composer" onSubmit={onSubmit}>
            <textarea
              aria-label={t('co-create.inputLabel')}
              data-field="co-create-input"
              rows={2}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || input.trim() === ''}
            >
              {busy ? t('co-create.thinking') : t('co-create.send')}
            </button>
          </form>
        </div>

        <div className="co-create-preview">
          <h4 className="row-list-title">{t('co-create.previewTitle')}</h4>
          <p className="muted">{t('co-create.previewHint')}</p>
          {pending === undefined ? (
            <p className="muted" data-status="co-create-no-proposal">
              {t('co-create.noProposal')}
            </p>
          ) : (
            <>
              <ul className="co-create-ops" data-list="co-create-ops">
                {pending.proposal.ops.map((op) => (
                  // The key comes from the OPERATION and not from its position: Biome's
                  // `noArrayIndexKey` refuses an index (a list that can change would re-use one for a
                  // different item), and `proposal.id` + verb + path is stable for as long as this
                  // operation is in this proposal. No index is needed anywhere in this list.
                  <li className="co-create-op" key={`${pending.proposal.id}:${op.op}:${op.path}`}>
                    {t('co-create.opLine', {
                      op: t(VERB_KEYS[op.op]),
                      path: opLabel(op, t),
                    })}
                  </li>
                ))}
              </ul>
              {pending.proposal.rationale === undefined ? null : (
                <p className="muted">{pending.proposal.rationale}</p>
              )}
              <PreviewBody preview={preview} />
              {preview !== undefined && !preview.ok ? (
                <p className="notice notice-error" data-status="co-create-refused">
                  {refusalSentence(preview.refusal, t)}
                </p>
              ) : null}
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  type="button"
                  data-action="co-create-accept"
                  disabled={preview === undefined || !preview.ok}
                  onClick={() => {
                    void accept(pending.proposal.id);
                  }}
                >
                  {t('co-create.accept')}
                </button>
                <button
                  className="btn"
                  type="button"
                  data-action="co-create-reject"
                  onClick={() => {
                    void reject(pending.proposal.id);
                  }}
                >
                  {t('co-create.reject')}
                </button>
              </div>
            </>
          )}

          {/* The undo belongs to the APPLIED change, not to the pending proposal: see the header. */}
          {undoable === undefined ? null : (
            <div className="co-create-undo">
              <p className="muted">{t('co-create.undoHint')}</p>
              <button
                className="btn"
                type="button"
                data-action="co-create-undo"
                onClick={() => {
                  void undoAccept();
                }}
              >
                {t('co-create.undo')}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 生成模式 and 字段级 AI 操作: the two entrances M1-W3 and M1-W4 add.
 *
 * WHY THEY SHARE ONE COMPONENT: they are one walk with two errands. 从零生成 walks every step of the
 * plan, 生成选中的字段 walks the steps the ticked fields belong to, and the same plan list, the same
 * 生成下一步 / 跳过这一步 / 停止生成 controls and the same per-field buttons drive both — which is what
 * "the two modes share the step and proposal machinery" looks like on screen. Both start a request
 * through the store and are ANSWERED by the same 采纳 / 否决 pair in the preview pane below.
 */
function GenerationControls({
  generation,
  busy,
  pending,
  nextStep,
  fieldOp,
  chosen,
  onStart,
  onFieldSetStart,
  onGenerateStep,
  onSkipStep,
  onCancel,
  onFieldOp,
  onToggleChosen,
}: {
  readonly generation: CoCreateGeneration | undefined;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly nextStep: number | undefined;
  readonly fieldOp: { readonly path: string; readonly fieldOp: FieldOpKind } | undefined;
  readonly chosen: readonly string[];
  readonly onStart: () => void;
  readonly onFieldSetStart: () => void;
  readonly onGenerateStep: () => void;
  readonly onSkipStep: () => void;
  readonly onCancel: () => void;
  readonly onFieldOp: (path: string, op: FieldOpKind) => void;
  readonly onToggleChosen: (path: string) => void;
}) {
  const { t } = useTranslation();
  // The field a gesture will be run on. Local state, because it is a selection rather than a fact about
  // the card or the conversation: choosing a field writes nothing, and the gesture is what sends.
  const [selected, setSelected] = useState(WORLD_PATCH_PATHS[0]?.path ?? '');
  const running = generation !== undefined && generation.status === 'running';
  const total = generation?.plan.steps.length ?? 0;
  const current = generation === undefined ? 0 : generation.current + 1;
  // A field gesture is offered when no request is in flight, no step proposal is waiting for an
  // answer, and no plan still has a step to generate — one turn at a time is the store's own rule, and
  // a control that could break it would be a button that reports an error instead of doing what it
  // says. `nextStep === undefined` and not merely `!running`: a FINISHED walk must not hold the field
  // actions hostage, because working on one field by hand is what the author does next
  // (`co-create-store.ts`'s `blocked` is the same rule on the store's side).
  const fieldDisabled = busy || pending || nextStep !== undefined;

  return (
    <section className="co-create-generation" aria-labelledby="co-create-generation-title">
      <div className="co-create-columns">
        <div className="co-create-generate">
          <h4 className="row-list-title" id="co-create-generation-title">
            {t('co-create.generateTitle')}
          </h4>
          <p className="muted">{t('co-create.generateHint')}</p>

          <div className="btn-row">
            {/* 从零生成 is offered while no plan is running, 停止生成 while one is: one control for the
                act that is possible now, rather than a disabled button for the one that is not. */}
            {running ? (
              <button className="btn" type="button" data-action="co-create-stop" onClick={onCancel}>
                {t('co-create.generateStop')}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                type="button"
                data-action="co-create-start"
                onClick={onStart}
              >
                {t('co-create.generateStart')}
              </button>
            )}
            {/* 生成下一步 stays available whenever the plan has a pending step: after a refusal it is
                how the author resumes (the automatic walk stopped — the store's header says why), and
                after a stop it is how they restart the one thing they stopped. */}
            {nextStep === undefined ? null : (
              <button
                className="btn"
                type="button"
                data-action="co-create-generate-step"
                disabled={busy || (running && pending)}
                onClick={onGenerateStep}
              >
                {t('co-create.generateNext')}
              </button>
            )}
            {running && pending ? (
              <button
                className="btn"
                type="button"
                data-action="co-create-skip"
                onClick={onSkipStep}
              >
                {t('co-create.generateSkip')}
              </button>
            ) : null}
          </div>

          {generation === undefined ? null : (
            <>
              <p className="muted" data-status="co-create-step-of">
                {t('co-create.generateStepOf', { current, total })}
              </p>
              <ol className="co-create-steps" data-list="co-create-steps">
                {generation.steps.map((progress, index) => {
                  const step = generation.plan.steps[index];
                  const next = index === generation.current;
                  return (
                    <li
                      className="co-create-step"
                      // The step ids are the plan's own and are unique in it; an index would be refused
                      // by Biome's `noArrayIndexKey` for the reason the operations list records.
                      key={progress.id}
                      data-step={progress.id}
                      data-step-state={progress.state}
                      data-step-next={next ? 'yes' : 'no'}
                    >
                      {step === undefined ? progress.id : t(step.label)}
                      <span className="muted"> {t(STEP_STATE_KEYS[progress.state])}</span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>

        <div className="co-create-fields">
          <h4 className="row-list-title">{t('co-create.fieldTitle')}</h4>
          <p className="muted">{t('co-create.fieldHint')}</p>
          <div className="btn-row">
            <label className="field">
              <span>{t('co-create.fieldSelectLabel')}</span>
              <select
                data-field="co-create-field"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {WORLD_PATCH_PATHS.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {t(entry.label)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="btn-row">
            {/* The three gestures of docs/06 §2.5 (重写 / 扩写 / 精简): each takes one field, so each is
                one button and the title says which gesture the pending proposal is. */}
            {FIELD_OP_KEYS.map(({ op, label }) => (
              <button
                className="btn"
                type="button"
                key={op}
                data-action={`co-create-field-${op}`}
                disabled={fieldDisabled || selected === ''}
                onClick={() => onFieldOp(selected, op)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          {fieldOp === undefined ? null : (
            <p className="muted" data-status="co-create-last-field-op">
              {t('co-create.fieldOpTitle', {
                op: t(fieldOpLabel(fieldOp.fieldOp)),
                field: fieldLabel(fieldOp.path, t),
              })}
            </p>
          )}

          {/*
            逐字段生成: the SAME steps as 从零生成, chosen instead of walked. A ticked field is generated
            by the step that owns it, so the per-request scope is identical in both modes — the tick
            list is the form's field inventory (`proposal.ts` derives it from the editor's own
            descriptor tables), not a second list of controls.
          */}
          <h5 className="row-list-title">{t('co-create.selectedTitle')}</h5>
          <ul className="co-create-field-list" data-list="co-create-field-picks">
            {WORLD_PATCH_PATHS.map((entry) => (
              <li className="co-create-field-pick" key={entry.path}>
                <label className="field-check">
                  <input
                    type="checkbox"
                    data-field={`co-create-pick-${fieldKey(entry.path)}`}
                    checked={chosen.includes(entry.path)}
                    onChange={() => onToggleChosen(entry.path)}
                  />
                  <span>{t(entry.label)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="btn-row">
            <button
              className="btn"
              type="button"
              data-action="co-create-field-set"
              disabled={fieldDisabled || chosen.length === 0}
              onClick={onFieldSetStart}
            >
              {t('co-create.fieldSetStart')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────── helpers ───────────────────────────────── */

/** The index of the first step the plan has not decided yet, or `undefined` when every one is. */
function nextPendingStep(generation: CoCreateGeneration): number | undefined {
  for (let index = 0; index < generation.steps.length; index += 1) {
    if (generation.steps[index]?.state === 'pending') return index;
  }
  return undefined;
}

/** The catalog key for one gesture's label. */
function fieldOpLabel(op: FieldOpKind): MessageKey {
  const entry = FIELD_OP_KEYS.find((candidate) => candidate.op === op);
  return entry?.label ?? 'co-create.fieldRewrite';
}

/** A field path as the form's own label, or its dotted path when the form has no label for it. */
function fieldLabel(
  path: string,
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string,
): string {
  const entry = WORLD_PATCH_PATHS.find((candidate) => candidate.path === path);
  return entry === undefined ? path : t(entry.label);
}

/**
 * A path as a stable DOM key: `/regions` -> `regions`, `/calendar/months` -> `calendar-months`.
 *
 * A KEY AND NOT AN INDEX: the field list is the form's inventory and does not reorder today, but a
 * position-keyed checkbox is exactly the construct that silently keeps the wrong tick when it does.
 */
function fieldKey(path: string): string {
  return path.replace(/^\//, '').split('/').join('-');
}

/** The proposed payload, as the pane that previews it. Renders nothing when there is no proposal. */
function PreviewBody({ preview }: { preview: ProposalPreview | undefined }) {
  if (preview === undefined || !preview.ok) return null;
  return (
    <pre className="co-create-json" data-status="co-create-preview">
      {JSON.stringify(preview.data, null, 2)}
    </pre>
  );
}

/**
 * The sentence for a proposal that cannot be applied.
 *
 * Two refusals, two sentences: an OPERATION the engine refused (naming the verb and the field) and a
 * payload the SCHEMA refused (naming the path it complained about). They are kept apart because the
 * author's next move differs — the first is "the model aimed at the wrong place", the second is "that
 * value is not allowed here".
 */
function refusalSentence(
  refusal: ProposalRefusal,
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string,
): string {
  if (refusal.kind === 'schema') return t('co-create.refusedSchema', { detail: refusal.path });
  const issue = refusal.issues[0];
  if (issue === undefined) return t('co-create.refusedOp', { op: '', path: '' });
  return t('co-create.refusedOp', {
    op: t(VERB_KEYS[issue.op]),
    // The operation's own pointer, verbatim: a refused operation is a machine fact the author may want
    // to quote back to the model, and a label would lose the exact path that failed.
    path: issue.path,
  });
}

/**
 * One operation's target, as a sentence: the form's label when the form has one, else the dotted path.
 *
 * WHY BOTH BRANCHES GO THROUGH `t`: a catalogued field name must be translated at render time, and a
 * dotted path is data that must NOT be (it is the author's own JSON). A `MessageKey` and a path are
 * different kinds of thing, so the union is narrowed here rather than guessed at each call site.
 */
function opLabel(
  op: WorldOp,
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string,
): string {
  const key = opTargetLabel(op);
  return key === undefined ? opPathText(op) : t(key);
}
