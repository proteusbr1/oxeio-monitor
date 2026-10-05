import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HolidaysService } from '../src/admin/holidays.service';
import { ErrorReporter } from '../src/error-reporting/error-reporter.service';
import { ERROR_REPORTING_SETTING_KEY } from '../src/error-reporting/error-reporting.rules';
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
 * Sentry error reporting, against a fake Sentry that records what arrives —
 * so the test sees exactly what would leave the server.
 */
interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  event: Record<string, unknown>;
}

let h: Harness;
let owner: Session;
let sentry: Server;
let received: Received[];
let answer: number;
let dsn: string;

beforeAll(async () => {
  sentry = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      // envelope: header line, item header line, the event
      const event = JSON.parse(body.split('\n')[2] ?? '{}') as Record<string, unknown>;
      received.push({ path: req.url ?? '', headers: req.headers, event });
      res.statusCode = answer;
      res.end('{}');
    });
  });
  await new Promise<void>((done) => sentry.listen(0, '127.0.0.1', done));
  dsn = `http://publickey@127.0.0.1:${(sentry.address() as AddressInfo).port}/42`;
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
  await new Promise((done) => sentry.close(done));
});

beforeEach(async () => {
  received = [];
  answer = 200;
  await resetDatabase(h.prisma, h.app);
  await h.app.get(ErrorReporter).reload();
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

afterEach(() => vi.restoreAllMocks());

const save = (body: Record<string, unknown>) =>
  owner.http
    .patch('/api/v1/settings/error-reporting')
    .set('X-CSRF-Token', owner.csrf)
    .send(body);

const flush = () => h.app.get(ErrorReporter).flush();

/** GET /holidays answers 500 with this message */
const breakHolidays = (message: string) =>
  vi
    .spyOn(h.app.get(HolidaysService), 'list')
    .mockRejectedValue(new Error(message));

describe('off by default', () => {
  it('nothing set → off, and a server error sends nothing', async () => {
    const res = await owner.http.get('/api/v1/settings/error-reporting').expect(200);
    expect(res.body).toMatchObject({ enabled: false, dsn: null, source: 'default' });

    breakHolidays('db exploded');
    await owner.http.get('/api/v1/holidays').expect(500);
    await flush();
    expect(received).toHaveLength(0);
  });

  it('the test button says it is off', async () => {
    const res = await owner.http
      .post('/api/v1/settings/error-reporting/test')
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);
    expect(res.body).toMatchObject({ ok: false, message: expect.stringMatching(/off/) });
  });
});

describe('set on screen', () => {
  it('a DSN that is not one is refused', async () => {
    const res = await save({ dsn: 'https://sentry.io/' }).expect(400);
    expect(res.body.message).toMatch(/no key|project number/);
  });

  it('applies at once, and the test event arrives', async () => {
    const res = await save({ dsn, environment: 'staging' }).expect(200);
    expect(res.body).toMatchObject({ enabled: true, source: 'dashboard', environment: 'staging' });

    const test = await owner.http
      .post('/api/v1/settings/error-reporting/test')
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);
    expect(test.body.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].path).toMatch(/^\/api\/42\/envelope\//);
    expect(JSON.stringify(received[0].event)).toMatch(/oXeio test error/);
    expect(received[0].event.environment).toBe('staging');
  });

  it('a key Sentry refuses is said plainly', async () => {
    await save({ dsn }).expect(200);
    answer = 401;
    const test = await owner.http
      .post('/api/v1/settings/error-reporting/test')
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);
    expect(test.body).toMatchObject({ ok: false, message: expect.stringMatching(/refused the key/) });
  });

  it('clearing the DSN turns it off again', async () => {
    await save({ dsn }).expect(200);
    const res = await save({ dsn: '' }).expect(200);
    expect(res.body).toMatchObject({ enabled: false, source: 'default' });
  });

  it('the audit log keeps the host, never the key', async () => {
    await save({ dsn }).expect(200);
    const [row] = await h.prisma.auditLog.findMany({
      where: { targetId: ERROR_REPORTING_SETTING_KEY },
    });
    expect(JSON.stringify(row.meta)).toContain('127.0.0.1');
    expect(JSON.stringify(row.meta)).not.toContain('publickey');
  });

  it('only the owner sees or changes it', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/error-reporting').expect(403);
  });
});

describe('server errors', () => {
  beforeEach(async () => {
    await save({ dsn }).expect(200);
  });

  it('an unexpected 500 is reported with its route — and nothing personal', async () => {
    breakHolidays('lookup failed for rima@studio.com');
    const res = await owner.http.get('/api/v1/holidays?year=2026').expect(500);
    // the answer to the browser is what Nest always gave
    expect(res.body.message).toBe('Internal server error');
    await flush();

    expect(received).toHaveLength(1);
    const event = received[0].event;
    const text = JSON.stringify(event);
    expect(text).toContain('lookup failed for [email]');
    expect(text).not.toContain('rima@studio.com');
    expect(event.tags).toMatchObject({ source: 'server', method: 'GET' });
    expect(String((event.tags as Record<string, string>).route)).toMatch(/holidays/);
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.server_name).toBe('oxeio-api');
    expect(text).not.toContain('year=2026');
    expect(text).not.toMatch(/oxeio_(session|csrf)/i);
  });

  it('a 404 or a 403 is not a bug — not reported', async () => {
    await owner.http.get('/api/v1/holidays/does-not-exist-route').expect(404);
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/error-reporting').expect(403);
    await flush();
    expect(received).toHaveLength(0);
  });
});

describe('dashboard crashes', () => {
  const crash = (session: Session, path = '/staff/12?tab=x') =>
    session.http
      .post('/api/v1/error-reports')
      .set('X-CSRF-Token', session.csrf)
      .send({
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'name')",
        stack: 'TypeError: …\n    at StaffRow (https://oxeio.example/assets/index-abc.js:1:2345)',
        componentStack: '\n    at StaffRow\n    at Table',
        path,
      });

  it('not sent while dashboard reporting is off — the page still gets 204', async () => {
    await save({ dsn, browser: false }).expect(200);
    await crash(owner).expect(204);
    await flush();
    expect(received).toHaveLength(0);
  });

  it('sent when on, from anyone signed in, with the page as a pattern', async () => {
    await save({ dsn, browser: true }).expect(200);
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await crash(manager).expect(204);
    await flush();

    expect(received).toHaveLength(1);
    const event = received[0].event;
    expect(event.tags).toMatchObject({ source: 'browser', page: '/staff/:id', role: 'manager' });
    expect(JSON.stringify(event)).toContain("reading 'name'");
    expect(JSON.stringify(event)).not.toContain('tab=x');
  });

  it('a crash loop stops at 10 a minute per person', async () => {
    await save({ dsn, browser: true }).expect(200);
    for (let i = 0; i < 12; i++) await crash(owner).expect(204);
    await flush();
    expect(received).toHaveLength(10);
  });

  it('signed out cannot post', async () => {
    const { default: request } = await import('supertest');
    await request(h.app.getHttpServer())
      .post('/api/v1/error-reports')
      .send({ name: 'x', message: 'y', path: '/' })
      .expect(401);
  });
});
