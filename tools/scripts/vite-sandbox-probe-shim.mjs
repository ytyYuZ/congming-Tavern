/**
 * Sandboxed-Windows workaround preload (LOCAL DEVELOPMENT ONLY).
 *
 * Some hosts refuse to spawn a child process with piped stdio (the DSH sandbox
 * does: `spawnSync(..., { stdio: 'pipe' })` → EPERM). Vite calls
 * `child_process.exec('net use')` from `optimizeSafeRealPathSync()` purely to
 * detect mapped network drives. On such a host that call throws EPERM and Vite
 * dies before a single test runs — even though the answer for a local drive is
 * "no network drives", which is exactly the fallback Vite already uses when the
 * probe fails.
 *
 * This preload neutralises ONLY that probe. Every other spawn is passed straight
 * through to Node, so a genuine failure still surfaces. Run it as:
 *
 *   node --import ./tools/scripts/vite-sandbox-probe-shim.mjs \
 *        node_modules/vitest/vitest.mjs run --configLoader runner
 *
 * CI does not need it (pipelines run on unrestricted Linux runners) and the
 * commands in package.json do not use it. Delete this file once your host
 * allows piped child processes.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const NET_USE_PROBE = /^\s*net\s+use\b/i;

for (const name of ['exec', 'execFile']) {
  const original = childProcess[name];
  childProcess[name] = function patched(...args) {
    const [command, optionsOrCallback, maybeCallback] = args;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (typeof command === 'string' && NET_USE_PROBE.test(command)) {
      if (typeof callback === 'function') queueMicrotask(() => callback(null, '', ''));
      return undefined;
    }
    // Everything else goes to Node untouched: a real failure still surfaces.
    return original.apply(this, args);
  };
}
