/**
 * @smarttavern/stpack-cli — the `.stpack` command line tool.
 *
 * BOUNDARY: a leaf tool. It may consume any library workspace but no library may
 * import it (`tools/*` is the top of the graph, next to `apps/*`).
 *
 * The packaging logic itself stays in `@smarttavern/packages`; this package is
 * argument parsing, exit codes and output only (`docs/06-开发任务拆解.md` §8.3).
 * Run it with `pnpm stpack -- <command>`.
 */
export * from './cli';
export * from './commands';
export * from './format';

/** Identity marker, kept so the package is greppable and smoke-testable. */
export const STPACK_CLI = '@smarttavern/stpack-cli' as const;
