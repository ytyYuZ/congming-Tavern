/**
 * The co-creation panel (M1-W2): the conversation on the left, the LIVE PREVIEW of the proposed card on
 * the right, and the acts the acceptance is stated over — now also the controls M1-W3, M1-W4 and M1-C3
 * add (生成模式, 字段级 AI 操作, 发言档案评估).
 *
 * WHY IT IS ONE PANEL FOR BOTH CARDS (M1-C2)
 * The conversation, the step list, the field picker, the preview and 采纳 / 否决 / 撤销 are the same
 * screen whichever card is open; what differs is which INVENTORY the field picker lists, which TARGET
 * the preview validates against, and one extra button (发言档案评估) that only a character has. All
 * three come from the `kind` prop, so a second panel would have been a second copy of this file with two
 * lines changed — and the first thing to drift.
 *
 * WHAT THIS COMPONENT DECIDES, AND WHAT IT DOES NOT
 * It decides where the panes are, which catalog key each line reads, and WHICH STEP of a generation is
 * the next one to show. It decides NO transition: every gesture is a value handed to
 * `state/co-create-store.ts`, which owns the conversation, the generation walk and the four acts, and
 * every write goes through `state/content-store.ts`'s autosave. It also decides no PATCH ARITHMETIC: the
 * preview's payload comes from `co-create/target.ts`'s `previewProposal`, which is the same function the
 * store persists, and what a turn is ALLOWED to write comes from the scope the store built.
 *
 * WHY THE PREVIEW IS COMPUTED FROM THE PROPOSAL AND NOT FROM THE DRAFT
 * That is the whole point of a preview: the right pane has to show what the card would BECOME, or the
 * author is being asked to accept a change they have not seen. The payload rendered below is
 * `previewProposal(target, data, proposal)` — never `data` — and the pane says so in words
 * (`co-create.previewHint`) rather than relying on the reader inferring it from the JSON.
 *
 * WHY THE PROPOSED PAYLOAD IS SHOWN AS JSON AND NOT AS A SECOND COPY OF THE FORM
 * The card's forty controls are the EDITOR's job. Re-rendering them here would be a second renderer of
 * the same document, which is exactly the drift `previewProposal` exists to prevent; and the author's
 * question at this moment is "what would my card say", which the payload answers directly. The
 * operations are also listed one sentence each, with the exact JSON Pointer they write — a pointer is
 * data the author may want to quote back to the model, and it is what the gate compared.
 *
 * WHY THE STEP LIST IS ON SCREEN AND NOT BURIED IN A MESSAGE
 * M1-W3's acceptance is that the AI works in STRUCTURE — a plan of steps, one request each, accepted one
 * at a time — and a structure the author cannot see is indistinguishable from a model that happened to
 * answer in pieces. So the whole plan is listed, each step carries its own state (待生成 / 已采纳 /
 * 已否决 / 已跳过), and the step being generated NOW is marked separately: 「which step is next」 and
 * 「what is already accepted」 are the two facts the acceptance is about.
 *
 * WHY THE FIELD LIST IS DERIVED FROM THE CARD'S OWN INVENTORY
 * A field-level action has to name a PAYLOAD PATH, because that is what the scope gate compares and what
 * the model is sent. `co-create/plan.ts`'s `patchPathsOf(kind)` is already derived from the editor's own
 * descriptor tables, so the list here cannot name a field the form does not render, and cannot miss one
 * it does. The label is the form's own, so the author reads the same word here as beside the control.
 *
 * WHY 「撤销」 SITS IN THE PREVIEW PANE'S FOOTER
 * Because it undoes what was APPLIED, and what was applied is what the card now contains. Putting it
 * beside 采纳 / 否决 would make it look like a third answer to the pending proposal — the confusion
 * `docs/06` §2.2's 「补丁可回退」 must not create: 否决 is "do not apply this", 撤销 is "take back the
 * one I applied".
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { Id } from '@smarttavern/schema';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from '../i18n/use-translation';
import type { CoCreateGeneration, GenerationStepState } from '../state/co-create-store';
import { useCoCreateStore } from '../state/co-create-store';
import { useContentStore } from '../state/content-store';
import { patchPathsOf } from './plan';
import {
  type CardKind,
  cardTargetOf,
  type FieldOpKind,
  type PatchPath,
  type PatchVerb,
  type ProposalPreview,
  type ProposalRefusal,
  previewProposal,
} from './target';

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
  /** Which card this is. It decides the inventory, the target and the extra assessment button. */
  readonly kind: CardKind;
  /** The open card's id. The conversation is dropped when it changes — see the effect below. */
  readonly id: Id;
  /** The same value the editor's form is rendering — the card as it stands right now. */
  readonly data: unknown;
}

export function CoCreatePanel({ kind, id, data }: CoCreatePanelProps) {
  const { t } = useTranslation();
  const turns = useCoCreateStore((state) => state.turns);
  const proposals = useCoCreateStore((state) => state.proposals);
  const pendingId = useCoCreateStore((state) => state.pendingId);
  const undoable = useCoCreateStore((state) => state.undoable);
  const busy = useCoCreateStore((state) => state.busy);
  const finding = useCoCreateStore((state) => state.finding);
  const generation = useCoCreateStore((state) => state.generation);
  const fieldOp = useCoCreateStore((state) => state.fieldOp);
  const voiceEvaluation = useCoCreateStore((state) => state.voiceEvaluation);
  const openFor = useCoCreateStore((state) => state.openFor);
  const startGeneration = useCoCreateStore((state) => state.startGeneration);
  const startFieldGeneration = useCoCreateStore((state) => state.startFieldGeneration);
  const generateStep = useCoCreateStore((state) => state.generateStep);
  const skipStep = useCoCreateStore((state) => state.skipStep);
  const cancelGeneration = useCoCreateStore((state) => state.cancelGeneration);
  const askFieldOp = useCoCreateStore((state) => state.askFieldOp);
  const askVoiceEvaluation = useCoCreateStore((state) => state.askVoiceEvaluation);
  const send = useCoCreateStore((state) => state.send);
  const accept = useCoCreateStore((state) => state.accept);
  const reject = useCoCreateStore((state) => state.reject);
  const undoAccept = useCoCreateStore((state) => state.undoAccept);
  const reset = useCoCreateStore((state) => state.reset);
  const [input, setInput] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);

  const inventory = patchPathsOf(kind);
  const target = cardTargetOf(kind);
  // The world a character is generated against (M1-C2), and the library to choose from.
  const worlds = useContentStore((state) => state.worlds);
  const loadWorlds = useContentStore((state) => state.loadWorlds);
  const worldId = useCoCreateStore((state) => state.worldId);
  const loadWorld = useCoCreateStore((state) => state.loadWorld);

  /*
   * A character's picker lists the WORLD LIBRARY, which nothing else on this route reads — opening a
   * character does not open a world. The read is guarded to the character panel so a world card's own
   * co-creation does not pay for a list it never shows (`state/content-store.ts` holds the list, so the
   * second open is a no-op the store already owns).
   */
  useEffect(() => {
    if (kind === 'character') void loadWorlds();
  }, [kind, loadWorlds]);

  /*
   * ONE CONVERSATION PER CARD. The store's state is in memory (its header records why), so a proposal
   * computed against world A would otherwise still be on screen — and still 采纳-able — after the user
   * navigated to world B or to a character.
   *
   * TWO EFFECTS, TWO JOBS: this one tells the STORE which card the panel is about (so nothing can be
   * previewed or applied against the other draft), and the one below drops the conversation when the
   * CARD changed.
   */
  useEffect(() => {
    openFor(kind);
  }, [kind, openFor]);

  /*
   * WHY THE GUARD READS THE ID INSIDE THE EFFECT rather than resetting unconditionally with `id` merely
   * listed as a dependency: React runs the cleanup of the OLD effect before the new one only when the
   * dependencies CHANGE, so an unconditional cleanup already runs exactly on a card change — but a
   * dependency the effect never reads is a dependency the linter (rightly) refuses, and a future
   * refactor could drop it silently. Comparing the id the effect was created for against the id that is
   * current makes the rule "reset only when the CARD changed" explicit, and it keeps a panel that is
   * toggled shut and open — a remount with the SAME id — holding its conversation.
   */
  useEffect(() => {
    return () => {
      const content = useContentStore.getState();
      const current = kind === 'world' ? content.world?.id : content.character?.id;
      if (current !== id) reset();
    };
  }, [kind, id, reset]);

  // The pending proposal, read from the list rather than held as a second copy: `send` installs it and
  // `accept` / `reject` move its status in the same list.
  const pending = proposals.find((entry) => entry.proposal.id === pendingId);
  const preview =
    pending === undefined ? undefined : previewProposal(target, data, pending.proposal);
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
        生成模式 (M1-W3) and 字段级 AI 操作 (M1-W4). ABOVE the conversation because they are entrances to
        it rather than parts of it: each one starts a request of its own, and the proposal it produces is
        answered in the pane below by the same 采纳 / 否决 pair as any other turn.
      */}
      <GenerationControls
        kind={kind}
        inventory={inventory}
        generation={generation}
        busy={busy}
        pending={pending !== undefined}
        nextStep={nextStep}
        fieldOp={fieldOp}
        chosen={chosen}
        worlds={worlds}
        worldId={worldId}
        onWorldChange={(next) => {
          void loadWorld(next);
        }}
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
        onVoiceEvaluate={() => {
          void askVoiceEvaluation();
        }}
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
                      path: op.path,
                    })}
                  </li>
                ))}
              </ul>
              {pending.proposal.rationale === undefined ? null : (
                <p className="muted">{pending.proposal.rationale}</p>
              )}
              {/* M1-C3's 「并给出理由」, beside the values it explains: the model's own rationale when it
                  gave one, else the sentence the instruction asked with. */}
              {voiceEvaluation === undefined ? null : (
                <p className="muted" data-status="co-create-voice-reason">
                  {t('co-create.voiceReasoning', { detail: voiceEvaluation.reason })}
                </p>
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
 * 生成模式, 字段级 AI 操作 and (M1-C3) 发言档案评估: the three entrances this panel adds.
 *
 * WHY THEY SHARE ONE COMPONENT: they are one walk with three errands. 从零生成 walks every step of the
 * plan, 生成选中的字段 walks the steps the ticked fields belong to, a field gesture runs a one-step plan,
 * and the assessment is a scope over the profile — the same plan list, the same 生成下一步 / 跳过这一步 /
 * 停止生成 controls and the same per-field buttons drive all of them, which is what "the modes share the
 * step and proposal machinery" looks like on screen. Every one starts a request through the store and is
 * ANSWERED by the same 采纳 / 否决 pair in the preview pane below.
 */
function GenerationControls({
  kind,
  inventory,
  generation,
  busy,
  pending,
  nextStep,
  fieldOp,
  chosen,
  worlds,
  worldId,
  onWorldChange,
  onStart,
  onFieldSetStart,
  onGenerateStep,
  onSkipStep,
  onCancel,
  onFieldOp,
  onToggleChosen,
  onVoiceEvaluate,
}: {
  readonly kind: CardKind;
  readonly inventory: readonly PatchPath[];
  readonly generation: CoCreateGeneration | undefined;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly nextStep: number | undefined;
  readonly fieldOp: { readonly path: string; readonly fieldOp: FieldOpKind } | undefined;
  readonly chosen: readonly string[];
  readonly worlds: readonly { readonly id: string; readonly name: string }[];
  readonly worldId: string | undefined;
  readonly onWorldChange: (worldId: string | undefined) => void;
  readonly onStart: () => void;
  readonly onFieldSetStart: () => void;
  readonly onGenerateStep: () => void;
  readonly onSkipStep: () => void;
  readonly onCancel: () => void;
  readonly onFieldOp: (path: string, op: FieldOpKind) => void;
  readonly onToggleChosen: (path: string) => void;
  readonly onVoiceEvaluate: () => void;
}) {
  const { t } = useTranslation();
  // The field a gesture will be run on. Local state, because it is a selection rather than a fact about
  // the card or the conversation: choosing a field writes nothing, and the gesture is what sends.
  const [selected, setSelected] = useState(inventory[0]?.path ?? '');
  const running = generation !== undefined && generation.status === 'running';
  const total = generation?.plan.steps.length ?? 0;
  const current = generation === undefined ? 0 : generation.current + 1;
  // A field gesture is offered when no request is in flight, no step proposal is waiting for an answer,
  // and no plan still has a step to generate — one turn at a time is the store's own rule, and a control
  // that could break it would be a button that reports an error instead of doing what it says.
  // `nextStep === undefined` and not merely `!running`: a FINISHED walk must not hold the field actions
  // hostage, because working on one field by hand is what the author does next
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
            {/* 从零生成 is offered while no plan is running, 停止生成 while one is: one control for the act
                that is possible now, rather than a disabled button for the one that is not. */}
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
            {/* 生成下一步 stays available whenever the plan has a pending step: after a refusal it is how
                the author resumes (the automatic walk stopped — the store's header says why), and after a
                stop it is how they restart the one thing they stopped. */}
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
                {inventory.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {t(entry.label)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="btn-row">
            {/* The three gestures of docs/06 §2.5 (重写 / 扩写 / 精简): each takes one field, so each is one
                button and the title says which gesture the pending proposal is. */}
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
                field: fieldLabel(inventory, fieldOp.path, t),
              })}
            </p>
          )}

          {/*
            M1-C2 (docs/06 §2.3): 发言档案自动评估 is offered ONLY on a character card, and so is the picker
            that names the WORLD the character is generated INTO — 「基于所选世界的生成」. The picker lives
            here because opening a character CLOSES the world in the editor, so "which world" is a choice
            the author has to make for this card rather than something the open editor still holds
            (`state/co-create-store.ts`'s `loadWorld` reads it by id and keeps only its payload).
          */}
          {kind !== 'character' ? null : (
            <div className="co-create-voice">
              <h5 className="row-list-title">{t('co-create.voiceTitle')}</h5>
              <p className="muted">{t('co-create.voiceHint')}</p>
              <div className="btn-row">
                <label className="field">
                  <span>{t('co-create.voiceWorldLabel')}</span>
                  <select
                    data-field="co-create-world"
                    value={worldId ?? ''}
                    onChange={(event) => {
                      const next = event.target.value;
                      onWorldChange(next === '' ? undefined : next);
                    }}
                  >
                    <option value="">{t('co-create.voiceWorldNone')}</option>
                    {worlds.map((world) => (
                      <option key={world.id} value={world.id}>
                        {world.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="btn-row">
                <button
                  className="btn"
                  type="button"
                  data-action="co-create-voice-evaluate"
                  disabled={fieldDisabled}
                  onClick={onVoiceEvaluate}
                >
                  {t('co-create.voiceEvaluate')}
                </button>
              </div>
            </div>
          )}

          {/*
            逐字段生成: the SAME steps as 从零生成, chosen instead of walked. A ticked field is generated by
            the step that owns it, so the per-request scope is identical in both modes — the tick list is
            the form's field inventory (`co-create/plan.ts` derives it from the editor's own descriptor
            tables), not a second list of controls.
          */}
          <h5 className="row-list-title">{t('co-create.selectedTitle')}</h5>
          <ul className="co-create-field-list" data-list="co-create-field-picks">
            {inventory.map((entry) => (
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
  inventory: readonly PatchPath[],
  path: string,
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string,
): string {
  const entry = inventory.find((candidate) => candidate.path === path);
  return entry === undefined ? path : t(entry.label);
}

/**
 * A path as a stable DOM key: `/regions` -> `regions`, `/voice/roles` -> `voice-roles`.
 *
 * A KEY AND NOT AN INDEX: the field list is the form's inventory and does not reorder today, but a
 * position-keyed checkbox is exactly the construct that silently keeps the wrong tick when it does.
 */
function fieldKey(path: string): string {
  return path.replace(/^\//, '').split('/').join('-');
}

/** The proposed payload, as the pane that previews it. Renders nothing when there is no proposal. */
function PreviewBody({ preview }: { preview: ProposalPreview<unknown> | undefined }) {
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
 * Two refusals, two sentences: an OPERATION the engine refused (naming the verb and the pointer) and a
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
