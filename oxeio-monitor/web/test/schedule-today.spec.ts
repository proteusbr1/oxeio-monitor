import { afterEach, describe, expect, it } from 'vitest';

import type { TodayPerson } from '../src/api/schedule';
import i18n from '../src/i18n';
import {
  breachCount,
  liveNowMin,
  todayStatus,
} from '../src/pages/live/scheduleToday';

/** 08:00–17:00, a 60-minute break starting between 11:00 and 14:00 */
const person = (over: Partial<TodayPerson> = {}): TodayPerson => ({
  employeeId: 1,
  fullName: 'Alex Silva',
  startMin: 480,
  endMin: 1020,
  requiredBreakMin: 60,
  breakFromMin: 660,
  breakToMin: 840,
  toleranceMarkMin: 5,
  checkedToday: true,
  arrivedMin: null,
  leftMin: null,
  breakStartMin: null,
  breakMin: 0,
  lateMin: 0,
  earlyLeaveMin: 0,
  breaches: [],
  final: false,
  ...over,
});

const idle = { status: 'offline' as const, todayWorkedSec: 0 };
const working = { status: 'active' as const, todayWorkedSec: 3600 };

describe("today's schedule, one line each", () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('a day without a schedule check', () => {
    expect(todayStatus(person({ checkedToday: false }), 600)).toEqual({
      arrival: 'Not scheduled today',
      breakState: 'none',
      breakText: null,
      leaving: null,
      tone: 'off',
    });
  });

  it('before the start time nobody is late yet', () => {
    expect(todayStatus(person(), 450)).toMatchObject({
      arrival: 'Expected at 08:00',
      tone: 'ok',
    });
  });

  it('within the tolerance nobody is missing yet', () => {
    expect(todayStatus(person(), 485, idle)).toMatchObject({
      arrival: 'Expected at 08:00',
      tone: 'ok',
    });
  });

  it('past the start and the tolerance, with no time today', () => {
    expect(todayStatus(person(), 500, idle)).toMatchObject({
      arrival: 'Not in yet',
      breakText: null,
      leaving: null,
      tone: 'attention',
    });
  });

  it('the row is older than the live board: at work, not missing', () => {
    // the roll-up runs every 15 minutes; the live card already shows time
    expect(todayStatus(person(), 500, working)).toMatchObject({
      arrival: 'At work',
      tone: 'ok',
      leaving: 'Leaves at 17:00',
    });
    expect(
      todayStatus(person(), 500, { status: 'idle', todayWorkedSec: 120 })
        .arrival,
    ).toBe('At work');
  });

  it('arrived on time, break still to come', () => {
    expect(todayStatus(person({ arrivedMin: 478, leftMin: 600 }), 600)).toEqual(
      {
        arrival: 'Arrived 07:58',
        breakState: 'pending',
        breakText: 'Break pending · window until 14:00',
        leaving: 'Leaves at 17:00',
        tone: 'ok',
      },
    );
  });

  it('arrived late', () => {
    const late = person({
      arrivedMin: 492,
      leftMin: 600,
      lateMin: 12,
      breaches: ['late'],
    });
    expect(todayStatus(late, 600)).toMatchObject({
      arrival: 'Arrived 08:12 · 12m late',
      tone: 'attention',
    });
  });

  it('the break taken in full', () => {
    const s = todayStatus(
      person({
        arrivedMin: 480,
        leftMin: 900,
        breakStartMin: 720,
        breakMin: 60,
      }),
      900,
    );
    expect(s).toMatchObject({
      breakState: 'done',
      breakText: 'Break 12:00 · 1h 0m',
      tone: 'ok',
    });
  });

  it('a break going on right now', () => {
    // the current pause starts where the last stretch ended
    const s = todayStatus(
      person({
        arrivedMin: 480,
        leftMin: 720,
        breakStartMin: 720,
        breakMin: 20,
      }),
      740,
    );
    expect(s).toMatchObject({
      breakState: 'ongoing',
      breakText: 'On break since 12:00',
    });
  });

  it('an earlier short pause is not the break: still pending', () => {
    const s = todayStatus(
      person({
        arrivedMin: 480,
        leftMin: 800,
        breakStartMin: 690,
        breakMin: 15,
      }),
      800,
    );
    expect(s.breakState).toBe('pending');
  });

  it('a short or missing break', () => {
    expect(
      todayStatus(
        person({
          arrivedMin: 480,
          leftMin: 1020,
          breakStartMin: 720,
          breakMin: 30,
          breaches: ['break_short'],
        }),
        1000,
      ),
    ).toMatchObject({
      breakState: 'missed',
      breakText: 'Break 12:00 · 30m',
      tone: 'attention',
    });
    expect(
      todayStatus(
        person({ arrivedMin: 480, leftMin: 960, breaches: ['break_missing'] }),
        960,
      ),
    ).toMatchObject({ breakState: 'missed', breakText: 'No break taken' });
  });

  it('no break required', () => {
    const s = todayStatus(
      person({ requiredBreakMin: 0, arrivedMin: 480, leftMin: 600 }),
      600,
    );
    expect(s).toMatchObject({ breakState: 'none', breakText: null });
  });

  it('after the end time: when they left', () => {
    const base = { arrivedMin: 480, breakStartMin: 720, breakMin: 60 };
    expect(
      todayStatus(
        person({
          ...base,
          leftMin: 995,
          earlyLeaveMin: 25,
          breaches: ['early_leave'],
        }),
        1030,
      ),
    ).toMatchObject({ leaving: 'Left 16:35 · 25m early', tone: 'attention' });
    expect(
      todayStatus(person({ ...base, leftMin: 1022, final: true }), 1440),
    ).toMatchObject({ leaving: 'Left 17:02', tone: 'ok' });
  });

  it('still working past the end time: not "left"', () => {
    const base = { arrivedMin: 480, breakStartMin: 720, breakMin: 60 };
    // the row's last stretch ended at 17:02 a few minutes ago; they are still at it
    expect(
      todayStatus(person({ ...base, leftMin: 1022 }), 1035, working),
    ).toMatchObject({ leaving: 'Working past 17:00', tone: 'ok' });
    expect(
      todayStatus(person({ ...base, leftMin: 1022 }), 1035, idle).leaving,
    ).toBe('Left 17:02');
  });

  it('after the window, a break not yet judged is just pending', () => {
    const s = todayStatus(person({ arrivedMin: 480, leftMin: 860 }), 860);
    expect(s).toMatchObject({
      breakState: 'pending',
      breakText: 'Break pending',
    });
  });

  it("now, in minutes, from the work zone's clock", () => {
    const today = { workDate: '2026-10-09', nowMin: 600 };
    // Etc/GMT-6 in tests: 04:30Z is 10:30 local
    expect(liveNowMin(today, new Date('2026-10-09T04:30:00Z'))).toBe(630);
    // the next day has started: the day is over
    expect(liveNowMin(today, new Date('2026-10-09T18:30:00Z'))).toBe(1440);
  });

  it('in the other languages', async () => {
    const late = person({
      arrivedMin: 492,
      leftMin: 600,
      lateMin: 12,
      breaches: ['late'],
    });
    await i18n.changeLanguage('pt-BR');
    expect(todayStatus(late, 600)).toMatchObject({
      arrival: 'Chegou 08:12 · 12m de atraso',
      breakText: 'Intervalo pendente · janela até 14:00',
      leaving: 'Sai às 17:00',
    });
    expect(todayStatus(person(), 500, idle).arrival).toBe('Ainda não chegou');
    expect(todayStatus(person({ checkedToday: false }), 500).arrival).toBe(
      'Não tem jornada hoje',
    );
    expect(todayStatus(person(), 500, working).arrival).toBe('No trabalho');
    await i18n.changeLanguage('es');
    expect(todayStatus(late, 600).arrival).toBe('Llegó 08:12 · 12m de retraso');
  });

  it('counts the people with at least one breach', () => {
    expect(
      breachCount([
        person(),
        person({ breaches: ['late'] }),
        person({ breaches: ['late', 'break_short'] }),
      ]),
    ).toBe(2);
    expect(breachCount([])).toBe(0);
  });
});
