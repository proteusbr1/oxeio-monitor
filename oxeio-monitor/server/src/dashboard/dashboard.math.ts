/**
 * Pure calculations for the live board and the timeline — no I/O.
 *
 * Kept in its own file for the same reason as payroll.math: these three rules
 * (status decision, splitting into hour buckets, date parsing) fail
 * **silently** — the dashboard shows no error, just a wrong number. Being
 * testable without a database is how such mistakes get caught here.
 */
import type { SegmentState } from '@prisma/client';

import { startOfWorkDate, workHourOf } from '../agent/util/work-time';

const MS = 1000;
const HOUR_MS = 3600 * MS;

export const HOURS_PER_DAY = 24;

/**
 * Careful: "agent switched off" (red) and "employee has left" (grey) are two
 * completely different events. The first is an IT problem, the second is
 * normal. Showing one in the other's colour either makes a false accusation or
 * hides a real problem.
 */
/**
 * Careful: **`AGENT_DOWN_AFTER_SEC` was removed** (it was 600 s).
 *
 * It decided whether an agent was "dead" purely from how long it had been
 * silent. But the **length** of the silence can never tell what happened: at
 * 9 pm everyone is silent for ten hours and their PCs are simply switched
 * off. The whole team turned red every evening (seen in the field), and red
 * lost its meaning.
 *
 * Now the question is about the **last thing the agent said** — see
 * `decideLiveStatus()`. Keeping the constant would make the next reader assume
 * the rule is still time-based, so deleting it is the honest option.
 */
export const OFFLINE_AFTER_SEC = 90;

/** The card's colours. SegmentState's `locked` is merged into `idle` here. */
/**
 * The card has **three** colours. `SegmentState`'s `locked` is merged into
 * `idle` here.
 *
 * Careful: **`agent_down` was removed** — details in <c>decideLiveStatus</c>.
 * In short: the board could never tell whether an agent was "dead" or the PC
 * was "switched off", yet the red colour pretended to be certain. The real
 * answer to that question comes from `AgentDownCheck`, which raises an
 * **alert** — where a mistake can also be corrected.
 */
export type LiveStatus = 'active' | 'idle' | 'offline';

/**
 * Everything the board knows about one device (three columns of the `devices`
 * row).
 *
 * Careful: they answer three **different** questions, and mixing them up
 * shows the wrong colour with no error:
 *    · `lastSeenAt`  — whether the agent is alive (set on *any* agent request)
 *    · `lastState`   — what it said last time (set on heartbeat only)
 *    · `lastStateAt` — **when** it said it, i.e. whether it is still credible
 */
export interface DeviceReport {
  /**
   * Careful: revoked devices now **do** appear in the list — the query used
   * to filter them out. Filtering made it impossible to tell "never installed"
   * from "switched off".
   */
  status: 'active' | 'revoked';
  lastSeenAt: Date | null;
  lastState: SegmentState | null;
  lastStateAt: Date | null;
}

/**
 * The agent's **presence** — an explanation, not a colour.
 *
 * Careful: all three show a grey "Offline" on the board, but the owner has to
 * do something different in each case. The difference used to be missing,
 * which produced a **self-contradicting card**: a 16:50 screenshot on top and
 * *"Never checked in"* below.
 */
export type AgentPresence =
  /** No agent was ever installed — a new employee whose PC has not been issued yet */
  | 'never_installed'
  /**
   * Devices exist, but all of them have been revoked.
   *
   * Careful: this also happens when the employee is **deactivated** —
   * `deactivate()` revokes all their devices, and `reactivate()` deliberately
   * does not restore them.
   */
  | 'switched_off'
  /** At least one active device exists */
  | 'installed';

export interface LiveStatusInput {
  /**
   * All of the employee's **active (non-revoked) devices**.
   * Careful: judging per device would show an employee working on the laptop
   * as offline whenever the desktop is off (§ 2.1c — one person, many devices).
   */
  devices: readonly DeviceReport[];
  /**
   * State of the last `activity_segments` row — **a fallback only**.
   *
   * Careful: it cannot be the first choice. The agent sends segments in
   * **batches**, so the row can be minutes old — the card would stay green
   * three minutes after the employee left. It cannot be dropped either: the
   * `last_state` column is new, so after the migration (or for an agent that
   * has not sent a heartbeat yet) it is null, and this guess is the only
   * information left.
   */
  fallbackState: SegmentState | null;
  now: Date;
}

/**
 * The one place that decides the card's colour.
 *
 * Three answers, all about the employee: **working · paused · not there**.
 * Whether the machine is healthy is not the board's question.
 */
/**
 * Careful: this one line also decides what the card **says**, not just what is counted.
 */
export function agentPresence(devices: readonly DeviceReport[]): AgentPresence {
  if (devices.length === 0) return 'never_installed';
  if (devices.some((d) => d.status === 'active')) return 'installed';

  return 'switched_off';
}

export function decideLiveStatus(input: LiveStatusInput): LiveStatus {
  const { fallbackState, now } = input;

  /**
   * Careful: revoked devices are **not counted** here. The query used to drop
   * them; now the exclusion is explicit and in this function. Without it, the
   * old `lastSeenAt` of a machine revoked months ago would show the employee
   * as "green".
   */
  const devices = input.devices.filter((d) => d.status === 'active');

  // Careful: no active device does not mean the agent has "fallen over" — it is
  // either a new employee (PC not issued yet) or a revoked device. Neither is
  // as urgent as a red alarm, and a false red would make red meaningless.
  // `agentPresence` text explains the difference.
  if (devices.length === 0) return 'offline';

  const lastSeenAt = latestHeartbeat(devices);

  /**
   * A device exists but has never responded — installed but never started.
   *
   * Careful: this is a real problem, but **not the board's job** — the card's
   * `agentPresence` text ("Never checked in") already says it, and the alert
   * system sends a separate notification.
   */
  if (lastSeenAt === null) return 'offline';

  const ageSec = secondsSince(lastSeenAt, now);

  /**
   * **A silent agent: dead, or gone home?** The board **no longer tries** to
   * answer this.
   *
   * Careful: the clock alone used to decide — `> 600 s` meant `agent_down`,
   * otherwise `offline`. So `offline` was only possible in the narrow window
   * between 90 s and 10 minutes, and after that everyone stayed red forever.
   *
   * Careful: the consequence was daily and seen in the field: **every evening,
   * ten minutes after everyone went home, the whole team turned red.** One
   * evening the board showed `Agent down 12`, `Offline 0` — yet nothing was
   * broken, the office had just closed. That is how **red loses its meaning**,
   * which is exactly what all the other rules in this file exist to prevent.
   *
   * The next attempt used the **last thing said**: going silent right after
   * `active` meant red, after `idle`/`locked` meant grey. The reasoning was
   * that someone switching the PC off is idle for at least a minute first.
   *
   * Careful: **that assumption broke too.** If someone presses Shut down
   * while working, the whole shutdown finishes in under a minute — the next
   * heartbeat never goes out, so the server's last word stays `active`. Result:
   * an employee who had gone home showed **red**, though nothing was broken.
   * The owner took it for a broken new agent, and a whole release was halted.
   *
   * **So the question itself was removed.** The data the board has can never
   * establish "dead or switched off" — the parting event (shutdown/logoff) is
   * written to **disk** by the agent and sent on the next start. Answering an
   * unanswerable question with a guess in **red** is the worst option, since a
   * false red destroys the meaning of red.
   *
   * The real answer comes from `AgentDownCheck`: it looks at those parting
   * events, filters them with `isExpectedSilence()`, and then raises an
   * **alert**. The board now speaks only about the employee, not the machine.
   */
  if (ageSec > OFFLINE_AFTER_SEC) return 'offline';

  // The agent's own report is the first truth; a guess from segments is used
  // only when the agent said nothing or its report has gone stale.
  const state = freshReportedState(devices, now) ?? fallbackState;

  // Careful: the agent is alive but nobody has said anything (old agent, and
  // the batch has not arrived yet). "Don't know" must not be shown as active —
  // unknown time is never claimed as work time.
  if (state === null) return 'idle';

  // `locked` gets no colour of its own — the board has only three colours, and
  // from the employee's side a locked PC and sitting idle are the same: neither
  // is work time.
  return state === 'active' ? 'active' : 'idle';
}

/*
 * Careful: `partingState()` used to be here — "what was the last thing said
 * before going silent". Its only job was to separate red from grey, and that
 * split has been removed (see `decideLiveStatus` above). Keeping the function
 * would make the next reader think the rule still exists.
 *
 * The `devices.last_state` column stays, though — `AgentDownCheck` uses it,
 * and that is the right home for the question.
 */

/**
 * The most recent `lastSeenAt` across all of the employee's devices.
 *
 * The card's `lastHeartbeatAt` is this too — kept in one place so that the
 * "responded N ago" text and the colour never come from two calculations.
 */
export function latestHeartbeat(devices: readonly DeviceReport[]): Date | null {
  let latest: Date | null = null;
  for (const d of devices) {
    // Careful: a revoked device's old heartbeat is not counted — otherwise the
    // response of a machine switched off seven days ago would show "Seen 7
    // days ago", though it will never respond again.
    if (d.status !== 'active') continue;
    if (d.lastSeenAt === null) continue;
    if (latest === null || d.lastSeenAt.getTime() > latest.getTime()) {
      latest = d.lastSeenAt;
    }
  }
  return latest;
}

/**
 * The state reported in the heartbeat, **if it is still fresh** — otherwise null.
 *
 * Careful: a stale report cannot be trusted. At the moment an agent dies it
 * may have said `active`; that value stays in the column forever. Without an
 * expiry, the card of a switched-off PC would **stay green** — worse than
 * showing offline, since non-work time would be claimed as work.
 *
 * Careful: the expiry is deliberately `OFFLINE_AFTER_SEC` itself, not a
 * separate constant: a report older than that means the agent was silent that
 * long, and silence has exactly one meaning in this file. With two knobs, one
 * day one would change and the other would not.
 *
 * Careful: with several devices the employee is active if **any** active
 * report says `active` — not "take the most recent". If someone locks the
 * desktop and works on the laptop, both devices send a heartbeat every 30
 * seconds, so "most recent" is effectively random — the card colour would
 * flip green-grey on every refresh while the employee works continuously.
 */
export function freshReportedState(
  devices: readonly DeviceReport[],
  now: Date,
): SegmentState | null {
  let bestState: SegmentState | null = null;
  let bestAtMs = -Infinity;

  for (const { lastState, lastStateAt } of devices) {
    if (lastState === null || lastStateAt === null) continue;
    if (secondsSince(lastStateAt, now) > OFFLINE_AFTER_SEC) continue;

    if (lastState === 'active') return 'active';
    if (lastStateAt.getTime() > bestAtMs) {
      bestAtMs = lastStateAt.getTime();
      bestState = lastState;
    }
  }
  return bestState;
}

/**
 * Careful: it can be negative, and that is intended — if a device clock runs
 * slightly ahead (drift), a "future" heartbeat arrives, and `Math.abs` would
 * make it look old and show a healthy agent as offline.
 */
function secondsSince(then: Date, now: Date): number {
  return (now.getTime() - then.getTime()) / MS;
}

interface HourSlot {
  start: number;
  end: number;
  /** the local hour (0-23) the slot is shown under */
  hour: number;
}

/**
 * The real hours of one work day, each with the local hour it belongs to.
 *
 * Careful: a day is not always 24 hours. With daylight saving one day has 23
 * (an hour is skipped — that bucket stays empty) and one has 25 (an hour comes
 * twice — both land in the same bucket). Stepping 24 × 1 h from midnight would
 * put the evening into the wrong buckets on those two days.
 */
function hourSlotsOf(workDate: Date): HourSlot[] {
  const dayStart = startOfWorkDate(workDate).getTime();
  const dayEnd = startOfWorkDate(new Date(workDate.getTime() + 24 * HOUR_MS)).getTime();
  const slots: HourSlot[] = [];
  for (let t = dayStart; t < dayEnd; t += HOUR_MS) {
    slots.push({ start: t, end: Math.min(t + HOUR_MS, dayEnd), hour: workHourOf(new Date(t)) });
  }
  return slots;
}

export interface HourSpreadInput {
  startedAt: Date;
  endedAt: Date;
  /** Actual duration from the monotonic clock (§ 3.2) */
  durationSec: number;
}

/**
 * Spreads one segment **proportionally** across the 24 hour buckets.
 *
 * Careful: dropping the whole segment into its starting hour is the easiest
 * mistake. 90 minutes of work from 10:45 to 12:15 would show as "90 minutes at
 * 10 o'clock" — an hour bucket holding an hour and a half, and nothing in the
 * 11:00 slot. The chart would look fine but tell a completely wrong story.
 *
 * It is `durationSec` that gets divided, not the wall-clock span — but the
 * **proportions** come from the wall clock. The two numbers differ:
 * durationSec is from the monotonic clock (unaffected if the PC clock is
 * changed), while hour boundaries are wall-clock. This keeps the chart's
 * total always equal to the timeline's total — if two screens showed two
 * numbers, there would be no way to prove which is right.
 */
export function spreadIntoHourBuckets(
  segments: readonly HourSpreadInput[],
  workDate: Date,
): number[] {
  const buckets = new Array<number>(HOURS_PER_DAY).fill(0);
  const slots = hourSlotsOf(workDate);
  const dayStart = slots[0].start;
  const dayEnd = slots[slots.length - 1].end;

  for (const seg of segments) {
    if (seg.durationSec <= 0) continue;

    // By § 2.1a a segment should not cross midnight, but it is clamped anyway —
    // data from an old agent may have arrived before the server splits it.
    const start = Math.max(seg.startedAt.getTime(), dayStart);
    const end = Math.min(seg.endedAt.getTime(), dayEnd);
    const span = end - start;

    if (span <= 0) {
      // The wall-clock span is zero or negative (clock went back) — no
      // proportion can be computed, so the whole duration goes to the starting
      // hour. Better in one bucket than lost, since the day's total stays right.
      const hour = hourIndexOf(seg.startedAt.getTime(), slots);
      if (hour !== null) buckets[hour] += seg.durationSec;
      continue;
    }

    // Careful: calling Math.round separately for each hour would accumulate 24
    // roundings, and the bucket sum would be a few seconds off durationSec.
    // So the calculation is **cumulative**: each time work out "how much should
    // be assigned in total so far" and add only what is still missing.
    // In the last hour covered === span, so the sum is exactly durationSec.
    let coveredMs = 0;
    let assignedSec = 0;

    for (const slot of slots) {
      const overlap = Math.min(end, slot.end) - Math.max(start, slot.start);
      if (overlap > 0) coveredMs += overlap;
      if (coveredMs === 0) continue;

      const targetSec = Math.round((seg.durationSec * coveredMs) / span);
      buckets[slot.hour] += targetSec - assignedSec;
      assignedSec = targetSec;

      if (coveredMs >= span) break;
    }
  }

  return buckets;
}

/** The whole team's picture for one hour */
export interface TeamHour {
  /** Local hour in the work zone, 0-23 */
  hour: number;
  /** The team's total counted seconds in that hour */
  activeSec: number;
  /**
   * **How many people** did some work in that hour.
   *
   * The two numbers must be kept apart, because `activeSec` alone answers only
   * half the question: does 4 hours mean four people for one hour, or one
   * person for four hours? On the cockpit the difference matters — the first
   * is a normal morning, the second a night with one person working alone.
   */
  people: number;
}

interface TeamHourInput extends HourSpreadInput {
  employeeId: number;
}

/**
 * The whole team's rhythm for the day, in 24 buckets.
 *
 * Careful: **each employee is spread separately, not all together** — the
 * only subtle decision here. Feeding every segment into
 * `spreadIntoHourBuckets` in one pile would still give the right total
 * seconds, but **how many people** could no longer be worked out — once
 * segments are in a bucket, it is unknown whose they were.
 *
 * The spreading rule comes from the very same function
 * (`spreadIntoHourBuckets`), so one person's `/hourly` chart and the team's
 * rhythm never tell different stories. Copying the rule would let one change
 * and not the other someday.
 *
 * Careful: `people` is counted with `> 0`, with no threshold. If even one
 * second falls in that hour, the person "was there" — a threshold would be a
 * silent opinion, and nobody would know why someone at 6 am vanished.
 */
export function spreadTeamIntoHourBuckets(
  segments: readonly TeamHourInput[],
  workDate: Date,
): TeamHour[] {
  const byEmployee = new Map<number, TeamHourInput[]>();
  for (const seg of segments) {
    const list = byEmployee.get(seg.employeeId);
    if (list) list.push(seg);
    else byEmployee.set(seg.employeeId, [seg]);
  }

  const activeSec = new Array<number>(HOURS_PER_DAY).fill(0);
  const people = new Array<number>(HOURS_PER_DAY).fill(0);

  for (const own of byEmployee.values()) {
    const buckets = spreadIntoHourBuckets(own, workDate);
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      activeSec[h] += buckets[h];
      if (buckets[h] > 0) people[h] += 1;
    }
  }

  return activeSec.map((sec, hour) => ({
    hour,
    activeSec: sec,
    people: people[hour],
  }));
}

function hourIndexOf(instantMs: number, slots: readonly HourSlot[]): number | null {
  const slot = slots.find((s) => instantMs >= s.start && instantMs < s.end);
  return slot ? slot.hour : null;
}

/**
 * `?date=YYYY-MM-DD` → that work day, as a UTC-midnight Date
 * (this is exactly what Prisma's `@db.Date` wants, and what workDateOf returns).
 *
 * Careful: writing `new Date('2026-02-31')` directly makes JS silently produce
 * 3 March. The user would ask for 31 February, see 3 March's data and never
 * notice — so the returned values are checked against the input again.
 */
export function parseWorkDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;

  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Work day → `YYYY-MM-DD`.
 *
 * Careful: sending `@db.Date` straight into JSON would give
 * `2026-08-10T00:00:00.000Z`. In Asia/Dhaka that instant is 6 am on the 10th — a
 * browser converting it to local time showed the previous day for some
 * people. So dates always travel as strings, never as Date.
 */
export function formatWorkDate(workDate: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    workDate.getUTCFullYear(),
    pad(workDate.getUTCMonth() + 1),
    pad(workDate.getUTCDate()),
  ].join('-');
}

/** The 1st of the month containing that work-zone date — start of the monthly ring. */
export function monthStartOf(workDate: Date): Date {
  return new Date(
    Date.UTC(workDate.getUTCFullYear(), workDate.getUTCMonth(), 1),
  );
}

/** The previous work day — to catch segments around midnight on the live board. */
export function previousWorkDate(workDate: Date): Date {
  return new Date(workDate.getTime() - HOURS_PER_DAY * HOUR_MS);
}

/** One employee's seven-day total — the raw material for `rankLaggards` */
export interface WorkedInWindow {
  creditedSec: number;
  daysCounted: number;
}

export interface LaggardRow {
  employeeId: number;
  fullName: string;
  creditedSec: number;
  daysCounted: number;
}

/**
 * **Who has worked the fewest hours** *(owner's request)* — a few people from
 * the bottom.
 *
 * Careful: **the base is the employee list, not the query result** — the
 * only real decision here. Sorting the total rows would leave out anyone who
 * worked **not one day** in the window (they have no row), so they would
 * vanish from the list — yet they are exactly the answer to "who worked the
 * least". So everyone is assumed to have zero first, then sorted.
 *
 * Careful: ties on hours are broken by name — otherwise several people with
 * zero would change order on every refresh and the screen would look jumpy.
 *
 * Careful: `daysCounted` is only carried along, **not** used for ordering.
 * Sorting by average ("per day") was possible, but then someone who came in
 * one day and worked seven hours would rank **above** — though their hours
 * for the week are the fewest. The question was "least work", not "lowest
 * average"; and since the number of days is shown next to it on screen, there
 * is no chance of misreading it.
 */
export function rankLaggards(
  names: ReadonlyMap<number, string>,
  worked: ReadonlyMap<number, WorkedInWindow>,
  limit = 5,
): LaggardRow[] {
  return [...names.entries()]
    .map(([employeeId, fullName]) => ({
      employeeId,
      fullName,
      creditedSec: worked.get(employeeId)?.creditedSec ?? 0,
      daysCounted: worked.get(employeeId)?.daysCounted ?? 0,
    }))
    .sort(
      (a, b) =>
        a.creditedSec - b.creditedSec || a.fullName.localeCompare(b.fullName),
    )
    .slice(0, limit);
}
