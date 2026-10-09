import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

let h: Harness;
let owner: Session;
const saved = { ...process.env };

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  process.env = saved;
  await h.close();
});
beforeEach(async () => {
  delete process.env.SMTP_HOST;
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const patch = (s: Session, body: object) =>
  s.http.patch('/api/v1/settings/smtp').set('X-CSRF-Token', s.csrf).send(body);
const testMail = (s: Session) =>
  s.http
    .post('/api/v1/settings/smtp/test')
    .set('X-CSRF-Token', s.csrf)
    .send({});

describe('SMTP on screen', () => {
  it('starts off; a save applies and never returns the password', async () => {
    expect(
      (await owner.http.get('/api/v1/settings/smtp').expect(200)).body,
    ).toMatchObject({ configured: false, source: 'none' });

    const res = await patch(owner, {
      host: 'smtp.example.test',
      port: 587,
      user: 'u',
      pass: 'top-secret',
      from: 'Team <t@example.test>',
    }).expect(200);
    expect(res.body).toMatchObject({
      configured: true,
      source: 'database',
      host: 'smtp.example.test',
      passwordSet: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('top-secret');
  });

  it('saving again with an empty password keeps the stored one', async () => {
    await patch(owner, {
      host: 'a.test',
      port: 587,
      user: 'u',
      pass: 'kept',
    }).expect(200);
    await patch(owner, {
      host: 'b.test',
      port: 587,
      user: 'u',
      pass: '',
    }).expect(200);
    const row = await h.prisma.setting.findUniqueOrThrow({
      where: { key: 'smtp' },
    });
    expect(row.value).toMatchObject({ host: 'b.test', pass: 'kept' });
  });

  it('the audit log records the change without the password', async () => {
    await patch(owner, {
      host: 'a.test',
      port: 587,
      pass: 'never-logged',
    }).expect(200);
    const audit = await h.prisma.auditLog.findMany({
      where: { targetId: 'smtp' },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('never-logged');
  });

  it('a bad port is a 400 with a reason', async () => {
    const res = await patch(owner, { host: 'a.test', port: 0 }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/port/);
  });

  it('a user without a password is refused on an install that only has the .env', async () => {
    process.env.SMTP_HOST = 'env.example.test';
    const res = await patch(owner, {
      host: 'a.test',
      port: 587,
      user: 'u',
      pass: '',
    }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/SMTP password/);
    expect(
      await h.prisma.setting.findUnique({ where: { key: 'smtp' } }),
    ).toBeNull();
  });

  it('"Use the .env value" forgets the screen', async () => {
    process.env.SMTP_HOST = 'env.example.test';
    await patch(owner, { host: 'a.test', port: 587 }).expect(200);
    await owner.http
      .delete('/api/v1/settings/env/smtp')
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);
    expect(
      (await owner.http.get('/api/v1/settings/smtp').expect(200)).body,
    ).toMatchObject({ source: 'env', host: 'env.example.test' });
  });

  it('test email: not configured when nothing is set', async () => {
    const res = await testMail(owner).expect(201);
    expect(res.body).toMatchObject({
      outcome: 'not_configured',
      to: OWNER_EMAIL,
    });
  });

  it('test email: an unreachable server answers with its error text, not a 500', async () => {
    await patch(owner, { host: '127.0.0.1', port: 1 }).expect(200);
    const res = await testMail(owner).expect(201);
    expect(res.body.outcome).toBe('failed');
    expect(res.body.to).toBe(OWNER_EMAIL);
    expect(typeof res.body.error).toBe('string');
  });

  it('managers cannot read or change it', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/smtp').expect(403);
    await patch(manager, { host: 'a.test', port: 587 }).expect(403);
  });
});
