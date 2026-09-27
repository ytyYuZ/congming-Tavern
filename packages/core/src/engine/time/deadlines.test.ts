/**
 * Deadlines: the `active -> expired` transition (M1-T1, docs/02 §5.7 副作用链
 * step 3, `entities/session.ts` `Deadline`).
 *
 * The boundary table is the whole point: `dueMinute <= now` expires at exactly
 * `dueMinute` and never one minute earlier. The other rows pin the two terminal
 * states — `expired` and `cleared` — because resurrecting a cleared countdown is
 * the failure mode a second sweep would produce.
 *
 * `kind` is deliberately varied across rows: a duration and a countdown with the
 * same `dueMinute` must behave identically, since both are just an instant.
 */
import { describe, expect, it } from 'vitest';
import { expireDeadlines, expireDue, isDueAt } from './deadlines';
import { deadline, deepFreeze } from './test-kit';

describe('isDueAt — the boundary', () => {
  const active = deadline({ id: 'ritual', dueMinute: 100, kind: 'duration' });

  const table: readonly [now: number, expected: boolean][] = [
    [0, false],
    [99, false],
    [100, true],
    [101, true],
    [1000, true],
  ];

  it.each(table)('a deadline due at 100 is due at now=%i: %s', (now, expected) => {
    expect(isDueAt(active, now)).toBe(expected);
  });

  it('does not re-expire a deadline that already expired', () => {
    expect(isDueAt({ ...active, status: 'expired' }, 1000)).toBe(false);
  });

  it('does not resurrect a cleared deadline', () => {
    expect(isDueAt({ ...active, status: 'cleared' }, 1000)).toBe(false);
  });
});

describe('expireDue — active entries expire, the rest are untouched', () => {
  const deadlines = deepFreeze([
    deadline({ id: 'past', dueMinute: 50 }),
    deadline({ id: 'boundary', dueMinute: 100 }),
    deadline({ id: 'future', dueMinute: 150 }),
    deadline({ id: 'already-expired', dueMinute: 10, status: 'expired' }),
    deadline({ id: 'cleared', dueMinute: 10, status: 'cleared' }),
    deadline({ id: 'duration', dueMinute: 90, kind: 'duration' }),
  ]);

  const sweep = expireDue(deadlines, 100);

  it('expires everything active with dueMinute <= now, in input order', () => {
    expect(sweep.expired.map((entry) => entry.id)).toEqual(['past', 'boundary', 'duration']);
  });

  it('marks the expired ones and nothing else', () => {
    expect(sweep.deadlines.map((entry) => `${entry.id}:${entry.status}`)).toEqual([
      'past:expired',
      'boundary:expired',
      'future:active',
      'already-expired:expired',
      'cleared:cleared',
      'duration:expired',
    ]);
  });

  it('keeps the identity of every deadline it did not touch', () => {
    expect(sweep.deadlines[2]).toBe(deadlines[2]);
    expect(sweep.deadlines[3]).toBe(deadlines[3]);
    expect(sweep.deadlines[4]).toBe(deadlines[4]);
  });

  it('returns a new object for each deadline it did change', () => {
    expect(sweep.deadlines[0]).not.toBe(deadlines[0]);
    expect(sweep.deadlines[0]).toEqual({ ...deadlines[0], status: 'expired' });
  });

  it('does not mutate its input', () => {
    expect(deadlines[0]?.status).toBe('active');
    expect(deadlines[1]?.status).toBe('active');
  });

  it('expires nothing when the clock has not reached any due minute', () => {
    const none = expireDue(deadlines, 49);
    expect(none.expired).toEqual([]);
    expect(none.deadlines).toEqual(deadlines);
  });

  it('expires an empty list without complaint', () => {
    expect(expireDue([], 100)).toEqual({ now: 100, expired: [], deadlines: [] });
  });

  it('rejects a non-finite now', () => {
    expect(() => expireDue(deadlines, Number.NaN)).toThrow(/finite/);
  });
});

describe('expireDeadlines — the array-only form agrees with expireDue', () => {
  it('produces the same array', () => {
    const deadlines = [
      deadline({ id: 'a', dueMinute: 10 }),
      deadline({ id: 'b', dueMinute: 10, status: 'cleared' }),
      deadline({ id: 'c', dueMinute: 30 }),
    ];
    expect(expireDeadlines(deadlines, 20)).toEqual(expireDue(deadlines, 20).deadlines);
  });

  it('is idempotent across two sweeps', () => {
    const once = expireDeadlines([deadline({ id: 'a', dueMinute: 10 })], 20);
    const twice = expireDeadlines(once, 30);
    expect(twice.map((entry) => entry.status)).toEqual(['expired']);
    expect(expireDeadlines(once, 30)[0]).toBe(once[0]);
  });
});
