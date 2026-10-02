/**
 * The session a TEST needs when it is not testing session creation (M1-S1).
 *
 * WHY THIS EXISTS AT ALL
 * `db/repository.ts`'s `createSession` requires the versioned pins the create flow chose,
 * because that choice IS the session (ADR-010): a default would be a row pinning a world no
 * `worlds` row backs — the placeholder M1-S1 deleted. But most tests in this workspace — the
 * message tree, the checkpoints, the turn lifecycle, the route smoke tests — need a SESSION as a
 * container, not content, and their subject has nothing to do with which world it pins. So the
 * pins those tests would otherwise invent live HERE, in a `*.test-helpers.ts` module they all
 * import, and the production API stays honest.
 *
 * WHY THE IDS RESOLVE TO NOTHING, ON PURPOSE
 * `test-world` / `test-player` are ids no row carries. Nothing on the paths these tests exercise
 * resolves a `Session.refs` pin (the prompt's `{worldId}`/`{userId}` slots copy the id verbatim,
 * which is what `chat/clock.ts` means by "the pin ids stand in for names"), so a helper that
 * created rows would enlarge every test's database to assert nothing. The two tests that DO read
 * a pin out of the composed prompt assert these ids (`state/opening.test.ts`,
 * `chat/send-turn.test.ts`), which is why they are spelled here rather than in each test.
 *
 * `TEST_INITIAL_CLOCK` is 0 — the calendar epoch, the one minute that needs no world.
 */
import type { Session } from '@smarttavern/schema';
import { createSession as createSessionRow, type NewSessionRefs } from './repository';

/** The world/player/preset pins a test session carries. See the header for why they resolve to nothing. */
export const TEST_SESSION_PINS: NewSessionRefs = {
  world: { id: 'test-world', version: 1 },
  playerCharacter: { id: 'test-player', version: 1 },
  cast: [],
  promptPreset: { id: 'builtin-default', version: 1 },
};

/** Where a test session's clock starts: the calendar epoch. */
export const TEST_INITIAL_CLOCK = 0;

/**
 * `createSession` with the fixture pins — the shape a test that does not care about content wants.
 *
 * The parameter list is deliberately the OLD one (`{title}`): making the pins arguments was the
 * point of M1-S1, and a test whose subject is the transcript should not have to restate that to
 * get a row.
 */
export function createTestSession(options: { title: string }): Promise<Session> {
  return createSessionRow({
    ...options,
    refs: TEST_SESSION_PINS,
    initialClock: TEST_INITIAL_CLOCK,
  });
}
