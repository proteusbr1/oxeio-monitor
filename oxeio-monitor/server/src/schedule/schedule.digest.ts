import type { Breach } from './schedule.rules';

export interface DigestBreach {
  fullName: string;
  breaches: Breach[];
  lateMin: number;
  earlyLeaveMin: number;
  breakMin: number;
  requiredBreakMin: number;
}

/** The daily summary's "Schedule today" lines (English, like the rest of the digest) */
export function scheduleDigestLines(rows: readonly DigestBreach[]): string[] {
  return rows.map((r) => {
    const parts = r.breaches.map((b) => {
      switch (b) {
        case 'late':
          return `late ${r.lateMin} min`;
        case 'early_leave':
          return `left ${r.earlyLeaveMin} min early`;
        case 'break_short':
          return `break ${r.breakMin} of ${r.requiredBreakMin} min`;
        case 'break_missing':
          return 'no break';
        default:
          return 'no activity on a scheduled day';
      }
    });
    return `• ${r.fullName} — ${parts.join(' · ')}`;
  });
}
