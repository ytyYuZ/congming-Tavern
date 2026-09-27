/**
 * Automated i18n hardcoded-text check — M1-G1 ("切换语言全界面生效").
 *
 * Invariant (docs/06-开发任务拆解.md §2.1 M1-G1): every user-facing string lives
 * in a message catalog (`packages/i18n`) and is reached through `t('area.key')`.
 * A hardcoded user-facing string therefore breaks the promise that switching the
 * language re-renders the WHOLE interface: the one literal nobody localised
 * stays Chinese (or English) forever, and no reviewer can see it in a diff of
 * the catalog.
 *
 * TWO RULES, ONE INVARIANT:
 *   R1 (characters) a string literal / JSX text / plain (substitution-free)
 *      template literal containing a CJK character is hardcoded UI text.
 *   R2 (attributes) a user-visible JSX attribute set to a bare literal is
 *      hardcoded UI text whatever its characters — `title="Settings"` is exactly
 *      as unlocalised as `title="设置"`, and the catalogs are bilingual.
 *      `USER_VISIBLE_JSX_ATTRIBUTES` below is the named, reviewable list.
 *
 * WHY CJK IS THE SIGNAL FOR R1: this project's user-facing text is Chinese, and
 * the catalogs are the only place it may live. So a literal containing a CJK
 * character is exactly the set of strings a human wrote for a user to read
 * without going through the catalog. R1 deliberately does not try to classify
 * each string as "user-facing": any Chinese text outside the catalogs is either
 * a missing translation or a locale identifier that belongs next to one —
 * flagging it and asking for a `t(...)` call is cheap, while a heuristic that
 * guesses wrong lets text through silently, which is the failure mode this rule
 * exists to prevent.
 *
 * WHAT THIS DOES **NOT** CATCH (a known blind spot, stated rather than hidden):
 *   • Latin prose in a JSX *text* node — `<h1>Settings</h1>` passes. A rule that
 *     banned every non-empty text node would fire on `<span>{item.name}</span>`,
 *     punctuation, separators and whitespace, and a checker nobody can satisfy
 *     gets an allowlist, at which point it enforces nothing.
 *   • Latin prose in a non-listed attribute — `<div label="Settings">`,
 *     `className`, `id`, `role`, `data-*`. Those are machine-facing values that
 *     legitimately hold bare strings; only the names in
 *     `USER_VISIBLE_JSX_ATTRIBUTES` are rendered to a human.
 *   A broader text-node rule was rejected on purpose: precision is what makes
 *   this rule enforceable without an allowlist.
 *
 * SCOPE: `apps/*\/src\/**\/*.{ts,tsx}` — where the UI text lives.
 * EXEMPT (each on purpose, see the reasons below):
 *   • `packages/i18n/**` — the catalogs ARE the Chinese text; translating them
 *     is the point of the package.
 *   • `**\/*.test.*` — a test legitimately asserts rendered Chinese text, e.g.
 *     `expect(screen.getByText('设置')).toBeVisible()`; the assertion is the
 *     proof that the catalog key resolves, so it must stay readable.
 *   • `apps/web/src/chat/prompt.ts` — the ONE temporary exemption: that file
 *     builds the messages sent to the MODEL, so its Chinese is prompt content,
 *     not interface copy. Localising it would make the system prompt follow the
 *     UI locale (an English interface would start sending English prompts to the
 *     model — a behaviour bug). Its long-term home is a `PromptPreset`'s blocks
 *     (data, ADR-029, M1-G4); see `MODEL_PROMPT_FILE` for the removal condition.
 *     Kept as one exact path so it cannot quietly grow.
 *
 * WHY THE COMPILER API AND NOT REGEXES: a regex over raw source cannot tell a
 * JSX text node from an identifier, a comment, or a string that is not text at
 * all, so it either misses violations or invents them. Parsing with TypeScript
 * gives the rule exact node kinds (JsxText / StringLiteral /
 * NoSubstitutionTemplateLiteral / template tokens / JsxAttribute), and template
 * *expressions* (`${...}`) are visited as their own nodes, so a literal inside
 * one is still reported.
 *
 * Wired into the `lint` job: `pnpm lint` = `biome check .` +
 * check-dependency-direction.mjs + this script.
 *
 * ── How to prove it turns red (documented verification, ~30 seconds) ────────
 *   1. Add a Chinese label (or a bare visible attribute) to an apps/web source,
 *      e.g. in apps/web/src/app/app.tsx:
 *          const label = '设置';
 *          // or: <button title="Settings">…</button>
 *   2. Run `pnpm lint` (or `node tools/scripts/check-i18n-literals.mjs`).
 *      Expected: non-zero exit and a report such as
 *          [i18n] 1 hardcoded-text violation(s):
 *          apps/web/src/app/app.tsx:12:17  "'设置'"
 *              use t('area.key') from @smarttavern/i18n
 *   3. Revert the line; `pnpm lint` is green again.
 *   The same experiment runs automatically in
 *   tools/scripts/check-i18n-literals.test.mjs (`pnpm test`), which fails if this
 *   checker ever stops reporting violations.
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = configuration error.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Repository root. The check is always invoked from there (pnpm lint). */
const repoRoot = process.cwd();

/** Workspace glob for UI text: `apps/<app>/src/**\/*.{ts,tsx}`. */
const SOURCE_GROUPS = ['apps'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * The forbidden characters, in ONE place so the rule can be read at a glance and
 * reused by the tests. Two families:
 *   • Han script — every BMP ideograph (U+4E00–U+9FFF), the extension-A block
 *     (U+3400–U+4DBF) and everything above the BMP (U+20000 and up, where the
 *     rarer extensions live). Using `\p{Script=Han}` instead of hand-copied
 *     ranges means a character added to a later Unicode version is caught too.
 *   • The CJK punctuation this project actually writes: ，。、：；！？（）「」『』…—
 *     (a bare 「」 quote pair or a `：` in a label is still user-facing text).
 * The pattern is deliberately not anchored: it must match a CJK character MIXED
 * INTO otherwise-technical text, e.g. `aria-label="发送"` or `label: 'LLM 设置'`.
 */
const CJK_CLASS = '[\\p{Script=Han}，。、：；！？（）「」『』…—]';
export const CJK_PATTERN = new RegExp(CJK_CLASS, 'u');

/** Non-global twin for "does this text contain CJK?" (no lastIndex state). */
const CJK_TEST = new RegExp(CJK_CLASS, 'u');

/** True when `text` contains at least one CJK character. */
export function containsCjk(text) {
  return CJK_TEST.test(text);
}

/** Directories never scanned (node_modules holds copied sources and bundles). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** A test legitimately asserts rendered Chinese text — see the header. */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** A test's fixtures live beside it (`__fixtures__`, `__mocks__`, …). */
const TEST_DIR = /^__.*__$/;
/** The catalogs ARE the Chinese text — see the header. */
const CATALOG_DIR = /(^|\/)packages\/i18n\//;

/**
 * TEMPORARY single-file exemption — `apps/web/src/chat/prompt.ts` (M1-G1).
 *
 * WHY: that file assembles the messages sent to the MODEL. Its Chinese is prompt
 * content, not interface copy, so it must NOT move into the catalogs: routing it
 * through `t(...)` would make the system prompt switch with the UI locale, and a
 * user with an English interface would silently start sending English prompts to
 * the model — model behaviour changing as a side effect of a UI preference. That
 * is a bug, not a localisation.
 *
 * WHY TEMPORARY, AND WHAT REMOVES IT: the honest long-term home for this text is
 * a `PromptPreset`'s blocks — data, per ADR-029 — which M1-G4 brings. Until then
 * it is a hardcoded built-in default. When those preset blocks ship, delete this
 * constant and its branch in `isExemptPath`; the exemption must not outlive the
 * reason for it.
 *
 * DELIBERATELY ONE EXACT FILE, anchored as `/chat/prompt.ts`: a broader pattern
 * (`chat/**`, `prompt*`) would quietly exempt files nobody decided to exempt —
 * and an exemption that can grow on its own is how a rule dies.
 */
const MODEL_PROMPT_FILE = /(^|\/)chat\/prompt\.ts$/;

const toPosix = (p) => p.split(sep).join(posix.sep);

/** Normalise a path for the predicates below: POSIX separators, no leading '/'. */
function normalizeRelPath(path) {
  const posixPath = toPosix(path);
  return posixPath.startsWith('/') ? posixPath.slice(1) : posixPath;
}

/** Index of a group segment, or -1 when the path does not contain it. */
function findGroupIndex(parts, group) {
  return parts.indexOf(group);
}

/**
 * True when a path is inside the scan scope (a UI source under `apps/<app>/src/`).
 *
 * The group segment is located wherever it appears rather than assumed to be the
 * first one, so the predicate stays correct for a path relative to a throwaway
 * root (the tests drive the rule through a temp directory) by passing that
 * root's own group name as `appsGroup`.
 */
export function isScopedSource(relFile, appsGroup = SOURCE_GROUPS[0]) {
  const normalized = normalizeRelPath(relFile);
  const parts = normalized.split('/').filter((part) => part.length > 0);
  const appsIndex = findGroupIndex(parts, appsGroup);
  if (appsIndex < 0) return false;
  if (parts.includes('node_modules')) return false;
  // apps / <app> / src / … — anything shorter has no UI source in it.
  if (parts.length < appsIndex + 4) return false;
  if (parts[appsIndex + 2] !== 'src') return false;
  return SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

/**
 * True when a path is exempt from the rule: the i18n catalogs (the text belongs
 * there), test files / test fixture directories (they assert rendered text), and
 * the one temporary model-prompt file (prompt content, not interface copy — see
 * `MODEL_PROMPT_FILE` for why and for what removes it).
 */
export function isExemptPath(relFile) {
  const normalized = normalizeRelPath(relFile);
  if (CATALOG_DIR.test(normalized)) return true;
  if (MODEL_PROMPT_FILE.test(normalized)) return true;
  const parts = normalized.split('/');
  if (parts.some((part) => TEST_DIR.test(part))) return true;
  return TEST_FILE.test(normalized);
}

/**
 * Recursively collect `apps/<app>/src/**\/*.{ts,tsx}` below an absolute `apps`
 * directory. Returns absolute paths; directories that do not exist are skipped
 * so a missing app is reported as "no files" by the caller (never as success).
 */
export function collectAppSources(appsDir) {
  const out = [];
  let apps;
  try {
    apps = readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const app of apps) {
    if (!app.isDirectory()) continue;
    const srcDir = join(appsDir, app.name, 'src');
    // Iterative walk: UI trees are shallow, but recursion depth is not worth
    // reasoning about when a deep `components/x/y/z` folder appears. An app
    // without a `src/` directory simply contributes no files.
    const pending = [srcDir];
    while (pending.length > 0) {
      const dir = pending.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          pending.push(abs);
        } else if (
          entry.isFile() &&
          SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
        ) {
          out.push(abs);
        }
      }
    }
  }
  return out;
}

/** Discover the scoped UI source files under `root`, sorted for stable output. */
export function findScopedFiles(root = repoRoot) {
  const files = [];
  for (const group of SOURCE_GROUPS) {
    files.push(...collectAppSources(join(root, group)));
  }
  // POSIX separators on every platform: the same file must produce the same path
  // in the report (and in the tests) whether the host is Windows or not.
  return files.map((file) => toPosix(file)).sort();
}

/**
 * JSX attributes whose value is rendered to the user, so a bare string is
 * hardcoded UI text REGARDLESS of its alphabet.
 *
 * The CJK rule cannot see `title="Settings"` or `aria-label="Close"`, and the
 * catalogs are bilingual, so those are exactly as hardcoded as a Chinese one.
 * The list is deliberately small and named: every entry is a promise that the
 * attribute reaches a human. `className`, `id`, `role`, `data-*` and friends are
 * NOT here — they are machine-facing and legitimately hold bare strings.
 */
export const USER_VISIBLE_JSX_ATTRIBUTES = new Set([
  'title', // tooltip on any element
  'placeholder', // input/textarea hint text
  'aria-label', // accessible name, read aloud verbatim
  'aria-description', // longer accessible description
  'alt', // image alternative text
]);

/**
 * Node kinds whose text the character rule inspects.
 *
 * The three `TemplateHead`/`Middle`/`Tail` kinds matter: in `\`共 ${count} 条\``
 * the Chinese on either side of the hole lives in a template TOKEN, not in a
 * `NoSubstitutionTemplateLiteral` — without them a translated-looking template
 * with hardcoded text around the hole would pass. The `First`/`LastTemplateToken`
 * aliases are included because which of the aliases the parser hands out is a
 * TypeScript implementation detail, not something this rule should depend on.
 */
const TEXT_NODE_KINDS = new Set(
  [
    'JsxText',
    'StringLiteral',
    'NoSubstitutionTemplateLiteral',
    'TemplateHead',
    'TemplateMiddle',
    'TemplateTail',
    'FirstTemplateToken',
    'LastTemplateToken',
  ].map((name) => ts.SyntaxKind[name]),
);

/** Walk every descendant of a node, collecting the kinds the rule looks at. */
function collectTextNodes(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (TEXT_NODE_KINDS.has(node.kind)) found.push(node);
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return found;
}

/**
 * Walk every JSX attribute and return one record per user-visible attribute that
 * is set to a BARE literal (`title="x"` / `title={'x'}` / `` title={`x`} ``).
 *
 * `{t('area.key')}` is a JsxExpression whose body is a CallExpression, so it is
 * not matched — that is the whole point of the rule. The record carries the
 * initializer's position span so the character rule can skip the same node and
 * the report never shows one problem twice.
 */
function collectAttributeViolations(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && USER_VISIBLE_JSX_ATTRIBUTES.has(node.name.getText(sourceFile))) {
      const initializer = node.initializer;
      if (initializer !== undefined) {
        let literal;
        if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
          literal = initializer;
        } else if (
          ts.isJsxExpression(initializer) &&
          initializer.expression !== undefined &&
          (ts.isStringLiteral(initializer.expression) ||
            ts.isNoSubstitutionTemplateLiteral(initializer.expression))
        ) {
          literal = initializer.expression;
        }
        if (literal !== undefined) {
          const start = literal.pos;
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
          found.push({
            start,
            end: literal.getEnd(),
            line: line + 1,
            column: character + 1,
            kind: 'jsx-attribute',
            attribute: node.name.getText(sourceFile),
            text: literal.text,
          });
        }
      }
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return found;
}

/**
 * The raw source text of a literal node, delimiters included.
 *
 * WHY RAW SOURCE AND NOT `node.text`: `node.text` is the unescaped VALUE, so it
 * hides which quotes/spelling were used. `getStart()` (not `pos`) is used for
 * string-like nodes so the report starts at the quote and not at the whitespace
 * `pos` carries; a JSX text node starts at `pos` so that the indentation of a
 * multi-line element is part of the quoted text, as written. `describeText`
 * trims and flattens the result for the one-line output.
 */
function nodeSourceText(node, sourceFile) {
  const start = node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sourceFile);
  return sourceFile.text.slice(start, node.getEnd());
}

/** One-line, quota-limited rendering of offending text for the report. */
function describeText(text) {
  const flat = text.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t').trim();
  const clipped = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  return JSON.stringify(clipped);
}

/**
 * Pure core: AST-based violation finder for ONE source string.
 *
 * Returns `[{ line, column, kind, attribute?, text }]`, 1-based line/column,
 * empty = clean. Catalog files are exempt wherever they are; a test file is
 * exempt only inside the scanned scope (a test outside `apps/*\/src` is not this
 * checker's business), and any other path — e.g. the tests' temp fixtures — is
 * checked directly so the matcher can be driven without the filesystem.
 */
export function findViolations({ relFile, source }) {
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(
      relFile,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch (error) {
    throw new Error(`cannot parse ${relFile}: ${String(error)}`);
  }
  if (isExemptPath(relFile)) return [];

  // A user-visible attribute set to a bare literal is a violation on its own —
  // including when the literal is pure ASCII and the CJK rule cannot see it.
  const attributeViolations = collectAttributeViolations(sourceFile);

  const violations = [];
  const seen = new Set();
  for (const node of collectTextNodes(sourceFile)) {
    // Anchor on the token's own start: `pos` carries the preceding trivia, and a
    // column that points at whitespace sends the reader to the wrong place.
    const start = node.getStart(sourceFile);
    if (seen.has(start)) continue;
    seen.add(start);
    // No-substitution templates and the token parts of a substituted template
    // are both covered; a template *expression* is visited as its own nodes, so
    // a literal inside `${...}` is still reported (once, at its own position).
    const text = nodeSourceText(node, sourceFile);
    if (!containsCjk(text)) continue;
    // Already reported as a bare user-visible attribute: report the cause once,
    // with the attribute-specific hint, instead of twice at the same position.
    if (attributeViolations.some((entry) => start >= entry.start && start < entry.end)) continue;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    violations.push({
      line: line + 1,
      column: character + 1,
      kind: ts.SyntaxKind[node.kind],
      text,
    });
  }
  // Source order: the report quotes the first offending line, and output that
  // depends on traversal order is harder to trust.
  return [...attributeViolations, ...violations].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );
}

/** Read one file and return its violations, tagged with the repo-relative path. */
export function scanFile({ root = repoRoot, absPath, relFile }) {
  // `relFile` is honoured verbatim (the tests plant fixtures under a temp root);
  // otherwise the report shows the path relative to the scanned root.
  const rel = relFile ?? toPosix(relative(root, absPath));
  let source;
  try {
    source = readFileSync(absPath, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`cannot read ${rel}: ${String(error)}`);
  }
  return findViolations({ relFile: rel, source }).map((violation) => ({
    ...violation,
    relFile: rel,
  }));
}

/** Scan the whole scope; returns `{ files, violations }`. */
export function checkAll(root = repoRoot) {
  const files = findScopedFiles(root);
  const violations = [];
  for (const absPath of files) violations.push(...scanFile({ root, absPath }));
  return { files, violations };
}

/** One-line hint per violation kind: what a human should write instead. */
function hintFor(violation) {
  if (violation.kind === 'jsx-attribute') {
    return `${violation.attribute} is user-visible: pass {t('area.key')} from @smarttavern/i18n instead of a literal`;
  }
  return "use t('area.key') from @smarttavern/i18n";
}

function main() {
  let result;
  try {
    result = checkAll();
  } catch (error) {
    console.error('[i18n] configuration error:', error);
    process.exit(2);
  }
  const { files, violations } = result;
  if (files.length === 0) {
    // A checker that silently checks nothing is worse than no checker.
    console.error(
      '[i18n] configuration error: no source files matched apps/*/src/**/*.{ts,tsx} — the scan scope is broken, refusing to report success.',
    );
    process.exit(2);
  }
  if (violations.length > 0) {
    console.error(`[i18n] ${violations.length} hardcoded-text violation(s):`);
    for (const violation of violations) {
      console.error(
        [
          `${violation.relFile}:${violation.line}:${violation.column}  ${describeText(violation.text)}`,
          hintFor(violation),
        ].join('\n    '),
      );
    }
    console.error(
      "[i18n] User-facing text lives in the packages/i18n catalogs (docs/06-开发任务拆解.md §2.1 M1-G1): replace every literal above with t('area.key').",
    );
    process.exit(1);
  }
  console.log(
    `[i18n] OK — ${files.length} UI source file(s) scanned, no hardcoded CJK text outside the catalogs.`,
  );
}

/**
 * Run only when executed as a script, never when imported.
 *
 * WHY THIS GUARD: unlike the dependency-direction checker, a red run here is the
 * NORMAL state until the UI conversion lands, and its `process.exit(1)` would
 * abort the whole Vitest run that imports the pure exports below. Gating on the
 * entry point keeps `node tools/scripts/check-i18n-literals.mjs` exactly as
 * strict for CI while making the module importable by
 * tools/scripts/check-i18n-literals.test.mjs.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
