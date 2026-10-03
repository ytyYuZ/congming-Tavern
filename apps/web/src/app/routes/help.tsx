/**
 * `/help` — the in-app guided help (C2).
 *
 * WHAT THIS SCREEN IS, AND WHAT IT DELIBERATELY IS NOT
 * It is a READABLE TOUR of the application, written as 19 short sections whose order and meaning
 * match the repository's long-form guide (`docs/07-使用指南.md`) section for section, so that a
 * reader who starts here can carry the same numbering into the document. It is NOT that document
 * rendered in the browser: the application serves one HTML bundle and no repository files, so the
 * screen points AT the document's path (see `help.docPointer`) instead of linking to a copy of it.
 *
 * WHY THE COPY LIVES IN THE CATALOG AND NOT IN THIS FILE
 * Every sentence here is a message key. `tools/scripts/check-i18n-literals.mjs` forbids bare CJK
 * text under the web application's `src` directory for exactly this reason, and the two catalogs
 * are the only place a translation can be added. The per-section KEY NAMES are the one thing this
 * file owns, because they are structure rather than copy: `HELP_BODY_KEYS[i]` is the body of
 * `HELP_SECTIONS[i]`.
 *
 * WHY THE FOLD STATE IS NOT PERSISTED
 * The folds come from `app/collapsible-section.tsx` (`useSectionOpen`), which is a plain
 * `useState` — the same primitive the world, character and play screens use. Nothing about a help
 * page belongs in the database, so this screen adds no collection and no `settings` row, and a
 * reload starts from "first section open".
 *
 * WHY THE BULLETS ARE ONE KEY EACH (newline-separated) AND NOT ONE KEY PER BULLET
 * One catalog value per section keeps the pair of catalogs diffable against each other and keeps
 * the key count at a size a reviewer can read; the split below is what turns that value into the
 * `<ul>` the reader sees. The newline is the separator the catalog documents (the same "one item
 * per line" convention `common.onePerLine` states for the user-facing fields).
 */
import type { MessageKey } from '@smarttavern/i18n';
import { useTranslation } from '../../i18n/use-translation';
import {
  CollapsibleSection,
  isSectionOpen,
  jumpToSection,
  type SectionDefinition,
  SectionToc,
  useSectionOpen,
  withSectionToggled,
} from '../collapsible-section';

/**
 * The 19 section TITLE keys, in the order `docs/07-使用指南.md` states them.
 *
 * The zero-padded numeric suffix is not decoration: catalog keys are sorted as strings, so
 * `help.sec02Title` must sort before `help.sec10Title`, and only the padding makes it do that.
 * The list is also the order of the table of contents, because both render THIS array.
 */
const HELP_TITLE_KEYS = [
  'help.sec01Title',
  'help.sec02Title',
  'help.sec03Title',
  'help.sec04Title',
  'help.sec05Title',
  'help.sec06Title',
  'help.sec07Title',
  'help.sec08Title',
  'help.sec09Title',
  'help.sec10Title',
  'help.sec11Title',
  'help.sec12Title',
  'help.sec13Title',
  'help.sec14Title',
  'help.sec15Title',
  'help.sec16Title',
  'help.sec17Title',
  'help.sec18Title',
  'help.sec19Title',
] as const satisfies readonly MessageKey[];

/** The 19 section BODY keys, index-aligned with `HELP_TITLE_KEYS` above. */
const HELP_BODY_KEYS = [
  'help.sec01',
  'help.sec02',
  'help.sec03',
  'help.sec04',
  'help.sec05',
  'help.sec06',
  'help.sec07',
  'help.sec08',
  'help.sec09',
  'help.sec10',
  'help.sec11',
  'help.sec12',
  'help.sec13',
  'help.sec14',
  'help.sec15',
  'help.sec16',
  'help.sec17',
  'help.sec18',
  'help.sec19',
] as const satisfies readonly MessageKey[];

/**
 * One section id per section, index-aligned with the two lists above.
 *
 * WHY A SHARED `sec01…` PREFIX AND NOT A WORD PER SECTION: these ids are DOM addresses
 * (`section-<id>`, the table-of-contents `data-section`) and nothing else — the NAME of a section
 * is its catalog key. Writing a second, more readable id here would create a second vocabulary to
 * keep in step with the first for no reader's benefit.
 */
const HELP_SECTION_IDS = [
  'sec01',
  'sec02',
  'sec03',
  'sec04',
  'sec05',
  'sec06',
  'sec07',
  'sec08',
  'sec09',
  'sec10',
  'sec11',
  'sec12',
  'sec13',
  'sec14',
  'sec15',
  'sec16',
  'sec17',
  'sec18',
  'sec19',
] as const;

/**
 * The sections the table of contents lists and the folds render, from ONE array.
 *
 * A single list is what keeps the directory and the document from disagreeing: every section is
 * rendered in a loop over this array, so a listed section is by construction a rendered one. The
 * first section is the only one open by default — it is the page's own introduction, and the
 * remaining eighteen are what the table of contents is for.
 */
const HELP_SECTIONS: readonly SectionDefinition[] = HELP_TITLE_KEYS.map((title, index) => ({
  id: HELP_SECTION_IDS[index] ?? '',
  title,
  openByDefault: index === 0,
}));

/**
 * The key the fold state is keyed by.
 *
 * `useSectionOpen` takes a `resetKey` so a screen can re-open its first section when the document
 * it is showing changes (a different world card, a different session). This screen always shows
 * the same document, so its key is a constant: a reload restores the default, and navigating to
 * `/help` again does not silently carry a reader's previous folds.
 */
const HELP_RESET_KEY = 'help';

/** One section's body, split into the bullet list the catalog stores as newline-separated lines. */
function bulletLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function HelpRoute() {
  const { t } = useTranslation();
  const [openSections, setOpenSections] = useSectionOpen(HELP_SECTIONS, HELP_RESET_KEY);

  return (
    <>
      <header className="help-header">
        <h2 className="help-title">{t('help.title')}</h2>
        <p className="help-intro">{t('help.intro')}</p>
        {/*
          WHERE THE LONG DOCUMENT IS. A PATH IN PROSE, not a link: the application is served from
          one bundle and does not serve repository files, so an `href` here would be a 404 dressed
          as navigation. The key's value names the file inside the repository and nothing about
          the machine it happens to be checked out on.
        */}
        <p className="help-document-preview">{t('help.documentPreview')}</p>
        <p className="help-doc-pointer">{t('help.docPointer')}</p>
      </header>

      <SectionToc
        sections={HELP_SECTIONS}
        onJump={(id) => {
          jumpToSection(id, setOpenSections);
        }}
      />

      {HELP_SECTIONS.map((section, index) => (
        <CollapsibleSection
          key={section.id}
          section={section}
          open={isSectionOpen(openSections, section.id)}
          onToggle={(id) => {
            setOpenSections((current) => withSectionToggled(current, id));
          }}
        >
          <ul className="help-points">
            {bulletLines(t(HELP_BODY_KEYS[index] ?? 'help.sec01')).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </CollapsibleSection>
      ))}

      <p className="help-footer">{t('help.footer')}</p>
    </>
  );
}
