/**
 * Output shaping for `stpack`.
 *
 * TWO FORMS, ONE SOURCE OF TRUTH: humans get aligned, greppable lines; scripts
 * get `--json`. Both are derived from the same `ValidationReport` (or, for
 * `import`, the same `ImportReport`), so the JSON form can never drift from what a
 * person sees — and CI can assert on the JSON without parsing prose.
 */
import type { ImportEntityReport, ImportFinding, ImportReport } from '@smarttavern/importers';
import type { ValidationFinding, ValidationReport } from '@smarttavern/packages';
import type { PackageManifest } from '@smarttavern/schema';

/** Where the CLI writes. Injectable so tests can assert on output. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const defaultCliIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** The fields of a manifest worth showing without dumping the whole thing. */
export interface ManifestSummary {
  readonly name: string;
  readonly kind: string;
  readonly id: string;
  readonly formatVersion: number;
  readonly createdAt: string;
  readonly license: string;
  readonly generator: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export function summarizeManifest(manifest: PackageManifest): ManifestSummary {
  return {
    name: manifest.name,
    kind: manifest.kind,
    id: manifest.id,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    license: manifest.license,
    generator: `${manifest.generator.app} ${manifest.generator.version} (${manifest.generator.platform})`,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.tags === undefined ? {} : { tags: manifest.tags }),
  };
}

/** Errors first, then warnings — the order a user needs to read them in. */
export function sortedFindings(findings: readonly ValidationFinding[]): ValidationFinding[] {
  return [...findings].sort((left, right) => {
    if (left.severity === right.severity) return 0;
    return left.severity === 'error' ? -1 : 1;
  });
}

export function formatFindings(findings: readonly ValidationFinding[]): string[] {
  return sortedFindings(findings).map((finding) => {
    const where = finding.path === undefined ? '' : ` [${finding.path}]`;
    return `${finding.severity === 'error' ? 'ERROR' : 'WARN '} ${finding.code}${where}: ${finding.message}`;
  });
}

export function formatCounts(report: ValidationReport): string[] {
  const counts = report.manifest?.contents.counts;
  if (counts === undefined) return [];
  const present = Object.entries(counts).filter(([, value]) => value > 0);
  if (present.length === 0) return ['  (empty)'];
  return present.map(([key, value]) => `  ${key.padEnd(14)} ${value}`);
}

export function formatEntries(report: ValidationReport): string[] {
  if (report.manifest === undefined) return [];
  return report.manifest.entries.map(
    (entry) => `  ${String(entry.bytes).padStart(10)}  ${entry.path}`,
  );
}

/**
 * The machine-readable form. `ok`, a stable `code` per finding and the same
 * summary a human sees; nothing here requires parsing English.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/* ──────────────────────────────── import ────────────────────────────────── */

/** One entity line of the import report: what happened, to what. */
function formatEntity(entity: ImportEntityReport): string {
  const label = [entity.name, entity.version === undefined ? undefined : `v${entity.version}`]
    .filter((part) => part !== undefined)
    .join(' ');
  const ids =
    entity.originId === undefined
      ? `${entity.packageId} -> ${entity.id ?? '-'}`
      : `${entity.originId} -> ${entity.id ?? '-'} (originId recorded)`;
  const reason = entity.reason === undefined ? '' : `  ${entity.reason}`;
  return `  ${entity.action.padEnd(9)} ${entity.entity.padEnd(11)} ${(label === '' ? '-' : label).padEnd(20)} ${ids}${reason}`;
}

/** Findings, sorted errors-first, in the same shape `formatFindings` uses. */
export function formatImportFindings(findings: readonly ImportFinding[]): string[] {
  const sorted = [...findings].sort((left, right) => {
    if (left.severity === right.severity) return 0;
    if (left.severity === 'error') return -1;
    return right.severity === 'error' ? 1 : 0;
  });
  return sorted.map((finding) => {
    const path = finding.path === undefined ? '' : ` [${finding.path}]`;
    const where = finding.where === undefined ? '' : ` (${finding.where})`;
    return `${finding.severity === 'error' ? 'ERROR' : finding.severity === 'warning' ? 'WARN ' : 'INFO '} ${finding.code}${path}${where}: ${finding.detail}`;
  });
}

/**
 * The import report a person reads (`docs/04` §7 step 9: the report "必须展示给用户",
 * because an import never overwrites anything silently). Counts first, then every
 * entity, then the findings — the order a user needs to decide whether the import
 * did what they meant.
 */
export function formatImportReport(
  report: ImportReport,
  file: string,
  libraryPath: string,
  dryRun: boolean,
): string[] {
  const lines: string[] = [];
  const name =
    report.package === undefined ? file : `${report.package.name} (${report.package.kind})`;
  lines.push(
    `${name}: ${report.ok ? 'OK' : 'REFUSED'}${dryRun ? ' — dry run, nothing was written' : ''}`,
  );
  lines.push(
    `  created ${report.counts.created} · reused ${report.counts.reused} · remapped ${report.counts.remapped} · skipped ${report.counts.skipped}`,
  );
  if (report.findings.length > 0) {
    lines.push('', 'findings:');
    lines.push(...formatImportFindings(report.findings));
  }
  if (report.entities.length > 0) {
    lines.push('', `entities (${report.entities.length}):`);
    for (const entity of report.entities) lines.push(formatEntity(entity));
  }
  lines.push('', `${dryRun ? 'would write to' : 'library'} ${libraryPath}`);
  return lines;
}

/** The library's row counts, so a second import visibly changed nothing. */
export function formatLibrarySizes(sizes: Readonly<Record<string, number>>): string[] {
  const entries = Object.entries(sizes);
  if (entries.length === 0) return ['  (empty)'];
  return entries.map(([name, count]) => `  ${name.padEnd(18)} ${count}`);
}
