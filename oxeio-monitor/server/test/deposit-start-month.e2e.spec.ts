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
  uniqueSuffix,
} from './setup/harness';

/**
 * **R21** — the month from which this staff member's deposit deduction starts.
 *
 * Careful: the start month used to be a single value for the whole office.
 * But staff join at different times, and some had deductions begin in another
 * month, with nowhere to record that. The ledger was wrong and there was no
 * way to correct it.
 *
 * The most important claim in this file: moving the month forward removes the
 * earlier wrong instalments. If they were not removed, even after a
 * "correction" the ledger would still hold the mistake, and the owner would
 * think the save had not worked.
 */
let h: Harness;
let owner: Session;
let employeeId: number;

const POLICY_START = '2026-01';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

  await h.prisma.depositPolicy.upsert({
    where: { id: 1 },
    update: {
      amountMinor: 50_000,
      startYearMonth: POLICY_START,
      active: true,
      updatedBy: 'test',
    },
    create: {
      id: 1,
      amountMinor: 50_000,
      startYearMonth: POLICY_START,
      active: true,
      updatedBy: 'test',
    },
  });

  const employee = await h.prisma.employee.create({
    data: { empCode: `DS-${uniqueSuffix()}`, fullName: 'Belal Hossain' },
  });
  employeeId = employee.id;
});

const setStart = (yearMonth: string | null, id = employeeId) =>
  owner.http
    .patch(`/api/v1/deposits/${id}/start`)
    .set('X-CSRF-Token', owner.csrf)
    .send({ yearMonth });

const months = () =>
  h.prisma.securityDeposit.findMany({
    where: { employeeId },
    orderBy: { yearMonth: 'asc' },
    select: { yearMonth: true },
  });

/** Calls the list once to fill the ledger — `balances()` itself runs `ensureLedger()` */
const fillLedger = () => owner.http.get('/api/v1/deposits').expect(200);

describe('PATCH /deposits/:id/start', () => {
  it('without an override, the ledger fills from the rule\'s start month', async () => {
    await fillLedger();

    const rows = await months();
    expect(rows[0].yearMonth).toBe(POLICY_START);
  });

  /**
   * The core test of this file. Moving the month forward removes the earlier
   * instalments — otherwise correcting a mistake would be meaningless.
   */
  it('moving the month forward removes the earlier instalments', async () => {
    await fillLedger();
    expect((await months())[0].yearMonth).toBe(POLICY_START);

    const res = await setStart('2026-05').expect(200);

    expect(res.body.removed).toBeGreaterThan(0);
    expect((await months())[0].yearMonth).toBe('2026-05');
  });

  it('moving the month back adds the earlier months too', async () => {
    await setStart('2026-06').expect(200);
    await fillLedger();
    expect((await months())[0].yearMonth).toBe('2026-06');

    const res = await setStart('2026-02').expect(200);

    expect(res.body.added).toBeGreaterThan(0);
    expect((await months())[0].yearMonth).toBe('2026-02');
  });

  /** `null` — back to the rule's normal month, which is also a valid action */
  it('null returns to the rule\'s month', async () => {
    await setStart('2026-06').expect(200);
    await setStart(null).expect(200);
    await fillLedger();

    expect((await months())[0].yearMonth).toBe(POLICY_START);
    const row = await h.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    expect(row.depositStartYearMonth).toBeNull();
  });

  it('the list returns both the chosen and the effective month', async () => {
    await setStart('2026-04').expect(200);

    const res = await owner.http.get('/api/v1/deposits').expect(200);
    const row = (res.body.rows as Record<string, unknown>[]).find(
      (r) => r.employeeId === employeeId,
    );

    expect(row).toMatchObject({ startYearMonth: '2026-04', effectiveStart: '2026-04' });
  });

  /**
   * The owner's word also beats the joining date. `joined_on` is often a guess
   * or empty; the owner picks this field personally, so if a guess beat a
   * statement, a correction would change nothing and nobody could tell why.
   */
  it('the owner\'s chosen month beats joined_on', async () => {
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { joinedOn: new Date('2026-07-01T00:00:00.000Z') },
    });

    await setStart('2026-03').expect(200);
    await fillLedger();

    expect((await months())[0].yearMonth).toBe('2026-03');
  });

  it('wrong shape gives 400', async () => {
    await setStart('2026/03').expect(400);
    await setStart('March').expect(400);
  });

  /** A future month would silently leave the ledger empty */
  it('a future month gives 400', async () => {
    await setStart('2099-01').expect(400);
  });

  /** Once settled the ledger is closed — a settled account must not be moved */
  it('cannot be changed after settlement', async () => {
    await fillLedger();
    await h.prisma.depositSettlement.create({
      data: {
        employeeId,
        outcome: 'refunded',
        amountMinor: 50_000,
        // Required — the number of days the rule specified at settlement time is
        // also stored in the row (history does not move if the rule changes later)
        noticeDaysRule: 30,
        settledBy: 'owner@test',
      },
    });

    const res = await setStart('2026-05');

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/settled/i);
  });

  it('unknown staff member gives 404', async () => {
    await setStart('2026-05', 999_999).expect(404);
  });

  /** The deposit is directly part of pay — not even the manager may (ADR-023, ADR-027) */
  it('a manager cannot', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http
      .patch(`/api/v1/deposits/${employeeId}/start`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ yearMonth: '2026-05' })
      .expect(403);
  });

  it('setting the same month again changes nothing', async () => {
    await setStart('2026-05').expect(200);

    const res = await setStart('2026-05').expect(200);

    expect(res.body).toEqual({ removed: 0, added: 0 });
  });

  it('the change appears in the audit log', async () => {
    await setStart('2026-05').expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { targetId: String(employeeId), action: 'deposit_policy_update' },
      orderBy: { id: 'desc' },
    });

    expect(row.meta).toMatchObject({ op: 'deposit_start_month', to: '2026-05' });
  });
});
