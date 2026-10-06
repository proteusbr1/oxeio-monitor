import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HolidaysService } from '../src/calendar/holidays.service';
import { publicHolidays } from '../src/calendar/public-holidays';
import {
  createHarness,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/** what date.nager.at returns, trimmed to the fields used */
const BR_2027 = [
  { date: '2027-01-01', localName: 'Confraternização Universal', name: "New Year's Day", global: true, types: ['Public'] },
  { date: '2027-01-25', localName: 'Aniversário de São Paulo', name: 'São Paulo Anniversary', global: false, types: ['Public'] },
  { date: '2027-02-08', localName: 'Carnaval', name: 'Carnival', global: true, types: ['Optional'] },
  { date: '2027-04-21', localName: 'Tiradentes', name: 'Tiradentes', global: true, types: ['Public'] },
  { date: '2027-04-21', localName: 'Outro', name: 'Other', global: true, types: ['Public'] },
  { date: '2027-12-25', localName: 'Natal', name: 'Christmas Day', global: true, types: ['Public'] },
];

const fakeFetch = (rows: unknown, status = 200): typeof fetch =>
  (async () => new Response(status === 204 ? null : JSON.stringify(rows), { status })) as unknown as typeof fetch;

describe('publicHolidays — what is taken from the calendar', () => {
  it('only nationwide public holidays, one per day, local name with the English one', async () => {
    const { holidays, problems } = await publicHolidays('br', 2027, fakeFetch(BR_2027));
    expect(holidays.map((h) => h.entry.date)).toEqual(['2027-01-01', '2027-04-21', '2027-12-25']);
    expect(holidays[0].entry.name).toBe("Confraternização Universal (New Year's Day)");
    expect(holidays[1].entry.name).toBe('Tiradentes');
    expect(holidays.every((h) => h.type === 'public' && !h.entry.approximate)).toBe(true);
    expect(problems.join(' ')).toMatch(/2027-04-21: two holidays on one day/);
  });

  it('refuses a bad country or year before asking anyone', async () => {
    await expect(publicHolidays('Brazil', 2027, fakeFetch([]))).rejects.toThrow(/two-letter/);
    await expect(publicHolidays('BR', 1990, fakeFetch([]))).rejects.toThrow(/2000 and 2100/);
  });

  it('a country the calendar does not know is said plainly', async () => {
    const { holidays, problems } = await publicHolidays('XX', 2027, fakeFetch(null, 404));
    expect(holidays).toEqual([]);
    expect(problems[0]).toMatch(/no public holidays for XX in 2027/);
  });

  it('an unreachable calendar is said plainly', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(publicHolidays('BR', 2027, down)).rejects.toThrow(/could not be reached/);
  });
});

describe('importing them', () => {
  let h: Harness;
  let owner: Session;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await resetDatabase(h.prisma, h.app);
    owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
  });

  const actor = async () => {
    const user = await h.prisma.user.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
    return { userId: user.id, email: user.email, role: user.role, employeeId: null, mustChangePw: false } as never;
  };

  it('preview first, then writes; dates already there are left alone', async () => {
    await h.prisma.holiday.create({ data: { holidayDate: new Date('2027-12-25T00:00:00Z'), name: 'Christmas (ours)', type: 'company' } });
    const service = h.app.get(HolidaysService);
    const now = new Date('2026-10-06T12:00:00Z');

    const preview = await service.importPublic(await actor(), { country: 'BR', year: 2027, allowPast: false, dryRun: true }, '127.0.0.1', now, fakeFetch(BR_2027));
    expect(preview.add.map((r) => r.date)).toEqual(['2027-01-01', '2027-04-21']);
    expect(preview.existing.map((r) => r.date)).toEqual(['2027-12-25']);
    expect(await h.prisma.holiday.count()).toBe(1);

    const done = await service.importPublic(await actor(), { country: 'BR', year: 2027, allowPast: false, dryRun: false }, '127.0.0.1', now, fakeFetch(BR_2027));
    expect(done.created).toBe(2);
    const christmas = await h.prisma.holiday.findFirstOrThrow({ where: { holidayDate: new Date('2027-12-25T00:00:00Z') } });
    expect(christmas.name).toBe('Christmas (ours)');
  });

  it('past and current months are left out unless asked', async () => {
    const service = h.app.get(HolidaysService);
    const plan = await service.importPublic(await actor(), { country: 'BR', year: 2027, allowPast: false, dryRun: true }, '127.0.0.1', new Date('2027-05-10T12:00:00Z'), fakeFetch(BR_2027));
    expect(plan.pastMonths.map((r) => r.date)).toEqual(['2027-01-01', '2027-04-21']);
    expect(plan.add.map((r) => r.date)).toEqual(['2027-12-25']);
  });

  it('the endpoint validates the country', async () => {
    const res = await owner.http.post('/api/v1/holidays/public').set('X-CSRF-Token', owner.csrf).send({ country: 'Brazil', year: 2027 }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/two-letter/);
  });
});
