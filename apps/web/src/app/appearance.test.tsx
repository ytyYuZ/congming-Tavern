/**
 * THE M1-G2 ACCEPTANCE TEST — "the settings persist and take effect immediately"
 * (docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS RENDERS THE REAL `<App/>` AND READS THE REAL `document.documentElement`
 * The claim under test is about the INTERFACE, not about a store: a test that read
 * `useAppearanceStore.getState()`, or compared `DEFAULT_APPEARANCE` against a parser,
 * would pass even if no component ever subscribed or no effect ever wrote to the DOM. So
 * every assertion below is either a rendered string a user could read, a control they
 * could operate, or a custom property / attribute on `<html>` that the CSS actually
 * consumes — and every change is driven the way a user drives it: a `<select>`'s change
 * event, a slider's input event.
 *
 * WHY THE STORED ROWS ARE READ BACK AFTER THE DOM ASSERTION
 * That ordering is the acceptance criterion's two halves in the order the store produces
 * them: the value on screen changes NOW (the store updates state before it awaits the
 * write — `state/appearance-store.ts` records why), and the row is written after. Reading
 * the row is a separate, awaited claim, so it is asserted separately (`expectRow` polls,
 * because the write is deliberately fire-and-forget).
 *
 * WHY THE RESTART IS DRIVEN THROUGH `mountAt` AND NOT BY SEEDING THE STORE
 * The locale work showed the trap: a test that pokes the store can pass while the app
 * never ASKS for the stored row. So the "restart" here unmounts, forgets the in-memory
 * state (`resetAppearanceStore`), clears `<html>`, and mounts `<App/>` again — the read
 * that follows is the shell's own `load()`. The values chosen make that decisive: the
 * stored theme is `light` on a DARK stubbed OS (a mount that never read would show dark)
 * and the stored font scale is not the default.
 *
 * WHY THE OS IS STUBBED RATHER THAN ASSUMED
 * jsdom does not implement `window.matchMedia` at all (measured on the pinned version),
 * so `system` has nothing to follow unless a test provides it. The stub below is a real
 * `change` listener registry, which is what lets this file assert BOTH that the DOM follows
 * the OS live and that the listener is gone after unmount.
 *
 * WHY THE STORES COME FROM `mount`
 * Vitest instantiates a module once per ENVIRONMENT and this workspace mixes them, so a
 * store reached through `state/*` could be a different object from the one the mounted
 * components read — a test would then seed state nothing renders (see `mount.ts`).
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_PROPERTY,
  FONT_SCALE_STEP,
  MESSAGE_WIDTH_MAX,
  MESSAGE_WIDTH_MIN,
  MESSAGE_WIDTH_PROPERTY,
  MESSAGE_WIDTH_STEP,
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
} from '../appearance/appearance';
import { readTable } from '../db/database';
import * as repository from '../db/repository';
import {
  FONT_SCALE_SETTINGS_ID,
  MESSAGE_WIDTH_SETTINGS_ID,
  type SettingsRow,
  THEME_SETTINGS_ID,
  writeLocaleSetting,
} from '../db/repository';
// The stores and the database accessors are taken from `mount`, NOT from `state/*` or
// `db/*` directly — see the file header.
import {
  closeDatabase,
  resetAppearanceStore,
  resetChat,
  resetDatabase,
  resetLocaleStore,
  resetSettingsStore,
  useAppearanceStore,
} from '../mount';
import { App, createAppRouter } from './app';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;

/**
 * React 19 requires this flag for `act` to mean anything, and jsdom's `window.scrollTo`
 * is a stub that throws "Not implemented" while TanStack Router calls it on a scroll
 * event. Neutralising it keeps the suite output honest instead of burying a real failure
 * in noise (the same one-liner `routes.test.tsx` uses).
 */
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
  databaseName = `apps-web-appearance-dom-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetAppearanceStore();
  clearDocument();
  // This file asserts RENDERED Chinese copy, and the store's documented initial value
  // follows the browser (jsdom reports `en-US`). So the language is pinned by writing the
  // STORED row — the same thing a returning user has — and the shell's own `load()` then
  // adopts it. Poking the store instead would be overwritten by that legitimate read.
  await writeLocaleSetting('zh-CN');
});

afterEach(async () => {
  // ORDER MATTERS: unmount before closing the database, because unmounting runs the
  // views' cleanup and unsubscribes their `liveQuery`. Closing under a live subscription
  // rejects that query after the test finished, which Vitest reports as unhandled.
  await unmount();
  vi.restoreAllMocks();
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetAppearanceStore();
  closeDatabase();
  await deleteDatabase(databaseName);
  // The stub is an OWN property this file created on jsdom's window (which has no
  // `matchMedia`), so it is removed the same way — `vi.stubGlobal` is not used because
  // the code under test reads `window.matchMedia`, not a global binding.
  Reflect.deleteProperty(window, 'matchMedia');
  clearDocument();
});

/** Put `<html>` back where a fresh page load finds it. */
function clearDocument(): void {
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  document.documentElement.style.removeProperty(FONT_SCALE_PROPERTY);
  document.documentElement.style.removeProperty(MESSAGE_WIDTH_PROPERTY);
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/* ───────────────────── the controllable prefers-color-scheme ─────────────── */

/**
 * A `MediaQueryList` stand-in that keeps its `change` listeners so a test can count them.
 *
 * A real `MediaQueryList` is an `EventTarget` and cannot be told to fire, so the fake
 * registry is not a convenience: it is the only way "the listener is removed on unmount"
 * becomes checkable rather than merely plausible.
 */
class FakeMediaQueryList {
  matches: boolean;
  readonly media: string;
  private readonly listeners = new Set<() => void>();

  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'change') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'change') this.listeners.delete(listener);
  }

  /** How many `change` listeners the app currently holds — the leak assertion. */
  get changeListenerCount(): number {
    return this.listeners.size;
  }

  /** The OS changed its mind: flip `matches` and notify. */
  flip(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Install a `window.matchMedia` that answers `PREFERS_DARK_QUERY` with `initialDark`.
 *
 * The SAME list object is returned for every call, which is what makes the app's
 * `removeEventListener` find the listener the earlier `addEventListener` registered — the
 * property a real `MediaQueryList` has and a naive `() => ({ matches })` stub does not.
 */
function installPrefersColorScheme(initialDark: boolean): FakeMediaQueryList {
  const list = new FakeMediaQueryList(PREFERS_DARK_QUERY, initialDark);
  window.matchMedia = (query: string): MediaQueryList =>
    query === PREFERS_DARK_QUERY
      ? // The casts are confined to this line: the fake is a listener registry rather
        // than an `EventTarget`, and the only members the app reads (`matches`,
        // `addEventListener`, `removeEventListener`) are the ones implemented above.
        (list as unknown as MediaQueryList)
      : (new FakeMediaQueryList(query, false) as unknown as MediaQueryList);
  return list;
}

/* ───────────────────────── the async render helper ───────────────────────── */

interface Mounted {
  host: HTMLElement;
  router: ReturnType<typeof createAppRouter>;
}

/** Mount the app at `path` and wait for `expected` to appear. */
async function mountAt(path: string, expected: string): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.append(host);
  container = host;
  const router = createAppRouter(path);
  await act(async () => {
    root = createRoot(host);
    root.render(<App router={router} />);
  });
  await waitForText(host, expected);
  // Let the app's own fire-and-forget reads settle before teardown closes the database.
  await settle();
  return { host, router };
}

/** Wait until the container's text contains `expected`. */
async function waitForText(host: HTMLElement, expected: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((host.textContent ?? '').includes(expected)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected}; DOM was: ${host.innerHTML}`);
    }
    await settle();
  }
}

/** Wait until `<html>` satisfies `predicate`, or fail with what it actually holds. */
async function waitForDocument(
  predicate: () => boolean,
  what: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      const html = document.documentElement.outerHTML;
      throw new Error(`timed out waiting for ${what}; <html> is ${html}`);
    }
    await settle();
  }
}

/** Let pending state updates inside the app flush. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
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
}

/** An element a view renders, or a loud failure instead of a `null` dereference. */
function element<T extends Element>(host: HTMLElement, selector: string, of: new () => T): T {
  const found = host.querySelector(selector);
  if (!(found instanceof of)) {
    throw new Error(`no ${selector} in the view; DOM was: ${host.innerHTML}`);
  }
  return found;
}

/* ──────────────────────────── driving the controls ───────────────────────── */

/** Choose a theme the way a user does: set the value, then fire `change`. */
async function chooseTheme(host: HTMLElement, theme: string): Promise<void> {
  const select = element(host, '#theme', HTMLSelectElement);
  await act(async () => {
    select.value = theme;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/** Choose a language through the header's picker. */
async function chooseLocale(host: HTMLElement, locale: string): Promise<void> {
  const select = element(host, '.locale-picker', HTMLSelectElement);
  await act(async () => {
    select.value = locale;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/**
 * Move a slider the way a user does: set the value, then fire `input`.
 *
 * WHY THE PROTOTYPE SETTER: React tracks `value` by redefining it as an OWN property of
 * the node (`inputValueTracking`), so a plain `input.value = '1.3'` updates the tracker
 * too — React then concludes nothing changed and skips the handler, and the test would be
 * green while proving nothing. Calling `HTMLInputElement.prototype`'s setter is what
 * bypasses the tracker, exactly as `@testing-library/dom`'s `setNativeValue` does.
 */
async function moveSlider(host: HTMLElement, selector: string, value: string): Promise<void> {
  const input = element(host, selector, HTMLInputElement);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('HTMLInputElement.prototype.value has no setter');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/* ───────────────────────────── the stored rows ───────────────────────────── */

/** The RAW stored value of one row, bypassing every parser. */
async function rawValue(id: string): Promise<unknown> {
  const row = await readTable<SettingsRow>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/** Poll until the row holds `expected`: the store's writes are fire-and-forget. */
async function expectRow(id: string, expected: unknown): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const stored = await rawValue(id);
    if (stored === expected) return;
    if (Date.now() > deadline) {
      const held = JSON.stringify(stored);
      throw new Error(`row ${id} never became ${JSON.stringify(expected)}; it holds ${held}`);
    }
    await settle();
  }
}

/* ────────────────────────────────── tests ────────────────────────────────── */

describe('M1-G2: a change takes effect now, and the row is written', () => {
  it('re-renders <html> for each control, then re-reads the stored row', async () => {
    // A dark OS, so `system` has something to resolve to and the first assertion is not
    // satisfied by the light default.
    installPrefersColorScheme(true);
    const { host } = await mountAt('/setup', '外观');
    const html = document.documentElement;

    // The constructed state, before any row exists: `system` resolves to the OS's dark,
    // and the two custom properties carry the documented defaults.
    expect(html.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    expect(html.style.getPropertyValue(FONT_SCALE_PROPERTY)).toBe('1');
    expect(html.style.getPropertyValue(MESSAGE_WIDTH_PROPERTY)).toBe('85%');

    // THEME: the attribute changes with the gesture, and the row follows.
    await chooseTheme(host, 'light');
    expect(html.getAttribute(THEME_ATTRIBUTE)).toBe('light');
    await expectRow(THEME_SETTINGS_ID, 'light');

    // FONT SCALE: the property the `font-size: calc(15px * var(...))` rule reads.
    await moveSlider(host, '#fontScale', '1.3');
    expect(html.style.getPropertyValue(FONT_SCALE_PROPERTY)).toBe('1.3');
    await expectRow(FONT_SCALE_SETTINGS_ID, 1.3);

    // MESSAGE WIDTH: the property both bubbles' `max-width` reads.
    await moveSlider(host, '#messageWidth', '60');
    expect(html.style.getPropertyValue(MESSAGE_WIDTH_PROPERTY)).toBe('60%');
    await expectRow(MESSAGE_WIDTH_SETTINGS_ID, 60);
  });

  it('keeps the appearance controls usable while the provider row is still loading', async () => {
    installPrefersColorScheme(true);
    // The form's own gate: a read that never answers, so `useSettingsStore.loaded` stays
    // false and the BYO-Key form is still showing its loading sentence. ADR-034 made `load()`
    // resolve WHICH provider row to edit before it reads one — `resolveProviderId` is that
    // first step, so it is the read that has to hang for `loaded` to stay false.
    const pending = new Promise<never>(() => undefined);
    vi.spyOn(repository, 'resolveProviderId').mockReturnValue(pending);

    const { host } = await mountAt('/setup', '外观');
    expect(host.textContent).toContain('正在读取设置…');

    await moveSlider(host, '#fontScale', '1.3');
    expect(document.documentElement.style.getPropertyValue(FONT_SCALE_PROPERTY)).toBe('1.3');
    await expectRow(FONT_SCALE_SETTINGS_ID, 1.3);
  });

  it('gives the sliders exactly the documented bounds', async () => {
    installPrefersColorScheme(true);
    const { host } = await mountAt('/setup', '外观');

    // The control and the parsers are the same numbers, spelled once: a bound that exists
    // only in the parser would be a slider that can store what the reader then clamps.
    const fontScale = element(host, '#fontScale', HTMLInputElement);
    expect(fontScale.type).toBe('range');
    expect(fontScale.min).toBe(String(FONT_SCALE_MIN));
    expect(fontScale.max).toBe(String(FONT_SCALE_MAX));
    expect(fontScale.step).toBe(String(FONT_SCALE_STEP));

    const messageWidth = element(host, '#messageWidth', HTMLInputElement);
    expect(messageWidth.min).toBe(String(MESSAGE_WIDTH_MIN));
    expect(messageWidth.max).toBe(String(MESSAGE_WIDTH_MAX));
    expect(messageWidth.step).toBe(String(MESSAGE_WIDTH_STEP));
  });
});

describe('M1-G2: the choice survives a restart, through the real load path', () => {
  it('adopts the stored rows when the app mounts again', async () => {
    const os = installPrefersColorScheme(true);

    const first = await mountAt('/setup', '外观');
    await chooseTheme(first.host, 'light');
    await moveSlider(first.host, '#fontScale', '1.3');
    await moveSlider(first.host, '#messageWidth', '60');
    await expectRow(THEME_SETTINGS_ID, 'light');
    await expectRow(FONT_SCALE_SETTINGS_ID, 1.3);
    await expectRow(MESSAGE_WIDTH_SETTINGS_ID, 60);

    // "Restart": unmount, forget everything in memory, and put <html> back to a fresh
    // page. The store now says `system`/1/85 again — and the OS is DARK, so a mount that
    // never read the rows could not produce the assertions below.
    await unmount();
    resetAppearanceStore();
    clearDocument();
    expect(useAppearanceStore.getState().theme).toBe(DEFAULT_THEME);
    expect(os.changeListenerCount).toBe(0);

    await mountAt('/setup', '外观');
    await waitForDocument(
      () => document.documentElement.getAttribute(THEME_ATTRIBUTE) === 'light',
      'the stored light theme',
    );
    expect(document.documentElement.style.getPropertyValue(FONT_SCALE_PROPERTY)).toBe('1.3');
    expect(document.documentElement.style.getPropertyValue(MESSAGE_WIDTH_PROPERTY)).toBe('60%');
    // The stored theme is `light`, so the read left the OS unsubscribed: the mount started
    // on `system` (one listener), and adopting the row removed it.
    expect(os.changeListenerCount).toBe(0);
  });
});

describe('M1-G2: `system` follows prefers-color-scheme', () => {
  it('follows the OS live, and stops following once a theme is chosen', async () => {
    const os = installPrefersColorScheme(true);
    const { host } = await mountAt('/setup', '外观');
    const html = document.documentElement;

    expect(html.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    expect(os.changeListenerCount).toBe(1);

    // The OS changes while the app is running: the attribute follows in the same task.
    await act(async () => {
      os.flip(false);
    });
    expect(html.getAttribute(THEME_ATTRIBUTE)).toBe('light');

    await act(async () => {
      os.flip(true);
    });
    expect(html.getAttribute(THEME_ATTRIBUTE)).toBe('dark');

    // An explicit choice does not ask the OS any more, so the listener is removed rather
    // than left firing at a value nobody uses.
    await chooseTheme(host, 'light');
    expect(os.changeListenerCount).toBe(0);
    await act(async () => {
      os.flip(false);
    });
    expect(html.getAttribute(THEME_ATTRIBUTE)).toBe('light');
  });

  it('removes the media listener on unmount, so nothing updates afterwards', async () => {
    const os = installPrefersColorScheme(true);
    await mountAt('/setup', '外观');
    expect(os.changeListenerCount).toBe(1);

    await unmount();
    // THE LEAK ASSERTION, in two parts: the query has no listener left, and a change can
    // no longer reach the document. Without the cleanup the attribute would flip below.
    expect(os.changeListenerCount).toBe(0);
    os.flip(false);
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
  });
});

describe('M1-G2: the settings are independent of each other and of the language', () => {
  it('renders the appearance copy in the pinned locale and keeps the theme across a switch', async () => {
    installPrefersColorScheme(true);
    // The language was pinned to zh-CN by writing the row in `beforeEach`, so these
    // assertions are about the catalogs rather than about jsdom's `en-US`.
    const { host } = await mountAt('/setup', '外观');
    expect(host.textContent).toContain('外观');
    expect(host.textContent).toContain('主题');
    expect(host.textContent).toContain('跟随系统');
    expect(host.textContent).toContain('字号');
    expect(host.textContent).toContain('消息宽度');
    // The readout beside the font-scale slider, at the default.
    expect(host.textContent).toContain('100%');

    await chooseTheme(host, 'dark');
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    await expectRow(THEME_SETTINGS_ID, 'dark');

    // The language picker is a different store and a different row, on the same screen.
    await chooseLocale(host, 'en');
    expect(host.textContent).toContain('Appearance');
    expect(host.textContent).toContain('Match system');
    expect(host.textContent).toContain('Text size');
    expect(host.textContent).toContain('Message width');
    expect(host.textContent).not.toContain('外观');
    // The theme survived the switch — on screen and on disk.
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    expect(await rawValue(THEME_SETTINGS_ID)).toBe('dark');

    // And a font-scale change leaves the theme row exactly where it was.
    await moveSlider(host, '#fontScale', '1.3');
    expect(document.documentElement.style.getPropertyValue(FONT_SCALE_PROPERTY)).toBe('1.3');
    await expectRow(FONT_SCALE_SETTINGS_ID, 1.3);
    expect(await rawValue(THEME_SETTINGS_ID)).toBe('dark');
  });
});
