/**
 * @vitest-environment jsdom
 *
 * The shell's real target is a browser, so this is where the jsdom environment
 * is exercised end to end (M0-T0 proves the toolchain; M0-T8 needs the real
 * thing for the streaming UI).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap, WEB_APP } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/web (M0-T0 scaffold)', () => {
  it('is a private app workspace at the top of the dependency graph', () => {
    expect(manifest.name).toBe('@smarttavern/web');
    expect(manifest.private).toBe(true);
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });

  it('is importable and runs in a DOM-capable test environment', () => {
    expect(WEB_APP).toBe('@smarttavern/web');
    expect(typeof document).toBe('object');
  });

  it('renders the scaffold marker into the app root', () => {
    document.body.innerHTML = '<div data-app="smarttavern"></div>';
    expect(bootstrap()).toContain('M0-T0 scaffold');
    expect(document.querySelector('[data-app="smarttavern"]')?.textContent).toContain(
      'M0-T0 scaffold',
    );
  });
});
