/**
 * The macro registry and the expander (M1-G4; docs/02-技术架构.md §5.1 宏系统).
 *
 * WHAT IS EXPANDED, AND FROM WHERE. Every macro this module serves reads a value
 * the CALLER put in the `MacroContext`. Nothing is recomputed here: `{{time}}`,
 * `{{date}}` and `{{segment}}` prefer the caller's preformatted strings and only
 * fall back to the fields of a `ClockDisplay` the caller already produced with
 * the time engine's `display()`. This file does no calendar arithmetic, reads no
 * clock and knows no locale (docs/02 §5.1, engine/time/types.ts rule 1).
 *
 * A MISSING EXPANDER MUST BE VISIBLE, NOT SILENT. Two cases produce the same
 * treatment — the raw token is left in the text VERBATIM and its raw text is
 * reported in `MacroExpansion.unresolved`:
 *   - a name nobody registered (`{{frobnicate}}`), and
 *   - a name this composer deliberately does not serve: `{{roll::2d6}}`,
 *     `{{random::a,b}}`, `{{pick::…}}`. Those need the dice engine (M3-R1) or a
 *     seeded RNG, and an RNG without a provider decision is not core's business
 *     (docs/06 §2.4 M3-R1). Expanding them to '' would silently delete a dice
 *     roll from a prompt and nobody would see it; leaving them in the text makes
 *     the gap readable in the assembled prompt.
 * The one expansion that IS deliberately empty is `{{setvar::…}}`: it is a
 * directive, not text, and dropping it from the sentence is the point. It is
 * therefore not reported as unresolved.
 *
 * `setvar` DOES NOT MUTATE. The composer is pure, so the expander only records a
 * change through `MacroSink` (M1-S6 persists it). `{{getvar::name}}` therefore
 * still reads the value the context arrived with — a `setvar` earlier in the same
 * block does not make a later `getvar` see it. That is stated so the behaviour is
 * a contract rather than an accident of evaluation order.
 *
 * SINGLE PASS, AND WHAT "IDEMPOTENT" MEANS HERE. The scanner walks the ORIGINAL
 * text and never rescans what it substituted, so a value that itself contains
 * `{{…}}` is data: `{{getvar::x}}` with `x = '{{char}}'` yields the literal
 * `{{char}}`. Expanding that output a second time WOULD expand it, since a
 * stateless text function cannot know a macro from a value that looks like one —
 * which is exactly why the composer expands once and reports what it left. For
 * text whose values contain no macro syntax, expanding twice is a no-op.
 *
 * NESTING. Braces are matched with a depth counter, so
 * `{{getvar::{{char}}_hp}}` finds the OUTER close, not the inner one; arguments
 * are expanded before the outer name is resolved, up to `MAX_ARG_NESTING` levels.
 */
import type { ClockDisplay } from '../time';

/* ───────────────────────────── context / sink ─────────────────────────────── */

/**
 * The value bag the expanders read.
 *
 * Every name field is optional, and `undefined` (or an empty string) means "the
 * caller does not have this", which leaves the macro unresolved rather than
 * substituting nothing. `turnNumber` is required because it is the one input the
 * composer always has (the caller knows which turn it is asking about), which
 * makes `{{round}}` and `conditions.minTurns` unconditionally evaluable.
 */
export interface MacroContext {
  /** The character card in scope for this turn (`{{char}}`). */
  readonly characterName?: string;
  /** The player's card name (`{{user}}`). */
  readonly userName?: string;
  /** Who is speaking this turn; falls back to `characterName` (`{{speaker}}`). */
  readonly speakerName?: string;
  readonly worldName?: string;
  readonly sceneLocation?: string;
  /** 1-based turn number (`{{round}}`, `conditions.minTurns`). */
  readonly turnNumber: number;
  /** Session variables; the value union mirrors `SessionState.vars`. */
  readonly variables?: Readonly<Record<string, PromptVariableValue>>;
  /** The world clock, already resolved by `TimeEngine.display()`. */
  readonly clock?: ClockDisplay;
  /** Caller-formatted clock text; wins over `clock` and may be empty (absent). */
  readonly timeText?: string;
  /** Caller-formatted date text; wins over `clock` and may be empty (absent). */
  readonly dateText?: string;
  /** Caller-formatted day-part name; wins over `clock.segments` (`{{segment}}`). */
  readonly segmentName?: string;
}

/**
 * A variable value, mirroring `SessionState.vars`' union (string | number |
 * boolean) rather than widening to `unknown`: a macro substitutes into text, and
 * these three are the only shapes the schema lets a variable hold.
 */
export type PromptVariableValue = string | number | boolean;

/** One `{{setvar}}` the composer performed, in the order it performed them. */
export interface VariableChange {
  readonly name: string;
  readonly value: string;
}

/**
 * Where a `setvar` writes. The composer hands in a recorder, so the expander can
 * express the directive without the module holding state.
 */
export interface MacroSink {
  setVariable(name: string, value: string): void;
}

/**
 * One macro's behaviour. `undefined` means "known, but this context cannot serve
 * it" — the caller of the expander leaves the raw token in place.
 */
export type MacroExpander = (
  args: readonly string[],
  context: MacroContext,
  sink: MacroSink,
) => string | undefined;

/** What one pass over a text produced. */
export interface MacroExpansion {
  /** The text with every servable macro replaced; the rest left verbatim. */
  readonly text: string;
  /** Distinct unresolved tokens (`{{roll::2d6}}`), in first-appearance order. */
  readonly unresolved: readonly string[];
  /** Recorded, not applied — see the file header. */
  readonly changes: readonly VariableChange[];
}

/* ───────────────────────────── scanner syntax ─────────────────────────────── */

const OPEN = '{{';
const CLOSE = '}}';
const ARG_SEPARATOR = '::';

/**
 * How many levels of macros-inside-arguments are expanded. A cap and not
 * "unbounded" because `{{a::{{a::{{a::…}}}}}}` is a text a user can type; the
 * limit turns a pathological prompt into a visible unresolved token instead of
 * unbounded work in a pure function.
 */
const MAX_ARG_NESTING = 4;

/**
 * What a macro name may look like. Dots are included for the namespaced names
 * §5.1 lists (`world.name`, `scene.location`); a name that does not match is not
 * a macro at all, so `{{ }}` and `{{2x}}` stay verbatim.
 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/* ──────────────────────────────── helpers ─────────────────────────────────── */

/** Two digits, so a 100-minute hour renders as evenly as a 60-minute one. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Last-resort, locale-free clock renderings.
 *
 * WHY THESE MIRROR `renderParts`: `TimeEngine.renderParts()` is the time
 * engine's public, prose-free join of the same fields, and a second, differently
 * ordered rendering of one clock is exactly the drift ADR-016 forbids. It emits
 * date and time in ONE string, and splitting its output on the separator would
 * break on a month name that contains a space, so the two halves are built here
 * in `renderParts`' field order — `epochLabel year monthName day` and `hh:mm` —
 * and `macros.test.ts` pins the mirror by asserting
 * `renderParts(clock) === \`${date} ${time}\``.
 */
function clockTime(clock: ClockDisplay): string {
  return `${pad2(clock.hour)}:${pad2(clock.minuteOfHour)}`;
}

function clockDate(clock: ClockDisplay): string {
  return [clock.epochLabel, String(clock.year), clock.monthName, String(clock.day)]
    .filter((field): field is string => field !== undefined)
    .join(' ');
}

/** Treat "absent" and "empty" alike: both leave the macro unresolved. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Read one variable; a key that exists with an empty value IS a value. */
function readVariable(context: MacroContext, name: string): string | undefined {
  if (name.length === 0) return undefined;
  const values: Readonly<Record<string, PromptVariableValue>> | undefined = context.variables;
  if (values === undefined) return undefined;
  const value: PromptVariableValue | undefined = values[name];
  return value === undefined ? undefined : String(value);
}

/* ──────────────────────────────── registry ────────────────────────────────── */

/**
 * The registry, as data. A table (not a switch) because §5.1 explicitly grows it
 * ("+ 自定义宏插件"): a plugin registry is a map, and this one already has the
 * shape the plugin loader will need.
 */
const MACRO_TABLE: readonly (readonly [string, MacroExpander])[] = [
  ['char', (_args, context) => present(context.characterName)],
  ['user', (_args, context) => present(context.userName)],
  ['speaker', (_args, context) => present(context.speakerName ?? context.characterName)],
  ['round', (_args, context) => String(context.turnNumber)],
  ['time', (_args, context) => present(context.timeText) ?? fallback(context, clockTime)],
  ['date', (_args, context) => present(context.dateText) ?? fallback(context, clockDate)],
  ['segment', (_args, context) => present(context.segmentName ?? context.clock?.segments[0]?.name)],
  ['world.name', (_args, context) => present(context.worldName)],
  ['scene.location', (_args, context) => present(context.sceneLocation)],
  ['getvar', (args, context) => readVariable(context, (args[0] ?? '').trim())],
  [
    'setvar',
    (args, _context, sink) => {
      const name = (args[0] ?? '').trim();
      // Fewer than two arguments is a malformed directive, not an empty value:
      // reporting it keeps `{{setvar::hp}}` visible instead of silently doing
      // nothing.
      if (name.length === 0 || args.length < 2) return undefined;
      const value = args.slice(1).join(ARG_SEPARATOR);
      sink.setVariable(name, value);
      return '';
    },
  ],
];

/** `{time}`/`{date}` from the clock, or unresolved when there is no clock. */
function fallback(
  context: MacroContext,
  render: (clock: ClockDisplay) => string,
): string | undefined {
  const clock = context.clock;
  return clock === undefined ? undefined : present(render(clock));
}

/** The registry itself: name -> expander. */
const MACROS: ReadonlyMap<string, MacroExpander> = new Map(MACRO_TABLE);

/** Every macro name this composer serves, for a UI macro panel and for tests. */
export const MACRO_NAMES: readonly string[] = MACRO_TABLE.map(([name]) => name);

/* ──────────────────────────────── expansion ───────────────────────────────── */

/**
 * Index of the `}}` that closes an opening `{{` at/after `from`, honouring
 * nesting, or -1 when the text never closes it.
 */
function closingIndex(text: string, from: number): number {
  let level = 1;
  let index = from;
  while (index < text.length) {
    if (text.startsWith(OPEN, index)) {
      level += 1;
      index += OPEN.length;
      continue;
    }
    if (text.startsWith(CLOSE, index)) {
      level -= 1;
      if (level === 0) return index;
      index += CLOSE.length;
      continue;
    }
    index += 1;
  }
  return -1;
}

/**
 * One pass over `text`.
 *
 * A `{{` with no matching `}}` is NOT a macro: it stays in the text and is not
 * reported, because reporting it would claim a macro name the text does not
 * contain. The typo is visible in the assembled prompt, which is where a human
 * sees it anyway.
 */
function expand(
  text: string,
  context: MacroContext,
  sink: MacroSink,
  unresolved: Set<string>,
  depth: number,
): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(OPEN, cursor);
    if (open < 0) {
      out += text.slice(cursor);
      break;
    }
    const close = closingIndex(text, open + OPEN.length);
    if (close < 0) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, open);
    const raw = text.slice(open, close + CLOSE.length);
    out += resolve(raw, text.slice(open + OPEN.length, close), context, sink, unresolved, depth);
    cursor = close + CLOSE.length;
  }
  return out;
}

/** Resolve one `{{…}}` token, or return it verbatim (and report it). */
function resolve(
  raw: string,
  body: string,
  context: MacroContext,
  sink: MacroSink,
  unresolved: Set<string>,
  depth: number,
): string {
  // Arguments first: `{{getvar::{{char}}_hp}}` must name `Aria_hp`. Splitting the
  // body before this would cut inside the nested `{{…}}`.
  const expandedBody =
    depth < MAX_ARG_NESTING && body.includes(OPEN)
      ? expand(body, context, sink, unresolved, depth + 1)
      : body;
  const segments = expandedBody.split(ARG_SEPARATOR);
  const name = (segments[0] ?? '').trim();
  const expander = NAME_PATTERN.test(name) ? MACROS.get(name) : undefined;
  const value = expander?.(segments.slice(1), context, sink);
  if (value === undefined) {
    unresolved.add(raw);
    return raw;
  }
  return value;
}

/**
 * Expand every macro in `text`. Pure: the same text and context always produce
 * the same result, the context is never written to, and `setvar` only reports.
 */
export function expandMacros(text: string, context: MacroContext): MacroExpansion {
  const unresolved = new Set<string>();
  const changes: VariableChange[] = [];
  const sink: MacroSink = {
    setVariable: (name, value) => {
      changes.push({ name, value });
    },
  };
  const expanded = expand(text, context, sink, unresolved, 0);
  return { text: expanded, unresolved: [...unresolved], changes };
}
