import { describe, expect, it } from 'vitest';

import { datesToRecount } from '../src/summary/recount';

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
