import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  enrollDevice,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  workNoon,
  workTodayIso,
} from './setup/harness';

/**
 * Every new endpoint is called at least once over real HTTP.
 *
 * Seven modules were written in parallel, and nearly all their tests cover
 * pure functions — the maths is verified, but no endpoint was ever called.
 * What those tests would miss:
 *
 * - Two controllers claiming the same path (e.g. `/employees/:id`) — Express
 *   calls the first, and the second would stay silently dead forever
 * - A guard placed wrongly — a manager getting into an owner-only route
 * - A wrong Prisma query — the types are fine but it breaks when run
 * - A BigInt in a response — JSON.stringify throws and it becomes a 500
 *
 * Business correctness is not checked here — only that it runs and gives the
 * right answer to the right person. Whether the numbers are right is the job
 * of the .math specs.
 */

let h: Harness;
let employeeId: number;
let deviceId: number;

/** Any 2xx/4xx is fine, but a 5xx means the endpoint is broken */
const notServerError = (status: number, where: string) => {
  expect(status, `${where} → ${status}`).toBeLessThan(500);
};

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const { employeeId: id, code } = await createEmployeeWithCode(h.prisma);
  employeeId = id;
  ({ deviceId } = await enrollDevice(h, code));
});

const TODAY = workTodayIso();
const MONTH = TODAY.slice(0, 7);

/** Both owner and manager can read these (section 4.3) */
const SHARED_READS = (id: number): string[] => [
  '/api/v1/live',
  `/api/v1/employees/${id}/timeline?date=${TODAY}`,
  `/api/v1/employees/${id}/hourly?date=${TODAY}`,
  `/api/v1/screenshots?employeeId=${id}&date=${TODAY}`,
  `/api/v1/reports/attendance?from=${TODAY}&to=${TODAY}`,
  `/api/v1/reports/productivity?from=${TODAY}&to=${TODAY}`,
  `/api/v1/activity/productivity?employeeId=${id}&from=${TODAY}&to=${TODAY}`,
  `/api/v1/activity/top?employeeId=${id}&from=${TODAY}&to=${TODAY}`,
  `/api/v1/activity/team?from=${TODAY}&to=${TODAY}`,
  // Since 15 August the manager too — the owner's decision. The manager can also
  // change both; the write side is in `staff-setup.e2e.spec.ts`.
  '/api/v1/categories',
  '/api/v1/holidays',
];

/** Owner only (section 4.3) */
const OWNER_ONLY_READS = [
  '/api/v1/devices',
  // Leave belongs to the manager, but work policy does not — changing the
  // monthly target and screenshot window changes every PC's behaviour, so it stays with the owner.
  '/api/v1/work-policies',
  '/api/v1/audit-log',
  '/api/v1/alerts',
  `/api/v1/payroll?month=${MONTH}`,
];

describe('every endpoint really responds', () => {
  it('none returns 500 for the owner', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    for (const url of [...SHARED_READS(employeeId), ...OWNER_ONLY_READS]) {
      const res = await s.http.get(url);
      notServerError(res.status, url);
      expect(res.status, `${url} → the owner should not get 403/404`).toBeLessThan(
        400,
      );
    }
  });

  it('manager can read the shared routes', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    for (const url of SHARED_READS(employeeId)) {
      const res = await s.http.get(url);
      notServerError(res.status, url);
      expect(res.status, `${url} → the manager should be able to read`).toBeLessThan(400);
    }
  });

  /**
   * This catches a forgotten class-level `@Roles(owner)` or one placed on a
   * method. If someone later adds a new owner-only endpoint, just add it to this list.
   */
  it('manager gets 403 on owner-only routes', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    for (const url of OWNER_ONLY_READS) {
      const res = await s.http.get(url);
      expect(res.status, `${url} → the manager should not get in`).toBe(403);
    }
  });

  /**
   * A coordinator never gets near the whole team's data.
   *
   * Why this list is the most important net in the whole file: adding a new
   * value to `UserRole` looks harmless, but many conditions in the codebase
   * were written in a deny-list style (`role !== 'employee'`), i.e. "if not
   * staff, let them see everything". A new role then falls silently inward,
   * not outward. Two places were measured:
   *
   *   - `screenshots.service` -> `resolveEmployeeScope` returned `null`, and
   *     `null` means no filter: everyone's pictures, every day
   *   - `adjustments.service` -> `assertCanSee` was skipped entirely
   *
   * The compiler said nothing: across the whole codebase the new value caused
   * only two compile errors, both merely about widening a type.
   *
   * So the guard goes by the list: on every route open to owner and manager,
   * a coordinator must get 403. If someone adds a new route later it joins
   * this list automatically.
   */
  it('a coordinator cannot enter any owner/manager route', async () => {
    const them = await h.prisma.employee.create({
      data: { empCode: 'OX-79', fullName: 'Coordinator' },
    });
    await h.prisma.user.create({
      data: {
        email: 'r-ep@test.local',
        fullName: 'Coordinator',
        passwordHash: await hashPassword('staff-password-123'),
        role: 'coordinator',
        employeeId: them.id,
        mustChangePw: false,
      },
    });

    const s = await loginReady(h, 'r-ep@test.local', 'staff-password-123');

    for (const url of [...SHARED_READS(employeeId), ...OWNER_ONLY_READS]) {
      const res = await s.http.get(url);
      expect(res.status, `${url} → the coordinator should not get in`).toBe(403);
    }
  });

  /**
   * And this is the direct guard against that trap. Calling `/screenshots`
   * without `employeeId` made the old code read it as "no filter" and return
   * everyone's pictures. A coordinator also has their own agent (verified in
   * the field), so they touch this route every day — the question is not
   * whether they can get in, but how much they can see.
   */
  it('a coordinator sees only their own pictures — not everyone\'s', async () => {
    const them = await h.prisma.employee.create({
      data: { empCode: 'OX-80', fullName: 'Coordinator' },
    });
    await h.prisma.user.create({
      data: {
        email: 'r-shot@test.local',
        fullName: 'Coordinator',
        passwordHash: await hashPassword('staff-password-123'),
        role: 'coordinator',
        employeeId: them.id,
        mustChangePw: false,
      },
    });

    const s = await loginReady(h, 'r-shot@test.local', 'staff-password-123');

    // Their own — open
    const mine = await s.http.get(`/api/v1/screenshots?date=${TODAY}`);
    expect(mine.status).toBeLessThan(400);
    for (const row of mine.body.rows ?? []) {
      expect(row.employeeId, 'nothing but their own screenshots should come back').toBe(them.id);
    }

    // Asking for someone else's — it is not silently swapped for their own, it is 403
    const theirs = await s.http.get(
      `/api/v1/screenshots?employeeId=${employeeId}&date=${TODAY}`,
    );
    expect(theirs.status, "asking for someone else's screenshots gives 403").toBe(403);
  });

  it('everything is closed without login', async () => {
    for (const url of [...SHARED_READS(employeeId), ...OWNER_ONLY_READS]) {
      const res = await h.http().get(url);
      expect(res.status, `${url} → open without login!`).toBe(401);
    }
  });
});

describe('pay never reaches the manager', () => {
  /**
   * The most sensitive field in the system. Sending `null` is not enough
   * either — the field must not be in the response at all, otherwise one day
   * someone would write `?? 0` and the field would come back.
   */
  it('monthlySalary is not in the employees list', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    const res = await s.http.get('/api/v1/employees');
    expect(res.status).toBeLessThan(400);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('monthlySalary');
    expect(body).not.toContain('monthly_salary');
  });

  it('the owner list has monthlySalary', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http.get('/api/v1/employees');
    expect(res.status).toBeLessThan(400);
    expect(JSON.stringify(res.body)).toContain('monthlySalary');
  });
});

describe('a full URL or window title never appears in a report', () => {
  /**
   * ADR-013 — nothing beyond the domain is stored, but `windowTitle` is
   * stored. If it came back in the activity report, "who opened which file" would leak.
   */
  it('the activity report has no windowTitle', async () => {
    const now = workNoon();
    await h.prisma.appUsage.create({
      data: {
        employeeId,
        deviceId,
        clientUuid: crypto.randomUUID(),
        workDate: new Date(`${TODAY}T00:00:00.000Z`),
        startedAt: new Date(now.getTime() - 60_000),
        endedAt: now,
        durationSec: 60,
        processName: 'chrome.exe',
        windowTitle: 'confidential-payroll-plan.xlsx',
        domain: 'github.com',
        isBrowser: true,
      },
    });

    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    for (const url of [
      `/api/v1/activity/top?employeeId=${employeeId}&from=${TODAY}&to=${TODAY}`,
      `/api/v1/reports/productivity?from=${TODAY}&to=${TODAY}`,
    ]) {
      const res = await s.http.get(url);
      expect(res.status, url).toBeLessThan(400);
      expect(JSON.stringify(res.body), url).not.toContain('confidential-payroll-plan');
    }
  });
});
