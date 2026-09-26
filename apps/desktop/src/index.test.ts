/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap, DESKTOP_APP } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/desktop (M0-T0 scaffold)', () => {
  it('is a private app workspace at the top of the dependency graph', () => {
    expect(manifest.name).toBe('@smarttavern/desktop');
    expect(manifest.private).toBe(true);
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });

  it('is importable and runs in a DOM-capable test environment', () => {
    expect(DESKTOP_APP).toBe('@smarttavern/desktop');
    expect(typeof document).toBe('object');
  });

  it('renders the scaffold marker into the app root', () => {
    document.body.innerHTML = '<div data-app="smarttavern"></div>';
    expect(bootstrap()).toContain('desktop shell');
  });
});
