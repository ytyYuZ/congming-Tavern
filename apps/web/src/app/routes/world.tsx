/**
 * The world-card editor (M1-W1): the grouped form, the calendar/time-rhythm settings, the custom
 * fields, and the draft → publish pair.
 *
 * WHAT THIS SCREEN DECIDES, AND WHAT IT DOES NOT
 * It decides where the controls are, which catalog key each one reads, and that a publish is only
 * offered as an explicit act. It decides NO transitions: every edit is a value handed to
 * `state/content-store.ts`, which writes the draft row, and every publish goes through the store's
 * validation gate and the repository's transaction. It also decides no ARITHMETIC: the calendar's
 * numbers are edited as data, and the only thing this screen asks about them is `worldIssues`,
 * which forwards the TimeEngine's own answer (`cards/world.ts`).
 *
 * WHY AUTOSAVE IS VISIBLE AS A RULE AND NOT AS A CONFIRMATION
 * `common.unsavedDraft` states the contract once ("autosave writes the draft; the publish button
 * makes a version"), and the only dynamic line is a FAILURE (`common.draftFailed` with the
 * exception's name). A "saved" toast on every keystroke would be noise, and a screen that shouted
 * "saved" would also be the thing that makes the publish button look redundant — which is exactly
 * the confusion ADR-010's split must not create.
 *
 * WHY THE DRAFT'S BASE VERSION IS PRINTED
 * `common.draftBase` says `草稿基于 v2；发布后成为 v4`. The two numbers differ only when another
 * tab published while this draft was open, and showing both is how that becomes visible instead of
 * being a silent merge — the version NUMBER is monotonic over the head, while the lineage records
 * the version the content was edited from (`cards/versions.ts`).
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { Calendar, WorldData } from '@smarttavern/schema';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { CardIssue } from '../../cards/fields';
import {
  blankFaction,
  blankMonth,
  blankRegion,
  blankSegment,
  CALENDAR_NUMBER_FIELDS,
  CALENDAR_TEXT_FIELDS,
  CALENDAR_WEEKDAYS_FIELD,
  FACTION_FIELDS,
  FACTION_GOALS_FIELD,
  MONTH_NUMBER_FIELDS,
  MONTH_TEXT_FIELDS,
  NARRATIVE_TEXT_FIELDS,
  NARRATIVE_THEMES_FIELD,
  REGION_FIELDS,
  REGION_TAGS_FIELD,
  RHYTHM_BOOLEAN_FIELDS,
  RHYTHM_NUMBER_FIELDS,
  RULES_FIELDS,
  SEGMENT_NUMBER_FIELDS,
  SEGMENT_TEXT_FIELDS,
  START_MINUTE_FIELD,
  WORLD_GENRE_FIELD,
  WORLD_OPENING_HOOKS_FIELD,
  WORLD_TEXT_FIELDS,
  worldIssues,
} from '../../cards/world';
import { useTranslation } from '../../i18n/use-translation';
import { useContentStore } from '../../state/content-store';
import {
  BooleanFields,
  CustomFieldsPanel,
  LineListField,
  labelEntries,
  NumberFields,
  RowList,
  TextFields,
} from '../fields';

/**
 * The label of every field a validation issue can name, from the descriptor tables the form
 * renders — so a sentence can never point at a field whose control has been renamed or removed.
 *
 * A member INSIDE a list row (`calendar.months.0.name`) has no entry here on purpose: the panel
 * then shows the dotted path, which is genuinely more precise than any of the labels (a month's
 * 「月名」 and a world's 「名称」 are two different controls, and the path says which row).
 */
const WORLD_ISSUE_LABELS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ...labelEntries('', WORLD_TEXT_FIELDS),
  ...labelEntries('rulesOfNature', RULES_FIELDS),
  ...labelEntries('narrative', NARRATIVE_TEXT_FIELDS),
  ...labelEntries('calendar', CALENDAR_TEXT_FIELDS),
  ...labelEntries('calendar', CALENDAR_NUMBER_FIELDS),
  ...labelEntries('timeRhythm', RHYTHM_NUMBER_FIELDS),
  ...labelEntries('timeRhythm', RHYTHM_BOOLEAN_FIELDS),
  ...([
    ['genre', 'world.genreLabel'],
    ['regions', 'world.regionsLabel'],
    ['factions', 'world.factionsLabel'],
    ['calendar.weekdays', 'world.weekdaysLabel'],
    ['calendar.months', 'world.monthsLabel'],
    ['calendar.segments', 'world.segmentsLabel'],
    ['calendar', 'world.calendarNameLabel'],
    ['startMinute', 'world.startMinuteLabel'],
    ['openingHooks', 'world.openingHooksLabel'],
  ] as const satisfies readonly (readonly [string, MessageKey])[]),
]);

export function WorldRoute({ worldId }: { worldId: string }) {
  const { t } = useTranslation();
  const world = useContentStore((state) => state.world);
  const draft = useContentStore((state) => state.worldDraft);
  const dirty = useContentStore((state) => state.worldDirty);
  const error = useContentStore((state) => state.error);
  const open = useContentStore((state) => state.openWorld);
  const close = useContentStore((state) => state.close);
  const edit = useContentStore((state) => state.editWorld);
  const publish = useContentStore((state) => state.publishWorld);
  const discard = useContentStore((state) => state.discardWorldDraft);
  const [status, setStatus] = useState('');

  // The route owns the open card's lifetime: opening another world (or unmounting) must not leave
  // the previous one's draft on screen (`state/content-store.ts`'s token does the same job there).
  useEffect(() => {
    void open(worldId);
    return () => close();
  }, [worldId, open, close]);

  const backLink = (
    <p className="muted">
      <Link to="/worlds">{t('world.backToLibrary')}</Link>
    </p>
  );

  if (world === undefined || draft === undefined) {
    return (
      <>
        {backLink}
        <p className="muted">{t('common.loading')}</p>
      </>
    );
  }

  const data = draft.data;
  const extensions = draft.extensions;
  const issues = worldIssues(data);
  /** One edit: the whole payload, written through the store's autosave. */
  const write = (next: WorldData): void => {
    void edit(next, extensions);
  };
  const writeCalendar = (calendar: Calendar): void => {
    write({ ...data, calendar });
  };

  const onPublish = async (): Promise<void> => {
    const published = await publish();
    setStatus(
      published
        ? t('common.published', { version: world.headVersion + 1 })
        : issues.length > 0
          ? t('common.publishRefused')
          : t('common.publishFailed'),
    );
  };

  const onDiscard = async (): Promise<void> => {
    if (await discard()) setStatus(t('common.discarded'));
  };

  return (
    <>
      {backLink}

      <header className="card-status">
        <h2 className="section-title">{world.name}</h2>
        <p className="muted">{t('common.unsavedDraft')}</p>
        <p className="muted" data-status="draft-base">
          {t('common.draftBase', {
            base: draft.baseVersion,
            next: world.headVersion + 1,
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
        </div>
        {status === '' ? null : <p className="time-status">{status}</p>}
        {error === undefined ? null : (
          <p className="notice notice-error">{t('common.draftFailed', { name: error })}</p>
        )}
      </header>

      <IssuePanel issues={issues} />

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionBasic')}</h3>
        <TextFields scope="world" fields={WORLD_TEXT_FIELDS} value={data} onChange={write} />
        <LineListField scope="world" field={WORLD_GENRE_FIELD} value={data} onChange={write} />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionRegions')}</h3>
        <RowList
          scope="world-regions"
          label="world.regionsLabel"
          items={data.regions}
          blank={blankRegion}
          onChange={(regions) => write({ ...data, regions: [...regions] })}
          render={(region, update, index) => (
            <>
              <TextFields
                scope={`region-${index}`}
                fields={REGION_FIELDS}
                value={region}
                onChange={update}
              />
              <LineListField
                scope={`region-${index}`}
                field={REGION_TAGS_FIELD}
                value={region}
                onChange={update}
              />
            </>
          )}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionFactions')}</h3>
        <RowList
          scope="world-factions"
          label="world.factionsLabel"
          items={data.factions}
          blank={blankFaction}
          onChange={(factions) => write({ ...data, factions: [...factions] })}
          render={(faction, update, index) => (
            <>
              <TextFields
                scope={`faction-${index}`}
                fields={FACTION_FIELDS}
                value={faction}
                onChange={update}
              />
              <LineListField
                scope={`faction-${index}`}
                field={FACTION_GOALS_FIELD}
                value={faction}
                onChange={update}
              />
            </>
          )}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionRules')}</h3>
        <TextFields
          scope="rules"
          fields={RULES_FIELDS}
          value={data.rulesOfNature}
          onChange={(rulesOfNature) => write({ ...data, rulesOfNature })}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionNarrative')}</h3>
        <TextFields
          scope="narrative"
          fields={NARRATIVE_TEXT_FIELDS}
          value={data.narrative}
          onChange={(narrative) => write({ ...data, narrative })}
        />
        <LineListField
          scope="narrative"
          field={NARRATIVE_THEMES_FIELD}
          value={data.narrative}
          onChange={(narrative) => write({ ...data, narrative })}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionCalendar')}</h3>
        <p className="muted">{t('world.calendarHint')}</p>
        <TextFields
          scope="calendar"
          fields={CALENDAR_TEXT_FIELDS}
          value={data.calendar}
          onChange={writeCalendar}
        />
        <NumberFields
          scope="calendar"
          fields={CALENDAR_NUMBER_FIELDS}
          value={data.calendar}
          onChange={writeCalendar}
        />
        <LineListField
          scope="calendar"
          field={CALENDAR_WEEKDAYS_FIELD}
          value={data.calendar}
          onChange={writeCalendar}
        />
        <RowList
          scope="calendar-months"
          label="world.monthsLabel"
          items={data.calendar.months}
          blank={blankMonth}
          onChange={(months) => writeCalendar({ ...data.calendar, months: [...months] })}
          render={(month, update, index) => (
            <>
              <TextFields
                scope={`month-${index}`}
                fields={MONTH_TEXT_FIELDS}
                value={month}
                onChange={update}
              />
              <NumberFields
                scope={`month-${index}`}
                fields={MONTH_NUMBER_FIELDS}
                value={month}
                onChange={update}
              />
            </>
          )}
        />
        <RowList
          scope="calendar-segments"
          label="world.segmentsLabel"
          items={data.calendar.segments}
          blank={blankSegment}
          onChange={(segments) => writeCalendar({ ...data.calendar, segments: [...segments] })}
          render={(segment, update, index) => (
            <>
              <TextFields
                scope={`segment-${index}`}
                fields={SEGMENT_TEXT_FIELDS}
                value={segment}
                onChange={update}
              />
              <NumberFields
                scope={`segment-${index}`}
                fields={SEGMENT_NUMBER_FIELDS}
                value={segment}
                onChange={update}
              />
            </>
          )}
        />
        <NumberFields scope="world" fields={[START_MINUTE_FIELD]} value={data} onChange={write} />
        <p className="muted">{t('world.startMinuteHint')}</p>
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionRhythm')}</h3>
        <p className="muted">{t('world.rhythmHint')}</p>
        <BooleanFields
          scope="rhythm"
          fields={RHYTHM_BOOLEAN_FIELDS}
          value={data.timeRhythm}
          onChange={(timeRhythm) => write({ ...data, timeRhythm })}
        />
        <NumberFields
          scope="rhythm"
          fields={RHYTHM_NUMBER_FIELDS}
          value={data.timeRhythm}
          onChange={(timeRhythm) => write({ ...data, timeRhythm })}
        />
      </section>

      <section className="field-group">
        <h3 className="section-title">{t('world.sectionOpening')}</h3>
        <LineListField
          scope="world"
          field={WORLD_OPENING_HOOKS_FIELD}
          value={data}
          onChange={write}
        />
      </section>

      <CustomFieldsPanel
        extensions={extensions}
        onChange={(next) => {
          void edit(data, next);
        }}
      />
    </>
  );
}

/**
 * The validation panel: what stands between this payload and a published version.
 *
 * It is ALWAYS rendered, including when there is nothing to report, because 「校验可用」 is an
 * acceptance criterion and a panel that only appears on failure cannot be seen to be working. The
 * sentence names the field through the form's own label when the path has one, and the schema's or
 * the engine's own words as the detail (`common.issue` documents that split).
 */
function IssuePanel({ issues }: { issues: readonly CardIssue[] }) {
  const { t } = useTranslation();
  return (
    <section className="issues" aria-labelledby="issues-title">
      <h3 className="section-title" id="issues-title">
        {t('common.issuesTitle')}
      </h3>
      {issues.length === 0 ? (
        <p className="notice notice-ok" data-status="issues-none">
          {t('common.issuesNone')}
        </p>
      ) : (
        <ul className="issue-list" data-status="issues">
          {issues.map((issue) => {
            const label = WORLD_ISSUE_LABELS.get(issue.path);
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
