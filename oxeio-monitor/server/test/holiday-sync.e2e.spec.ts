import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HolidaySyncService } from '../src/calendar/holiday-sync.service';
import { publicHolidays } from '../src/calendar/public-holidays';
import { ORGANIZATION_SETTING_KEY } from '../src/settings/organization';
import { AppSettingsService } from '../src/settings/app-settings.service';
import {
  createHarness,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * Brazil's national calendar from BrasilAPI, and the nightly automatic update
 * that keeps this year and next imported without anyone pressing a button.
 */

/** what brasilapi.com.br returns, trimmed */
const BRASIL_2027 = [
  { date: '2027-01-01', name: 'Confraternização mundial', type: 'national' },
  { date: '2027-02-08', name: 'Carnaval', type: 'national' },
  { date: '2027-04-21', name: 'Tiradentes', type: 'national' },
  { date: '2027-12-25', name: 'Natal', type: 'national' },
];
const NAGER_BR_2027 = [
  { date: '2027-01-01', localName: 'Confraternização Universal', name: "New Year's Day", global: true, types: ['Public'] },
  { date: '2027-02-08', localName: 'Carnaval', name: 'Carnival', global: true, types: ['Optional'] },
];

/** a fetch that answers by URL; `null` = the host is down */
const routes =
  (table: Record<string, unknown | null>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(table).find((k) => url.includes(k));
    if (key === undefined) return new Response(null, { status: 404 });
    if (table[key] === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(table[key]), { status: 200 });
  }) as unknown as typeof fetch;

describe('publicHolidays — Brazil', () => {
  it('comes from BrasilAPI, Carnaval included', async () => {
    const { holidays } = await publicHolidays('BR', 2027, routes({ 'feriados/v1/2027': BRASIL_2027 }));
    expect(holidays.map((h) => [h.entry.date, h.entry.name])).toEqual([
      ['2027-01-01', 'Confraternização mundial'],
      ['2027-02-08', 'Carnaval'],
      ['2027-04-21', 'Tiradentes'],
      ['2027-12-25', 'Natal'],
    ]);
  });

  it('falls back to Nager.Date when BrasilAPI is down', async () => {
    const { holidays } = await publicHolidays(
      'BR',
      2027,
      routes({ 'feriados/v1/2027': null, 'PublicHolidays/2027/BR': NAGER_BR_2027 }),
    );
    expect(holidays.map((h) => h.entry.date)).toEqual(['2027-01-01']);
  });
});

describe('automatic update', () => {
  let h: Harness;
  let owner: Session;
  let sync: HolidaySyncService;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await resetDatabase(h.prisma, h.app);
    owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    sync = h.app.get(HolidaySyncService);
    await h.prisma.setting.create({ data: { key: ORGANIZATION_SETTING_KEY, value: { name: 'Clínica', country: 'BR' } } });
    h.app.get(AppSettingsService).forget();
  });

  const enable = async () => {
    await h.prisma.setting.create({ data: { key: 'holidays.auto', value: { enabled: true } } });
  };
  const dates = async () =>
    (await h.prisma.holiday.findMany({ orderBy: { holidayDate: 'asc' } })).map((r) => r.holidayDate.toISOString().slice(0, 10));

  const BRASIL_2026 = [
    { date: '2026-10-12', name: 'Nossa Senhora Aparecida', type: 'national' },
    { date: '2026-11-20', name: 'Dia da consciência negra', type: 'national' },
    { date: '2026-12-25', name: 'Natal', type: 'national' },
  ];
  const both = routes({ 'feriados/v1/2026': BRASIL_2026, 'feriados/v1/2027': BRASIL_2027 });
  const now = new Date('2026-10-06T12:00:00Z');

  it('off by default: nothing happens', async () => {
    await sync.runOnce(now, both);
    expect(await dates()).toEqual([]);
    expect((await sync.view()).enabled).toBe(false);
  });

  it('imports this year and next, never into this month or an earlier one', async () => {
    await enable();
    const view = await sync.runOnce(now, both);

    // 12 October is in the current month: left out, as a manual import would
    expect(await dates()).toEqual(['2026-11-20', '2026-12-25', '2027-01-01', '2027-02-08', '2027-04-21', '2027-12-25']);
    expect(view?.years).toEqual([2026, 2027]);
    expect(view?.lastResult).toMatch(/2026: 2 added · 2027: 4 added/);

    const audit = await h.prisma.auditLog.findMany({ where: { userId: null, action: 'change_setting' } });
    expect(audit).toHaveLength(2);
  });

  it('each year once: a holiday the owner deleted does not come back', async () => {
    await enable();
    await sync.runOnce(now, both);
    await h.prisma.holiday.deleteMany({ where: { holidayDate: new Date('2027-02-08T00:00:00Z') } });

    const again = await sync.runOnce(new Date('2026-11-06T12:00:00Z'), both);
    expect(await dates()).not.toContain('2027-02-08');
    expect(again?.lastResult).toMatch(/Up to date/);
  });

  it('next year is picked up when the year turns', async () => {
    await enable();
    await sync.runOnce(now, both);
    const later = await sync.runOnce(
      new Date('2027-01-10T12:00:00Z'),
      routes({ 'feriados/v1/2028': [{ date: '2028-04-21', name: 'Tiradentes', type: 'national' }] }),
    );
    expect(later?.years).toEqual([2026, 2027, 2028]);
    expect(await dates()).toContain('2028-04-21');
  });

  it('an unreachable calendar is retried the next night', async () => {
    await enable();
    const down = routes({ 'feriados/v1': null, PublicHolidays: null });
    const first = await sync.runOnce(now, down);
    expect(first?.years).toEqual([]);
    expect(first?.lastResult).toMatch(/not reached/);

    const second = await sync.runOnce(now, both);
    expect(second?.years).toEqual([2026, 2027]);
  });

  it('the owner switches it on (audited); a manager can only look and update now', async () => {
    const res = await owner.http
      .patch('/api/v1/holidays/auto')
      .set('X-CSRF-Token', owner.csrf)
      .send({ enabled: false })
      .expect(200);
    expect(res.body).toMatchObject({ enabled: false, country: 'BR' });

    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/holidays/auto').expect(200);
    await manager.http.patch('/api/v1/holidays/auto').set('X-CSRF-Token', manager.csrf).send({ enabled: true }).expect(403);
    await manager.http.post('/api/v1/holidays/auto/run').set('X-CSRF-Token', manager.csrf).expect(200);
  });
});
