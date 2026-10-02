/**
 * `stpack` entry point: `parseArgs` → subcommand → exit code.
 *
 * Argument parsing uses Node's built-in `node:util` `parseArgs` (`docs/06` §8.3):
 * zero dependencies, and it is strict enough that a typo'd flag fails instead of
 * being ignored. `main()` never calls `process.exit` and never touches
 * `process.argv` — the runnable wrapper (`../bin/stpack.mjs`) does both, which is
 * what makes every subcommand testable.
 */
import { parseArgs } from 'node:util';
import {
  type BuildExampleOptions,
  type CommonOptions,
  EXIT,
  type ImportOptions,
  runBuildExample,
  runImport,
  runInspect,
  runUnpack,
  runValidate,
  type UnpackOptions,
} from './commands';
import { type CliIo, defaultCliIo } from './format';

export const USAGE = `stpack — inspect, validate, unpack, import and build .stpack packages

Usage:
  stpack validate <file>          check a package, exit 1 if it is not importable
  stpack inspect  <file>          print the manifest summary and the content list
  stpack unpack   <file> <dir>    extract a package into <dir> (manifest first)
  stpack import   <file> <lib>    import into a JSON library and print the report
  stpack example  <file>          build the built-in example content pack (docs/06 M1-I2)

Options:
  --json          machine-readable output on stdout
  --force         unpack: overwrite files that already exist
                  example: overwrite an existing .stpack
  --dry-run       import: report what would happen, write nothing
  --select a,b    import: only these payload categories (worlds, characters, …)
  -h, --help      show this message

Exit codes: 0 ok · 1 invalid package / refused import · 2 usage · 3 I/O`;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `--select worlds,characters` → `['worlds', 'characters']`; repeated flags add up. */
function splitList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export async function main(argv: readonly string[], io: CliIo = defaultCliIo): Promise<number> {
  let values: {
    json?: boolean;
    force?: boolean;
    help?: boolean;
    'dry-run'?: boolean;
    select?: string[];
  };
  let positionals: string[];

  // `pnpm stpack -- <args>` (and npm) forward a LITERAL `--`. Node's parseArgs
  // treats it as the end-of-options marker, which would turn a following `--help`
  // into a positional and make help unreachable through the documented
  // invocation. Drop one leading separator before parsing.
  const args = argv[0] === '--' ? argv.slice(1) : argv;

  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        'dry-run': { type: 'boolean', default: false },
        select: { type: 'string', multiple: true },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (cause) {
    io.err(`stpack: ${messageOf(cause)}`);
    io.err(USAGE);
    return EXIT.usage;
  }

  if (values.help === true) {
    io.out(USAGE);
    return EXIT.ok;
  }

  const command = positionals[0];
  if (command === undefined) {
    io.err(USAGE);
    return EXIT.usage;
  }

  const options: CommonOptions = { json: values.json === true };
  const file = positionals[1];

  switch (command) {
    case 'validate': {
      if (file === undefined) {
        io.err('stpack: validate needs a <file>');
        return EXIT.usage;
      }
      return runValidate(file, options, io);
    }
    case 'inspect': {
      if (file === undefined) {
        io.err('stpack: inspect needs a <file>');
        return EXIT.usage;
      }
      return runInspect(file, options, io);
    }
    case 'unpack': {
      const target = positionals[2];
      if (file === undefined || target === undefined) {
        io.err('stpack: unpack needs a <file> and a <dir>');
        return EXIT.usage;
      }
      const unpackOptions: UnpackOptions = { ...options, force: values.force === true };
      return runUnpack(file, target, unpackOptions, io);
    }
    case 'import': {
      const library = positionals[2];
      if (file === undefined || library === undefined) {
        io.err('stpack: import needs a <file> and a <library>');
        return EXIT.usage;
      }
      const only = splitList(values.select);
      const importOptions: ImportOptions = {
        ...options,
        dryRun: values['dry-run'] === true,
        ...(only === undefined ? {} : { only }),
      };
      return runImport(file, library, importOptions, io);
    }
    case 'example': {
      if (file === undefined) {
        io.err('stpack: example needs a <file>');
        return EXIT.usage;
      }
      const exampleOptions: BuildExampleOptions = { ...options, force: values.force === true };
      return runBuildExample(file, exampleOptions, io);
    }
    default: {
      io.err(`stpack: unknown command ${JSON.stringify(command)}`);
      io.err(USAGE);
      return EXIT.usage;
    }
  }
}
