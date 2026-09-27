/**
 * The macro registry and the expander (M1-G4; docs/02-技术架构.md §5.1 宏系统).
 *
 * THE FOUR DECISIONS THIS FILE PINS DOWN
 *
 * 1. Every macro is served from the CONTEXT, so there is one expectation per
 *    name and no calendar arithmetic is hidden in a macro.
 * 2. The clock fallback is byte-identical to the time engine's own
 *    `renderParts()` — asserted against that public function, so a second,
 *    differently ordered rendering of one clock cannot appear here unnoticed.
 * 3. `{{roll}}`/`{{random}}`/`{{pick}}` and unknown names stay VERBATIM and are
 *    reported: a missing expander must be visible in the assembled prompt, not
 *    silently become an empty string.
 * 4. `setvar` reports and never writes, and expansion is single-pass, so a value
 *    that looks like a macro is data.
 */
import { describe, expect, it } from 'vitest';
import { renderParts } from '../time';
import type { MacroContext } from './macros';
import { expandMacros, MACRO_NAMES } from './macros';
import { clock, deepFreeze, macroContext } from './test-kit';

describe('expandMacros — the registry', () => {
  const table: readonly [template: string, expected: string][] = [
    ['{{char}}', 'Aria'],
    ['{{user}}', 'Yuki'],
    ['{{speaker}}', 'Aria'],
    ['{{round}}', '4'],
    ['{{time}}', '02:30'],
    ['{{date}}', 'Era 3 Alpha 4'],
    ['{{segment}}', 'Dawn'],
    ['{{world.name}}', 'Elaria'],
    ['{{scene.location}}', 'The tavern'],
    ['{{getvar::hp}}', '10'],
    ['{{getvar::Aria_hp}}', '12'],
    // A directive expands to nothing on purpose: it is an instruction, not text.
    ['{{setvar::hp::7}}', ''],
  ];

  it.each(table)('%s expands to %j', (template, expected) => {
    const expansion = expandMacros(template, macroContext());
    expect(expansion.text).toBe(expected);
    expect(expansion.unresolved).toEqual([]);
  });

  it('registers exactly the names docs/02 §5.1 can serve from a context', () => {
    expect([...MACRO_NAMES].sort()).toEqual([
      'char',
      'date',
      'getvar',
      'round',
      'scene.location',
      'segment',
      'setvar',
      'speaker',
      'time',
      'user',
      'world.name',
    ]);
    // Deliberately absent: the dice engine is M3-R1 and an unseeded RNG is a
    // provider decision, not core's business.
    expect(MACRO_NAMES).not.toContain('roll');
    expect(MACRO_NAMES).not.toContain('random');
    expect(MACRO_NAMES).not.toContain('pick');
  });

  it('hands the caller-formatted strings priority over the clock', () => {
    const expansion = expandMacros(
      '{{time}} | {{date}} | {{segment}}',
      macroContext({
        timeText: 'the dusk bell',
        dateText: 'the fourth of Alpha',
        segmentName: 'dusk',
      }),
    );
    expect(expansion.text).toBe('the dusk bell | the fourth of Alpha | dusk');
  });

  it('reads an empty caller-formatted string as absent and falls back to the clock', () => {
    expect(expandMacros('{{time}}', macroContext({ timeText: '' })).text).toBe('02:30');
  });

  it("renders the clock exactly as the time engine's renderParts does", () => {
    const expansion = expandMacros('{{date}} {{time}}', macroContext({ clock }));
    // The one place the composer's fallback and the time engine's public
    // renderer are compared: if either changes field order, this fails.
    expect(expansion.text).toBe(renderParts(clock));
  });
});

describe('expandMacros — adjacency and nesting', () => {
  it('expands macros that touch each other or sit inside prose', () => {
    const context = macroContext();
    expect(expandMacros('{{char}}{{user}}', context).text).toBe('AriaYuki');
    expect(expandMacros('a{{round}}b{{round}}c', context).text).toBe('a4b4c');
    expect(expandMacros('the {{char}} of {{world.name}}', context).text).toBe('the Aria of Elaria');
    // Braces that are not a macro are left exactly as written.
    expect(expandMacros('{char} and {{ }} and {{2x}}', context).text).toBe(
      '{char} and {{ }} and {{2x}}',
    );
  });

  it('expands a macro inside an argument before resolving the outer name', () => {
    // `{{getvar::{{char}}_hp}}` names `Aria_hp`, which the fixture sets to 12.
    expect(expandMacros('{{getvar::{{char}}_hp}}', macroContext()).text).toBe('12');
    expect(expandMacros('{{setvar::{{char}}_mood::calm}}', macroContext()).changes).toEqual([
      { name: 'Aria_mood', value: 'calm' },
    ]);
  });

  it('leaves a brace with no closer verbatim and does not claim it is a macro', () => {
    const expansion = expandMacros('a {{char', macroContext());
    expect(expansion.text).toBe('a {{char');
    expect(expansion.unresolved).toEqual([]);
  });
});

describe('expandMacros — what is left unresolved', () => {
  it('reports each unresolved token once, in first-appearance order', () => {
    const expansion = expandMacros(
      '{{roll::2d6}} and {{random::a,b}} and {{pick::x}} and {{frobnicate}} and {{roll::2d6}}',
      macroContext(),
    );
    expect(expansion.text).toBe(
      '{{roll::2d6}} and {{random::a,b}} and {{pick::x}} and {{frobnicate}} and {{roll::2d6}}',
    );
    expect(expansion.unresolved).toEqual([
      '{{roll::2d6}}',
      '{{random::a,b}}',
      '{{pick::x}}',
      '{{frobnicate}}',
    ]);
  });

  const absent: readonly [template: string, context: MacroContext][] = [
    ['{{char}}', macroContext({ characterName: undefined })],
    ['{{user}}', macroContext({ userName: undefined })],
    ['{{speaker}}', macroContext({ characterName: undefined, speakerName: undefined })],
    ['{{world.name}}', macroContext({ worldName: undefined })],
    ['{{scene.location}}', macroContext({ sceneLocation: undefined })],
    ['{{time}}', macroContext({ clock: undefined })],
    ['{{date}}', macroContext({ clock: undefined })],
    ['{{segment}}', macroContext({ clock: undefined })],
    ['{{char}}', macroContext({ characterName: '' })],
    ['{{getvar::missing}}', macroContext()],
    ['{{getvar::}}', macroContext()],
    // A malformed directive is reported rather than silently doing nothing.
    ['{{setvar::hp}}', macroContext()],
    ['{{setvar::}}', macroContext()],
  ];

  it.each(absent)('%s stays verbatim when its input is absent', (template, context) => {
    const expansion = expandMacros(template, context);
    expect(expansion.text).toBe(template);
    expect(expansion.unresolved).toEqual([template]);
    expect(expansion.changes).toEqual([]);
  });
});

describe('expandMacros — setvar is a report, not a write', () => {
  it('records the change and leaves the frozen context untouched', () => {
    const context = deepFreeze(macroContext());
    const expansion = expandMacros('{{setvar::hp::7}}hp={{getvar::hp}}', context);
    // `getvar` still reads the value the context arrived with: the composer is
    // pure and M1-S6 is what persists the change.
    expect(expansion.text).toBe('hp=10');
    expect(expansion.changes).toEqual([{ name: 'hp', value: '7' }]);
    expect(context.variables).toEqual({ hp: 10, Aria_hp: 12 });
  });

  it('keeps the value verbatim, separators included, and does not trim it', () => {
    const expansion = expandMacros('{{setvar::note::a::b }}', macroContext());
    expect(expansion.changes).toEqual([{ name: 'note', value: 'a::b ' }]);
  });

  it('stringifies the variable value union the schema allows', () => {
    const context = macroContext({ variables: { level: 3, brave: true } });
    expect(expandMacros('{{getvar::level}}/{{getvar::brave}}', context).text).toBe('3/true');
  });

  it('reads a variable that exists with an empty value as empty, not as missing', () => {
    const context = macroContext({ variables: { note: '' } });
    const expansion = expandMacros('[{{getvar::note}}]', context);
    expect(expansion.text).toBe('[]');
    expect(expansion.unresolved).toEqual([]);
  });
});

describe('expandMacros — single pass', () => {
  it('treats a value that looks like a macro as data', () => {
    const context = macroContext({ variables: { tpl: '{{char}}' } });
    const once = expandMacros('{{getvar::tpl}}', context);
    expect(once.text).toBe('{{char}}');
    // A second pass over text the composer PRODUCED is not something it does —
    // this expectation documents exactly why: the output is data, and re-reading
    // it as a template is the double-expansion that must not happen inside one
    // assembly.
    expect(expandMacros(once.text, context).text).toBe('Aria');
  });

  it('is a no-op when the result contains no macro syntax', () => {
    const context = macroContext();
    const once = expandMacros('{{char}} greets {{user}} at {{time}}', context);
    expect(expandMacros(once.text, context).text).toBe(once.text);
  });

  it('does not fire a setvar twice', () => {
    const context = macroContext();
    const once = expandMacros('a{{setvar::k::v}}', context);
    expect(once.text).toBe('a');
    expect(once.changes).toEqual([{ name: 'k', value: 'v' }]);
    // The directive is gone from the text, so a second pass has nothing to do.
    const twice = expandMacros(once.text, context);
    expect(twice.text).toBe('a');
    expect(twice.changes).toEqual([]);
  });
});
