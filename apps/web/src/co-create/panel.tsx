/**
 * The co-creation panel (M1-W2): the conversation on the left, the LIVE PREVIEW of the proposed card
 * on the right, and the acts the acceptance is stated over.
 *
 * WHAT THIS COMPONENT DECIDES, AND WHAT IT DOES NOT
 * It decides where the two panes are and which catalog key each line reads. It decides NO transition:
 * every gesture is a value handed to `state/co-create-store.ts`, which owns the conversation and the
 * four acts, and every write goes through `state/content-store.ts`'s autosave. It also decides no
 * PATCH ARITHMETIC: the preview's payload comes from `co-create/proposal.ts`'s
 * `previewWorldProposal`, which is the same function the store persists.
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
import { useCoCreateStore } from '../state/co-create-store';
import { useContentStore } from '../state/content-store';
import type { PatchVerb, WorldOp } from './json-patch';
import {
  opPathText,
  opTargetLabel,
  type ProposalPreview,
  type ProposalRefusal,
  previewWorldProposal,
} from './proposal';

/** The verbs as catalog keys. One table, so a second spelling cannot appear in the markup. */
const VERB_KEYS: Readonly<Record<PatchVerb, MessageKey>> = {
  add: 'co-create.verbAdd',
  remove: 'co-create.verbRemove',
  replace: 'co-create.verbReplace',
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
  const send = useCoCreateStore((state) => state.send);
  const accept = useCoCreateStore((state) => state.accept);
  const reject = useCoCreateStore((state) => state.reject);
  const undoAccept = useCoCreateStore((state) => state.undoAccept);
  const reset = useCoCreateStore((state) => state.reset);
  const [input, setInput] = useState('');

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

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const text = input.trim();
    if (busy || text === '') return;
    setInput('');
    void send(text);
  };

  return (
    <section className="co-create" aria-labelledby="co-create-title" data-panel="co-create">
      <h3 className="section-title" id="co-create-title">
        {t('co-create.title')}
      </h3>
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
