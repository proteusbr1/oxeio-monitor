/**
 * When an alert is raised and when it is **not**: all decisions live here, in
 * pure functions. No I/O, no Prisma, no clock (time always comes in as a parameter).
 *
 * It is a separate file because the hard question about alerts is not "how do
 * I send it" but "when do I stay **quiet**". If that decision were tangled up
 * with the database it could not be tested, and getting it wrong is severe:
 * either a flood or silence.
 */

import {
  workPathParts,
  localMidnightOf,
  workDateOf,
} from '../agent/util/work-time';
import {
  AGENT_SILENCE_MIN,
  OFFICE_OPEN_GRACE_MIN,
  CLEAN_STOP_GRACE_MIN,
  DISK_CRITICAL_PCT,
  DISK_WARN_PCT,
  NO_ACTIVITY_FROM_HOUR,
  NO_ACTIVITY_TO_HOUR,
  OVERLAP_ALERT_SEC,
  SHUTDOWN_PAIR_WINDOW_MIN,
  STARTUP_GRACE_MIN,
  THROTTLE_HOURS,
  UNINSTALL_EVENT_TYPES,
  type AlertType,
} from './alerts.constants';
import { isOffWeekday } from '../summary/weekly-off';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// ════════════════════════════════════════════════════════════════════════════
// 1. Flood control — the backbone of the whole module
// ════════════════════════════════════════════════════════════════════════════

/** What "the same alert" means: the same if these three match */
export interface AlertKey {
  type: AlertType;
  deviceId?: number | null;
  employeeId?: number | null;
}

/**
 * Same reason on the same device = same key.
 *
 * When there is no device (e.g. disk, or per-employee alerts), `-` takes its
 * place in the key, so "the server's disk" is throttled as a single entity.
 */
export function dedupeKey(key: AlertKey): string {
  return `${key.type}|d:${key.deviceId ?? '-'}|e:${key.employeeId ?? '-'}`;
}

/** Start of the throttle window: the DB is searched for `createdAt >= this time` */
export function throttleFloor(now: Date, windowHours = THROTTLE_HOURS): Date {
  return new Date(now.getTime() - windowHours * HOUR_MS);
}

/**
 * **Alerts that describe the whole day.**
 *
 * The bug this fixes: these two checks run **every hour** and each time read
 * the segments of the **whole work day**. Once the condition is true it is
 * true on every later tick that day, because old rows are not deleted. But the
 * throttle window is only 6 hours and the key does not contain the day. So
 * **the same incident** produced 3-4 alerts a day, each with an identical
 * title, description and meta, and each one a separate email.
 *
 * This is not a guess: `agent_down`, which takes the same path, does exactly
 * this in the field. On 22 August each of **13** (device, employee) pairs got
 * exactly **4** alerts, 6 hours apart (00:17, 06:19, 12:20, 18:20).
 *
 * `agent_down` is deliberately **not** in this list. It does not describe the
 * day; it says "this PC is silent right now". A PC that stays off for three
 * days should be reminded about daily (when in doubt, noise beats silence
 * here). `no_activity_today` is not in the list either: its 4-hour window
 * already makes more than one alert a day impossible.
 */
export const DAY_SCOPED_TYPES: ReadonlySet<AlertType> = new Set<AlertType>([
  'device_overlap',
  'synthetic_input',
]);

/**
 * Where the throttle window starts for such alerts.
 *
 * For day-scoped types it is **the earlier of two**: the start of today in
 * the work zone, or 6 hours ago. Both are needed:
 * <ul>
 *   <li>Without the start of the day, the same day would raise repeated alerts;</li>
 *   <li>Without the 6 hours, right after midnight the window would shrink to a
 *       minute or so and yesterday night's alert would not be suppressed.</li>
 * </ul>
 *
 * Careful: the next day is not silenced. A new work day is a new incident, so
 * the floor moves forward with the day.
 */
export function alertFloor(
  type: AlertType,
  now: Date,
  windowHours = THROTTLE_HOURS,
): Date {
  const rolling = throttleFloor(now, windowHours);
  if (!DAY_SCOPED_TYPES.has(type)) return rolling;

  // `localMidnightOf` gives the real instant, not a label (see work-time.ts)
  const dayStart = localMidnightOf(now);
  return dayStart.getTime() < rolling.getTime() ? dayStart : rolling;
}

/**
 * Whether the previous alert is still "fresh".
 *
 * Careful: a future timestamp also counts as throttled (the `>` comparison),
 * so if the server clock goes backwards the error is on the side of silence,
 * not a flood.
 */
export function isThrottled(
  lastRaisedAt: Date | null | undefined,
  now: Date,
  windowHours = THROTTLE_HOURS,
): boolean {
  if (!lastRaisedAt) return false;
  return lastRaisedAt.getTime() > throttleFloor(now, windowHours).getTime();
}

/**
 * Type-aware version: for day-scoped alerts the window extends back to the
 * start of today in the work zone.
 */
export function isThrottledFor(
  type: AlertType,
  lastRaisedAt: Date | null | undefined,
  now: Date,
  windowHours = THROTTLE_HOURS,
): boolean {
  if (!lastRaisedAt) return false;
  return lastRaisedAt.getTime() > alertFloor(type, now, windowHours).getTime();
}

/** When the same alert may be raised again, for showing on the dashboard */
export function nextAllowedAt(
  lastRaisedAt: Date,
  windowHours = THROTTLE_HOURS,
): Date {
  return new Date(lastRaisedAt.getTime() + windowHours * HOUR_MS);
}

/**
 * Filters one round's candidates, in two steps:
 *
 *  1. Drop anything whose key already has an alert in the DB within 6 hours.
 *  2. **Within the same round too**, if the same key appears twice only one is
 *     kept. This second step is the easiest trap to forget: if a 15-minute
 *     window holds three agent_stop events for the same PC, the DB still has
 *     nothing, so step 1 would let all three through and three alerts would be
 *     created in the same second.
 */
export function suppressFlood<T extends AlertKey>(
  candidates: readonly T[],
  lastRaisedByKey: ReadonlyMap<string, Date>,
  now: Date,
  windowHours = THROTTLE_HOURS,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];

  for (const candidate of candidates) {
    const key = dedupeKey(candidate);
    if (seen.has(key)) continue;
    // Day-scoped types have a different floor (`alertFloor`)
    if (isThrottledFor(candidate.type, lastRaisedByKey.get(key), now, windowHours)) {
      continue;
    }
    seen.add(key);
    kept.push(candidate);
  }

  return kept;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. work-zone time. Offsets are never computed by hand; everything comes from work-time.ts
// ════════════════════════════════════════════════════════════════════════════

/** Local hour in the work zone, 0-23 */
export function workHourOf(instant: Date): number {
  return Number(workPathParts(instant).hhmmss.slice(0, 2));
}

/**
 * ISO weekday of the work-zone date: Mon = 1 ... Fri = 5 ... Sun = 7.
 *
 * Careful: `work_policies.weekly_off_day` stores exactly this number (Fri = 5),
 * but JavaScript's `getUTCDay()` gives Sun = 0 ... Sat = 6. Without converting,
 * the weekly off day would shift by one, and the mistake would only show on
 * the off day itself.
 */
export function workIsoWeekday(instant: Date): number {
  const day = workDateOf(instant).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Minute of the day in work-zone local time (0-1439) */
export function workMinuteOfDay(instant: Date): number {
  const hhmmss = workPathParts(instant).hhmmss;
  return Number(hhmmss.slice(0, 2)) * 60 + Number(hhmmss.slice(2, 4));
}

/** 'HH:MM' -> minute of day. null if malformed (the caller then treats it as "open") */
export function parseHhmm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface OfficeHoursInput {
  now: Date;
  /** 'HH:MM'; if empty, open all day */
  officeFrom: string | null;
  officeTo: string | null;
  /** The policy's weekly off days (ISO weekday, Fri = 5); empty if none */
  weeklyOffDays: readonly number[];
  /** Whether today is a holiday in the calendar */
  isHoliday: boolean;
}

/**
 * **Is the office open right now?**
 *
 * Careful: the only purpose of this function is **staying quiet**: deciding
 * when an `agent_down` alert is not raised. The owner's question was why we
 * should alert about agents being down after the office closes.
 *
 * Field measurement (14 days, by work-zone hour): 18:00 -> 90, 00:00 -> 78,
 * 06:00 -> 78, 12:00 -> 33. So every PC switched off after office hours raised
 * an alert, and because `THROTTLE_HOURS = 6` it came back three times through the night.
 *
 * Careful: **when no hours are set, it counts as "open"**, not closed. Both
 * kinds of error are bad, but not equally: extra alerts are annoying, while
 * **silently disabled alerts are dangerous** because nobody notices the watch
 * is gone. For the same reason `officeTo <= officeFrom` (reversed or equal)
 * also counts as open.
 */
export function isOfficeOpen(input: OfficeHoursInput): boolean {
  const { now, officeFrom, officeTo, weeklyOffDays, isHoliday } = input;

  if (isHoliday) return false;
  if (isOffWeekday(workIsoWeekday(now), weeklyOffDays)) {
    return false;
  }

  const from = parseHhmm(officeFrom);
  const to = parseHhmm(officeTo);
  if (from === null || to === null || to <= from) return true;

  const minute = workMinuteOfDay(now);
  return minute >= from && minute < to;
}

/**
 * **Is everyone expected to be present now?**
 *
 * Careful: this is **not** `isOfficeOpen()`, and the separate name is
 * deliberate. The office does open at 9:00, but not **everyone's PC is
 * expected to be on** at 9:00, because people are only just arriving. They are
 * two different questions, so two functions: putting the allowance into
 * `isOfficeOpen()` would make it lie about its own name.
 *
 * Measured in the field (23 August): start times 08:48-09:03, yet six alerts
 * at 9:00, none of them real.
 *
 * Careful: the allowance applies only at the **start**, not the end. A PC
 * suddenly going off in the afternoon is real news and must not be hidden before closing.
 */
export function isAgentWatchOpen(
  input: OfficeHoursInput,
  graceMin = OFFICE_OPEN_GRACE_MIN,
): boolean {
  if (!isOfficeOpen(input)) return false;

  const from = parseHhmm(input.officeFrom);
  // Careful: when hours are unknown `isOfficeOpen()` counts the whole day as open, so
  // there is no "after opening" moment and therefore no grace either.
  if (from === null) return true;

  return workMinuteOfDay(input.now) >= from + graceMin;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Agent silent for 10 minutes
// ════════════════════════════════════════════════════════════════════════════

/** Silence after these events is normal */
export const CLEAN_STOP_EVENTS: readonly string[] = [
  'agent_stop',
  'logoff',
  'shutdown',
  'sleep',
];

export interface DeviceSilence {
  deviceId: number;
  /** When anything last arrived, on the server clock */
  lastSeenAt: Date | null;
  /** The device's latest **goodbye** event (agent_stop/logoff/...); null if none */
  lastCleanStopAt?: Date | null;
}

/**
 * Is the silence explained?
 *
 * Shutting the PC down and going home, and the agent dying, both stop the
 * data, but the first is not news. The only difference: in the first case the
 * last thing we heard was a goodbye event. Without that check, every evening
 * as each PC was switched off twelve alerts would go out, so the check would
 * be useful for nothing even though it always told the truth.
 */
export function isExpectedSilence(
  device: DeviceSilence,
  graceMin = CLEAN_STOP_GRACE_MIN,
): boolean {
  const { lastSeenAt, lastCleanStopAt } = device;
  if (!lastCleanStopAt) return false;
  if (!lastSeenAt) return true;

  // Was the goodbye event the last news? If anything came after it, the agent
  // came back, and the silence after that has no explanation.
  return lastCleanStopAt.getTime() >= lastSeenAt.getTime() - graceMin * MINUTE_MS;
}

/** How long it has been silent, in minutes (null if there is no `lastSeenAt`) */
export function silentMinutes(
  lastSeenAt: Date | null,
  now: Date,
): number | null {
  if (!lastSeenAt) return null;
  return Math.floor((now.getTime() - lastSeenAt.getTime()) / MINUTE_MS);
}

/**
 * Devices whose silence has no explanation.
 *
 * Careful: devices with `lastSeenAt === null` are excluded. They enrolled but
 * never sent anything. That is an enrollment problem, not "the agent stopped",
 * and alerting on them would make every never-installed device complain forever.
 */
export function agentDownCandidates(
  devices: readonly DeviceSilence[],
  now: Date,
  silenceMin = AGENT_SILENCE_MIN,
): DeviceSilence[] {
  const floor = now.getTime() - silenceMin * MINUTE_MS;

  return devices.filter((d) => {
    if (!d.lastSeenAt) return false;
    if (d.lastSeenAt.getTime() > floor) return false;
    return !isExpectedSilence(d);
  });
}

/** An open agent_down alert plus its device's latest state */
export interface OpenAgentDownAlert {
  alertId: bigint;
  /** The device is still active (not revoked) */
  deviceActive: boolean;
  /** When anything last arrived, on the server clock */
  lastSeenAt: Date | null;
}

/**
 * A returned agent: which open agent_down alerts can now be closed automatically.
 *
 * The exact **mirror** of `agentDownCandidates()`: that one picks "went
 * silent" (`lastSeenAt < floor`), this one picks "is talking again"
 * (`lastSeenAt >= floor`). When the PC that raised an alert starts sending
 * data again, the alert's question ("is this PC OK?") answers itself: yes. So
 * in the morning the owner sees only what is **really down now**, not twelve
 * stale warnings about PCs switched off overnight.
 *
 * Careful: revoked devices are excluded. Silence is the whole point for them,
 * so their alerts are not closed this way.
 */
export function recoveredAlertIds(
  alerts: readonly OpenAgentDownAlert[],
  now: Date,
  silenceMin = AGENT_SILENCE_MIN,
): bigint[] {
  const floor = now.getTime() - silenceMin * MINUTE_MS;
  return alerts
    .filter(
      (a) =>
        a.deviceActive && a.lastSeenAt != null && a.lastSeenAt.getTime() >= floor,
    )
    .map((a) => a.alertId);
}

/**
 * The server has just started: checking agent_down now would only measure our
 * own absence. The question should not be asked before the agents have had
 * time to come back.
 */
export function isWithinStartupGrace(
  bootedAt: Date,
  now: Date,
  graceMin = STARTUP_GRACE_MIN,
): boolean {
  return now.getTime() - bootedAt.getTime() < graceMin * MINUTE_MS;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Agent stopped / uninstall attempt
// ════════════════════════════════════════════════════════════════════════════

export interface StopEvent {
  deviceId: number | null;
  employeeId?: number | null;
  type: string;
  occurredAt: Date;
}

/**
 * **Events that explain an `agent_stop` as "normal".**
 *
 * Careful: `agent_stop` means nothing by itself. It happens on everyone's PC
 * twice a day, and it is exactly what arrives when someone kills the agent
 * from Task Manager. The only way to tell them apart is these surrounding events.
 *
 * Careful: `agent_update` was added on 5 September 2026, and that was not just
 * adding a name; it stopped a **silent false alert**. When the agent's MSI
 * update is installed, the Windows Restart Manager makes the agent shut down
 * (`ENDSESSION_CLOSEAPP`). `agent_stop` was sent, but no `logoff`/`shutdown`
 * came with it, because the PC was not shutting down. So **every update raised
 * an `agent_killed` warning**.
 *
 * Updating one or two PCs by hand went unnoticed. But once the rollout
 * started on its own, there would be 12 false alerts at once, and after that
 * nobody would read alerts, so the stop/uninstall check would be useless in practice.
 *
 * Careful: the exemption is narrow, by design. `agent_update` is sent only
 * when Windows itself is shutting us down. If someone kills the process it is
 * not sent, so real tampering is still caught as before.
 */
export const CLEAN_STOP_CONTEXT: readonly string[] = [
  'logoff',
  'shutdown',
  'agent_update',
];

/**
 * agent_stop is both the most common and the most suspicious event.
 *
 * It happens on everyone's PC twice a day (logoff/shutdown), and it is also
 * exactly what arrives when someone kills the agent from Task Manager. The
 * only way to tell them apart: whether a logoff/shutdown is nearby.
 *
 * Careful: the benefit of the doubt does **not** go to silence. If no pair
 * matches, an alert is raised. A false alert is annoying, but a quietly
 * stopped agent ruins a whole month's numbers.
 */
export function isTamperStop(
  stop: StopEvent,
  sameDeviceEvents: readonly StopEvent[],
  windowMin = SHUTDOWN_PAIR_WINDOW_MIN,
): boolean {
  if (UNINSTALL_EVENT_TYPES.includes(stop.type)) return true;

  const windowMs = windowMin * MINUTE_MS;
  const paired = sameDeviceEvents.some(
    (e) =>
      e.deviceId === stop.deviceId &&
      CLEAN_STOP_CONTEXT.includes(e.type) &&
      Math.abs(e.occurredAt.getTime() - stop.occurredAt.getTime()) <= windowMs,
  );

  return !paired;
}

/** Uninstall = critical, a plain stop = warning */
export function tamperSeverity(eventType: string): 'warning' | 'critical' {
  return UNINSTALL_EVENT_TYPES.includes(eventType) ? 'critical' : 'warning';
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Server disk
// ════════════════════════════════════════════════════════════════════════════

/** The parts of `fs.statfs()` we use */
export interface DiskStats {
  /** Total blocks */
  blocks: number;
  /** Free blocks (including the part reserved for root) */
  bfree: number;
  /** Blocks actually free for ordinary users */
  bavail: number;
  bsize: number;
}

/**
 * Used percentage, following the definition `df` uses.
 *
 * Careful: the denominator is `used + bavail`, not `blocks` (the total). On
 * Linux, ext4 reserves 5% of blocks for root by default; dividing by the total
 * would not match `df`, and even when the disk was truly full our figure would
 * never pass 95%, so the alert would be missing at exactly the moment it is needed.
 */
export function diskUsedPct(stats: DiskStats): number {
  const used = stats.blocks - stats.bfree;
  const usable = used + stats.bavail;
  if (!Number.isFinite(usable) || usable <= 0) return 0;
  return (used / usable) * 100;
}

export interface DiskVerdict {
  type: Extract<AlertType, 'disk_warning' | 'disk_critical'>;
  severity: 'warning' | 'critical';
}

/**
 * Using two different `type` values is deliberate.
 *
 * Past 80%, one warning goes out every 6 hours. When the disk reaches 95% the
 * type changes, so the throttle key changes too. The serious news therefore
 * arrives immediately and is not buried in the shadow of the earlier warning.
 */
export function diskVerdict(usedPct: number): DiskVerdict | null {
  if (usedPct >= DISK_CRITICAL_PCT) {
    return { type: 'disk_critical', severity: 'critical' };
  }
  if (usedPct >= DISK_WARN_PCT) {
    return { type: 'disk_warning', severity: 'warning' };
  }
  return null;
}

/** Bytes -> human-readable (goes into the alert message) */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Nobody did any work all day
// ════════════════════════════════════════════════════════════════════════════

export function isNoActivityWindow(
  now: Date,
  fromHour = NO_ACTIVITY_FROM_HOUR,
  toHour = NO_ACTIVITY_TO_HOUR,
): boolean {
  const hour = workHourOf(now);
  return hour >= fromHour && hour < toHour;
}

export interface NoActivityInput {
  /** How many `counts_as_work` segments this employee has today */
  workedSegments: number;
  /** The employee's policy weekly off days (ISO weekday); empty if none */
  weeklyOffDays: readonly number[];
  /** Whether today is a holiday in the calendar */
  isHoliday: boolean;
  /**
   * Whether today is an approved leave day for **this employee**.
   *
   * Careful: not merged with `isHoliday`: that is the **office** calendar,
   * this is that one person's, just like `AttendanceRow.onLeave`.
   */
  onLeave: boolean;
  joinedOn: Date | null;
  leftOn: Date | null;
  now: Date;
}

/**
 * The real job of this function is to say **no**.
 *
 * The plain answer to "did nobody work today?" is often correct but
 * meaningless: a weekly day off, a public holiday, or someone who joined yesterday.
 * Careful: without excluding days off, twelve false alerts would go out on
 * every weekly day off, four or more times a month. That habit is how people end up leaving the
 * alert folder unread.
 *
 * Careful: "excluding" a holiday only means not raising the alert. If someone
 * works that day their hours are counted in full (§ 2.1(b), a holiday is not a block).
 */
export function shouldFlagNoActivity(input: NoActivityInput): boolean {
  const { workedSegments, weeklyOffDays, isHoliday, onLeave, joinedOn, leftOn, now } =
    input;

  if (workedSegments > 0) return false;
  if (!isNoActivityWindow(now)) return false;
  if (isHoliday) return false;
  /**
   * **Approved leave.**
   *
   * The bug this fixes: the note at the top of this file used to say "there
   * is no leave application/approval system in this one (ADR-011d)", and it
   * was **a month stale**. The leave register arrived later, but no alert
   * check ever read the `leaves` table.
   *
   * Measured in the field: on just **3** leave days there were **11** false
   * alerts (8 `agent_down` + 3 `no_activity_today`), so on every leave day
   * the owner's inbox got news about something they had approved themselves.
   */
  if (onLeave) return false;
  if (isOffWeekday(workIsoWeekday(now), weeklyOffDays)) {
    return false;
  }

  const today = workDateOf(now).getTime();
  // No work before the joining date is normal
  if (joinedOn && joinedOn.getTime() > today) return false;
  // Careful: `<`. The last day of employment is still a working day, so no work
  // that day raises an alert.
  if (leftOn && leftOn.getTime() < today) return false;

  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// 6a. Two devices of the same staff member at once
// ════════════════════════════════════════════════════════════════════════════

export interface OverlapInput {
  /** How many distinct devices of this staff member sent segments that day */
  deviceCount: number;
  /** `overlapSec()`: seconds both devices ran at the same wall-clock time */
  overlapSec: number;
  /** The day's UNIONed worked time, to give context in the message */
  workedSec: number;
}

/**
 * Whether an alert is raised.
 *
 * <b>The threshold is 15 minutes, deliberately high.</b> A few minutes of
 * overlap on two machines is completely normal: walking into a meeting with
 * the laptop without locking the desktop, or starting work on one machine
 * before the other's segment has closed. Careful: with a lower threshold (say
 * 1 minute) almost everyone would get an alert nearly every day, and the alert
 * would stop meaning anything.
 *
 * Careful: severity is `warning`, not `critical`, and this is **not** an
 * accusation. The spec (§ 2.1(c)) names two common causes: one PC used by two
 * people, or a forgotten machine left on. It has no effect on the hours,
 * because `worked_sec` is a UNION anyway, so time is not counted twice. The
 * alert is therefore information: <i>"know this before you read that day's numbers"</i>.
 */
export function shouldFlagOverlap(
  input: OverlapInput,
  thresholdSec = OVERLAP_ALERT_SEC,
): boolean {
  // Careful: with one device `overlapSec` is mathematically 0, but the condition is
  // kept explicit so this guard survives if the calculation changes.
  if (input.deviceCount < 2) return false;

  return input.overlapSec >= thresholdSec;
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Which alerts go out by email now
// ════════════════════════════════════════════════════════════════════════════

/** The label that goes into the subject */
export function severityLabel(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Warning';
    default:
      return 'Info';
  }
}
