/**
 * One term, explained in place: the tooltip half of F8-3 (docs/01 §F8-3, docs/06 §10.5).
 *
 * WHY IT IS NOT `title=` AND NOT A DIV WITH `tabIndex`
 * `title=` is unreachable with the keyboard, appears after an OS-length delay, and cannot be
 * styled — three reasons the help page alone was not enough (a reader who is already on the
 * screen should not have to leave it). A plain `<div>` with `tabIndex` would enter the tab order
 * without being a control; the marker is a real `<button>` instead, because "explain this word"
 * IS an action, and a button is the element the platform already routes keyboard focus and
 * click to.
 *
 * CLICK PINS, HOVER AND FOCUS REVEAL
 * The tip shows while the pointer is over the marker or the button has focus (CSS `:hover` /
 * `:focus-within`), and a click pins it open so it can be read at leisure and copied with the
 * mouse; `aria-expanded` says whether it is pinned. There is no Escape handler and no outside
 * click listener: the tip is a CHILD of its trigger (`app.css`), so it disappears as soon as the
 * pointer and focus leave — that is the whole dismissal story.
 *
 * WHY THE STRINGS ARE KEYS AND NOT PROPS
 * These are interface copy (every term is jargon the help page already explains, in both
 * locales), so they live in the catalog like every other sentence. The four terms are the ones
 * docs/01 names: 宏 / 世界书 / token / 发言调度.
 *
 * WHY `useId` AND NOT A LITERAL ID
 * The same term is rendered on more than one screen, and a worldbook hint can repeat inside one
 * import report; a literal id would make the second copy describe the wrong element.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { useId, useState } from 'react';
import { useTranslation } from '../i18n/use-translation';

/** The jargon F8-3 asks to explain: 宏 / 世界书 / token / 发言调度. */
export type TermKey = 'macro' | 'scheduler' | 'token' | 'worldbook';

/** The accessible name of the marker ("术语：宏"), which a screen reader reads on focus. */
const TERM_LABEL: Readonly<Record<TermKey, MessageKey>> = {
  macro: 'term.macroLabel',
  scheduler: 'term.schedulerLabel',
  token: 'term.tokenLabel',
  worldbook: 'term.worldbookLabel',
};

/** The sentence the tooltip shows. */
const TERM_HINT: Readonly<Record<TermKey, MessageKey>> = {
  macro: 'term.macroHint',
  scheduler: 'term.schedulerHint',
  token: 'term.tokenHint',
  worldbook: 'term.worldbookHint',
};

export function TermHint({ term }: { readonly term: TermKey }) {
  const { t } = useTranslation();
  const hintId = useId();
  const [pinned, setPinned] = useState(false);
  return (
    <span className="term-hint" data-pinned={pinned}>
      <button
        type="button"
        className="term-hint-mark"
        aria-label={t(TERM_LABEL[term])}
        aria-describedby={hintId}
        aria-expanded={pinned}
        onClick={() => setPinned((open) => !open)}
      >
        {/* The glyph is the control's face; the name above and the description below carry the
            meaning, so the character itself is not announced separately. */}
        <span aria-hidden="true">?</span>
      </button>
      <span className="term-hint-tip" id={hintId} role="tooltip">
        {t(TERM_HINT[term])}
      </span>
    </span>
  );
}
