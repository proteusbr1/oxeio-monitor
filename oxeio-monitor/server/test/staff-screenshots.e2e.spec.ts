import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { formatWorkDate } from '../src/screenshots/gallery.math';
import {
  createHarness,
  workNoon,
  hashPassword,
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
 * Who sees whose screenshots — and the owner's switch that hides staff's own
 * pictures from them (Settings → Modules › "Screenshots for staff").
 */
let h: Harness;
let owner: Session;
let today: string;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

/** a person with a PC, one picture today, and a login with this role */
async function person(code: string, role: 'employee' | 'researcher' | null) {
  const employee = await h.prisma.employee.create({
    data: { empCode: code, fullName: code, status: 'active' },
  });
  const device = await h.prisma.device.create({
    data: {
      hostname: `PC-${code}`,
      windowsUsername: 'u',
      employeeId: employee.id,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: 'active',
    },
  });
  const when = workNoon();
  const uuid = randomUUID();
  await h.prisma.screenshot.create({
    data: {
      employeeId: employee.id,
      deviceId: device.id,
      clientUuid: uuid,
      workDate: workDateOf(when),
      slotStart: when,
      capturedAt: when,
      monitorIndex: 0,
      filePath: `x/${uuid}.webp`,
      thumbPath: `x/${uuid}.thumb.webp`,
    },
  });

  let session: Session | null = null;
  if (role) {
    const email = `${code.toLowerCase()}@test.local`;
    await h.prisma.user.create({
      data: {
        email,
        fullName: code,
        passwordHash: await hashPassword('staff-password-123'),
        role,
        employeeId: employee.id,
        mustChangePw: false,
      },
    });
    session = await loginReady(h, email, 'staff-password-123');
  }
  return { id: employee.id, session };
}

const ids = (body: { items: { employeeId: number }[] }) =>
  body.items.map((i) => i.employeeId).sort();

const setStaffScreenshots = (on: boolean) =>
  owner.http
    .patch('/api/v1/settings/privacy')
    .set('X-CSRF-Token', owner.csrf)
    .send({ staffSeeOwnScreenshots: on })
    .expect(200);

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
  today = formatWorkDate(workDateOf(workNoon()));
});

describe('a researcher sees only their own pictures', () => {
  it('in "latest per person" too, not everyone\'s', async () => {
    const other = await person('OX-OTHER', null);
    const me = await person('OX-RES', 'researcher');

    const latest = await me.session!.http.get('/api/v1/screenshots/latest').expect(200);
    expect(ids(latest.body)).toEqual([me.id]);
    expect(ids(latest.body)).not.toContain(other.id);

    const gallery = await me.session!.http
      .get(`/api/v1/screenshots?date=${today}`)
      .expect(200);
    expect(ids(gallery.body)).toEqual([me.id]);
  });

  it('and cannot ask for someone else\'s', async () => {
    const other = await person('OX-OTHER', null);
    const me = await person('OX-RES', 'researcher');
    await me.session!.http
      .get(`/api/v1/screenshots?date=${today}&employeeId=${other.id}`)
      .expect(403);
  });
});

describe('Screenshots for staff — on (the default)', () => {
  it('staff see their own pictures, as before', async () => {
    const me = await person('OX-EMP', 'employee');
    const res = await me.session!.http.get(`/api/v1/screenshots?date=${today}`).expect(200);
    expect(ids(res.body)).toEqual([me.id]);
  });
});

describe('Screenshots for staff — off', () => {
  it('staff and researchers no longer see their own pictures', async () => {
    const emp = await person('OX-EMP', 'employee');
    const res = await person('OX-RES', 'researcher');
    await setStaffScreenshots(false);

    for (const session of [emp.session!, res.session!]) {
      const gallery = await session.http.get(`/api/v1/screenshots?date=${today}`).expect(403);
      expect(gallery.body.message).toMatch(/not shown to staff/);
      await session.http.get('/api/v1/screenshots/latest').expect(403);
    }
  });

  it('the owner and managers still see everyone', async () => {
    const emp = await person('OX-EMP', 'employee');
    await setStaffScreenshots(false);

    const ownerView = await owner.http.get('/api/v1/screenshots/latest').expect(200);
    expect(ids(ownerView.body)).toEqual([emp.id]);

    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    const managerView = await manager.http
      .get(`/api/v1/screenshots?date=${today}`)
      .expect(200);
    expect(ids(managerView.body)).toEqual([emp.id]);
  });

  it('pictures are still kept — turning it back on shows them again', async () => {
    const emp = await person('OX-EMP', 'employee');
    await setStaffScreenshots(false);
    await emp.session!.http.get(`/api/v1/screenshots?date=${today}`).expect(403);

    await setStaffScreenshots(true);
    const res = await emp.session!.http.get(`/api/v1/screenshots?date=${today}`).expect(200);
    expect(ids(res.body)).toEqual([emp.id]);
  });
});
