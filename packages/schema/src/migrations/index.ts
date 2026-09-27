/**
 * Payload migrations (`docs/04-分享格式规范.md` §8).
 *
 * When a package declares `schemaVersions[entity] < CURRENT_SCHEMA_VERSIONS[entity]`,
 * the importer chains the registered steps until the payload reaches the current
 * shape. A migration function must have before/after fixtures (§8 makes that a
 * requirement, and `migrations.test.ts` is where they go once the table is
 * non-empty).
 *
 * THE TABLE IS EMPTY ON PURPOSE. Nothing has changed since v1, so the only
 * possible behaviours are "identity" and "no such step, refuse loudly". Shipping
 * a fake step would be worse than shipping none: it would suggest a v1 payload
 * needs upgrading when it does not.
 */
import { CURRENT_SCHEMA_VERSIONS, type PackageSchemaVersionKey } from '../package';

/** One `from -> to` upgrade for one entity. */
export type MigrationStep = {
  entity: PackageSchemaVersionKey;
  from: number;
  to: number;
  migrate: (input: unknown) => unknown;
};

/** Registered steps, in any order — `migrate()` looks them up by `(entity, from)`. */
export const MIGRATIONS: readonly MigrationStep[] = [];

/**
 * Upgrade a payload from `fromVersion` to `toVersion` (default: the version this
 * build understands).
 *
 * Throws instead of returning the input unchanged whenever a step is missing:
 * silently importing a payload we cannot understand is exactly the failure mode
 * `docs/04` §8 exists to prevent.
 */
export function migrate(
  entity: PackageSchemaVersionKey,
  value: unknown,
  fromVersion: number,
  toVersion: number = CURRENT_SCHEMA_VERSIONS[entity],
): unknown {
  if (fromVersion === toVersion) return value;
  if (fromVersion > toVersion) {
    throw new Error(
      `cannot migrate ${entity} backwards (${fromVersion} -> ${toVersion}); this build understands up to ${CURRENT_SCHEMA_VERSIONS[entity]}`,
    );
  }

  let current = value;
  let version = fromVersion;
  while (version < toVersion) {
    const step = MIGRATIONS.find((m) => m.entity === entity && m.from === version);
    if (step === undefined) {
      throw new Error(`no migration step for ${entity} from schema version ${version}`);
    }
    current = step.migrate(current);
    version = step.to;
  }
  return current;
}
