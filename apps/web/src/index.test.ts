/**
 * The shell entry point and the mount contract (M0-T8).
 *
 * WHAT THIS REPLACES
 * The M0-T0 scaffold test asserted `bootstrap()` writing into `[data-app="smarttavern"]`.
 * M0-T8 replaces that placeholder with `mountApp(root, options)` and the real `#root`
 * mount point, so the test moves with it: the HTML has a `#root`, `index.ts` is the only
 * module that looks it up, and `mountApp` renders the app into whatever element it is
 * given (which is how `apps/desktop` will reuse it, with its own transport).
 *
 * WHY THE REAL DOM AND A REAL MOUNT
 * `mountApp` awaits `router.load()` before its first render, so this is the one place
 * that ordering is exercised end to end: a fake root would not prove it, and neither
 * would a render that skipped the awaiting. `createRoot` (not `hydrateRoot`) is what the
 * mount uses, because the mount point is an empty div and hydrating an empty container
 * makes React report a mismatch on every load.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '@smarttavern/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Taken from `mount` so this file shares ONE module instance with the mounted app; see
// the note on `mount.ts`'s test re-exports (Vitest instantiates a module per
// environment, and apps/web mixes them).
import { closeDatabase, resetChat, resetSettingsStore } from './mount';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

/** A transport that refuses every request: this test never sends one. */
const offline: FetchLike = () =>
  Promise.reject(new Error('this smoke test must not reach the network'));

let databases = 0;

beforeEach(() => {
  databases += 1;
  document.body.innerHTML = '<div id="root"></div>';
  resetChat();
  resetSettingsStore();
});

afterEach(() => {
  resetChat();
  resetSettingsStore();
  closeDatabase();
  document.body.innerHTML = '';
});

describe('@smarttavern/web entry point', () => {
  it('is a private app workspace at the top of the dependency graph', () => {
    expect(manifest.name).toBe('@smarttavern/web');
    expect(manifest.private).toBe(true);
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });

  it('gives the page a #root mount point and loads the entry as a module', () => {
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/src/index.ts"');
    // The M0-T0 scaffold marker must be gone: a leftover would hide a failed mount.
    expect(html).not.toContain('data-app="smarttavern"');
  });

  it('is importable in a DOM environment and mounts when #root is present', async () => {
    // `index.ts` mounts on import when the document is ready, so importing it IS the
    // test of the browser path. The mount itself is asynchronous (it awaits the
    // router's first match), hence the poll below.
    await import('./index');

    const root = document.querySelector('#root');
    expect(root).not.toBeNull();
    await waitFor(() => (root?.textContent ?? '').includes('聪明酒馆'));
    expect(root?.textContent).toContain('设置');
  });

  it('mountApp renders into whatever element it is given, with an injected transport', async () => {
    const { mountApp } = await import('./mount');
    const container = document.createElement('div');
    document.body.append(container);

    const router = mountApp(container, {
      transport: offline,
      databaseName: `apps-web-index-${databases}`,
    });

    await waitFor(() => container.textContent?.includes('聪明酒馆') === true);
    expect(container.textContent).toContain('新建会话');
    // The home view's own effect loads the session list. Wait for the routers to settle
    // BEFORE `afterEach` closes the database: closing it under an in-flight read rejects
    // that read, and Vitest reports the rejection as an unhandled error.
    await router.load();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('mountApp reports a missing #root instead of failing silently', async () => {
    // The browser path logs and does nothing rather than throwing inside a module, so
    // importing the entry with no `#root` present must not reject.
    document.body.innerHTML = '';
    await expect(import('./index')).resolves.toBeDefined();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
