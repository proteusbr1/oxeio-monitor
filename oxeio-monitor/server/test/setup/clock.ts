/**
 * The test clock.
 *
 * Careful: date-dependent tests broke three times in this repo, in three
 * different files: the dedupe test (after local midnight), `adjustments.e2e`
 * (pace, a number that grows daily, the owner inbox filling up) and
 * `agent-recovery.e2e` (outside office hours, CI ran at 23:19). Each time the
 * code already had a way to inject the time (`runOnce(now)`, `todayWindow()`);
 * the test just used the real clock instead. Three times is a pattern, not an
 * accident.
 *
 * This file lives outside `harness.ts` on purpose: the harness boots the whole
 * Nest app and a Postgres connection, so pure-function specs (`summary.math`,
 * `admin-enrollment-code`) cannot import it. Keeping the helpers separate lets
 * both kinds of spec share the same clock and the same rule.
 */
import { instantOfWorkWall, workDateOf } from '../../src/agent/util/work-time';

/**
 * A safe moment for fixtures: 12:00 noon of today's work day.
 *
 * Why noon, and why this is the heart of the rule:
 *
 * The server uses the live `new Date()`, so fixtures must be on today's date;
 * a fixed past date would make the fixture's "today" differ from the server's.
 * But with the real clock the moment can land on either side of midnight, and
 * that is where the bomb goes off.
 *
 * Noon is 12 hours from both boundaries: same calendar day, and no
 * `workDateOf()`, `todayWindow()` or office-hours condition moves below it.
 *
 * What this does not cover: if the suite runs at exactly 23:59 and the day
 * rolls over midway, a narrow gap remains. The window used to be six hours a
 * day (UTC-based fixtures broke between local 00:00 and 06:00 in a UTC+6
 * zone); now it is under a minute. Not zero, but no longer "CI is red every night".
 *
 * @param dayOffset how many days from today (negative = past)
 */
export function workNoon(dayOffset = 0): Date {
  // the work day's label (UTC midnight) + 12 h is "12:00" on the wall clock;
  // the zone turns that into the instant, daylight saving included
  const day = workDateOf(new Date());
  return instantOfWorkWall(
    new Date(day.getTime() + dayOffset * 86_400_000 + 12 * 3_600_000),
  );
}

/**
 * Today's date in the work zone, as `'YYYY-MM-DD'`.
 *
 * This formula used to be written by hand in four specs
 * (`new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10)`), and
 * four copies means one gets changed and the rest do not. In the dedupe test
 * this exact formula was written assuming UTC and broke.
 *
 * The name deliberately differs from `workToday(now)` in
 * `prisma/holidays.data.ts`: that one is a production function and takes an
 * argument, and with the same name the import would not show which is which.
 */
export function workTodayIso(): string {
  return workDateOf(new Date()).toISOString().slice(0, 10);
}

/**
 * The real clock, as a last resort. Use it only when the assertion is compared
 * with the server's own live clock, so a pinned moment would make the test lie:
 *
 * - `X-Client-Time` and an event's `occurredAt`: the server compares these with
 *   its own clock to correct clock drift (02-Workflow section 2). Noon would
 *   show a 9-hour drift in a test run in the morning, the timestamp would be
 *   corrected, and an alert would be raised.
 * - The JWT `iat`: the server measures token age on the live clock.
 * - Tolerant "was the row just written" comparisons (60-second allowance).
 *
 * The name exists so uses can be counted and searched. At the time of writing
 * it is used in three files (`agent.e2e`, `session-freshness.e2e`,
 * `adjustments.e2e`). If that number keeps growing, it is a signal that
 * someone is not following the rule.
 *
 * Never use it to build fixture dates; use `workNoon()` for that.
 */
export function realNow(): Date {
  return new Date();
}
