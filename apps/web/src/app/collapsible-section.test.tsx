/**
 * The foldable card sections and their table of contents (acceptance fix B1), on the WORLD EDITOR
 * and the CHARACTER EDITOR as screens.
 *
 * WHY THIS DRIVES THE REAL APP RATHER THAN RENDERING `<CollapsibleSection>` ALONE
 * The primitive can be correct and still not be what the editors use — a route could keep its own
 * boolean, or mount the sections without a table of contents. The acceptance criterion is about the
 * SCREEN (「长表单要分节、有目录、能跳」), so the tests below mount the real `<App/>` at the real
 * path, click the real entries and the real headings, and read the real attributes. The seeding is
 * through `db/repository.ts` (`createWorld` / `createCharacter`) so the screen is reached the way a
 * returning user reaches it.
 *
 * WHY THE ASSERTIONS ARE ABOUT `hidden` AND NOT ABOUT WHAT IS PAINTED
 * jsdom lays nothing out, and a VIEWPORT claim is not what this fix promises. What it promises is the
 * pairing of two states — the body carries `hidden` exactly when the button says `aria-expanded="false"`
 * — and that pairing is assertable here without a layout engine.
 *
 * WHY A FOLDED SECTION MUST STILL BE IN THE DOCUMENT
 * `routes/editors.test.tsx` proves the field inventory by SELECTOR, and it may not be edited, so a
 * section that unmounted when it closed would delete fields from that inventory. Every assertion
 * below that reaches a control inside a folded section is therefore also a guard on that rule — the
 * consequence of collapsing is a `hidden` attribute and nothing else.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blankCharacterData } from '../cards/character';
import { blankWorldData } from '../cards/world';
import { closeDatabase, resetDatabase } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import { createCharacter, createWorld, writeLocaleSetting } from '../db/repository';
// The stores come from `mount`, not from `state/*`: Vitest instantiates a module per environment, and
// a store reached through another graph would be a different object from the one the mounted views
// read (see `mount.ts`'s re-export note).
import {
  configureChat,
  resetChat,
  resetContentStore,
  resetLocaleStore,
  resetSettingsStore,
  useLocaleStore,
} from '../mount';
import { App, createAppRouter } from './app';
import {
  CollapsibleSection,
  defaultSectionOpen,
  isSectionOpen,
  type SectionDefinition,
  type SectionOpenState,
  SectionToc,
  useSectionOpen,
  withSectionToggled,
} from './collapsible-section';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;
/** The live router, kept so a test can navigate the screen it is looking at instead of re-rendering. */
const routers: ReturnType<typeof createAppRouter>[] = [];

/** A transport that fails loudly: no screen under test sends anything. */
const forbiddenTransport: FetchLike = () =>
  Promise.reject(new Error('no transport was substituted for this test'));

const originalScrollTo = window.scrollTo;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => undefined;
});

afterAll(() => {
  window.scrollTo = originalScrollTo;
});

beforeEach(async () => {
  databases += 1;
  databaseName = `apps-web-app-collapsible-section-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  configureChat({ transport: forbiddenTransport });
  // This file asserts RENDERED Chinese copy, so the language is pinned the way `routes/editors.test.tsx`
  // pins it: the STORED row, which the shell's own `load()` adopts.
  await writeLocaleSetting('zh-CN');
  useLocaleStore.setState({ locale: 'zh-CN' });
});

afterEach(async () => {
  await unmount();
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ───────────────────────────── the local harness ─────────────────────────── */

async function mountAt(path: string, expected: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  container = host;
  const router = createAppRouter(path);
  routers.push(router);
  await act(async () => {
    root = createRoot(host);
    root.render(<App router={router} />);
  });
  await waitForText(host, expected);
  await settle();
  return host;
}

async function waitForText(host: Element, expected: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((host.textContent ?? '').includes(expected)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected}; DOM was: ${host.innerHTML}`);
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function unmount(): Promise<void> {
  const current = root;
  root = undefined;
  if (current !== undefined) {
    await act(async () => {
      current.unmount();
    });
  }
  container?.remove();
  container = undefined;
  routers.length = 0;
}

/** Click one element the way a user does, then let the re-render land. */
async function click(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/**
 * One section, as the screen presents it: the heading's button, the body it controls, and whether the
 * body is folded.
 *
 * `querySelector` cannot throw the way a non-null assertion would be absent from the report, so the
 * lookups throw here with the section's own name in the message.
 */
function sectionOf(host: Element, id: string): { toggle: Element; body: Element } {
  const toggle = host.querySelector(`[data-action="section-toggle"][data-section="${id}"]`);
  const body = host.querySelector(`#section-${id}-body`);
  if (toggle === null || body === null) throw new Error(`no section ${id} on screen`);
  return { toggle, body };
}

/** Whether one table-of-contents entry's target is folded, via the entry's own `data-section`. */
function bodyOf(host: Element, id: string): Element {
  const body = host.querySelector(`#section-${id}-body`);
  if (body === null) throw new Error(`no section body ${id} on screen`);
  return body;
}

/* ────────────────────────────── the world editor ─────────────────────────── */

describe('the world editor’s sections (fix B1)', () => {
  /** Mount `/#/worlds/$worldId` for a freshly seeded world and return the host. */
  async function openWorld(): Promise<HTMLElement> {
    const created = await createWorld({ name: '银松群岛', data: blankWorldData('银松群岛') });
    if (created === undefined) throw new Error('the seeded world was refused by the schema');
    return mountAt(`/worlds/${created.world.id}`, '发布新版本');
  }

  it('groups the form into eight sections with one table-of-contents entry each', async () => {
    const host = await openWorld();
    const entries = host.querySelectorAll('[data-list="section-toc"] [data-action="section-jump"]');
    const headings = host.querySelectorAll('[data-action="section-toggle"]');
    expect(entries.length).toBe(8);
    expect(headings.length).toBe(8);

    // The SAME eight, in the SAME order, said once: the table of contents is the section list.
    const fromToc = Array.from(entries).map((entry) => entry.getAttribute('data-section'));
    const fromHeadings = Array.from(headings).map((heading) =>
      heading.getAttribute('data-section'),
    );
    expect(fromToc).toEqual(fromHeadings);
    expect(fromToc).toEqual([
      'basic',
      'regions',
      'factions',
      'rules',
      'narrative',
      'calendar',
      'rhythm',
      'opening',
    ]);
  });

  it('opens with the first section open and every other one folded', async () => {
    const host = await openWorld();
    for (const id of [
      'regions',
      'factions',
      'rules',
      'narrative',
      'calendar',
      'rhythm',
      'opening',
    ]) {
      const { toggle, body } = sectionOf(host, id);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(body.hasAttribute('hidden')).toBe(true);
    }
    const basic = sectionOf(host, 'basic');
    expect(basic.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(basic.body.hasAttribute('hidden')).toBe(false);
  });

  it('keeps a folded section’s controls in the document, so the field inventory is unchanged', async () => {
    const host = await openWorld();
    // 历法与时间 and 时间节奏 are both folded, and both still hold their controls.
    expect(bodyOf(host, 'calendar').hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('[data-field="calendar-minutesPerHour"]')).not.toBeNull();
    expect(bodyOf(host, 'rhythm').hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('[data-field="rhythm-advanceEveryTurns"]')).not.toBeNull();
  });

  it('opens the target section from its table-of-contents entry and scrolls to it', async () => {
    const host = await openWorld();
    expect(bodyOf(host, 'calendar').hasAttribute('hidden')).toBe(true);

    // `scrollIntoView` is absent in jsdom; the entry's call must therefore be optional. Spying on it
    // is how "能跳" is asserted without a layout engine — the scroll is the half a `hidden` flip does
    // not cover.
    const section = host.querySelector('#section-calendar');
    if (section === null) throw new Error('no calendar section on screen');
    const scrolled: unknown[] = [];
    section.scrollIntoView = (...args: unknown[]) => {
      scrolled.push(args);
    };

    const entry = host.querySelector(
      '[data-list="section-toc"] [data-action="section-jump"][data-section="calendar"]',
    );
    if (entry === null) throw new Error('no calendar entry in the table of contents');
    await click(entry);

    expect(bodyOf(host, 'calendar').hasAttribute('hidden')).toBe(false);
    expect(sectionOf(host, 'calendar').toggle.getAttribute('aria-expanded')).toBe('true');
    expect(scrolled.length).toBe(1);
    // Untouched: an entry opens the one section it names.
    expect(bodyOf(host, 'regions').hasAttribute('hidden')).toBe(true);
  });

  it('folds and unfolds a section from its own heading, and pins the accessible state to it', async () => {
    const host = await openWorld();
    const basic = sectionOf(host, 'basic');
    expect(basic.toggle.getAttribute('aria-label')).toBe('收起「基本」');
    await click(basic.toggle);
    expect(basic.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(basic.toggle.getAttribute('aria-label')).toBe('展开「基本」');
    expect(basic.body.hasAttribute('hidden')).toBe(true);
    // The folded section is not gone: its controls are still addressable, which is what the
    // unchangeable `routes/editors.test.tsx` depends on.
    expect(host.querySelector('[data-field="world-name"]')).not.toBeNull();

    await click(basic.toggle);
    expect(basic.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(basic.body.hasAttribute('hidden')).toBe(false);
  });

  it('starts from the uniform layout again after another card is opened', async () => {
    const first = await createWorld({ name: '银松群岛', data: blankWorldData('银松群岛') });
    const second = await createWorld({ name: '长日港', data: blankWorldData('长日港') });
    if (first === undefined || second === undefined) throw new Error('a seeded world was refused');
    const host = await mountAt(`/worlds/${first.world.id}`, '发布新版本');

    await click(sectionOf(host, 'basic').toggle);
    expect(sectionOf(host, 'basic').body.hasAttribute('hidden')).toBe(true);

    // A different card through the SAME router: a route parameter change is not a remount, so the
    // fold of the previous card must not survive it. (Rendering a second router into the same root
    // would not even replace the first one — `RouterProvider` keeps the instance it was given.)
    const router = routers.pop();
    if (router === undefined) throw new Error('no router on screen to navigate');
    await act(async () => {
      await router.navigate({ to: '/worlds/$worldId', params: { worldId: second.world.id } });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await waitForText(host, '长日港');
    expect(sectionOf(host, 'basic').body.hasAttribute('hidden')).toBe(false);
  });
});

/* ───────────────────────────── the character editor ──────────────────────── */

describe('the character editor’s sections (fix B1)', () => {
  it('groups the form into four sections and folds the three that are not the identity', async () => {
    const created = await createCharacter({
      name: '莉安',
      data: blankCharacterData('莉安'),
    });
    if (created === undefined) throw new Error('the seeded character was refused by the schema');
    const host = await mountAt(`/characters/${created.character.id}`, '发布新版本');

    const fromToc = Array.from(
      host.querySelectorAll('[data-list="section-toc"] [data-action="section-jump"]'),
    ).map((entry) => entry.getAttribute('data-section'));
    expect(fromToc).toEqual(['st', 'voice', 'visual', 'sampling']);

    expect(sectionOf(host, 'st').body.hasAttribute('hidden')).toBe(false);
    for (const id of ['voice', 'visual', 'sampling']) {
      expect(sectionOf(host, id).body.hasAttribute('hidden')).toBe(true);
    }
    // The ST section is the long one and it is the open one — the fields M1-C1's acceptance test
    // reaches are inside it, so the default layout must not hide them.
    expect(host.querySelector('[data-field="character-first_mes"]')).not.toBeNull();
    expect(sectionOf(host, 'sampling').toggle.getAttribute('aria-label')).toBe(
      '展开「默认采样参数」',
    );
  });

  it('opens the visual bible from its table-of-contents entry', async () => {
    const created = await createCharacter({
      name: '莉安',
      data: blankCharacterData('莉安'),
    });
    if (created === undefined) throw new Error('the seeded character was refused by the schema');
    const host = await mountAt(`/characters/${created.character.id}`, '发布新版本');

    const entry = host.querySelector(
      '[data-list="section-toc"] [data-action="section-jump"][data-section="visual"]',
    );
    if (entry === null) throw new Error('no visual entry in the table of contents');
    await click(entry);

    expect(bodyOf(host, 'visual').hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('[data-field="visual-seed-policy"]')).not.toBeNull();
    expect(host.querySelector('[data-field="appearance-hair"]')).not.toBeNull();
  });
});

/* ──────────────────────── the primitive, on its own terms ────────────────── */

/**
 * The two editors cover the primitive's contract as a SCREEN; these cover what one screen cannot.
 * The keyed case re-renders ONE component instance with a new `resetKey` and insists on the uniform
 * layout, which is the contract whatever React does underneath — and it is asserted as BEHAVIOUR
 * rather than as the guard's own line, because this environment replaces the instance and therefore
 * never reaches that line (see `useSectionOpen`'s note).
 */
describe('the collapse primitive (fix B1)', () => {
  const PROBE_SECTIONS: readonly SectionDefinition[] = [
    { id: 'one', title: 'world.sectionBasic', openByDefault: true },
    { id: 'two', title: 'world.sectionRegions', openByDefault: false },
  ];

  /** The smallest caller: the hook plus the two components, with the state printable. */
  function DisclosureProbe({ resetKey }: { resetKey: string }) {
    const [open, setOpen] = useSectionOpen(PROBE_SECTIONS, resetKey);
    return (
      <div>
        <output data-testid="open-state">
          {PROBE_SECTIONS.map(
            (section) => `${section.id}=${String(isSectionOpen(open, section.id))}`,
          ).join(' ')}
        </output>
        <SectionToc
          sections={PROBE_SECTIONS}
          onJump={(id) => setOpen((current) => ({ ...current, [id]: true }))}
        />
        {PROBE_SECTIONS.map((section) => (
          <CollapsibleSection
            key={section.id}
            section={section}
            open={isSectionOpen(open, section.id)}
            onToggle={(id) => setOpen((current) => withSectionToggled(current, id))}
          >
            <input data-field={`probe-${section.id}`} />
          </CollapsibleSection>
        ))}
      </div>
    );
  }

  it('derives the entry layout from the section list alone', () => {
    const state: SectionOpenState = defaultSectionOpen(PROBE_SECTIONS);
    expect(state).toEqual({ one: true, two: false });
    // An id no section defines is folded, not open: a stale map cannot make a section appear.
    expect(isSectionOpen(state, 'missing')).toBe(false);
    expect(withSectionToggled(state, 'two')).toEqual({ one: true, two: true });
    expect(withSectionToggled({ one: true, two: true }, 'one')).toEqual({ one: false, two: true });
  });

  it('folds through the primitive in a tree that is not a route', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const probeRoot = createRoot(host);
    await act(async () => {
      probeRoot.render(<DisclosureProbe resetKey="first" />);
    });
    try {
      const toc = host.querySelectorAll('[data-list="section-toc"] [data-action="section-jump"]');
      expect(Array.from(toc).map((entry) => entry.getAttribute('data-section'))).toEqual([
        'one',
        'two',
      ]);
      expect(bodyOf(host, 'two').hasAttribute('hidden')).toBe(true);
      // Folded and still addressable — the rule the editors' own tests depend on.
      expect(host.querySelector('[data-field="probe-two"]')).not.toBeNull();

      const toggle = sectionOf(host, 'one').toggle;
      await click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('[data-testid="open-state"]')?.textContent).toBe(
        'one=false two=false',
      );
    } finally {
      await act(async () => {
        probeRoot.unmount();
      });
      host.remove();
    }
  });

  it('comes back to the uniform layout when the key changes, without a remount of the root', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const probeRoot = createRoot(host);
    await act(async () => {
      probeRoot.render(<DisclosureProbe resetKey="first" />);
    });
    try {
      expect(host.querySelector('[data-testid="open-state"]')?.textContent).toBe(
        'one=true two=false',
      );
      // Open the folded one through the table of contents, so the dirty map is not merely the reverse
      // of the entry layout.
      const entry = host.querySelector(
        '[data-list="section-toc"] [data-action="section-jump"][data-section="two"]',
      );
      if (entry === null) throw new Error('no entry for two');
      await click(entry);
      expect(host.querySelector('[data-testid="open-state"]')?.textContent).toBe(
        'one=true two=true',
      );

      // Same element, same instance, new key — a parameter-only change.
      await act(async () => {
        probeRoot.render(<DisclosureProbe resetKey="second" />);
      });
      expect(host.querySelector('[data-testid="open-state"]')?.textContent).toBe(
        'one=true two=false',
      );
      expect(sectionOf(host, 'one').body.hasAttribute('hidden')).toBe(false);
      expect(sectionOf(host, 'two').body.hasAttribute('hidden')).toBe(true);
    } finally {
      await act(async () => {
        probeRoot.unmount();
      });
      host.remove();
    }
  });
});
