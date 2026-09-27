/**
 * Output shaping for `stpack`.
 *
 * TWO FORMS, ONE SOURCE OF TRUTH: humans get aligned, greppable lines; scripts
 * get `--json`. Both are derived from the same `ValidationReport`, so the JSON
 * form can never drift from what a person sees (and CI can assert on the JSON
 * without parsing prose).
 */
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
