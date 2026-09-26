/**
 * @smarttavern/stpack-cli — `tools/stpack-cli` entry point (M0-T0 placeholder).
 *
 * BOUNDARY: a leaf tool. It may consume any library workspace but no library
 * may import it (`tools/*` is the top of the graph, next to apps/*).
 *
 * M0-T4 adds the three subcommands required by docs/06-开发任务拆解.md:
 *   validate <file>   — schema + manifest + checksum validation
 *   inspect  <file>   — print the entry list, sizes and manifest summary
 *   unpack   <file> <dir> — deterministic extraction
 * The packaging logic itself stays in `@smarttavern/packages`; this CLI is
 * argument parsing, exit codes and human-readable output only.
 */
export const STPACK_CLI = '@smarttavern/stpack-cli' as const;
