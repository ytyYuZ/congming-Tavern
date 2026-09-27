/**
 * Tests for the hardcoded-i18n-text checker (M1-G1 enforcement half).
 *
 * These tests are the automated half of "a deliberate violation must make CI
 * fail": they feed the checker real Chinese literals (and bare user-visible
 * attributes) in every AST shape the rule claims to cover and assert it reports
 * them, assert clean input stays clean, and assert both exemptions (the i18n
 * catalogs, test files) hold. They run in `pnpm test` because vitest.config.mjs
 * lists `tools/scripts` as a project.
 *
 * The end-to-end half — plant a Chinese literal in an apps/web source, watch
 * `pnpm lint` exit 1, revert — is documented at the top of
 * tools/scripts/check-i18n-literals.mjs.
 *
 * The fixture lives under `.tmp-i18n-check/` inside the workspace so that the
 * REAL scope walk (`apps/`) is exercised: a checker whose scope silently stops
 * matching is exactly the failure this rule cannot afford. Biome ignores
 * `**\/.tmp-*`, and the directory is removed after every test. Fixture paths
 * keep their `apps/<app>/src/` shape, so scope and exemptions behave exactly as
 * they do for the real tree.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  containsCjk,
  findScopedFiles,
  findViolations,
  isExemptPath,
  isScopedSource,
  scanFile,
  USER_VISIBLE_JSX_ATTRIBUTES,
} from './check-i18n-literals.mjs';

/** Throwaway workspace-local root that mirrors the real `apps/` layout. */
const TMP_ROOT = join(process.cwd(), '.tmp-i18n-check');
const TMP_APP_SRC = join(TMP_ROOT, 'apps', 'web', 'src');

/** Native → POSIX path, the same normalisation the checker reports with. */
const toPosix = (p) => p.split('\\').join('/');

/** Pure-core convenience wrapper: violations for one source string. */
const violationsOf = (relFile, source) => findViolations({ relFile, source });

/**
 * Scan a planted fixture: the paths carry the real `apps/` segment, so scope and
 * exemptions behave exactly as they do for the real tree.
 */
const scanFixture = ({ absPath, relFile }) =>
  scanFile({ root: TMP_ROOT, absPath: toPosix(absPath), relFile });

/** Write a fixture file below the temp app and return its paths, POSIX-style. */
function plant(relUnderSrc, content) {
  const abs = join(TMP_APP_SRC, relUnderSrc);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, { encoding: 'utf8' });
  return { relFile: `.tmp-i18n-check/apps/web/src/${relUnderSrc}`, abs: toPosix(abs) };
}

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('i18n checker — CJK matcher', () => {
  it('matches Han characters in the BMP, extension A and above the BMP', () => {
    expect(containsCjk('设置')).toBe(true); // U+8BBE U+7F6E, CJK Unified Ideographs
    expect(containsCjk('㐀')).toBe(true); // U+3400, extension A
    expect(containsCjk('𠀀')).toBe(true); // U+20000, extension B (surrogate pair)
  });

  it('matches the CJK punctuation this project writes', () => {
    for (const punctuation of [
      '，',
      '。',
      '、',
      '：',
      '；',
      '！',
      '？',
      '（',
      '）',
      '「',
      '」',
      '『',
      '』',
      '…',
      '—',
    ]) {
      expect(containsCjk(`text${punctuation}text`), punctuation).toBe(true);
    }
  });

  it('matches a CJK character mixed into otherwise-technical text', () => {
    expect(containsCjk('aria-label="发送"')).toBe(true);
    expect(containsCjk('LLM 设置')).toBe(true);
    expect(containsCjk("t('chat.send')")).toBe(false);
  });

  it('ignores ASCII, Latin-1 accents, Cyrillic and emoji', () => {
    for (const clean of [
      '',
      'Settings',
      'Konfiguration',
      'Réglages',
      'Настройки',
      '🎲',
      'llm.base-url',
    ]) {
      expect(containsCjk(clean), clean).toBe(false);
    }
  });

  it('does not mistake Japanese kana or Hangul for Han (out of the stated range)', () => {
    // Documented boundary: the rule is Han + CJK punctuation, per the task's
    // range. Kana/Hangul are not user-facing text in this project yet.
    expect(containsCjk('せってい')).toBe(false);
    expect(containsCjk('설정')).toBe(false);
  });
});

describe('i18n checker — scope and exemptions', () => {
  it('scopes exactly apps/<app>/src/**/*.{ts,tsx}', () => {
    expect(isScopedSource('apps/web/src/app/app.tsx')).toBe(true);
    expect(isScopedSource('apps/web/src/chat/prompt.ts')).toBe(true);
    expect(isScopedSource('apps/desktop/src/index.ts')).toBe(true);
    expect(isScopedSource('packages/ui/src/index.tsx')).toBe(false);
    expect(isScopedSource('apps/web/index.html')).toBe(false);
    expect(isScopedSource('apps/web/src/styles.css')).toBe(false);
    expect(isScopedSource('apps/web/src/deep/node_modules/x.ts')).toBe(false);
  });

  it('exempts the i18n catalogs, which ARE the Chinese text', () => {
    expect(isExemptPath('packages/i18n/src/index.ts')).toBe(true);
    expect(isExemptPath('packages/i18n/src/catalogs/zh-cn.ts')).toBe(true);
    expect(isScopedSource('packages/i18n/src/index.ts')).toBe(false);
  });

  it('exempts test files and test fixture directories', () => {
    expect(isExemptPath('apps/web/src/app/routes/routes.test.tsx')).toBe(true);
    expect(isExemptPath('apps/web/src/chat/prompt.test.ts')).toBe(true);
    expect(isExemptPath('apps/web/src/__fixtures__/labels.ts')).toBe(true);
    expect(isExemptPath('apps/web/src/chat/providers.ts')).toBe(false);
  });

  it('exempts exactly the one temporary model-prompt file', () => {
    expect(isExemptPath('apps/web/src/chat/prompt.ts')).toBe(true);
  });

  it('keeps the model-prompt exemption from becoming a directory exemption', () => {
    // THE property that keeps a file exemption honest: a sibling in the same
    // directory is still reported, so the exemption cannot creep outward.
    expect(isExemptPath('apps/web/src/chat/providers.ts')).toBe(false);
    expect(isExemptPath('apps/web/src/chat/send-turn.ts')).toBe(false);
    expect(isExemptPath('apps/web/src/chat/prompt-extra.ts')).toBe(false);
    expect(isExemptPath('apps/web/src/chat/prompt.tsx')).toBe(false);
    expect(
      violationsOf('apps/web/src/chat/providers.ts', "export const message = '连接失败';"),
    ).toHaveLength(1);
    expect(
      violationsOf('apps/web/src/chat/prompt.ts', "export const message = '连接失败';"),
    ).toEqual([]);
  });
});

describe('i18n checker — every CJK literal shape is reported', () => {
  const cases = {
    'a single-quoted literal': "const label = '设置';",
    'a double-quoted literal': 'const label = "设置";',
    'a JSX text node': '<h1>设置</h1>',
    'a no-substitution template literal': 'const label = `保存`;',
    'a mixed technical string': 'const label = "LLM 设置";',
    'a CJK-punctuation-only string': 'const label = "…";',
  };

  for (const [name, source] of Object.entries(cases)) {
    it(`reports ${name}`, () => {
      const violations = violationsOf('apps/web/src/app/example.tsx', source);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(1);
      expect(violations[0].column).toBeGreaterThan(0);
      // The report quotes what the developer wrote, delimiters included, so the
      // line is recognisable at a glance in a CI log.
      expect(violations[0].text).toContain(
        source
          .trim()
          .replace(/^[^'"`]*/, '')
          .slice(1, -1),
      );
    });
  }

  it('reports a JSX text node on its own line, at the line the text starts', () => {
    const violations = violationsOf('apps/web/src/app/example.tsx', '<h1>\n  新建会话\n</h1>');
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
    expect(violations[0].text).toContain('新建会话');
  });

  it('reports the exact line and column of the literal', () => {
    const source = ['const a = 1;', 'const b = 2;', "const label = '设置';"].join('\n');
    const violations = violationsOf('apps/web/src/app/example.ts', source);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
    expect(violations[0].column).toBe(15); // the opening quote, not the '=' before it
    expect(violations[0].text).toBe("'设置'");
  });

  it('reports violations in source order', () => {
    const source = ["const b = '第二';", "const a = '第一';"].join('\n');
    const violations = violationsOf('apps/web/src/app/example.ts', source);
    expect(violations.map((violation) => violation.text)).toEqual(["'第二'", "'第一'"]);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
  });

  it('covers both tokens of a substituted template that has text around the hole', () => {
    // A substituted template is not one node: the text lives in a template
    // TOKEN on each side of `${}`. Missing those tokens is how a template like
    // this one would have passed the rule silently.
    const withChineseHole = `const label = \`共 \${count} 条\`;`;
    const violations = violationsOf('apps/web/src/app/example.ts', withChineseHole);
    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.text)).toEqual(['`共 ${', '} 条`']);
    expect(violations.map((violation) => violation.column)).toEqual([15, 25]);
  });

  it('reports a CJK literal inside a template expression, exactly once', () => {
    const onlyTheHole = `const label = \`\${'设置'}\`;`;
    const violations = violationsOf('apps/web/src/app/example.ts', onlyTheHole);
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toBe("'设置'");
  });

  it('reports nothing for clean input', () => {
    const clean = [
      "import { t } from '@smarttavern/i18n';",
      'export const view = () => (',
      '  <section aria-label={t("chat.input.label")}>',
      '    <h1>{t("app.title")}</h1>',
      '    <p>{t("chat.empty", { count })}</p>',
      '    <button title={t("chat.send")} placeholder={t("chat.input.placeholder")}>',
      '      {t("chat.send")}',
      '    </button>',
      '    <img src={url} alt={t("chat.image.alt")} />',
      '    <span className="badge" role="status" data-testid="badge">',
      '      {items.map((item) => item.name)}',
      '    </span>',
      '  </section>',
      ');',
    ].join('\n');
    expect(violationsOf('apps/web/src/app/clean.tsx', clean)).toEqual([]);
  });

  it('does not report comments or identifiers, which no regex can separate', () => {
    const source = [
      '// 这里是注释：规则不看注释',
      '/* 「块注释」也一样 */',
      'const 设置 = 1;',
      'const label = t("settings.title");',
    ].join('\n');
    // `const 设置 = 1` is a CJK IDENTIFIER, not a literal: reporting it would
    // mean guessing, and the rule reports only text a user could read.
    expect(violationsOf('apps/web/src/app/clean.ts', source)).toEqual([]);
  });

  it('does not report a CJK literal in an exempt file even when driven directly', () => {
    expect(
      violationsOf('packages/i18n/src/index.ts', "export const zhCN = { title: '设置' };"),
    ).toEqual([]);
    expect(violationsOf('apps/web/src/app/routes/routes.test.tsx', '<h1>设置</h1>')).toEqual([]);
  });
});

describe('i18n checker — user-visible JSX attributes, whatever the characters', () => {
  it('keeps a named, reviewable list of the attributes it treats as user-visible', () => {
    expect([...USER_VISIBLE_JSX_ATTRIBUTES].sort()).toEqual([
      'alt',
      'aria-description',
      'aria-label',
      'placeholder',
      'title',
    ]);
  });

  for (const attribute of ['title', 'placeholder', 'aria-label', 'aria-description', 'alt']) {
    it(`reports ${attribute}="…" even when the value is pure ASCII`, () => {
      const violations = violationsOf(
        'apps/web/src/app/example.tsx',
        `<img ${attribute}="Settings" src={url} />`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe('jsx-attribute');
      expect(violations[0].attribute).toBe(attribute);
      expect(violations[0].text).toBe('Settings');
    });
  }

  it('reports both JSX spellings and the template spelling of a bare attribute', () => {
    expect(
      violationsOf('apps/web/src/app/example.tsx', `<div title={'Close'} />`)[0].attribute,
    ).toBe('title');
    const violations = violationsOf('apps/web/src/app/example.tsx', '<div title={`Close`} />');
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('jsx-attribute');
  });

  it('reports a bare visible attribute once, with the attribute hint, not twice', () => {
    // Before the attribute rule this was the double-report trap: `title="设置"`
    // matched the character rule AND the attribute rule at the same position.
    const violations = violationsOf(
      'apps/web/src/app/example.tsx',
      '<button title="发送">go</button>',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('jsx-attribute');
    expect(violations[0].text).toBe('发送');
  });

  it('accepts the t(...) call and a runtime expression, which is the fix', () => {
    expect(violationsOf('apps/web/src/app/example.tsx', '<div title={t("app.title")} />')).toEqual(
      [],
    );
    expect(violationsOf('apps/web/src/app/example.tsx', '<div title={label} />')).toEqual([]);
    expect(
      violationsOf('apps/web/src/app/example.tsx', '<div title={t("a.b")} aria-label={label} />'),
    ).toEqual([]);
  });

  it('leaves machine-facing attributes alone', () => {
    const source = [
      '<div className="badge" id="root" role="status" data-testid="x" aria-hidden="true">',
      '  {t("app.title")}',
      '</div>',
    ].join('\n');
    expect(violationsOf('apps/web/src/app/example.tsx', source)).toEqual([]);
  });

  it('still reports a Chinese value in a machine-facing attribute via the character rule', () => {
    const violations = violationsOf('apps/web/src/app/example.tsx', '<div data-label="设置" />');
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('StringLiteral');
  });

  it('documents the blind spot: Latin prose in a JSX text node is not caught', () => {
    // Stated in the checker header on purpose. If this ever changes, the header
    // and CONTRIBUTING §5 must change with it — a rule may not claim more than
    // it does.
    expect(violationsOf('apps/web/src/app/example.tsx', '<h1>Settings</h1>')).toEqual([]);
  });
});

describe('i18n checker — scanning the real tree', () => {
  it('finds the planted violation through the real apps/ walk', () => {
    const { relFile, abs } = plant('app/planted.tsx', 'export const title = <h1>设置</h1>;');
    const files = findScopedFiles(TMP_ROOT);
    expect(files).toContain(abs);
    const violations = scanFixture({ absPath: abs, relFile });
    expect(violations).toHaveLength(1);
    expect(violations[0].relFile).toBe(relFile);
    expect(violations[0].text).toContain('设置');
  });

  it('reports a planted CJK literal in a .ts file too', () => {
    const { relFile, abs } = plant('chat/errors.ts', "export const message = '连接失败';");
    expect(scanFixture({ absPath: abs, relFile })).toHaveLength(1);
  });

  it('reports a planted bare visible attribute in a .tsx file', () => {
    const { relFile, abs } = plant('app/button.tsx', 'export const b = <button title="Send" />;');
    const violations = scanFixture({ absPath: abs, relFile });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('jsx-attribute');
  });

  it('reports nothing when the planted file is clean', () => {
    const { relFile, abs } = plant('app/clean.ts', "export const title = t('app.title');");
    expect(scanFixture({ absPath: abs, relFile })).toEqual([]);
  });

  it('does not report an exempt test file planted under the temp root', () => {
    const { relFile, abs } = plant('app/planted.test.tsx', 'export const title = <h1>设置</h1>;');
    // The file IS discovered by scope (a test file is still a source file); the
    // exemption is what keeps it unreported.
    expect(findScopedFiles(TMP_ROOT)).toContain(abs);
    expect(isScopedSource(relFile, 'apps')).toBe(true);
    expect(isExemptPath(relFile)).toBe(true);
    expect(scanFixture({ absPath: abs, relFile })).toEqual([]);
  });

  it('does not report an exempt catalog file planted under the temp root', () => {
    const abs = join(TMP_ROOT, 'packages', 'i18n', 'src', 'zh-cn.ts');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, "export const zhCN = { title: '设置' };", { encoding: 'utf8' });
    expect(
      scanFixture({ absPath: abs, relFile: '.tmp-i18n-check/packages/i18n/src/zh-cn.ts' }),
    ).toEqual([]);
  });

  it('fails loudly instead of succeeding when no files match the scope', () => {
    // An empty apps/ tree is the "checker silently checks nothing" case. The
    // CLI turns an empty result into exit code 2; here the emptiness itself is
    // the observable that keeps that branch honest.
    mkdirSync(join(TMP_ROOT, 'apps', 'web'), { recursive: true });
    expect(existsSync(TMP_APP_SRC)).toBe(false);
    expect(findScopedFiles(TMP_ROOT)).toEqual([]);
  });

  it('finds the real repository sources (the scope is not accidentally empty)', () => {
    const files = findScopedFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('apps/web/src/index.ts'))).toBe(true);
  });
});
