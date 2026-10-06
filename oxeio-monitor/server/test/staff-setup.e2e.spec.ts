import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  hashPassword,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
  uniqueSuffix,
} from './setup/harness';

/**
 * The "Setup" column of the Staff screen: who is ready for the agent to be installed.
 *
 * Why it was needed: before the 15-person rollout, the owner needs to know
 * whose portal account has been opened and whose has not. The response used
 * not to carry that information, so the only way to find out was to click
 * every row. If someone was missed, it would be found while standing at that
 * PC, when the employee could not sign in: the worst possible moment.
 *
 * These tests deliberately create real rows (users, devices): the real
 * question is whether the two `_count` values come from the right place.
 */
let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const rowFor = async (empCode: string) => {
  const res = await owner.http.get('/api/v1/employees?status=all').expect(200);
  return (res.body.rows as Record<string, unknown>[]).find(
    (r) => r.empCode === empCode,
  ) as { hasPortalAccount: boolean; hasDevice: boolean; agentSwitchedOff: boolean };
};

describe('GET /employees/next-code', () => {
  const next = async (): Promise<string> => {
    const res = await owner.http.get('/api/v1/employees/next-code').expect(200);
    return (res.body as { code: string }).code;
  };

  /**
   * This test is the most important: the route order.
   *
   * Nest matches routes from top to bottom, so if `@Get('next-code')` sat
   * below `@Get(':id')`, `next-code` would be taken as `:id` and
   * `ParseIntPipe` would give 400 with the message "Validation failed (numeric
   * string is expected)", which makes the real cause hard to see.
   */
  it('the route does not fall into the :id trap', async () => {
    const code = await next();
    expect(code).toMatch(/^[A-Za-z_]+-\d+$/);
  });

  it('OX-001 when there is nobody', async () => {
    expect(await next()).toBe('OX-001');
  });

  it('gives the one after the largest code', async () => {
    await createEmployeeWithCode(h.prisma, 'OX-01');
    await createEmployeeWithCode(h.prisma, 'OX-07');

    expect(await next()).toBe('OX-08');
  });

  /**
   * An inactive employee's code is counted too. If it were not, a dismissed
   * person's code would be suggested again and saving would give 409, while
   * nobody with that code was visible on screen (under the active filter), so
   * the reason could not be understood.
   */
  it('an inactive employee\'s code is counted too', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma, 'OX-09');
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { status: 'inactive' },
    });

    expect(await next()).toBe('OX-10');
  });

  /**
   * The code shown in advance is the one that really gets assigned: that is the real claim.
   *
   * The code is not sent; the server assigns it itself. So this also shows
   * that the prediction and reality are the same.
   */
  it('the code shown in advance is the one assigned on save', async () => {
    await createEmployeeWithCode(h.prisma, 'OX-01');

    const code = await next();
    const res = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Notun Kormi' });

    expect(res.status).toBe(201);
    expect(res.body.empCode).toBe(code);
  });

  /** A manager also sees the add-employee screen, so they need it too */
  it('a manager gets it too', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/employees/next-code').expect(200);
  });
});

/**
 * The system assigns the employee code, nobody can change it.
 *
 * Why these tests: the code is a person's identity: it is what is written in
 * reports, Excel, payroll sheets and printed paper. Letting people set it by
 * hand had two dangers: typos (`OX-007` vs `OX-07`, both happened in real
 * data), and changing it midway, so old paper and the new screen would say
 * two different things.
 *
 * On screen the field is `disabled`, but the real guard is here, so that even
 * a request sent directly through DevTools cannot get in.
 */
describe('employee code: in the system\'s hands', () => {
  // The global `beforeEach` above already wipes the database and logs the owner in

  it('an employee is created even without a code, and a code is assigned', async () => {
    const res = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Kono Code Chara' });

    expect(res.status).toBe(201);
    expect(res.body.empCode).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(res.body.empCode.length).toBeGreaterThan(0);
  });

  /**
   * 400, not silently ignored: `forbidNonWhitelisted`. "I sent it but it did
   * not take" is the most dangerous state for this field, because people
   * recognise the code by eye and would assume that is what was set.
   */
  it('sending a code at creation gives 400', async () => {
    const res = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ empCode: 'MY-OWN-99', fullName: 'Nijer Code' });

    expect(res.status).toBe(400);
  });

  it('trying to change the code on edit gives 400, and the code stays intact', async () => {
    const created = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Age Jini Chilen' })
      .expect(201);

    const before: string = created.body.empCode;

    await owner.http
      .patch(`/api/v1/employees/${created.body.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ empCode: 'BODLE-DILAM' })
      .expect(400);

    const after = await owner.http
      .get(`/api/v1/employees/${created.body.id}`)
      .expect(200);

    expect(after.body.empCode).toBe(before);
  });

  /** Adding several in a row advances the code: the same code is never assigned twice */
  it('three added in a row get three different codes', async () => {
    const codes: string[] = [];

    for (const name of ['Ek', 'Dui', 'Tin']) {
      const res = await owner.http
        .post('/api/v1/employees')
        .set('X-CSRF-Token', owner.csrf)
        .send({ fullName: name })
        .expect(201);
      codes.push(res.body.empCode);
    }

    expect(new Set(codes).size).toBe(3);
  });
});

describe('receiving tasks', () => {
  it('off by default; can be switched on with an own daily target, and back', async () => {
    const created = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Task Person', designation: 'Clerk' })
      .expect(201);
    expect(created.body).toMatchObject({ receivesTasks: false, dailyTaskTarget: null, designation: 'Clerk' });
    expect(created.body).not.toHaveProperty('staffType');

    const on = await owner.http
      .patch(`/api/v1/employees/${created.body.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ receivesTasks: true, dailyTaskTarget: 15 })
      .expect(200);
    expect(on.body).toMatchObject({ receivesTasks: true, dailyTaskTarget: 15 });

    const cleared = await owner.http
      .patch(`/api/v1/employees/${created.body.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ dailyTaskTarget: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ receivesTasks: true, dailyTaskTarget: null });
  });

  it('created with receivesTasks at once', async () => {
    const res = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Task Person Two', receivesTasks: true, dailyTaskTarget: 0 })
      .expect(201);
    expect(res.body).toMatchObject({ receivesTasks: true, dailyTaskTarget: 0 });
  });

  it('the old staffType field is refused', async () => {
    await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Old Field', staffType: 'manager' })
      .expect(400);
  });
});

describe('GET /employees: setup state', () => {
  it('a newly added employee has both false', async () => {
    await createEmployeeWithCode(h.prisma, 'SU-NEW');

    const row = await rowFor('SU-NEW');

    expect(row.hasPortalAccount).toBe(false);
    expect(row.hasDevice).toBe(false);
  });

  it('after the portal account is opened, the first is true', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma, 'SU-LOGIN');

    await h.prisma.user.create({
      data: {
        email: 'su-login@test.local',
        passwordHash: await hashPassword('whatever-123'),
        fullName: 'Rakib Hasan',
        role: 'employee',
        employeeId,
      },
    });

    const row = await rowFor('SU-LOGIN');

    expect(row.hasPortalAccount).toBe(true);
    // the agent is not installed yet: the screen shows "Ready to install"
    expect(row.hasDevice).toBe(false);
  });

  it('when the agent enrolls, the second is true too', async () => {
    const { code } = await createEmployeeWithCode(h.prisma, 'SU-RUN');
    await enrollDevice(h, code);

    expect((await rowFor('SU-RUN')).hasDevice).toBe(true);
  });

  /**
   * A revoked device is not counted. Otherwise the old row of a dismissed
   * employee or a replaced PC would show "Running" forever, though not one
   * hour comes from that machine any more, and the owner would think all is well.
   */
  it('a revoked device is no longer counted', async () => {
    const { code } = await createEmployeeWithCode(h.prisma, 'SU-REVOKED');
    const device = await enrollDevice(h, code);

    await h.prisma.device.update({
      where: { id: device.deviceId },
      data: { status: 'revoked' },
    });

    expect((await rowFor('SU-REVOKED')).hasDevice).toBe(false);
  });

  /**
   * "Never installed" and "switched off" are two different states.
   *
   * `hasDevice` is false in both, but what to do is completely different: one
   * needs a trip to the PC to install the MSI, the other a single click on
   * the row. Without telling them apart, the owner would go to reinstall for
   * an agent that had merely been switched off.
   */
  it('with a revoked device, agentSwitchedOff is true', async () => {
    const { code } = await createEmployeeWithCode(h.prisma, 'SU-OFF');
    const device = await enrollDevice(h, code);

    await h.prisma.device.update({
      where: { id: device.deviceId },
      data: { status: 'revoked' },
    });

    const row = await rowFor('SU-OFF');
    expect(row.hasDevice).toBe(false);
    expect(row.agentSwitchedOff).toBe(true);
  });

  it('with no device ever, agentSwitchedOff is false', async () => {
    await createEmployeeWithCode(h.prisma, 'SU-NEVER');

    expect((await rowFor('SU-NEVER')).agentSwitchedOff).toBe(false);
  });

  /**
   * If even one is active it is not "off": the desktop is revoked, the laptop is on.
   *
   * The second device is inserted directly, not through `enrollDevice`: an
   * enrollment code is single-use, and a second use gives 401.
   */
  it('with an active device, agentSwitchedOff is false', async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'SU-MIX');
    await enrollDevice(h, code);

    await h.prisma.device.create({
      data: {
        hostname: 'OLD-DESKTOP',
        windowsUsername: 'someone',
        employeeId,
        machineGuid: `mix-${uniqueSuffix()}`,
        tokenHash: 'not-a-real-token',
        status: 'revoked',
      },
    });

    const row = await rowFor('SU-MIX');
    expect(row.hasDevice).toBe(true);
    expect(row.agentSwitchedOff).toBe(false);
  });

  /**
   * A manager sees this column too: installing the agent is their job as
   * well. `_count` yields only yes/no, not the user's email or the device's
   * token, so nothing extra leaks.
   */
  it('nothing from inside the user or device goes into the response', async () => {
    const { code } = await createEmployeeWithCode(h.prisma, 'SU-LEAK');
    await enrollDevice(h, code);

    const res = await owner.http.get('/api/v1/employees?status=all').expect(200);
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain('_count');
  });
});

/**
 * A manager's access (the owner's decision).
 *
 * A manager can add and edit employees, and can fully run Holidays and
 * Categories. But not salary ([ADR-023](../../../docs/05-Options-Decisions.md)).
 *
 * The last two tests are the real ones: `redact.ts` strips the salary from
 * the manager's response, but that does not stop salary being sent to the
 * server. Without closing that gap, a manager could write into a field they
 * cannot read, and if they entered it wrong they could not see and catch it.
 */
describe('manager access', () => {
  let manager: Session;

  beforeEach(async () => {
    manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
  });

  it('can add employees', async () => {
    const res = await manager.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', manager.csrf)
      .send({ fullName: 'Manager Joge Korlen' });

    expect(res.status).toBe(201);
    // the salary field is not in the response at all: redact.ts
    expect(res.body.monthlySalary).toBeUndefined();
  });

  it('can edit employees', async () => {
    const created = await manager.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', manager.csrf)
      .send({ fullName: 'Age Naam' })
      .expect(201);

    await manager.http
      .patch(`/api/v1/employees/${created.body.id}`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ fullName: 'Pore Naam', department: 'Finance' })
      .expect(200);
  });

  it('can both read and write holidays and categories', async () => {
    await manager.http.get('/api/v1/holidays').expect(200);
    await manager.http.get('/api/v1/categories').expect(200);

    await manager.http
      .post('/api/v1/holidays')
      .set('X-CSRF-Token', manager.csrf)
      .send({ holidayDate: '2026-12-25', name: 'Boro Din' })
      .expect(201);

    await manager.http
      .post('/api/v1/categories')
      .set('X-CSRF-Token', manager.csrf)
      .send({
        matchType: 'domain',
        pattern: 'figma.com',
        displayName: 'Figma',
        category: 'productive',
      })
      .expect(201);
  });

  /** deactivate, portal account, audit: these belong to the owner only */
  it('cannot deactivate', async () => {
    const created = await manager.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', manager.csrf)
      .send({ fullName: 'Keu Ekjon' })
      .expect(201);

    await manager.http
      .post(`/api/v1/employees/${created.body.id}/deactivate`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ reason: 'cheshta korchi' })
      .expect(403);

    await manager.http.get('/api/v1/audit-log').expect(403);
  });

  it('sending a salary when adding an employee gives 403', async () => {
    const res = await manager.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', manager.csrf)
      .send({ fullName: 'Beton Soho', monthlySalary: '99000' });

    expect(res.status).toBe(403);
    // the employee was not created either: it does not save quietly with the salary dropped
    const list = await owner.http.get('/api/v1/employees').expect(200);
    expect(
      (list.body.rows as { fullName: string }[]).some(
        (r) => r.fullName === 'Beton Soho',
      ),
    ).toBe(false);
  });

  it('sending a salary on edit gives 403, and the salary stays intact', async () => {
    const created = await owner.http
      .post('/api/v1/employees')
      .set('X-CSRF-Token', owner.csrf)
      .send({ fullName: 'Beton Ache', monthlySalary: '15000' })
      .expect(201);

    await manager.http
      .patch(`/api/v1/employees/${created.body.id}`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ monthlySalary: '99000' })
      .expect(403);

    // sending `null` to erase it is also touching the salary: also forbidden
    await manager.http
      .patch(`/api/v1/employees/${created.body.id}`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ monthlySalary: null })
      .expect(403);

    const after = await owner.http
      .get(`/api/v1/employees/${created.body.id}`)
      .expect(200);
    expect(after.body.monthlySalary).toBe('15000.00');
  });
});
