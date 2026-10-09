import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  delete process.env.DIGEST_EMAIL_TO;
  delete process.env.ALERT_EMAIL_TO;
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const put = (body: object) =>
  owner.http
    .put('/api/v1/settings/mail-recipients')
    .set('X-CSRF-Token', owner.csrf)
    .send(body);

describe('recipients per kind of email', () => {
  it('by default every kind goes to the owners', async () => {
    const res = await owner.http
      .get('/api/v1/settings/mail-recipients')
      .expect(200);
    for (const k of res.body.kinds) expect(k.effective).toEqual([OWNER_EMAIL]);
  });

  it('a saved list replaces the owners for that kind only', async () => {
    const res = await put({
      dailyDigest: ['Boss@x.test', 'boss@x.test'],
    }).expect(200);
    const byKind = Object.fromEntries(
      res.body.kinds.map((k: { kind: string; effective: string[] }) => [
        k.kind,
        k.effective,
      ]),
    );
    expect(byKind.dailyDigest).toEqual(['Boss@x.test']);
    expect(byKind.alerts).toEqual([OWNER_EMAIL]);
  });

  it('a bad address is a 400 naming it', async () => {
    const res = await put({ alerts: ['nope'] }).expect(400);
    expect(JSON.stringify(res.body)).toContain('nope');
  });
});
