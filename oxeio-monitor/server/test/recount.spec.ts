import { describe, expect, it, vi } from 'vitest';

import { datesToRecount, markDirty } from '../src/summary/recount';

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
