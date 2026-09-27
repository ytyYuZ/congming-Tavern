/**
 * Agenda firing and repeat rollover (M1-T1, docs/02 §5.7 `fireDue`,
 * `entities/agenda.ts`).
 *
 * THE EXPECTATION THAT DECIDES THE DESIGN is the "lands exactly on now" row: an
 * entry with `atMinute` 100 repeating every 100 minutes, swept at `now` 200, must
 * NOT be re-fired at 200 — the next occurrence is 300. Anchoring the rollover on
 * `now` instead of `atMinute` is the mistake this table exists to catch, because
 * it also drifts the entry's phase by however late the sweep ran.
 *
 * Every number below is hand arithmetic: `next = atMinute + k * period` for the
 * smallest whole `k` with `next > now`, and `k >= 1` so a fired entry can never
 * be scheduled into its own minute.
 */
import { describe, expect, it } from 'vitest';
import { fireDue, nextRepeat, rollOverRepeat } from './scheduler';
import { agendaEntry, deepFreeze } from './test-kit';

describe('nextRepeat — strictly after now, anchored on atMinute', () => {
  const base = agendaEntry({ id: 'market', atMinute: 100, repeatEveryMinutes: 100 });

  const table: readonly [now: number, repeats: boolean, nextMinute: number | undefined][] = [
    // not yet due at all: the next occurrence after now is the FIRST one.
    [0, true, 100],
    [99, true, 100],
    // due exactly now: this occurrence is the one firing, so the next is one period on.
    [100, true, 200],
    // just after: the next occurrence after now is the second one.
    [101, true, 200],
    [199, true, 200],
    // WOULD LAND EXACTLY ON NOW: 200 must not be handed back, or the entry fires twice.
    [200, true, 300],
    [299, true, 300],
    // several periods late: the rollover catches up in one jump, no loop needed.
    [1000, true, 1100],
    [1001, true, 1100],
    [1100, true, 1200],
  ];

  it.each(table)('now %i -> repeats %s at %s', (now, repeats, nextMinute) => {
    expect(nextRepeat(base, now)).toEqual({ repeats, nextMinute });
  });

  it('reports no repeat for a one-shot entry', () => {
    expect(nextRepeat(agendaEntry({ id: 'once', atMinute: 100 }), 100)).toEqual({ repeats: false });
  });

  it('reports no repeat for a period that cannot move the entry forward', () => {
    const broken = { ...base, repeatEveryMinutes: 0 };
    expect(nextRepeat(broken, 100)).toEqual({ repeats: false });
    expect(nextRepeat({ ...base, repeatEveryMinutes: -100 }, 100)).toEqual({ repeats: false });
  });
});

describe('rollOverRepeat — re-arms an entry at its next occurrence', () => {
  it('returns a new pending entry at the next minute', () => {
    const entry = agendaEntry({ id: 'market', atMinute: 100, repeatEveryMinutes: 100 });
    expect(rollOverRepeat(entry, 200)).toEqual({
      ...entry,
      atMinute: 300,
      status: 'pending',
    });
  });

  it('returns a one-shot entry unchanged, by identity', () => {
    const entry = agendaEntry({ id: 'once', atMinute: 100 });
    expect(rollOverRepeat(entry, 100)).toBe(entry);
  });

  it('does not mutate the entry it is given', () => {
    const entry = deepFreeze(agendaEntry({ id: 'market', atMinute: 100, repeatEveryMinutes: 100 }));
    expect(() => rollOverRepeat(entry, 200)).not.toThrow();
    expect(entry.atMinute).toBe(100);
  });
});

describe('fireDue — selection at the boundary', () => {
  const pending = (id: string, atMinute: number) => agendaEntry({ id, atMinute });

  const table: readonly [now: number, dueIds: string][] = [
    [100, 'at-now'],
    [150, 'at-now,in-the-past'],
    [99, ''],
    [0, ''],
  ];

  const agenda = deepFreeze([
    pending('at-now', 100),
    pending('in-the-past', 120),
    pending('not-yet', 200),
  ]);

  it.each(table)('at now %i the entries that come due are: %s', (now, dueIds) => {
    const sweep = fireDue(agenda, now);
    expect(sweep.fired.map((fired) => fired.entry.id).join(',')).toBe(dueIds);
  });

  it('marks each fired entry fired and leaves the rest untouched', () => {
    const sweep = fireDue(agenda, 100);
    expect(sweep.fired).toHaveLength(1);
    expect(sweep.fired[0]?.entry).toEqual({ ...agenda[0], status: 'fired' });
    // the two entries that are not due yet keep their identity and their order.
    expect(sweep.remaining[0]).toBe(agenda[1]);
    expect(sweep.remaining[1]).toBe(agenda[2]);
    expect(sweep.now).toBe(100);
  });

  it('does not mutate the input array or its entries', () => {
    const input = deepFreeze([pending('a', 10), pending('b', 20)]);
    const sweep = fireDue(input, 15);
    expect(input[0]?.status).toBe('pending');
    expect(input[0]?.atMinute).toBe(10);
    // entries are new objects for the fired ones and the SAME objects for the rest.
    expect(sweep.fired[0]?.entry).not.toBe(input[0]);
    expect(sweep.remaining[0]).toBe(input[1]);
  });

  it('ignores entries that are no longer pending, whatever their minute', () => {
    const mixed = [
      agendaEntry({ id: 'fired', atMinute: 1, status: 'fired' }),
      agendaEntry({ id: 'skipped', atMinute: 1, status: 'skipped' }),
      agendaEntry({ id: 'rescheduled', atMinute: 1, status: 'rescheduled' }),
      agendaEntry({ id: 'pending', atMinute: 1 }),
    ];
    const sweep = fireDue(mixed, 100);
    expect(sweep.fired.map((fired) => fired.entry.id)).toEqual(['pending']);
    expect(sweep.remaining.map((entry) => entry.id)).toEqual(['fired', 'skipped', 'rescheduled']);
  });

  it('is idempotent: sweeping the result again fires nothing', () => {
    const once = fireDue([pending('a', 10), pending('b', 20)], 20);
    const twice = fireDue(
      once.fired.map((fired) => fired.entry),
      20,
    );
    expect(twice.fired).toEqual([]);
  });
});

describe('fireDue — repeat rollover', () => {
  it('reports the next occurrence strictly after now, not at now', () => {
    const entry = agendaEntry({ id: 'bell', atMinute: 100, repeatEveryMinutes: 100 });
    const sweep = fireDue([entry], 200);
    expect(sweep.fired[0]?.repeat).toEqual({ repeats: true, nextMinute: 300 });
    expect(sweep.fired[0]?.rolledOver).toBe(true);
    // the fired entry itself stays at the minute it fired at.
    expect(sweep.fired[0]?.entry.atMinute).toBe(200 - 100);
  });

  it('reports no rollover for a one-shot entry', () => {
    const sweep = fireDue([agendaEntry({ id: 'once', atMinute: 100 })], 100);
    expect(sweep.fired[0]?.repeat).toEqual({ repeats: false });
    expect(sweep.fired[0]?.rolledOver).toBe(false);
  });

  it('keeps the phase of an entry that was swept late', () => {
    // A daily bell at minute 100 swept at 250 still rings next at 300, not at 350.
    const sweep = fireDue(
      [agendaEntry({ id: 'bell', atMinute: 100, repeatEveryMinutes: 100 })],
      250,
    );
    expect(sweep.fired[0]?.repeat.nextMinute).toBe(300);
  });

  it('rolls over several periods in one sweep when the clock jumped', () => {
    const sweep = fireDue(
      [agendaEntry({ id: 'bell', atMinute: 100, repeatEveryMinutes: 100 })],
      1000,
    );
    expect(sweep.fired).toHaveLength(1);
    expect(sweep.fired[0]?.repeat.nextMinute).toBe(1100);
  });

  it('handles a repeat period that does not divide the difference', () => {
    const sweep = fireDue([agendaEntry({ id: 'odd', atMinute: 10, repeatEveryMinutes: 7 })], 20);
    // 10 + 2 * 7 = 24 > 20, while 10 + 1 * 7 = 17 is still in the past.
    expect(sweep.fired[0]?.repeat.nextMinute).toBe(24);
  });

  it('rejects a non-finite now instead of sweeping everything', () => {
    expect(() => fireDue([agendaEntry({ id: 'a', atMinute: 0 })], Number.NaN)).toThrow(/finite/);
  });
});
