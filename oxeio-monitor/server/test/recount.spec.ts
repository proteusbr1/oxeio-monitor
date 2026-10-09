import { describe, expect, it, vi } from 'vitest';

import {
  datesToRecount,
  markDirty,
  policyRecountDates,
} from '../src/summary/recount';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('datesToRecount — the open months after a measure change', () => {
  it('from the first of last month through today', () => {
    const dates = datesToRecount(d('2026-10-09'));
    expect(dates[0]).toEqual(d('2026-09-01'));
    expect(dates[dates.length - 1]).toEqual(d('2026-10-09'));
    expect(dates).toHaveLength(30 + 9);
  });

  it('crosses the year', () => {
    expect(datesToRecount(d('2027-01-02'))[0]).toEqual(d('2026-12-01'));
  });
});

describe('policyRecountDates — a policy change never re-credits a frozen pay period', () => {
  const fake = (endDate: Date | null) => ({
    payPeriod: {
      findFirst: vi.fn().mockResolvedValue(endDate ? { endDate } : null),
    },
  });

  it('with a period frozen through 25 September, a change on 9 October counts 26 September on', async () => {
    const dates = await policyRecountDates(
      fake(d('2026-09-25')),
      d('2026-10-09'),
    );
    expect(dates[0]).toEqual(d('2026-09-26'));
    expect(dates[dates.length - 1]).toEqual(d('2026-10-09'));
    expect(dates).toHaveLength(5 + 9);
  });

  it('a frozen period older than last month changes nothing', async () => {
    expect(
      await policyRecountDates(fake(d('2026-08-25')), d('2026-10-09')),
    ).toEqual(datesToRecount(d('2026-10-09')));
  });

  it('no frozen period: the open months, as before', async () => {
    expect(await policyRecountDates(fake(null), d('2026-10-09'))).toEqual(
      datesToRecount(d('2026-10-09')),
    );
  });
});

describe('markDirty — queueing days for the dirty drain', () => {
  const fake = () => {
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    return { prisma: { summaryDirty: { createMany } }, createMany };
  };
  /** 12:00 local on 2026-10-09 in the test zone (UTC+6) */
  const now = new Date('2026-10-09T06:00:00Z');

  it('queues the days up to today, once each, skipping ones already queued', async () => {
    const { prisma, createMany } = fake();
    await markDirty(
      prisma,
      [d('2026-10-05'), d('2026-10-09'), d('2026-10-05'), d('2026-10-10')],
      now,
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [{ workDate: d('2026-10-05') }, { workDate: d('2026-10-09') }],
      skipDuplicates: true,
    });
  });

  it('a future day has nothing to count yet: no query at all', async () => {
    const { prisma, createMany } = fake();
    await markDirty(prisma, [d('2026-12-24')], now);
    await markDirty(prisma, [], now);
    expect(createMany).not.toHaveBeenCalled();
  });
});
