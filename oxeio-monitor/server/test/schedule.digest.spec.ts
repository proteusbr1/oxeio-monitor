import { describe, expect, it } from 'vitest';

import { scheduleDigestLines } from '../src/schedule/schedule.digest';

describe('scheduleDigestLines', () => {
  it('one line per person, each breach with its size', () => {
    expect(
      scheduleDigestLines([
        {
          fullName: 'Ana',
          breaches: ['late', 'break_short'],
          lateMin: 12,
          earlyLeaveMin: 0,
          breakMin: 40,
          requiredBreakMin: 60,
        },
        {
          fullName: 'Bo',
          breaches: ['no_show'],
          lateMin: 0,
          earlyLeaveMin: 0,
          breakMin: 0,
          requiredBreakMin: 60,
        },
        {
          fullName: 'Cy',
          breaches: ['early_leave', 'break_missing'],
          lateMin: 0,
          earlyLeaveMin: 25,
          breakMin: 0,
          requiredBreakMin: 60,
        },
      ]),
    ).toEqual([
      '• Ana — late 12 min · break 40 of 60 min',
      '• Bo — no activity on a scheduled day',
      '• Cy — left 25 min early · no break',
    ]);
  });

  it('nobody broke the schedule: no lines', () => {
    expect(scheduleDigestLines([])).toEqual([]);
  });
});
