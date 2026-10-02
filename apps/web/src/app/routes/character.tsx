/**
 * The character-card editor (M1-C1): the SillyTavern V2/V3 fields, the speaking profile, the
 * visual bible, the default sampling parameters and the custom fields — plus the draft → publish
 * pair every card entity shares.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT OFFER (ADR-010)
 * No 「玩家角色」 checkbox, no cast flag, no `kind` and no duplicate persona. Identity is a property
 * of the SESSION (`session.ts`'s header), and the same card has to be able to play the protagonist
 * in one session and the antagonist in the next — a control here would let a card declare something
 * the session then has to fight. `character.identityHint` says that out loud, because an ABSENT
 * control is only legible when the screen explains why (`cards/character.test.ts` pins the absence
 * against the form's own inventory, so a later edit cannot put one back quietly).
 *
 * WHERE C1 ENDS AND I1 BEGINS
 * The field NAMES are SillyTavern's, verbatim, and this editor stores them. The mapping to and from
 * a real ST card (PNG tEXt chunk / JSON, V1/V2/V3) is M1-I1's; `stExtensions` is preserved for
 * exactly that round trip and is not rendered, because its keys belong to other people's scripts.
 *
 * 视觉档案 WITHOUT AN ASSET PIPELINE (docs/06 §10.5)
 * `visual.references[].assetId` is stored and may DANGLE: no asset pipeline exists yet, so nothing
 * validates the id and nothing uploads the image. The panel says so (`character.assetsHint`)
 * rather than pretending the field is complete, and it does not grow an upload path — that is
 * M2-I5's job, and building one here would be a second owner of the asset contract.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { CharacterData, PartialSamplingParams } from '@smarttavern/schema';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  APPEARANCE_FIELDS,
  APPEARANCE_MARKS_FIELD,
  blankExpression,
  blankOutfit,
  blankReference,
  CHARACTER_GREETINGS_FIELD,
  CHARACTER_TAGS_FIELD,
  CHARACTER_TEXT_FIELDS,
  characterIssues,
  EXPRESSION_FIELDS,
  isReasoningEffort,
  isReferenceRole,
  isSeedPolicy,
  OUTFIT_FIELDS,
  REASONING_EFFORT_LABELS,
  REFERENCE_ROLE_LABELS,
  REFERENCE_TEXT_FIELDS,
  SAMPLING_NUMBER_FIELDS,
  SAMPLING_STOP_FIELD,
  SEED_POLICY_LABELS,
  STYLE_FIELDS,
  VISUAL_PARAMS_NUMBER_FIELDS,
  VISUAL_PARAMS_TEXT_FIELDS,
  VOICE_NUMBER_FIELDS,
  VOICE_ROLES_FIELD,
} from '../../cards/character';
import type { CardIssue } from '../../cards/fields';
import { CoCreatePanel } from '../../co-create/panel';
import { useTranslation } from '../../i18n/use-translation';
import { useContentStore } from '../../state/content-store';
import {
  CustomFieldsPanel,
  LineListField,
  labelEntries,
  NumberFields,
  ProseListField,
  RowList,
  TextFields,
} from '../fields';

/** The label of every field a validation issue can name (see `world.tsx` for the rule). */
const CHARACTER_ISSUE_LABELS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ...labelEntries('', CHARACTER_TEXT_FIELDS),
  ...labelEntries('voice', VOICE_NUMBER_FIELDS),
  ...labelEntries('visual.appearance', APPEARANCE_FIELDS),
  ...labelEntries('visual.style', STYLE_FIELDS),
  ...labelEntries('visual.params', VISUAL_PARAMS_TEXT_FIELDS),
  ...labelEntries('visual.params', VISUAL_PARAMS_NUMBER_FIELDS),
  ...labelEntries('sampling', SAMPLING_NUMBER_FIELDS),
  ...([
    ['tags', 'character.tagsLabel'],
    ['alternate_greetings', 'character.alternateGreetingsLabel'],
    ['voice.roles', 'character.rolesLabel'],
    ['visual.appearance.marks', 'character.marksLabel'],
    ['visual.outfits', 'character.outfitsLabel'],
    ['visual.expressions', 'character.expressionsLabel'],
    ['visual.params.seedPolicy', 'character.seedPolicyLabel'],
    ['visual.references', 'character.referencesLabel'],
    ['sampling.stop', 'character.samplingStopLabel'],
    ['sampling.reasoningEffort', 'character.samplingReasoningLabel'],
    ['customFields', 'common.customFieldsTitle'],
  ] as const satisfies readonly (readonly [string, MessageKey])[]),
]);

export function CharacterRoute({ characterId }: { characterId: string }) {
  const { t } = useTranslation();
  const character = useContentStore((state) => state.character);
  const draft = useContentStore((state) => state.characterDraft);
  const dirty = useContentStore((state) => state.characterDirty);
  const error = useContentStore((state) => state.error);
  const open = useContentStore((state) => state.openCharacter);
  const close = useContentStore((state) => state.close);
  const edit = useContentStore((state) => state.editCharacter);
  const publish = useContentStore((state) => state.publishCharacter);
  const discard = useContentStore((state) => state.discardCharacterDraft);
  const [status, setStatus] = useState('');
  /*
   * Whether the AI co-creation panel is open (M1-C2 / M1-C3).
   *
   * The same toggle the world editor has, and for the same reason: the panel carries its own composer,
   * and a form that always ends in a second textarea makes 「发布新版本」 harder to find for the author
   * who never asked for the AI. It is this ROUTE's state rather than the store's because it is a layout
   * choice, and the conversation itself lives in `state/co-create-store.ts` — which is told which card
   * the panel is about (`kind="character"`) and resets on a CARD change, not on a toggle.
   */
  const [coCreateOpen, setCoCreateOpen] = useState(false);

  useEffect(() => {
    void open(characterId);
    return () => close();
  }, [characterId, open, close]);

  const backLink = (
    <p className="muted">
      <Link to="/characters">{t('character.backToLibrary')}</Link>
    </p>
  );

  if (character === undefined || draft === undefined) {
    return (
      <>
        {backLink}
        <p className="muted">{t('common.loading')}</p>
      </>
    );
  }

  const data = draft.data;
  const extensions = draft.extensions;
  const issues = characterIssues(data);
  const write = (next: CharacterData): void => {
    void edit(next, extensions);
  };

  const onPublish = async (): Promise<void> => {
    const published = await publish();
    setStatus(
      published
        ? t('common.published', { version: character.headVersion + 1 })
        : issues.length > 0
          ? t('common.publishRefused')
          : t('common.publishFailed'),
    );
  };

  const onDiscard = async (): Promise<void> => {
    if (await discard()) setStatus(t('common.discarded'));
  };

  const sampling: PartialSamplingParams = data.sampling ?? {};

  return (
    <>
      {backLink}

      <header className="card-status">
        <h2 className="section-title">{character.name}</h2>
        <p className="muted">{t('common.unsavedDraft')}</p>
        <p className="muted" data-status="draft-base">
          {t('common.draftBase', {
            base: draft.baseVersion,
            next: character.headVersion + 1,
          })}
        </p>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              void onPublish();
            }}
          >
            {t('common.publish')}
          </button>
          <button
            className="btn"
            type="button"
            disabled={!dirty}
            onClick={() => {
              void onDiscard();
            }}
          >
            {t('common.discardDraft')}
          </button>
          {/* AI 共创 (M1-C2) and 发言档案自动评估 (M1-C3): the panel is this card's conversation, so the
              control that opens it belongs with the card's other acts rather than at the bottom of a
              long form. */}
          <button
            className="btn"
            type="button"
            data-action="co-create-toggle"
            aria-expanded={coCreateOpen}
            onClick={() => setCoCreateOpen((open) => !open)}
          >
            {coCreateOpen ? t('co-create.hide') : t('co-create.show')}
          </button>
        </div>
        {status === '' ? null : <p className="time-status">{status}</p>}
        {error === undefined ? null : (
          <p className="notice notice-error">{t('common.draftFailed', { name: error })}</p>
        )}
      </header>

      <IssuePanel issues={issues} />

      <section className="field-group">
        <h3 className="section-title">{t('character.sectionSt')}</h3>
        <p className="muted">{t('character.identityHint')}</p>
        <p className="muted">{t('character.stHint')}</p>
        <TextFields
          scope="character"
          fields={CHARACTER_TEXT_FIELDS}
          value={data}
          onChange={write}
        />
        <ProseListField
          scope="character"
          field={CHARACTER_GREETINGS_FIELD}
          value={data}
          onChange={write}
        />
        <LineListField
          scope="character"
          field={CHARACTER_TAGS_FIELD}
          value={data}
          onChange={write}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('character.sectionVoice')}</h3>
        <NumberFields
          scope="voice"
          fields={VOICE_NUMBER_FIELDS}
          value={data.voice}
          onChange={(voice) => write({ ...data, voice })}
        />
        <LineListField
          scope="voice"
          field={VOICE_ROLES_FIELD}
          value={data.voice}
          onChange={(voice) => write({ ...data, voice })}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('character.sectionVisual')}</h3>
        <TextFields
          scope="appearance"
          fields={APPEARANCE_FIELDS}
          value={data.visual.appearance}
          onChange={(appearance) => write({ ...data, visual: { ...data.visual, appearance } })}
        />
        <LineListField
          scope="appearance"
          field={APPEARANCE_MARKS_FIELD}
          value={data.visual.appearance}
          onChange={(appearance) => write({ ...data, visual: { ...data.visual, appearance } })}
        />
        <RowList
          scope="visual-outfits"
          label="character.outfitsLabel"
          items={data.visual.outfits}
          blank={blankOutfit}
          onChange={(outfits) =>
            write({ ...data, visual: { ...data.visual, outfits: [...outfits] } })
          }
          render={(outfit, update, index) => (
            <TextFields
              scope={`outfit-${index}`}
              fields={OUTFIT_FIELDS}
              value={outfit}
              onChange={update}
            />
          )}
        />
        <RowList
          scope="visual-expressions"
          label="character.expressionsLabel"
          items={data.visual.expressions}
          blank={blankExpression}
          onChange={(expressions) =>
            write({ ...data, visual: { ...data.visual, expressions: [...expressions] } })
          }
          render={(expression, update, index) => (
            <TextFields
              scope={`expression-${index}`}
              fields={EXPRESSION_FIELDS}
              value={expression}
              onChange={update}
            />
          )}
        />
        <TextFields
          scope="style"
          fields={STYLE_FIELDS}
          value={data.visual.style}
          onChange={(style) => write({ ...data, visual: { ...data.visual, style } })}
        />
        <TextFields
          scope="visual-params"
          fields={VISUAL_PARAMS_TEXT_FIELDS}
          value={data.visual.params}
          onChange={(params) => write({ ...data, visual: { ...data.visual, params } })}
        />
        <NumberFields
          scope="visual-params"
          fields={VISUAL_PARAMS_NUMBER_FIELDS}
          value={data.visual.params}
          onChange={(params) => write({ ...data, visual: { ...data.visual, params } })}
        />
        {/* The seed policy is a closed union the schema declares, so the options come from the
            label record's own keys and the handler narrows what the `<select>` hands back. */}
        <div className="field">
          <label htmlFor="visual-seed-policy">{t('character.seedPolicyLabel')}</label>
          <select
            id="visual-seed-policy"
            data-field="visual-seed-policy"
            value={data.visual.params.seedPolicy}
            onChange={(event) => {
              const next = event.target.value;
              if (!isSeedPolicy(next)) return;
              write({
                ...data,
                visual: { ...data.visual, params: { ...data.visual.params, seedPolicy: next } },
              });
            }}
          >
            {Object.entries(SEED_POLICY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </div>
        <RowList
          scope="visual-references"
          label="character.referencesLabel"
          items={data.visual.references ?? []}
          blank={blankReference}
          onChange={(references) =>
            write({ ...data, visual: { ...data.visual, references: [...references] } })
          }
          render={(reference, update, index) => (
            <>
              <TextFields
                scope={`reference-${index}`}
                fields={REFERENCE_TEXT_FIELDS}
                value={reference}
                onChange={update}
              />
              <div className="field">
                <label htmlFor={`reference-role-${index}`}>
                  {t('character.referenceRoleLabel')}
                </label>
                <select
                  id={`reference-role-${index}`}
                  data-field={`reference-${index}-role`}
                  value={reference.role}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (!isReferenceRole(next)) return;
                    update({ ...reference, role: next });
                  }}
                >
                  {Object.entries(REFERENCE_ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {t(label)}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        />
        <p className="muted">{t('character.assetsHint')}</p>
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('character.sectionSampling')}</h3>
        <p className="muted">{t('character.samplingHint')}</p>
        <NumberFields
          scope="sampling"
          fields={SAMPLING_NUMBER_FIELDS}
          value={sampling}
          onChange={(next) => write({ ...data, sampling: next })}
        />
        <LineListField
          scope="sampling"
          field={SAMPLING_STOP_FIELD}
          value={sampling}
          onChange={(next) => write({ ...data, sampling: next })}
        />
        <div className="field">
          <label htmlFor="sampling-reasoning">{t('character.samplingReasoningLabel')}</label>
          <select
            id="sampling-reasoning"
            data-field="sampling-reasoning"
            value={sampling.reasoningEffort ?? ''}
            onChange={(event) => {
              const next = event.target.value;
              // An empty option is "no override": the session's own configuration decides, which is
              // a different fact from pinning the lowest level (`samplingHint` says so).
              write({
                ...data,
                sampling:
                  next === ''
                    ? { ...sampling, reasoningEffort: undefined }
                    : isReasoningEffort(next)
                      ? { ...sampling, reasoningEffort: next }
                      : sampling,
              });
            }}
          >
            <option value="">{t('character.reasoningNone')}</option>
            {Object.entries(REASONING_EFFORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/*
        AI 共创 (M1-C2) + 发言档案自动评估 (M1-C3). It sits at the END of the form rather than in a screen
        of its own because the conversation is ABOUT the card above it: the preview pane and the editor
        render the same draft value, so an accepted proposal appears in the form without a navigation,
        and the DOM test that drives generate -> preview -> accept -> the form -> undo never has to leave
        the screen. `kind="character"` is what makes it the CHARACTER half of one shared panel.
      */}
      {coCreateOpen ? <CoCreatePanel kind="character" id={character.id} data={data} /> : null}

      <CustomFieldsPanel
        value={data.customFields ?? {}}
        onChange={(customFields) => write({ ...data, customFields })}
      />
    </>
  );
}

/** The validation panel (M1-C1): schema-only, because nothing in a card is arithmetic. */
function IssuePanel({ issues }: { issues: readonly CardIssue[] }) {
  const { t } = useTranslation();
  return (
    <section className="issues" aria-labelledby="character-issues-title">
      <h3 className="section-title" id="character-issues-title">
        {t('common.issuesTitle')}
      </h3>
      {issues.length === 0 ? (
        <p className="notice notice-ok" data-status="issues-none">
          {t('common.issuesNone')}
        </p>
      ) : (
        <ul className="issue-list" data-status="issues">
          {issues.map((issue) => {
            const label = CHARACTER_ISSUE_LABELS.get(issue.path);
            return (
              <li className="issue" key={`${issue.path}:${issue.message}`}>
                {t('common.issue', {
                  field: label === undefined ? issue.path : t(label),
                  detail: issue.message,
                })}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
