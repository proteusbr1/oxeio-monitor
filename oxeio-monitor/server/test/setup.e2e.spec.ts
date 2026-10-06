import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultWorkRules, checkWorkRules } from '../src/setup/setup.rules';
import { createHarness, resetDatabase, type Harness } from './setup/harness';

describe('defaultWorkRules — a starting point per country', () => {
  it('Saturday + Sunday off for most countries, 8-hour days', () => {
    expect(defaultWorkRules('BR')).toEqual({ monthlyTargetHours: 176, expectedWorkdays: 22, weeklyOffDays: [6, 7] });
    expect(defaultWorkRules(null).weeklyOffDays).toEqual([6, 7]);
  });

  it('the local weekend where it differs', () => {
    expect(defaultWorkRules('SA').weeklyOffDays).toEqual([5, 6]);
    // a one-day weekend: six 8-hour days a week, in any case of the code
    expect(defaultWorkRules('ir')).toEqual({ monthlyTargetHours: 208, expectedWorkdays: 26, weeklyOffDays: [5] });
  });

  it('refuses a week without a working day', () => {
    expect(() => checkWorkRules({ weeklyOffDays: [1, 2, 3, 4, 5, 6, 7] }, defaultWorkRules('BR'))).toThrow(/working day/);
  });
});

describe('first-run setup wizard', () => {
  let h: Harness;
  const TOKEN = 'test-setup-token-0123456789';

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    vi.stubEnv('SETUP_TOKEN', TOKEN);
    await resetDatabase(h.prisma, h.app);
    // a fresh install: nobody yet, no policy, no categories
    await h.prisma.user.deleteMany();
  });
  afterEach(() => vi.unstubAllEnvs());

  const body = (over: Record<string, unknown> = {}) => ({
    token: TOKEN,
    organizationName: '  Clínica Exemplo  ',
    country: 'br',
    timeZone: 'America/Sao_Paulo',
    currency: 'BRL',
    displayLocale: 'pt-BR',
    ownerName: 'Ana Souza',
    ownerEmail: 'Ana@Example.com',
    ownerPassword: 'a-long-password-123',
    importHolidays: false,
    ...over,
  });

  it('says it is needed, and shows the company name for the login page', async () => {
    const res = await request(h.app.getHttpServer()).get('/api/v1/setup/status').expect(200);
    expect(res.body).toEqual({ needed: true, organizationName: expect.any(String) });
  });

  it('refuses without the token from the server log', async () => {
    await request(h.app.getHttpServer()).post('/api/v1/setup').send(body({ token: 'guess' })).expect(403);
    expect(await h.prisma.user.count()).toBe(0);
  });

  it('sets everything up and signs the owner in', async () => {
    const agent = request.agent(h.app.getHttpServer());
    const res = await agent.post('/api/v1/setup').send(body()).expect(200);
    expect(res.body.restartNeeded).toBe(true); // tests run on Etc/GMT-6

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: 'ana@example.com', role: 'owner', mustChangePassword: false });

    const region = await h.prisma.setting.findUniqueOrThrow({ where: { key: 'region' } });
    expect(region.value).toMatchObject({ timeZone: 'America/Sao_Paulo', currency: 'BRL', displayLocale: 'pt-BR' });
    const org = await h.prisma.setting.findUniqueOrThrow({ where: { key: 'organization' } });
    expect(org.value).toEqual({ name: 'Clínica Exemplo', country: 'BR' });

    expect(await h.prisma.appCategory.count()).toBeGreaterThan(50);
    // the original company's own modules start off on a new install
    const features = await agent.get('/api/v1/features').expect(200);
    expect(features.body).toMatchObject({ payroll: true, deposits: false, screenshots: true, appTracking: true, tasks: false });
    const status = await request(h.app.getHttpServer()).get('/api/v1/setup/status').expect(200);
    expect(status.body).toEqual({ needed: false, organizationName: 'Clínica Exemplo' });
  });

  it('creates the work policy from the country defaults when there is none', async () => {
    await h.prisma.employee.updateMany({ data: { policyId: null } });
    await h.prisma.workPolicy.deleteMany();
    await request(h.app.getHttpServer()).post('/api/v1/setup').send(body()).expect(200);
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    expect({
      hours: Number(policy.monthlyTargetHours),
      days: policy.expectedWorkdays,
      off: policy.weeklyOffDays,
      zone: policy.timezone,
    }).toEqual({ hours: 176, days: 22, off: [6, 7], zone: 'America/Sao_Paulo' });
  });

  it('works only once', async () => {
    await request(h.app.getHttpServer()).post('/api/v1/setup').send(body()).expect(200);
    await request(h.app.getHttpServer()).post('/api/v1/setup').send(body({ ownerEmail: 'b@example.com' })).expect(409);
    expect(await h.prisma.user.count({ where: { role: 'owner' } })).toBe(1);
  });

  it('refuses an unknown time zone, a short password, a bad country', async () => {
    const res = await request(h.app.getHttpServer()).post('/api/v1/setup').send(body({ timeZone: 'Mars/Base' })).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/IANA/);
    await request(h.app.getHttpServer()).post('/api/v1/setup').send(body({ ownerPassword: 'short' })).expect(400);
    await request(h.app.getHttpServer()).post('/api/v1/setup').send(body({ country: 'Brazil' })).expect(400);
    expect(await h.prisma.user.count()).toBe(0);
  });
});
