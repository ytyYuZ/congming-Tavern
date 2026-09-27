/**
 * `chat/vars.ts` — the session-variable contract (M1-S6, ADR-031).
 *
 * WHAT THIS FILE HAS TO PROVE
 * 1. Every write is PURE: the old state and its `vars` record come out unchanged
 *    (ADR-010), which is what keeps an already-taken checkpoint from following a later
 *    edit and what an AI-proposed change needs in order to be refusable.
 * 2. A name is trimmed exactly the way `engine/prompt/macros.ts` trims it, and a blank
 *    one is refused rather than stored as a key no macro can address.
 * 3. The composer's change log is TEXT (`{{setvar::hp::10}}` writes `"10"`), it is
 *    replayed in order, and an empty log returns the same object so a caller can skip a
 *    write by identity.
 * 4. The typed editor's three kinds round-trip, and text a kind cannot hold is refused
 *    with `undefined` rather than coerced (`Number('')` would be 0).
 */
import { defaultSessionState, type SessionState } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  applyVariableChanges,
  deleteVariable,
  isVariableKind,
  parseVariableInput,
  setVariable,
  variableKindOf,
  variableText,
} from './vars';

/** A session state carrying exactly these variables and the epoch clock. */
function stateWith(vars: Record<string, string | number | boolean>): SessionState {
  return { ...defaultSessionState(0), vars };
}

describe('chat/vars — the pure transitions (ADR-031)', () => {
  it('sets through a new object: neither the old state nor its vars record moves', () => {
    const before = stateWith({ hp: 10 });
    const after = setVariable(before, 'hp', 3);

    expect(after?.vars).toEqual({ hp: 3 });
    // The old state is the value a checkpoint taken a moment ago holds. An in-place
    // implementation would have moved it too, and the save point would stop being "then".
    expect(before.vars).toEqual({ hp: 10 });
    expect(after).not.toBe(before);
    expect(after?.vars).not.toBe(before.vars);
    // Nothing but `vars` changes: a variable write is not a clock or a scene edit.
    expect(after?.clock).toBe(before.clock);
    expect(after?.scene).toEqual(before.scene);
  });

  it('trims the name the macro layer trims, and refuses a blank one', () => {
    // `{{setvar:: hp ::1}}` writes `hp`, so the editor must not be able to write a second
    // key that reads identically.
    expect(setVariable(stateWith({}), '  hp  ', 1)?.vars).toEqual({ hp: 1 });
    // A blank name can never be addressed by `{{getvar::}}` or by the editor's own field.
    expect(setVariable(stateWith({}), '   ', 1)).toBeUndefined();
  });

  it('re-assigns an existing name instead of duplicating it', () => {
    expect(setVariable(stateWith({ hp: 1 }), 'hp', 2)?.vars).toEqual({ hp: 2 });
  });

  it('deletes by copying, and refuses a name that is not there', () => {
    const before = stateWith({ hp: 1, weather: 'snow' });
    const after = deleteVariable(before, 'hp');

    expect(after?.vars).toEqual({ weather: 'snow' });
    // The record the caller still holds is intact — the delete built a new one.
    expect(before.vars).toEqual({ hp: 1, weather: 'snow' });
    // Nothing to delete is a refusal, not a write that changes nothing: the view says so
    // instead of reporting a save that did not happen.
    expect(deleteVariable(before, 'missing')).toBeUndefined();
    expect(deleteVariable(before, '  ')).toBeUndefined();
  });

  it('replays the composer log in order, as text, and returns the input for an empty log', () => {
    const before = stateWith({ hp: 1 });
    // `addvar` records the ABSOLUTE sum it computed, so the last entry for a name wins —
    // exactly what the composer performed, in the order it performed it.
    const after = applyVariableChanges(before, [
      { name: 'hp', value: '4' },
      { name: 'hp', value: '6' },
      { name: 'weather', value: 'snow' },
    ]);

    // TEXT, not numbers: a macro substitutes into text, so `{{setvar::hp::10}}` writes the
    // string "10". A typed number is what the status bar's editor writes.
    expect(after.vars).toEqual({ hp: '6', weather: 'snow' });
    expect(before.vars).toEqual({ hp: 1 });
    // Identity for an empty log is what lets a caller skip the write without counting.
    expect(applyVariableChanges(before, [])).toBe(before);
  });
});

describe('chat/vars — the typed editor', () => {
  it('parses each kind', () => {
    // An empty string IS a value (`readVariable` documents that a key which exists with
    // an empty value is a value), so the string kind accepts it.
    expect(parseVariableInput('string', '')).toBe('');
    expect(parseVariableInput('string', '12')).toBe('12');
    expect(parseVariableInput('number', ' 12 ')).toBe(12);
    expect(parseVariableInput('number', '-2.5')).toBe(-2.5);
    expect(parseVariableInput('boolean', 'true')).toBe(true);
    expect(parseVariableInput('boolean', ' false ')).toBe(false);
  });

  it('refuses text a kind cannot hold instead of coercing it', () => {
    // `Number('')` is 0 and `Number('abc')` is `NaN`: both would silently store a value
    // nobody typed.
    expect(parseVariableInput('number', '')).toBeUndefined();
    expect(parseVariableInput('number', 'abc')).toBeUndefined();
    expect(parseVariableInput('number', 'Infinity')).toBeUndefined();
    expect(parseVariableInput('boolean', '1')).toBeUndefined();
    expect(parseVariableInput('boolean', 'yes')).toBeUndefined();
  });

  it('names and renders a stored value the way a prompt does', () => {
    expect(variableKindOf('snow')).toBe('string');
    expect(variableKindOf(3)).toBe('number');
    expect(variableKindOf(true)).toBe('boolean');
    // `String(value)` is the conversion `readVariable` substitutes with (ADR-031).
    expect(variableText('snow')).toBe('snow');
    expect(variableText(10)).toBe('10');
    expect(variableText(true)).toBe('true');
    expect(isVariableKind('number')).toBe(true);
    expect(isVariableKind('object')).toBe(false);
  });
});
