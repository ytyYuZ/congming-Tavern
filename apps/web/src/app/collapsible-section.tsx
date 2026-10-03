/**
 * The collapsible form section and its table of contents (acceptance fix B1).
 *
 * WHY THIS IS ONE FILE AND NOT TWO COPIES
 * The world editor and the character editor are the same design twice (see the `common.` block's
 * header in `packages/i18n/src/catalog.ts`), and the manual acceptance test made the same complaint
 * about both: a card's form is one long sequence of controls, so the section a user wants is
 * somewhere below the fold and there is no way to ask for it. Two copies of a collapse would drift —
 * one editor would keep a section open across a card change and the other would not — so the
 * behaviour lives here and each route contributes only its own SECTION LIST.
 *
 * WHY COLLAPSED MEANS `hidden` AND NOT UNMOUNTED, AND NOT `disabled`
 * A collapsed section is the same controls, still in the document, with the `hidden` attribute on
 * the container: every field keeps its value, its `id`, its `data-field` and its event handlers, so
 * nothing about the form's contract changes when it is folded away — only what is painted. That is
 * the explicit decision of the acceptance fix: the tests that drive these editors (`routes/
 * editors.test.tsx`) reach their controls by selector and assert the FIELD INVENTORY through them,
 * and an inventory cannot be proven by a tree that omits the fields. `disabled` is refused for the
 * same reason: a disabled input does not dispatch the events the autosave path is built on, and it
 * would silently stop writing the draft of a section the user is not looking at.
 *
 * WHY THERE IS NO `[hidden] { display: none }` RULE IN THE STYLESHEET
 * `hidden` is honoured by the UA stylesheet, and this app's own rules are the only thing that could
 * take that away — none of them sets `display` on a section body. A `display: none` duplicate would
 * just be a second, weaker copy of the same rule.
 *
 * WHY THE STATE IS THE ROUTE'S AND IS NOT PERSISTED
 * `useSectionOpen` is a plain `useState`, so opening a card always produces the same layout: the
 * first section open, the rest folded. Persisting it — a settings row or a session row — would make
 * the first screen a returning user sees depend on what they were doing last time, and the
 * acceptance criterion is about finding a section, not about restoring a view. It also keeps this
 * primitive free of the storage layer, which is what lets the co-creation panel (B2) reuse it.
 *
 * WHY A SECTION MAY CARRY A SUMMARY LINE (added by the play screen, B2)
 * The play screen's clock is 「常驻」 (docs/01 §F11-1): its sentence has to stay readable on the
 * screen that plays a session even though the panel it used to live in is now one fold among eight.
 * So a section may render a short trailing note in its heading — live, unlike the section list — and
 * the play screen passes the clock sentence there. The note is optional and defaults to nothing, which
 * keeps the editors' headings exactly as they were.
 *
 * WHY THE TABLE OF CONTENTS IS BUTTONS AND NOT `<a href="#id">`
 * The router is an in-memory history (`app.tsx`): an anchor's fragment would go through it, and a
 * fragment navigation is a navigation. The entry is an act on the screen, not a route, so it is a
 * `<button>` that opens the target first and then scrolls to it.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from '../i18n/use-translation';

export interface SectionDefinition {
  /** Self-describing and collision-free: see `sectionId`. */
  readonly id: string;
  /** Both the section heading and the table-of-contents entry read this one key. */
  readonly title: MessageKey;
  /** The layout on entry. Exactly one section per card form leaves this true. */
  readonly openByDefault: boolean;
}

/** Which sections of one form are open, by `SectionDefinition.id`. */
export type SectionOpenState = Readonly<Record<string, boolean>>;

/** The map handed to React: the whole next map, or a function of the current one. */
export type SetSectionOpen = (
  next: SectionOpenState | ((current: SectionOpenState) => SectionOpenState),
) => void;

/**
 * The layout a form opens with: every `openByDefault` section open, every other one folded.
 *
 * This is also the map `useSectionOpen` puts back, because a `useState` initial value is only read
 * once per mount and the reset has to be usable after the first render too.
 */
export function defaultSectionOpen(sections: readonly SectionDefinition[]): SectionOpenState {
  const state: Record<string, boolean> = {};
  for (const section of sections) state[section.id] = section.openByDefault;
  return state;
}

/** Whether one section is open. A section the map does not know is folded. */
export function isSectionOpen(state: SectionOpenState, id: string): boolean {
  return state[id] === true;
}

/** The next state with one section set to `open`. */
export function withSectionOpen(
  state: SectionOpenState,
  id: string,
  open: boolean,
): SectionOpenState {
  return { ...state, [id]: open };
}

/** The next state with one section flipped. */
export function withSectionToggled(state: SectionOpenState, id: string): SectionOpenState {
  return withSectionOpen(state, id, !isSectionOpen(state, id));
}

/**
 * The open/closed map for one form, reset whenever the FORM is replaced.
 *
 * The second argument is the identity of the thing being edited — a world or character id. A map
 * carried across cards would fold whatever the previous card had folded, and the acceptance criterion
 * is a layout a user can learn, so a card change has to produce the uniform layout.
 *
 * HOW THAT IS GUARANTEED, AND WHAT THE KEY IS FOR
 * The router replaces the route component when the card id changes (measured — a same-root re-render
 * with another id mounts a NEW instance and re-runs `useState`), so the reset does not depend on this
 * function noticing anything. The key comparison is the backstop for the day that is no longer true:
 * a changed key yields the uniform layout on the way out of the SAME render, because React re-runs a
 * component that sets state during render instead of committing the stale map. It is therefore
 * deliberately not load-bearing today, and no test can reach it — the key that would reach it also
 * replaces the instance first.
 */
export function useSectionOpen(
  sections: readonly SectionDefinition[],
  resetKey: string,
): [SectionOpenState, SetSectionOpen] {
  const [state, setState] = useState<SectionOpenState>(() => defaultSectionOpen(sections));
  const [currentKey, setCurrentKey] = useState(resetKey);
  if (currentKey !== resetKey) {
    setCurrentKey(resetKey);
    setState(defaultSectionOpen(sections));
  }
  const open = currentKey === resetKey ? state : defaultSectionOpen(sections);
  const setOpen = useCallback<SetSectionOpen>((next) => {
    setState(next);
  }, []);
  return [open, setOpen];
}

/**
 * A section's element id. Namespaced because the editor screens already own ids of their own
 * (`visual-seed-policy`, `character-issues-title`) and a bare section name would be one rename away
 * from colliding with one of them.
 */
export function sectionId(id: string): string {
  return `section-${id}`;
}

/**
 * Open the section and bring it into view — the whole of what a table-of-contents entry does.
 *
 * Both halves are optional-call on purpose: `scrollIntoView` is not implemented in jsdom, and a
 * missing element (a caller passing an id no section defines) has no target. Neither is worth
 * throwing over: the section is still open, which is the part that matters.
 */
export function jumpToSection(id: string, setOpen: SetSectionOpen): void {
  setOpen((current) => withSectionOpen(current, id, true));
  document.getElementById(sectionId(id))?.scrollIntoView?.({ block: 'start' });
}

export interface SectionTocProps {
  readonly sections: readonly SectionDefinition[];
  /**
   * Open the target section and scroll to it. The route supplies `jumpToSection` bound to its own
   * state, which is why this is one callback and not a `closed`/`onScroll` pair: opening a section
   * IS what makes it reachable, and an entry that only scrolled would leave the target folded.
   */
  readonly onJump: (id: string) => void;
}

/**
 * The table of contents above a card form: one entry per section, in the form's own order.
 *
 * It is a `<nav>` with a heading because it is navigation INSIDE one screen, and the heading is the
 * only thing that tells a screen reader what the list of buttons is for. The list is driven by the
 * SAME array the sections are, so a listed entry is by construction one that renders.
 */
export function SectionToc({ sections, onJump }: SectionTocProps) {
  const { t } = useTranslation();
  return (
    <nav className="section-toc" aria-labelledby="section-toc-title">
      <h3 className="section-toc-title" id="section-toc-title">
        {t('common.sectionsTitle')}
      </h3>
      <ul className="section-toc-list" data-list="section-toc">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              className="btn section-toc-button"
              type="button"
              data-action="section-jump"
              data-section={section.id}
              onClick={() => onJump(section.id)}
            >
              {t(section.title)}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface CollapsibleSectionProps {
  readonly section: SectionDefinition;
  readonly open: boolean;
  readonly onToggle: (id: string) => void;
  /**
   * A short trailing note in the heading, e.g. the play screen's 「当前 纪元 1 一月 1 06:30（晨）」.
   *
   * It is a PROP and not a field of `SectionDefinition` on purpose: a section definition is a module
   * constant whose values must read the same on every render, while a summary is live — the clock
   * changes when a turn advances it — and it belongs to the ROUTE (the play screen owns the session
   * it summarises), not to the section list.
   *
   * It sits INSIDE the toggle button: it is part of the heading a click acts on, so no new target is
   * invented, and the accessible name stays the one `aria-label` sets — a summary is a glance for a
   * sighted user, not a second name for the control.
   */
  readonly summary?: ReactNode;
  readonly children: ReactNode;
}

/**
 * One foldable section: a heading whose button says whether it is open, and a body that is always
 * rendered and merely hidden. See the file header for why neither half is optional.
 */
export function CollapsibleSection({
  section,
  open,
  onToggle,
  summary,
  children,
}: CollapsibleSectionProps) {
  const { t } = useTranslation();
  const headingId = `${sectionId(section.id)}-title`;
  const bodyId = `${sectionId(section.id)}-body`;
  // The label names the ACT, and it is derived from the same `open` the chevron and `aria-expanded`
  // read: a second source of truth here is exactly how a toggle ends up lying about its state.
  const label = open
    ? t('common.sectionCollapse', { name: t(section.title) })
    : t('common.sectionExpand', { name: t(section.title) });
  return (
    <section className="field-group collapsible-section" id={sectionId(section.id)}>
      <h3 className="section-title section-heading" id={headingId}>
        <button
          className="section-toggle"
          type="button"
          data-action="section-toggle"
          data-section={section.id}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={label}
          onClick={() => onToggle(section.id)}
        >
          {/* The chevron is decoration: `aria-expanded` above is what carries the state to assistive
              technology, so the glyph is neither the only nor the accessible signal. */}
          <span className="section-toggle-mark" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="section-toggle-label">{t(section.title)}</span>
          {summary === undefined ? null : (
            <span className="section-summary" data-summary={section.id}>
              {summary}
            </span>
          )}
        </button>
      </h3>
      {/* `hidden` and never a missing element — the field inventory has to stay complete. */}
      <div className="section-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
