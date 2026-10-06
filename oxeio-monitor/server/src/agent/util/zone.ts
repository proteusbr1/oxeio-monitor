/**
 * Wall-clock arithmetic for one IANA time zone, daylight saving included.
 * No side effects and no environment: `work-time.ts` makes the one instance
 * the server uses, and tests make their own for any zone.
 *
 * Every answer comes from `Intl` (the tz database Node ships), never from a
 * constant offset: with daylight saving the offset changes twice a year, a
 * day can be 23 or 25 hours long, and a local midnight can even be missing.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** One change of offset: from `at` on, wall clock = UTC + `offsetMinutes` */
export interface ZoneTransition {
  at: Date;
  offsetMinutes: number;
}

/** Throws a readable error when the name is not an IANA zone Node knows */
export function assertKnownZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(
      `"${timeZone}" is not a known IANA time zone (examples: America/Sao_Paulo, Europe/Lisbon, Asia/Dhaka)`,
    );
  }
}

export class Zone {
  private readonly format: Intl.DateTimeFormat;
  /** offset per UTC minute — heartbeats ask about the same minutes over and over */
  private readonly offsets = new Map<number, number>();
  /** first instant of each local date, by the date's UTC-midnight label */
  private readonly dayStarts = new Map<number, number>();

  constructor(readonly name: string) {
    assertKnownZone(name);
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  /** Milliseconds to add to a UTC instant to read the wall clock */
  offsetMsAt(t: number): number {
    const minute = Math.floor(t / MINUTE_MS);
    const hit = this.offsets.get(minute);
    if (hit !== undefined) return hit;

    const at = minute * MINUTE_MS;
    const p: Record<string, number> = {};
    for (const part of this.format.formatToParts(new Date(at))) {
      if (part.type !== 'literal') p[part.type] = Number(part.value);
    }
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offset = wall - at;

    if (this.offsets.size > 50_000) this.offsets.clear();
    this.offsets.set(minute, offset);
    return offset;
  }

  offsetMinutesAt(t: number): number {
    return Math.round(this.offsetMsAt(t) / MINUTE_MS);
  }

  /** The wall clock at `t`, written as if it were UTC (read it with getUTC*) */
  wallOf(t: number): Date {
    return new Date(t + this.offsetMsAt(t));
  }

  /** The local date of `t`, as that date's UTC midnight (Prisma's `@db.Date`) */
  dateOf(t: number): Date {
    const w = this.wallOf(t);
    return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()));
  }

  /**
   * The first instant of a local date (given as its UTC-midnight label).
   * Usually that date's 00:00; on a day whose midnight is skipped by daylight
   * saving, the moment the clock jumps.
   *
   * Found by bisection rather than `label - offset`: the offset to subtract
   * is the one in force at the answer, which is what is being looked for.
   */
  startOfDate(label: Date): Date {
    const key = label.getTime();
    const hit = this.dayStarts.get(key);
    if (hit !== undefined) return new Date(hit);

    // offsets lie within −12 h … +14 h, so the answer lies within this window
    let lo = key - 16 * HOUR_MS; // before the date starts
    let hi = key + 14 * HOUR_MS; // after it started
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.dateOf(mid).getTime() >= key) hi = mid;
      else lo = mid;
    }

    if (this.dayStarts.size > 5_000) this.dayStarts.clear();
    this.dayStarts.set(key, hi);
    return new Date(hi);
  }

  /** The first instant of the local day after the one `t` falls on */
  nextDayStart(t: number): Date {
    return this.startOfDate(new Date(this.dateOf(t).getTime() + DAY_MS));
  }

  /**
   * The offset in force at `from`, then every change up to `to`. What the
   * agent needs to cut days exactly as the server does, without depending
   * on the PC's own time-zone data.
   */
  transitions(from: Date, to: Date): ZoneTransition[] {
    const out: ZoneTransition[] = [{ at: from, offsetMinutes: this.offsetMinutesAt(from.getTime()) }];
    const STEP = 6 * HOUR_MS;
    let prevT = from.getTime();
    let prev = this.offsetMsAt(prevT);

    for (let t = prevT + STEP; prevT < to.getTime(); t += STEP) {
      const now = this.offsetMsAt(t);
      if (now !== prev) {
        // the change lies in (prevT, t]: find its exact millisecond
        let lo = prevT;
        let hi = t;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (this.offsetMsAt(mid) === prev) lo = mid;
          else hi = mid;
        }
        if (hi <= to.getTime()) out.push({ at: new Date(hi), offsetMinutes: Math.round(now / MINUTE_MS) });
        prev = now;
      }
      prevT = t;
    }
    return out;
  }

  /** An instant whose wall clock reads `wall` (either one, if the hour occurs twice) */
  instantOfWall(wall: Date): Date {
    const target = wall.getTime();
    let lo = target - 16 * HOUR_MS;
    let hi = target + 14 * HOUR_MS;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.wallOf(mid).getTime() >= target) hi = mid;
      else lo = mid;
    }
    return new Date(hi);
  }
}
