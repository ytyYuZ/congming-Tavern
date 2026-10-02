/**
 * The card editors' input primitives (M1-W1 / M1-C1): the generic field renderers, the list
 * editors, and the custom-field panel.
 *
 * WHY THE FIELDS ARE RENDERED FROM DESCRIPTOR TABLES
 * A world and a character have ~40 and ~50 leaves, and 「字段完整」 has to be checkable rather than
 * remembered. The tables live in `cards/world.ts` / `cards/character.ts` (`TextFieldSpec` and
 * friends), a test compares them against the entity schema, and this file knows only how to turn
 * ONE descriptor into ONE control. Adding a field is therefore one line in a table, and it cannot
 * be a field the completeness check does not see.
 *
 * WHY THE FIELD IS ALWAYS THE THING THAT CHANGES THE WHOLE VALUE
 * Every control calls `onChange(nextWholeValue)`: the payload is immutable (`cards/fields.ts`
 * returns new objects), so a component never holds a fragment of it and two controls cannot
 * disagree about what the document is. A half-typed value therefore lives in the PAYLOAD — an
 * empty tag line, a cleared name — which is exactly what the draft row is written from.
 *
 * WHY THE NUMBER INPUT KEEPS ITS TEXT ONLY AS LONG AS IT PARSES
 * A number control's DOM value is a string: `''` is a cleared optional field, `'abc'` is not a
 * number at all. So an input that does not parse is IGNORED rather than coerced (`Number('')` is
 * `0`, i.e. a cleared field would silently become a legal-looking zero), and the refusals are the
 * validation panel's business. Clearing a REQUIRED number writes `0`, because the schema's own
 * `positive()` rule is what should say so — reported, not clamped.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { Extensions } from '@smarttavern/schema';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  customFieldsOf,
  withCustomField,
  withCustomFieldValue,
  withoutCustomField,
} from '../cards/extensions';
import {
  appendItem,
  type BooleanFieldSpec,
  itemsOfLines,
  linesOf,
  moveItem,
  type NumberFieldSpec,
  removeItem,
  type StringListFieldSpec,
  type TextFieldSpec,
  withItem,
} from '../cards/fields';
import { useTranslation } from '../i18n/use-translation';

/* ────────────────────────────── stable row keys ──────────────────────────── */

/**
 * A row key that is unique inside one editor and is NEVER persisted.
 *
 * WHY A COUNTER AND NOT `key={index}`: Biome's `noArrayIndexKey` refuses an index key, and it is
 * right to — a list whose rows can be added, moved and removed re-uses an index for a different
 * item. WHY NOT A KEY DERIVED FROM THE VALUE: an editable row would get a new key on every
 * keystroke, React would unmount the input and the caret would jump out of the field the user is
 * typing in. These keys are stable for as long as a row exists, which is all React needs, and the
 * module counter is safe because a key only ever has to be unique among its siblings.
 */
let rowKeySequence = 0;

function nextRowKey(): string {
  rowKeySequence += 1;
  return `row-${rowKeySequence}`;
}

/**
 * One key per row, reconciled to the list's LENGTH during render.
 *
 * The list's length is the only thing these keys depend on, and every change to the list goes
 * through the same `onChange` this hook's component wraps — so the keys cannot disagree with the
 * payload about how many rows there are. Adjusting state during render is React's documented
 * pattern for "the props changed, recompute what I derived from them" (`play.tsx`'s
 * `useSessionDraft` records why an effect is the wrong tool here).
 */
function useRowKeys(count: number): readonly string[] {
  const [keys, setKeys] = useState<readonly string[]>([]);
  if (keys.length !== count) {
    const next = Array.from(
      { length: count },
      (_unused, position) => keys[position] ?? nextRowKey(),
    );
    setKeys(next);
    return next;
  }
  return keys;
}

/* ─────────────────────────── the plain field kinds ───────────────────────── */

/** Text fields over one object (`WorldData`, `rulesOfNature`, a region row, …). */
export function TextFields<S extends object>({
  scope,
  fields,
  value,
  onChange,
}: {
  /** Prefix for the DOM ids and the `data-field` markers: `world`, `region-2`, … */
  scope: string;
  fields: readonly TextFieldSpec<S>[];
  value: S;
  onChange: (next: S) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((field) => {
        const id = `${scope}-${field.key}`;
        const text = String(value[field.key]);
        const write = (next: string): void => {
          onChange(Object.assign({ ...value }, { [field.key]: next }));
        };
        return (
          <div className="field" key={id}>
            <label htmlFor={id}>{t(field.label)}</label>
            {field.multiline === true ? (
              <textarea
                id={id}
                data-field={id}
                rows={3}
                value={text}
                onChange={(event) => write(event.target.value)}
              />
            ) : (
              <input
                id={id}
                data-field={id}
                value={text}
                onChange={(event) => write(event.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Numeric fields over one object. See the header for the empty-input rule. */
export function NumberFields<S extends object>({
  scope,
  fields,
  value,
  onChange,
}: {
  scope: string;
  fields: readonly NumberFieldSpec<S>[];
  value: S;
  onChange: (next: S) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((field) => {
        const id = `${scope}-${field.key}`;
        const current: unknown = value[field.key];
        const text = typeof current === 'number' && Number.isFinite(current) ? String(current) : '';
        const write = (raw: string): void => {
          const trimmed = raw.trim();
          if (trimmed === '') {
            // An OPTIONAL number is "not set" (`CharacterData.sampling`), and a required one is the
            // schema's to refuse — `0` is what the user sees and what the panel explains.
            onChange(
              Object.assign({ ...value }, { [field.key]: field.optional === true ? undefined : 0 }),
            );
            return;
          }
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) return;
          onChange(Object.assign({ ...value }, { [field.key]: parsed }));
        };
        return (
          <div className="field" key={id}>
            <label htmlFor={id}>{t(field.label)}</label>
            <input
              id={id}
              data-field={id}
              type="number"
              inputMode="numeric"
              step={field.integer === true ? 1 : 'any'}
              {...(field.min === undefined ? {} : { min: field.min })}
              {...(field.max === undefined ? {} : { max: field.max })}
              value={text}
              onChange={(event) => write(event.target.value)}
            />
          </div>
        );
      })}
    </>
  );
}

/** Checkboxes over one object (`timeRhythm.implicitAdvance` today). */
export function BooleanFields<S extends object>({
  scope,
  fields,
  value,
  onChange,
}: {
  scope: string;
  fields: readonly BooleanFieldSpec<S>[];
  value: S;
  onChange: (next: S) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((field) => {
        const id = `${scope}-${field.key}`;
        return (
          <div className="field field-check" key={id}>
            <label htmlFor={id}>
              <input
                id={id}
                data-field={id}
                type="checkbox"
                checked={value[field.key] === true}
                onChange={(event) => {
                  onChange(Object.assign({ ...value }, { [field.key]: event.target.checked }));
                }}
              />
              {t(field.label)}
            </label>
          </div>
        );
      })}
    </>
  );
}

/* ──────────────────────────────── the lists ──────────────────────────────── */

/**
 * A line-oriented string list: one item per line in ONE textarea.
 *
 * WHY NOT A ROW PER ITEM: `z.array(z.string())` gives an item no identity, and a row would need
 * one (see `useRowKeys`). A single textarea makes the list one value with one caret, which is what
 * the data is; `cards/fields.ts`'s `linesOf`/`itemsOfLines` are the exact round trip that keeps a
 * half-typed line from moving the caret.
 */
export function LineListField<S extends object>({
  scope,
  field,
  value,
  onChange,
}: {
  scope: string;
  field: StringListFieldSpec<S>;
  value: S;
  onChange: (next: S) => void;
}) {
  const { t } = useTranslation();
  const items = value[field.key];
  const id = `${scope}-${field.key}`;
  return (
    <div className="field">
      <label htmlFor={id}>{t(field.label)}</label>
      <textarea
        id={id}
        data-field={id}
        rows={3}
        value={linesOf(Array.isArray(items) ? items : [])}
        onChange={(event) => {
          onChange(Object.assign({ ...value }, { [field.key]: itemsOfLines(event.target.value) }));
        }}
      />
      <span className="muted">{t('common.onePerLine')}</span>
    </div>
  );
}

/**
 * A PROSE string list: one textarea per item, because an item may contain line breaks.
 *
 * `alternate_greetings` is the one list of this shape (a greeting is a whole message), and the
 * two list controls are separate components rather than one with a flag so the markup difference
 * stays visible at the call site.
 */
export function ProseListField<S extends object>({
  scope,
  field,
  value,
  onChange,
}: {
  scope: string;
  field: StringListFieldSpec<S>;
  value: S;
  onChange: (next: S) => void;
}) {
  const { t } = useTranslation();
  const items = value[field.key];
  const list = Array.isArray(items) ? items : [];
  const keys = useRowKeys(list.length);
  const id = `${scope}-${field.key}`;
  const write = (next: readonly string[]): void => {
    onChange(Object.assign({ ...value }, { [field.key]: [...next] }));
  };
  return (
    <section className="row-list" data-list={id}>
      <h4 className="row-list-title">{t(field.label)}</h4>
      {list.length === 0 ? (
        <p className="muted">{t('common.emptyList')}</p>
      ) : (
        <ul className="row-list-items">
          {list.map((item, index) => {
            const key = keys[index];
            if (key === undefined) return null;
            return (
              <li className="row-list-row" key={key}>
                <label className="field">
                  <span className="sr-only">{t(field.label)}</span>
                  <textarea
                    data-field={`${id}-${index}`}
                    rows={3}
                    value={item}
                    onChange={(event) => write(withItem(list, index, event.target.value))}
                  />
                </label>
                <div className="btn-row">
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={index === 0}
                    onClick={() => write(moveItem(list, index, -1))}
                  >
                    {t('common.moveUp')}
                  </button>
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={index === list.length - 1}
                    onClick={() => write(moveItem(list, index, 1))}
                  >
                    {t('common.moveDown')}
                  </button>
                  <button
                    className="btn btn-small"
                    type="button"
                    onClick={() => write(removeItem(list, index))}
                  >
                    {t('common.removeItem')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button className="btn" type="button" onClick={() => write(appendItem(list, ''))}>
        {t('common.addItem')}
      </button>
    </section>
  );
}

/**
 * A list of COMPOSITE rows (地区 / 势力 / 月份 / 时段 / 服装 / 表情 / 参考图).
 *
 * The rows are the caller's markup: `render` receives one row and an `update` that replaces THAT
 * row and nothing else, so a list editor never has to know which fields a region has. The row
 * controls (上移 / 下移 / 删除) are here, once, because they are the same act on every list and the
 * `cards/fields.ts` transitions they call are what keeps the input list untouched.
 */
export function RowList<T>({
  scope,
  label,
  items,
  onChange,
  blank,
  render,
}: {
  scope: string;
  label: MessageKey;
  items: readonly T[];
  onChange: (next: readonly T[]) => void;
  /** The value a new row starts from: a blank factory from `cards/world.ts` / `cards/character.ts`. */
  blank: () => T;
  /**
   * One row's markup. `update` replaces THAT row and nothing else; `index` is the row's position,
   * which is what the DOM ids are derived from — a row's own id may be minted (`blankRegion`), and
   * an id nobody can predict is an id a test cannot address.
   */
  render: (item: T, update: (next: T) => void, index: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const keys = useRowKeys(items.length);
  return (
    <section className="row-list" data-list={scope}>
      <h4 className="row-list-title">{t(label)}</h4>
      {items.length === 0 ? (
        <p className="muted">{t('common.emptyList')}</p>
      ) : (
        <ul className="row-list-items">
          {items.map((item, index) => {
            const key = keys[index];
            if (key === undefined) return null;
            return (
              <li className="row-list-row" key={key}>
                {render(item, (next) => onChange(withItem(items, index, next)), index)}
                <div className="btn-row">
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={index === 0}
                    onClick={() => onChange(moveItem(items, index, -1))}
                  >
                    {t('common.moveUp')}
                  </button>
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={index === items.length - 1}
                    onClick={() => onChange(moveItem(items, index, 1))}
                  >
                    {t('common.moveDown')}
                  </button>
                  <button
                    className="btn btn-small"
                    type="button"
                    onClick={() => onChange(removeItem(items, index))}
                  >
                    {t('common.removeItem')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button className="btn" type="button" onClick={() => onChange(appendItem(items, blank()))}>
        {t('common.addItem')}
      </button>
    </section>
  );
}

/* ───────────────────────────── 自定义字段 (M1-W1) ─────────────────────────── */

/**
 * The custom-field panel: the user's own key/value pairs, stored in the version envelope's
 * `extensions` bag (`cards/extensions.ts` records why that is the only channel).
 *
 * WHY THE LABEL IS NOT EDITABLE IN PLACE: the derived key IS the field's identity, so renaming is
 * a delete plus an add — the same rule the status bar's variable rows follow, and the reason the
 * panel's hint says so out loud. WHY A REFUSAL IS A SENTENCE AND NOT A SILENT NO-OP: a label with
 * no letter or digit has no key, and a duplicate would silently overwrite the field it collides
 * with; both are refused before anything is written.
 */
export function CustomFieldsPanel({
  extensions,
  onChange,
}: {
  extensions: Extensions;
  onChange: (next: Extensions) => void;
}) {
  const { t } = useTranslation();
  const fields = customFieldsOf(extensions);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [refused, setRefused] = useState(false);

  const onAdd = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = withCustomField(extensions, name, value);
    if (next === undefined) {
      setRefused(true);
      return;
    }
    setRefused(false);
    setName('');
    setValue('');
    onChange(next);
  };

  return (
    <section className="custom-fields" data-list="custom-fields">
      <h4 className="row-list-title">{t('common.customFieldsTitle')}</h4>
      <p className="muted">{t('common.customFieldsHint')}</p>

      {fields.length === 0 ? (
        <p className="muted">{t('common.customFieldEmpty')}</p>
      ) : (
        <ul className="custom-list">
          {fields.map((field) => (
            <li className="custom-row" key={field.key} data-custom={field.key}>
              <label className="field">
                <span className="variable-name">{field.label}</span>
                <input
                  data-field={`custom-${field.key}`}
                  value={field.value}
                  onChange={(event) => {
                    onChange(
                      withCustomFieldValue(extensions, field.key, field.label, event.target.value),
                    );
                  }}
                />
              </label>
              <button
                className="btn btn-small"
                type="button"
                onClick={() => onChange(withoutCustomField(extensions, field.key))}
              >
                {t('common.removeItem')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="custom-add" onSubmit={onAdd}>
        <label className="sr-only" htmlFor="custom-field-name">
          {t('common.customFieldNameLabel')}
        </label>
        <input
          id="custom-field-name"
          data-field="custom-field-name"
          value={name}
          placeholder={t('common.customFieldNameLabel')}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="sr-only" htmlFor="custom-field-value">
          {t('common.customFieldValueLabel')}
        </label>
        <input
          id="custom-field-value"
          data-field="custom-field-value"
          value={value}
          placeholder={t('common.customFieldValueLabel')}
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="btn btn-primary" type="submit">
          {t('common.customFieldAdd')}
        </button>
      </form>

      {refused ? <p className="field-error">{t('common.customFieldRefused')}</p> : null}
    </section>
  );
}

/* ─────────────────────── labels for a validation issue ───────────────────── */

/**
 * `[dotted path, label]` pairs for one descriptor group, scoped by its prefix.
 *
 * Used to name the field a validation issue belongs to: the panel shows the form's own label for
 * a path it knows (`calendar.months`) and the raw dotted path for a member inside a list
 * (`calendar.months.0.name`), where the path is genuinely more precise than any label — it names
 * the exact row.
 */
export function labelEntries(
  scope: string,
  fields: readonly { readonly key: string; readonly label: MessageKey }[],
): [string, MessageKey][] {
  return fields.map((field) => [scope === '' ? field.key : `${scope}.${field.key}`, field.label]);
}
