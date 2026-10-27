/**
 * **M1 — what time range an agent upload may describe.**
 *
 * The hole: `POST /agent/enroll-login` takes any staff member's own email and
 * password and an invented hostname, and hands back a device token. With it,
 * `POST /agent/segments` took `state: active` for **any** start and end, so
 * an employee could credit themselves back-dated hours for the whole open
 * month from a script, without a PC ever running.
 *
 * Three bounds, all measured on the **drift-corrected** time (the same value
 * that is stored):
 *
 *  1. **Not in the future.** The agent sends a segment only once it has
 *     closed, so its end is in the past. A small allowance covers the
 *     rounding of the drift correction (`DRIFT_IGNORE_SEC`).
 *  2. **Not before this device was enrolled.** The agent records nothing
 *     before sign-in (`TrackingGate` in the agent), and signing out clears its
 *     outbox, so nothing honest predates `devices.enrolled_at`. This is the
 *     bound that closes the hole: a freshly enrolled fake device can claim
 *     nothing before the moment it was created.
 *  3. **Not older than the agent can hold data.** See `MAX_BACKFILL_DAYS`.
 *
 * Pure functions, so every edge can be tested without a database.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * How far in the future an end time may be.
 *
 * Careful: the drift correction already moves the agent's clock onto the
 * server's, so this only has to absorb its rounding and the request's own
 * travel time; five minutes is generous for both.
 */
export const DEFAULT_FUTURE_SKEW_MS = 5 * MINUTE_MS;

/**
 * How far before `enrolled_at` a start may be.
 *
 * Careful: `enrolled_at` is the server's clock at the end of the enrol
 * request, and the agent opens its first segment right after. Five minutes
 * covers a slow sign-in round trip; it does not cover hours.
 */
export const ENROLL_SKEW_MS = 5 * MINUTE_MS;

/**
 * **The oldest record still accepted: 32 days.**
 *
 * Taken from the agent's own queue, so an honest PC that was offline is never
 * punished:
 *
 *  - `OutboxBudget.Default.SegmentMaxAge` = **30 days** after enqueue, and
 *    `RetryPolicy`'s `MaxAge` = 30 days: past that the agent drops the row
 *    itself, so nothing older can arrive from an honest agent anyway.
 *  - A segment is enqueued when it **closes**, and may be up to a day long
 *    (`durationSec` <= 86 400 in the DTO), so its start can be one more day
 *    before its enqueue time.
 *  - One more day of slack for clock correction and the hourly sweep.
 *
 * Screenshots, app usage and events live only 7 days in the agent
 * (`OutboxBudget.MaxAge`), but the same limit is used for them: it is the
 * outer bound, and a second, tighter number would only be one more thing to
 * keep in step with the agent.
 */
export const MAX_BACKFILL_DAYS = 32;

export interface IngestLimits {
  futureSkewMs: number;
  enrollSkewMs: number;
  maxBackfillMs: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  futureSkewMs: DEFAULT_FUTURE_SKEW_MS,
  enrollSkewMs: ENROLL_SKEW_MS,
  maxBackfillMs: MAX_BACKFILL_DAYS * DAY_MS,
};

export type OutOfBounds = 'future' | 'before_enrolment' | 'too_old';

/**
 * Why a record is outside the allowed window, or `null` when it is fine.
 *
 * Careful: the order matters only for the label. `before_enrolment` comes
 * before `too_old` because it is the more telling of the two: on a device
 * enrolled yesterday, a record from six weeks ago is suspicious first and
 * old second.
 */
export function outOfBounds(
  span: { startedAt: Date; endedAt: Date },
  enrolledAt: Date,
  now: Date,
  limits: IngestLimits = DEFAULT_INGEST_LIMITS,
): OutOfBounds | null {
  const start = span.startedAt.getTime();
  const end = Math.max(start, span.endedAt.getTime());

  if (end > now.getTime() + limits.futureSkewMs) return 'future';
  if (start < enrolledAt.getTime() - limits.enrollSkewMs) return 'before_enrolment';
  if (start < now.getTime() - limits.maxBackfillMs) return 'too_old';
  return null;
}

/** Counts by reason, plus the time range of what was dropped (for the alert) */
export interface Rejections {
  total: number;
  byReason: Partial<Record<OutOfBounds, number>>;
  earliest: Date | null;
  latest: Date | null;
}

/**
 * Splits a batch into what may be stored and what is dropped.
 *
 * Careful: **dropped, not refused.** A 4xx would make the agent narrow the
 * batch down to single rows and abandon them one by one (`SyncWorker`), and a
 * 5xx would make it retry the same rows forever. Dropping inside a 200 keeps
 * the rest of the batch and lets the agent ack the whole thing.
 */
export function partitionByBounds<T>(
  items: readonly T[],
  spanOf: (item: T) => { startedAt: Date; endedAt: Date },
  enrolledAt: Date,
  now: Date,
  limits: IngestLimits = DEFAULT_INGEST_LIMITS,
): { kept: T[]; rejected: Rejections } {
  const kept: T[] = [];
  const rejected: Rejections = { total: 0, byReason: {}, earliest: null, latest: null };

  for (const item of items) {
    const span = spanOf(item);
    const reason = outOfBounds(span, enrolledAt, now, limits);
    if (reason === null) {
      kept.push(item);
      continue;
    }

    rejected.total += 1;
    rejected.byReason[reason] = (rejected.byReason[reason] ?? 0) + 1;
    if (rejected.earliest === null || span.startedAt < rejected.earliest) {
      rejected.earliest = span.startedAt;
    }
    if (rejected.latest === null || span.endedAt > rejected.latest) {
      rejected.latest = span.endedAt;
    }
  }

  return { kept, rejected };
}
