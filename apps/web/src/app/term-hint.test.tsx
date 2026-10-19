/**
 * The in-place term tooltip (F8-3's tooltip half), on the component itself.
 *
 * WHY THIS RENDERS `<TermHint>` AND NOT A WHOLE SCREEN
 * The screen-level wiring is already guarded where it belongs: `routes/editors.test.tsx` proves the
 * section headings and their contents, and `routes.test.tsx` mounts the real views. What those
 * cannot see is the contract this component owns — that the marker is a real BUTTON with a name,
 * that `aria-describedby` points at the sentence that is actually rendered, and that a click pins
 * it. Those four claims are local to the component, so the test is too; a route test asserting them
 * again would only re-prove React.
 *
 * WHY THE LOCALE IS SET THROUGH THE STORE
 * `useTranslation` subscribes to `useLocaleStore`, which is the same store the mounted app reads.
 * Writing to it here is how a test asserts BOTH catalogs — an English-only tooltip would pass a
 * zh assertion and fail a reader.
 */
/** @vitest-environment jsdom */

import type { MessageKey } from '@smarttavern/i18n';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translatorFor } from '../i18n/translate';
import { useLocaleStore } from '../state/locale-store';
import { TermHint, type TermKey } from './term-hint';

/** The four terms docs/01 §F8-3 names. Kept here so a fifth term is added to the test first. */
const TERMS: readonly TermKey[] = ['macro', 'scheduler', 'token', 'worldbook'];

let root: Root | undefined;
let host: HTMLElement | undefined;

beforeEach(() => {
  // React 19 only allows `act` where the environment says so, exactly as the other jsdom suites do.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The store follows the BROWSER on first read, which in jsdom is en-US — so the language a test
  // asserts is always set, never inherited.
  useLocaleStore.setState({ locale: 'zh-CN' });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host?.remove();
  host = undefined;
  // Back to the default so one test's language cannot leak into the next.
  useLocaleStore.setState({ locale: 'zh-CN' });
});

function render(term: TermKey): HTMLElement {
  if (host === undefined) throw new Error('no host');
  // A local, because the narrowing above does not survive into the arrow below.
  const container = host;
  act(() => {
    // A previous render, when the loop below asks for another term, is replaced rather than
    // stacked: two roots in one host would make `querySelector('button')` ambiguous.
    root?.unmount();
    root = createRoot(container);
    root.render(<TermHint term={term} />);
  });
  const marker = host.querySelector('button');
  if (marker === null) throw new Error('term hint rendered no button');
  return marker;
}

describe('F8-3: a term is explained where it is used', () => {
  it('is a button named after the term, described by the sentence it shows', () => {
    const marker = render('token');
    const t = translatorFor('zh-CN').t;
    expect(marker.getAttribute('aria-label')).toBe(t('term.tokenLabel'));
    const describedBy = marker.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const tip = document.getElementById(describedBy ?? '');
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe(t('term.tokenHint'));
  });

  it('pins and unpins on click, and says so through aria-expanded', () => {
    const marker = render('token');
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      marker.click();
    });
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      marker.click();
    });
    expect(marker.getAttribute('aria-expanded')).toBe('false');
  });

  it('explains every term in both locales, never with a missing-key fallback', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      useLocaleStore.setState({ locale });
      const t = translatorFor(locale).t;
      for (const term of TERMS) {
        const marker = render(term);
        // The cast is the loop's price: `TermKey` is a union, so the template literal cannot be
        // narrowed to one `MessageKey` literal. A key that stopped existing would still come back
        // as itself, which is what the assertions below catch.
        const label = t(`term.${term}Label` as MessageKey);
        const hint = t(`term.${term}Hint` as MessageKey);
        // A missing key comes back as the key itself (`translate` does not throw), which is exactly
        // the failure a reader would see as `term.tokenHint` in the tooltip.
        expect(label).not.toContain('term.');
        expect(hint).not.toContain('term.');
        expect(marker.getAttribute('aria-label')).toBe(label);
        const tip = document.getElementById(marker.getAttribute('aria-describedby') ?? '');
        expect(tip?.textContent).toBe(hint);
      }
    }
  });
});
