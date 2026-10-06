/**
 * All alert thresholds in one place.
 *
 * They live in their own file because these numbers are **policy**, not
 * implementation. Seeing what each change does at a glance stops someone from
 * quietly "lowering it a bit" and making the whole system useless.
 */

/**
 * Values that go into the `alerts.type` column (the list from the schema.prisma comment).
 *
 * Careful: the column is `TEXT`, not an enum, so this union is the only place
 * that catches typos.
 */
export type AlertType =
  | 'agent_down'
  | 'agent_killed'
  | 'disk_warning'
  | 'disk_critical'
  | 'backup_failed'
  | 'clock_drift'
  | 'no_activity_today'
  | 'device_overlap'
  | 'synthetic_input'
  | 'agent_capability';

/** As a list; needed by the DTO's `@IsIn()` */
export const ALERT_TYPE_VALUES: readonly AlertType[] = [
  'agent_down',
  'agent_killed',
  'disk_warning',
  'disk_critical',
  'backup_failed',
  'clock_drift',
  'no_activity_today',
  'device_overlap',
  'synthetic_input',
  'agent_capability',
];

/**
 * The most important number in the whole module.
 *
 * One alert per device per reason within 6 hours. Without it, a PC that is off
 * overnight would raise an alert every 5 minutes: 140 in one night, about a
 * thousand emails for a twelve-person office. Nobody would read alerts after
 * that, so the **real** problems would be missed too. Flood control is not a
 * courtesy; it is what keeps the system useful.
 */
export const THROTTLE_HOURS = 6;

// ── Synthetic input (mouse jiggler) ─────────────────────────────────────────

/**
 * Once a day is enough: the check looks at segments from the **whole day**, so
 * running it often gains nothing. It still runs during the day (not at night)
 * so the owner sees the incident **the same day** while the screenshots are
 * still fresh.
 */
export const SYNTHETIC_INPUT_TICK_MS = 60 * 60_000;

// ── Agent silent ────────────────────────────────────────────────────────────

/** Spec § 6.4: "is any agent silent for 10 minutes?" */
export const AGENT_SILENCE_MIN = 10;

/** Same row: the check runs every 5 minutes */
export const AGENT_DOWN_TICK_MS = 5 * 60_000;

/**
 * **The agent_down check does not run for this long after the office opens.**
 *
 * Careful: the office opens at 9:00, but people **arrive and switch on their
 * PC** at 9:00. Everyone is naturally silent for the first few minutes, and
 * that is not news.
 *
 * Measured in the field: everyone started working between **08:48 and 09:03**,
 * the latest at 09:03. Yet **six** alerts fired at exactly 9:00, and all six
 * people were back by 9:09, so none of them was real.
 *
 * Without this grace it would happen **every day**: about 130 pointless alerts
 * a month, which would again bury the real ones (the exact disease ADR-031 cured).
 *
 * Why 15 minutes: 12 minutes more than the latest starter, and enough for a
 * slow-booting PC. Careful: this does **not** change office hours; it only
 * sets "from when everyone is expected to be present".
 */
export const OFFICE_OPEN_GRACE_MIN = 15;

/**
 * Event times come from the agent's clock (after drift correction), while
 * `lastSeenAt` is set on the server's clock. A few seconds of difference is
 * normal, so this allowance is kept for the question "was the last event the
 * goodbye event?".
 */
export const CLEAN_STOP_GRACE_MIN = 5;

/**
 * The agent_down check does not run for this long after a server restart.
 *
 * If the server was down for an hour, **every** device's `lastSeenAt` is stale
 * the moment it returns, because the agents have not checked in again yet.
 * Without a grace period every restart would send twelve false "agent down"
 * alerts for a twelve-person office, and those are the most trust-destroying
 * alerts because they are always wrong.
 */
export const STARTUP_GRACE_MIN = 15;

// ── Agent stopped / uninstalled ─────────────────────────────────────────────

/** When these events arrive, we check whether someone tampered with the agent */
export const TAMPER_EVENT_TYPES: readonly string[] = [
  'agent_stop',
  'agent_uninstall',
  'uninstall',
];

/** An uninstall is never normal, so these get no exemption */
export const UNINSTALL_EVENT_TYPES: readonly string[] = [
  'agent_uninstall',
  'uninstall',
];

/**
 * A logoff/shutdown right after agent_stop is an ordinary shutdown, not
 * tampering. Two events inside this window are exempted.
 */
export const SHUTDOWN_PAIR_WINDOW_MIN = 2;

/**
 * Agents buffer events while offline, so a three-day-old agent_stop can arrive
 * today. That is why the scan uses `receivedAt`, not `occurredAt`; otherwise
 * late-arriving events would stay invisible forever.
 *
 * The window is deliberately much longer than the tick (5 minutes): after a
 * server restart the first tick comes 5 minutes later, and anything that
 * arrived before it must still be inside the window. Seeing extra events does
 * no harm, since the throttle merges them into a single alert anyway.
 */
export const TAMPER_LOOKBACK_MIN = 30;

export const TAMPER_TICK_MS = 5 * 60_000;

// ── Disk ────────────────────────────────────────────────────────────────────

export const DISK_WARN_PCT = 80;
export const DISK_CRITICAL_PCT = 95;
export const DISK_TICK_MS = 15 * 60_000;

// ── No activity all day ─────────────────────────────────────────────────────

/**
 * The question is asked only inside this evening window.
 *
 * Saying "nobody did anything today" at 9 AM is meaningless; the day has just
 * begun. Without a window, right after midnight the new day's numbers would
 * show everyone as "did no work", which means twelve alerts every night.
 *
 * Careful: the window (4 hours) is deliberately shorter than the 6-hour
 * throttle, which makes more than one alert per person per day mathematically
 * impossible.
 */
export const NO_ACTIVITY_FROM_HOUR = 18;
export const NO_ACTIVITY_TO_HOUR = 22;
export const NO_ACTIVITY_TICK_MS = 30 * 60_000;

// ── Two devices of the same staff member at once ────────────────────────────

/**
 * Spec § 2.1(c): "a `device_overlap` alert when overlap exceeds 15 minutes a day".
 *
 * Careful: the threshold is deliberately high. An overlap of a minute or two
 * is an everyday event, such as walking into a meeting with the laptop without
 * locking the desktop. With a lower threshold almost everyone would get an
 * alert nearly every day, and the alert would stop meaning anything.
 */
export const OVERLAP_ALERT_SEC = 15 * 60;

/**
 * Once an hour is enough. Overlap is not an emergency (it does not affect the
 * hours total, since `worked_sec` is a UNION anyway), and the check pulls
 * **all** of the day's segments. Running it every 5 minutes would needlessly
 * hammer the database.
 */
export const OVERLAP_TICK_MS = 60 * 60_000;

// ── Sending email ───────────────────────────────────────────────────────────

export const DISPATCH_TICK_MS = 60_000;

/**
 * Alerts older than 24 hours are no longer emailed.
 *
 * If SMTP is fixed after a week of downtime, the 300 queued alerts would all
 * go out at once. All of them would be stale, and sending them together would
 * be another flood.
 */
export const DISPATCH_MAX_AGE_HOURS = 24;

/** The most alerts sent in one email per round */
export const DISPATCH_BATCH = 20;

/** After this many failed attempts we give up, write `email_failed` and set it aside */
export const MAX_EMAIL_ATTEMPTS = 3;

/**
 * SMTP timeout, so one hung mail server cannot block the whole sweep.
 * nodemailer's default is very long, so it is set explicitly.
 */
export const SMTP_TIMEOUT_MS = 10_000;
