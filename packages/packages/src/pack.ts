/**
 * `pack` — turn payload files plus a manifest draft into `.stpack` bytes
 * (`docs/04` §2, §11; ADR-018).
 *
 * DETERMINISM, CONCRETELY: the same input always produces the same bytes, because
 *   - the payload is sorted into ASCII dictionary order (`docs/04` §2),
 *   - `manifest.json` is written first and nowhere else,
 *   - every entry gets the fixed DOS timestamp `1980-01-01 00:00:00`,
 *   - JSON is written as canonical JSON (recursive key order, no whitespace).
 * `docs/04` §12 item 1 is exactly this property, asserted by the round-trip test.
 *
 * WHY EVERYTHING IS DEFLATED: per-entry compression choices are deliberately
 * unexciting. Payloads are deflated, nothing is `store`d, because a "clever"
 * choice per file would make the output harder for a third-party writer to
 * reproduce byte for byte.
 */
import type { PackageManifest } from '@smarttavern/schema';
import { canonicalJsonBytes } from './canonical-json';
import type { PartialPackageLimits } from './limits';
import {
  buildManifest,
  MANIFEST_ENTRY_PATH,
  type ManifestDraft,
  type PayloadInput,
  preparePayload,
} from './manifest';
import { writeZip } from './zip/write';

/** Everything `pack` needs. `limits` also bounds what we are willing to WRITE. */
export interface PackInput {
  readonly manifest: ManifestDraft;
  readonly files: readonly PayloadInput[];
  readonly limits?: PartialPackageLimits;
}

/**
 * Build the archive. Returns the bytes; writing them to a file, a download or a
 * share sheet is the caller's business (`packages/packages` never touches I/O).
 */
export async function pack(input: PackInput): Promise<Uint8Array> {
  const payload = preparePayload(input.files, input.limits);
  const manifest: PackageManifest = await buildManifest(input.manifest, payload);

  const entries = [
    { path: MANIFEST_ENTRY_PATH, bytes: canonicalJsonBytes(manifest), method: 'deflate' as const },
    ...payload.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      method: 'deflate' as const,
    })),
  ];

  return writeZip(entries);
}
