/**
 * What a proposal is (M1-W2): the format the model is asked for, the tolerant reader, and the ONE
 * `(draft, proposal) -> payload` function the preview and the apply share.
 *
 * WHY THE READER IS TESTED SEPARATELY FROM THE STORE
 * A model is a text model, and "what does this side do with an answer it did not expect" is the half
 * of this feature that no provider contract can guarantee. Each refusal the reader can produce is
 * asserted here as DATA (`reason` plus whatever text came with it), so the panel's sentence and the
 * store's "the draft did not move" are both statements about a value this file pins.
 */
/** @vitest-environment node */
import type { WorldData } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { blankWorldData } from '../cards/world';
import {
  coCreateInstructions,
  customFieldPaths,
  opPathText,
  opTargetLabel,
  PROPOSAL_RESPONSE_SCHEMA,
  previewWorldProposal,
  readProposal,
  sameWorldData,
  WORLD_PATCH_PATHS,
} from './proposal';

function world(): WorldData {
  return { ...blankWorldData('霜月群岛'), premise: '群岛在霜月下沉' };
}

describe('the paths a proposal may address', () => {
  it('offers the form’s own fields, as pointers, with the form’s own labels', () => {
    const paths = WORLD_PATCH_PATHS.map((entry) => entry.path);
    expect(paths).toContain('/premise');
    expect(paths).toContain('/rulesOfNature/taboos');
    expect(paths).toContain('/calendar/minutesPerHour');
    expect(paths).toContain('/timeRhythm/implicitAdvance');
    expect(paths).toContain('/regions');
    // Every one of them is a pointer the engine can parse and address.
    expect(opTargetLabel({ op: 'replace', path: '/rulesOfNature/taboos' })).toBe(
      'world.taboosLabel',
    );
  });

  it('leaves customFields to the keys that exist, escaped', () => {
    expect(WORLD_PATCH_PATHS.map((entry) => entry.path)).not.toContain('/customFields');
    const data = { ...world(), customFields: { 天气: '暴雪', 'a/b': 'c' } };
    expect(customFieldPaths(data).map((entry) => entry.path)).toEqual([
      '/customFields/天气',
      '/customFields/a~1b',
    ]);
  });
});

describe('the instruction the model is asked with', () => {
  it('carries the payload, the editable paths and the operation format', () => {
    const text = coCreateInstructions(world());
    expect(text).toContain('"premise": "群岛在霜月下沉"');
    expect(text).toContain('- /rulesOfNature/taboos');
    expect(text).toContain('{"op":"replace","path":"/era","value":"..."}');
    expect(text).toContain('"ops"');
    // The plugin channel is NOT part of the conversation: no `extensions` key reaches the prompt.
    expect(text).not.toContain('x-');
    expect(JSON.stringify(PROPOSAL_RESPONSE_SCHEMA)).toContain('"ops"');
  });
});

describe('reading an answer', () => {
  it('reads a bare JSON object', () => {
    const read = readProposal(
      '{"message":"ok","rationale":"because","ops":[{"op":"replace","path":"/premise","value":"x"}]}',
      'p1',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.proposal.message).toBe('ok');
    expect(read.proposal.rationale).toBe('because');
    expect(read.proposal.ops).toEqual([{ op: 'replace', path: '/premise', value: 'x' }]);
    expect(read.proposal.empty).toBe(false);
  });

  it('reads a fenced object and one buried in prose', () => {
    const fenced = readProposal('```json\n{"message":"m","ops":[]}\n```', 'p1');
    expect(fenced.ok && fenced.proposal.empty).toBe(true);
    const prose = readProposal(
      'Sure, here it is:\n{"message":"m","ops":[]}\nHope that helps!',
      'p1',
    );
    expect(prose.ok && prose.proposal.message).toBe('m');
  });

  it('does not stop at a brace inside a string', () => {
    const read = readProposal('{"message":"a } b {","ops":[]}', 'p1');
    expect(read.ok && read.proposal.message).toBe('a } b {');
  });

  it('treats an empty ops list as a turn that only talked', () => {
    const read = readProposal('{"message":"tell me more","ops":[]}', 'p1');
    expect(read.ok && read.proposal.empty).toBe(true);
  });

  it('reports prose, a missing ops field and a bad operation as findings', () => {
    const prose = readProposal('I think the premise is fine as it is.', 'p1');
    expect(prose.ok).toBe(false);
    expect(prose.ok ? undefined : prose.malformed).toEqual({
      reason: 'no-json',
      message: 'I think the premise is fine as it is.',
      // The answer VERBATIM: the panel's `{detail}` slot carries it, which is what lets the author
      // decide whether retrying is worth it.
      text: 'I think the premise is fine as it is.',
    });

    const noOps = readProposal('{"message":"hmm"}', 'p1');
    expect(noOps.ok ? undefined : noOps.malformed.reason).toBe('no-ops');
    expect(noOps.ok ? undefined : noOps.malformed.text).toBe('{"message":"hmm"}');

    const badOp = readProposal('{"message":"m","ops":[{"op":"move","path":"/premise"}]}', 'p1');
    expect(badOp.ok ? undefined : badOp.malformed.reason).toBe('not-an-operation');
  });

  it('refuses a patch over the operation bound', () => {
    const many = Array.from({ length: 40 }, () => ({
      op: 'replace',
      path: '/premise',
      value: 'x',
    }));
    const read = readProposal(JSON.stringify({ message: 'm', ops: many }), 'p1');
    expect(read.ok ? undefined : read.malformed.reason).toBe('too-many-ops');
  });
});

describe('previewWorldProposal — one function for the preview and the apply', () => {
  it('answers the proposed payload, and says which operation it could not apply', () => {
    const preview = previewWorldProposal(world(), {
      ops: [{ op: 'replace', path: '/premise', value: '新的一句' }],
    });
    expect(preview.ok && preview.data.premise).toBe('新的一句');

    const refused = previewWorldProposal(world(), {
      ops: [{ op: 'replace', path: '/nope', value: 'x' }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? undefined : refused.refusal).toEqual({
      kind: 'ops',
      issues: [{ index: 0, op: 'replace', path: '/nope', kind: 'path-missing' }],
    });
  });

  it('reports a legal patch whose result the schema refuses, with the schema’s path', () => {
    const refused = previewWorldProposal(world(), {
      ops: [{ op: 'replace', path: '/name', value: '' }],
    });
    expect(refused.ok ? undefined : refused.refusal).toEqual({ kind: 'schema', path: 'name' });
  });

  it('never touches the payload it previews, and compares documents as JSON', () => {
    const data = world();
    const before = JSON.stringify(data);
    previewWorldProposal(data, { ops: [{ op: 'replace', path: '/premise', value: 'x' }] });
    expect(JSON.stringify(data)).toBe(before);
    expect(sameWorldData(data, { ...data })).toBe(true);
    expect(sameWorldData(data, { ...data, premise: 'x' })).toBe(false);
  });

  it('prints a dotted path for an operation the form has no label for', () => {
    const op = { op: 'add' as const, path: '/customFields/Weather', value: '暴雪' };
    expect(opTargetLabel(op)).toBeUndefined();
    expect(opPathText(op)).toBe('customFields.Weather');
  });
});
