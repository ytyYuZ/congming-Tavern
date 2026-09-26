/**
 * `pnpm ci:local` — run the four CI steps on a host that forbids piped child
 * processes (see tools/scripts/vite-sandbox-probe-shim.mjs).
 *
 * `pnpm ci` stays the canonical command and is what GitHub Actions runs. This
 * wrapper exists because one Vite internal probe on Windows shells out to
 * `net use`; on a host that denies such spawns the probe kills Vitest and
 * `vite build` before they start. The shim neutralises only that probe.
 *
 * Usage:  pnpm ci:local            (all four steps, in CI order)
 *         pnpm ci:local lint test  (a subset, for iterating)
 *
 * Nothing here changes what the steps check — only whether the host lets them
 * run.
 */
import { spawn } from 'node:child_process';

const ALL_STEPS = ['lint', 'typecheck', 'test', 'build'];
const requested = process.argv.slice(2);
const steps = requested.length > 0 ? requested : ALL_STEPS;

const unknown = steps.filter((step) => !ALL_STEPS.includes(step));
if (unknown.length > 0) {
  console.error(`[ci:local] unknown step(s): ${unknown.join(', ')}. Use: ${ALL_STEPS.join(', ')}`);
  process.exit(2);
}

// `--import` needs a URL, not a Windows drive path (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const shim = new URL('./vite-sandbox-probe-shim.mjs', import.meta.url).href;
const existing = process.env.NODE_OPTIONS ?? '';
const nodeOptions = `${existing} --import ${shim}`.trim();

const results = [];
for (const step of steps) {
  console.log(`\n[ci:local] ── ${step} ─────────────────────────────────────────────`);
  // Pipelines are allowed to pipe: pass the command through the shell so the
  // `pnpm` shim (pnpm.cmd on Windows) resolves.
  const code = await new Promise((resolve) => {
    const child = spawn(`pnpm ${step}`, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
    child.on('error', () => resolve(1));
  });
  results.push({ step, code });
  if (code !== 0) {
    console.error(`\n[ci:local] ${step} FAILED (exit ${code}) — stopping, like CI does.`);
    break;
  }
}

console.log('\n[ci:local] summary');
for (const { step, code } of results) {
  console.log(`  ${code === 0 ? 'ok  ' : 'FAIL'} ${step}`);
}
const failed = results.some(({ code }) => code !== 0);
process.exit(failed ? 1 : 0);
