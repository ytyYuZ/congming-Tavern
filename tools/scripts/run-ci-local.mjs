/**
 * `pnpm ci:local` — run the four CI steps on a host that forbids piped child
 * processes (see tools/scripts/vite-sandbox-probe-shim.mjs).
 *
 * `pnpm ci` stays the canonical command and is what GitHub Actions runs. This
 * wrapper exists because one Vite internal probe on Windows shells out to
 * `net use`; on a host that denies such spawns the probe kills Vitest and
 * `vite build` before they start. The shim neutralises only that probe.
 *
 * Usage:  pnpm ci:local            (all steps, in CI order)
 *         pnpm ci:local lint test  (a subset, for iterating)
 *
 * Nothing here changes what the steps check — only whether the host lets them
 * run.
 */
import { spawn } from 'node:child_process';

const ALL_STEPS = ['lockfile', 'lint', 'typecheck', 'test', 'build'];
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

// The `build` step needs a host-specific shape, for exactly one reason: this host
// cannot build pnpm's default ISOLATED node_modules tree (`ERR_PNPM_SYMLINK_FAILED
// [symlinkAllModules] Maximum call stack size exceeded`), so the workspace uses the
// HOISTED linker — and the hoisted linker lifts `vite` to the repository root instead
// of linking it into each app. That leaves `apps/*`'s own `vite build` script with a
// `.bin` shim pointing at a package that is not there. CI runs the canonical
// `pnpm build` on Linux with the isolated linker and needs none of this.
const BUILD_COMMANDS = [
  'node node_modules/typescript/bin/tsc -b --noCheck --noEmit false',
  'node node_modules/vite/bin/vite.js build apps/web --logLevel warn',
  'node node_modules/vite/bin/vite.js build apps/desktop --logLevel warn',
];

// The CI install step is `pnpm install --frozen-lockfile`, and it runs FIRST — so a
// manifest/lockfile drift turns all four jobs red before a single check runs. That
// happened once (M0-T8): two specifiers in `apps/desktop/package.json` were edited by
// hand without a matching install, and every other local step was blind to it.
//
// `--lockfile-only --ignore-scripts` keeps this side-effect free: it never touches
// node_modules and never runs a lifecycle script, which matters on hosts where the
// esbuild postinstall cannot spawn.
//
// CAVEAT, and it is the bigger half: this runs whatever pnpm is on PATH. pnpm 12
// ALSO enforces a `minimumReleaseAge` supply-chain policy (24 h by default) that
// pnpm 11 knows nothing about, so a dependency published in the last day passes here
// and still fails CI. Use the pnpm version CI pins for that check — see
// CONTRIBUTING.md §1.
const LOCKFILE_COMMANDS = ['pnpm install --frozen-lockfile --lockfile-only --ignore-scripts'];

const commandsFor = (step) => {
  if (step === 'lockfile') return LOCKFILE_COMMANDS;
  if (step === 'build') return BUILD_COMMANDS;
  return [`pnpm --reporter=append-only ${step}`];
};

/** Run one command through the shell, inheriting stdio. Resolves to its exit code. */
function run(command) {
  return new Promise((resolve) => {
    // `append-only`: pnpm's default reporter redraws a progress line in place, which
    // makes an embedding terminal flicker. The env var is what the INNER pnpm
    // (`pnpm build` spawns one) sees; the flag covers the outer one.
    const child = spawn(command, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_OPTIONS: nodeOptions, npm_config_reporter: 'append-only' },
    });
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
    child.on('error', () => resolve(1));
  });
}

const results = [];
for (const step of steps) {
  console.log(`\n[ci:local] ── ${step} ─────────────────────────────────────────────`);
  let code = 0;
  for (const command of commandsFor(step)) {
    code = await run(command);
    if (code !== 0) break;
  }
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
