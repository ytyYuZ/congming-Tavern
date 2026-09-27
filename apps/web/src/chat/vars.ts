/**
 * Session variables (M1-S6): the app's read/write surface over `SessionState.vars`
 * (ADR-031), as PURE functions of `old state + change -> new state`.
 *
 * WHY EVERY WRITE IS A PURE FUNCTION AND NEVER AN IN-PLACE EDIT (ADR-010, ADR-031)
 * A `SessionState` is snapshotted WHOLE into a checkpoint (docs/04 §6), and the live
 * one is written whole into `Session.state` (ADR-032). If a writer mutated the object
 * it was handed, a checkpoint created earlier would silently follow every later change
 * — it would stop being "then", and a rollback would roll nothing back (the repository
 * test pins that independence at the row level). So `setVariable` / `deleteVariable` /
 * `applyVariableChanges` all answer a NEW object and leave their input untouched, which
 * is also what ADR-031 means by "a machine will write later": an AI's proposed change is
 * a value that can be shown to the user and REJECTED, and rejection is only expressible
 * while the write is a value rather than a mutation. The AI channel itself
 * (`update_state` / `update_relation`) is deferred to M2+ and deliberately NOT built
 * here — this module is the shape that makes it possible later.
 *
 * WHAT A VARIABLE IS (ADR-031, not a new decision)
 * A flat, session-scoped table of PRIMITIVES (`string | number | boolean`) and nothing
 * else: the schema froze that (`SessionStateSchema.vars`), objects and arrays belong to
 * a rule pack's `sheets`, and the status bar edits exactly these three. There is no
 * lookup chain and no prefix syntax, so `{{getvar::hp}}` needs none either.
 *
 * WHY THE MACRO LAYER'S LOG IS APPLIED HERE (`applyVariableChanges`)
 * `compose()` is pure, so a `{{setvar}}` cannot write anything: it returns a change log
 * (`ComposeSuccess.variableChanges`). This module turns that log into a state, and the
 * caller (`chat/send-turn.ts`) persists it — the composer produces values, the layer
 * that owns storage writes them. A change log is therefore TEXT (`VariableChange.value`
 * is a `string`), because macros substitute into text: a `setvar` writes the string
 * `"10"`, while a TYPED number is what the status bar's editor writes.
 */
import type { VariableChange } from '@smarttavern/core';
import type { SessionState } from '@smarttavern/schema';

/* ─────────────────────────────── the vocabulary ───────────────────────────── */

/**
 * One variable value. Three shapes and no more — this mirrors
 * `SessionState.vars` rather than widening to `unknown`, so a value that cannot be
 * stored is a compile error instead of a row the schema would refuse.
 */
export type VariableValue = string | number | boolean;

/**
 * The value kinds the typed editor offers, as DATA: the type below is derived from
 * this array, so the editor's dropdown and the parser cannot drift apart, and a
 * fourth kind would be a compile error at every `switch` over it.
 */
export const VARIABLE_KINDS = ['string', 'number', 'boolean'] as const;

/** One kind of value a variable may hold. */
export type VariableKind = (typeof VARIABLE_KINDS)[number];

/**
 * Narrow a `<select>`'s string back to a kind.
 *
 * WHY THIS EXISTS AT ALL: `event.target.value` is a `string`, and the two rules this
 * workspace compiles under leave no honest cast — `as VariableKind` is a lie the
 * compiler cannot check, and the select's own options are the only thing making it
 * true. A guard is checkable, and it is what the form calls before it parses a value.
 */
export function isVariableKind(value: string): value is VariableKind {
  return VARIABLE_KINDS.some((kind) => kind === value);
}

/**
 * The kind a stored value has.
 *
 * WHY AN `if` CHAIN AND NOT `return typeof value`: the return type of a bare `typeof`
 * expression on this union is TypeScript's whole typeof vocabulary (`bigint`, `object`,
 * …), because the operator is not narrowed by the union — so the honest total function
 * is three branches, and the last one is `string` rather than a cast.
 */
export function variableKindOf(value: VariableValue): VariableKind {
  if (typeof value === 'number') return 'number';
  return typeof value === 'boolean' ? 'boolean' : 'string';
}

/**
 * The text an editor starts from.
 *
 * `String(value)` is the SAME conversion `readVariable` uses when it substitutes a
 * variable into a prompt (`engine/prompt/macros.ts`), so the value the status bar shows
 * and the value the model is sent are one rendering: `true`/`false` spelled out and a
 * number in decimal (ADR-031 records the one caveat — around 1e21 JavaScript switches to
 * exponential notation, which is a data problem rather than a macro one).
 */
export function variableText(value: VariableValue): string {
  return String(value);
}

/**
 * Editor text -> a value of that kind, or `undefined` when the text is not one.
 *
 * WHY `undefined` AND NOT A THROW: this is called from a form on every save, and an
 * unreadable value is a sentence the user can act on, not a fault (the same reason
 * `advance` refuses a fractional delta instead of raising the engine's exception).
 * A `string` accepts ANY text including `''` — an empty string IS a value, and
 * `readVariable` documents that a key which exists with an empty value is a value, so
 * refusing it here would make a legal variable unreachable from the editor. A `number`
 * must be finite and not blank (`Number('')` is 0, which would hide the blank), and a
 * `boolean` is exactly the two spellings ADR-031 fixes: `true` and `false`.
 */
export function parseVariableInput(kind: VariableKind, text: string): VariableValue | undefined {
  const trimmed = text.trim();
  if (kind === 'string') return text;
  if (kind === 'boolean') {
    if (trimmed === 'true') return true;
    return trimmed === 'false' ? false : undefined;
  }
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/* ───────────────────────────── the pure transitions ───────────────────────── */

/**
 * The key a change is stored under: the name, trimmed.
 *
 * WHY TRIMMED: the macro layer trims too (`{{setvar:: hp ::1}}` writes `hp`), so
 * trimming here and not there would let one directive and one form write two keys that
 * look identical. `undefined` for a name that is empty after trimming — that is the one
 * spelling no variable can have, because `{{getvar::}}` and the editor's blank field can
 * never address it, and storing it would be a row nobody can read back.
 */
function keyOf(name: string): string | undefined {
  const key = name.trim();
  return key === '' ? undefined : key;
}

/**
 * Assign one variable (ADR-031: `setvar` assigns). Returns a NEW state whose `vars` is a
 * new record, or `undefined` when the name is not addressable.
 *
 * Re-assigning an existing name is an overwrite, not a duplicate: the table is flat and
 * keyed by name, and an editor that refused a second write could not edit at all.
 */
export function setVariable(
  state: SessionState,
  name: string,
  value: VariableValue,
): SessionState | undefined {
  const key = keyOf(name);
  if (key === undefined) return undefined;
  return { ...state, vars: { ...state.vars, [key]: value } };
}

/**
 * Remove one variable. Returns a NEW state, or `undefined` when there is nothing to
 * remove (a blank name, or a name that is not in the table).
 *
 * The record is rebuilt by COPYING rather than by `delete`: a `delete` on the existing
 * object would be the in-place edit this module exists to avoid, and the copy states
 * plainly that the input state is untouched.
 */
export function deleteVariable(state: SessionState, name: string): SessionState | undefined {
  const key = keyOf(name);
  if (key === undefined || !(key in state.vars)) return undefined;
  const vars: Record<string, VariableValue> = {};
  for (const [existing, value] of Object.entries(state.vars)) {
    if (existing !== key) vars[existing] = value;
  }
  return { ...state, vars };
}

/**
 * Apply the composer's change log (`{{setvar}}` / `{{addvar}}`), in the order it was
 * recorded: a later change to the same name wins, exactly as the directives were
 * performed.
 *
 * WHY THE WHOLE LOG AND NOT ONE CHANGE: `addvar` is recorded by the composer as the
 * ABSOLUTE value it computed (`engine/prompt/macros.ts` reads the context it was given
 * and writes the sum), so replaying the log in order reproduces what the composer
 * performed. Two `addvar`s in one block therefore compose — the second one having read
 * the value the context arrived with, which is the macro layer's documented single-pass
 * contract.
 *
 * An EMPTY log returns the SAME state object (identity), so a caller can skip a write
 * with `next === state` rather than by counting changes.
 */
export function applyVariableChanges(
  state: SessionState,
  changes: readonly VariableChange[],
): SessionState {
  const vars = { ...state.vars };
  let touched = false;
  for (const change of changes) {
    const key = keyOf(change.name);
    if (key === undefined) continue;
    vars[key] = change.value;
    touched = true;
  }
  return touched ? { ...state, vars } : state;
}
