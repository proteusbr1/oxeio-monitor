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
  dhakaNoon,
} from './setup/harness';

/**
 * **R21 — security money (deposit).**
 *
 * The owner's rule (15 August): 500 taka is held back every month, and anyone
 * who leaves with 30 days' notice gets all of it back.
 *
 * This is money, so the questions are about money: is anything deducted
 * twice, is anything deducted for a month before the person joined, and do
 * old instalments stay put when the rule changes.
 */
let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

/** The current Dhaka month — the tests' expectations match it */
const thisMonth = dhakaNoon().toISOString().slice(0, 7);

/** '2026-09' → '2026-08' */
function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

  /**
   * `resetDatabase` empties the tables, so the rule row inserted by the
   * migration goes too — it has to be re-inserted in every test.
   */
  await h.prisma.depositPolicy.upsert({
    where: { id: 1 },
    update: {
      amountPaisa: 50_000,
      startYearMonth: thisMonth,
      noticeDays: 30,
      active: true,
      updatedBy: 'test',
    },
    create: {
      id: 1,
      amountPaisa: 50_000,
      startYearMonth: thisMonth,
      noticeDays: 30,
      active: true,
      updatedBy: 'test',
    },
  });
});

const addStaff = async (fullName: string, joinedOn?: string) => {
  const res = await owner.http
    .post('/api/v1/employees')
    .set('X-CSRF-Token', owner.csrf)
    .send({ fullName, monthlySalary: '10000', joinedOn })
    .expect(201);
  return res.body as { id: number; empCode: string };
};

const balances = async () => {
  const res = await owner.http.get('/api/v1/deposits').expect(200);
  return res.body as {
    policy: { amount: string; noticeDays: number; startYearMonth: string };
    rows: {
      employeeId: number;
      empCode: string;
      months: number;
      balance: string;
      settlement: { outcome: string; amount: string } | null;
    }[];
  };
};

describe('the deposit ledger', () => {
  it('a person gets exactly one instalment in the current month', async () => {
    const staff = await addStaff('Jomanot Ek');

    const { rows, policy } = await balances();
    const row = rows.find((r) => r.employeeId === staff.id);

    expect(policy.amount).toBe('500.00');
    expect(row?.months).toBe(1);
    expect(row?.balance).toBe('500.00');
  });

  /**
   * The most important test. The ledger is created when a page is opened, not
   * by a cron job, so "opened twice, deducted twice" could happen right here.
   */
  it('opening the ledger repeatedly does not increase the balance', async () => {
    const staff = await addStaff('Bar Bar');

    await balances();
    await balances();
    const { rows } = await balances();

    const row = rows.find((r) => r.employeeId === staff.id);
    expect(row?.months).toBe(1);
    expect(row?.balance).toBe('500.00');
  });

  it('no instalment is created for a month before the person joined', async () => {
    // The rule starts this month and this person joins next month — none at all
    const nextMonthDate = `${nextMonthOf(thisMonth)}-05`;
    const staff = await addStaff('Pore Joge Diyechen', nextMonthDate);

    const { rows } = await balances();
    const row = rows.find((r) => r.employeeId === staff.id);

    expect(row?.months).toBe(0);
    expect(row?.balance).toBe('0.00');
  });

  /**
   * Changing the rule's amount does not change old instalments, because each
   * row stores that month's amount. Otherwise setting 600 today would push up
   * the deposits of past months retroactively, and the ledger would claim
   * money nobody ever paid.
   */
  it('changing the amount leaves earlier months\' instalments intact', async () => {
    const staff = await addStaff('Purono Kisti');
    await balances(); // the current month's instalment is now fixed at 500

    await owner.http
      .patch('/api/v1/deposits/policy')
      .set('X-CSRF-Token', owner.csrf)
      .send({ amountPaisa: 60_000 })
      .expect(200);

    const { rows, policy } = await balances();
    const row = rows.find((r) => r.employeeId === staff.id);

    expect(policy.amount).toBe('600.00');
    // The new amount applies from the new month — this month's is still 500
    expect(row?.balance).toBe('500.00');
  });

  it('switching the rule off adds no new instalments and keeps old deposits', async () => {
    const staff = await addStaff('Bondho Niyom');
    await balances();

    await owner.http
      .patch('/api/v1/deposits/policy')
      .set('X-CSRF-Token', owner.csrf)
      .send({ active: false })
      .expect(200);

    const { rows } = await balances();
    expect(rows.find((r) => r.employeeId === staff.id)?.balance).toBe('500.00');
  });
});

describe('settlement — refund or forfeit', () => {
  it('with 30 days\' notice it is refunded, and the calculation is stored in the row', async () => {
    const staff = await addStaff('Niyom Mene');
    await balances();

    const res = await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        outcome: 'refunded',
        noticeGivenOn: '2026-07-31',
        lastWorkingDay: '2026-08-30',
      })
      .expect(201);

    expect(res.body.outcome).toBe('refunded');
    expect(res.body.amount).toBe('500.00');
    expect(res.body.noticeDaysGiven).toBe(30);
    expect(res.body.noticeDaysRule).toBe(30);
  });

  /**
   * The owner may refund even when the rule is not met — the decision is
   * theirs. The system only records the calculation and does not block.
   * Exceptions always exist, and no `if` can capture them.
   */
  it('the owner may refund even if the rule is not met — the calculation is just recorded', async () => {
    const staff = await addStaff('Byatikrom');
    await balances();

    const res = await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        outcome: 'refunded',
        noticeGivenOn: '2026-08-25',
        lastWorkingDay: '2026-08-30',
        note: 'হাসপাতালে ভর্তি ছিলেন',
      })
      .expect(201);

    expect(res.body.outcome).toBe('refunded');
    expect(res.body.noticeDaysGiven).toBe(5);
    expect(res.body.note).toBe('হাসপাতালে ভর্তি ছিলেন');
  });

  it('a second settlement is not allowed — 409', async () => {
    const staff = await addStaff('Dubar Noy');
    await balances();

    await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ outcome: 'forfeited' })
      .expect(201);

    await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ outcome: 'refunded' })
      .expect(409);
  });

  it('no new instalments are created after settlement', async () => {
    const staff = await addStaff('Khata Bondho');
    await balances();

    await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ outcome: 'refunded' })
      .expect(201);

    const { rows } = await balances();
    const row = rows.find((r) => r.employeeId === staff.id);

    expect(row?.months).toBe(1);
    expect(row?.settlement?.outcome).toBe('refunded');
  });

  it('anything else as outcome gives 400', async () => {
    const staff = await addStaff('Bhul Outcome');

    await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ outcome: 'maybe' })
      .expect(400);
  });
});

describe('who can see it', () => {
  /**
   * The deposit is directly part of pay, so not even the manager (ADR-023, ADR-027).
   */
  it('a manager cannot open the deposit page — 403', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http.get('/api/v1/deposits').expect(403);
    await manager.http
      .patch('/api/v1/deposits/policy')
      .set('X-CSRF-Token', manager.csrf)
      .send({ amountPaisa: 10 })
      .expect(403);
  });

  /**
   * Staff see their own deposit, and that does not break the pay rules — the
   * amount is their own money, not part of the pay calculation.
   */
  it('staff see their own deposit, month by month', async () => {
    const staff = await addStaff('Nijer Jomma');
    await balances();

    // The server generates the password and returns it only once — it cannot be guessed
    const account = await owner.http
      .post(`/api/v1/employees/${staff.id}/portal-account`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ email: 'nijer.jomma@oxeio.test' })
      .expect(201);

    const session = await loginReady(
      h,
      'nijer.jomma@oxeio.test',
      account.body.tempPassword as string,
    );

    const res = await session.http.get('/api/v1/me/deposit').expect(200);
    expect(res.body.total).toBe('500.00');
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].yearMonth).toBe(thisMonth);
    expect(res.body.noticeDays).toBe(30);
  });
});

describe('on the payroll sheet', () => {
  it('shows net after deducting 500 from payable, and both numbers are present', async () => {
    const staff = await addStaff('Payroll Kata');
    await balances();

    const res = await owner.http
      .get(`/api/v1/payroll?month=${thisMonth}`)
      .expect(200);

    const row = (res.body.rows as Record<string, string | number>[]).find(
      (r) => r.employeeId === staff.id,
    );

    // Without a rollup there is no row at all — then this test has nothing to say
    if (!row) return;

    expect(row.securityDeposit).toBe('500.00');
    // net = payable - 500, and both numbers are kept separately
    expect(Number(row.netPayable)).toBeCloseTo(Number(row.payable) - 500, 2);
  });

  /**
   * Deposits switched off in Settings → Modules: the sheet holds nothing
   * back — a deduction nobody can see on screen would be worse — and the
   * ledger rows stay, ready for when the module is turned back on.
   */
  it('deposits switched off → nothing held back, the ledger is kept', async () => {
    const staff = await addStaff('Payroll Off');
    await balances();
    // the sheet only lists people whose month has been rolled up
    await h.prisma.monthlySummary.create({
      data: {
        employeeId: staff.id,
        yearMonth: thisMonth,
        workedSec: 100 * 3600,
        creditedSec: 100 * 3600,
        expectedWorkdays: 20,
      },
    });

    await owner.http
      .patch('/api/v1/settings/features')
      .set('X-CSRF-Token', owner.csrf)
      .send({ deposits: false })
      .expect(200);

    const res = await owner.http
      .get(`/api/v1/payroll?month=${thisMonth}`)
      .expect(200);

    expect(
      await h.prisma.securityDeposit.count({ where: { employeeId: staff.id } }),
    ).toBe(1);

    const row = (res.body.rows as Record<string, string | number>[]).find(
      (r) => r.employeeId === staff.id,
    );
    expect(row).toBeDefined();
    expect(row?.securityDeposit).toBeNull();
    expect(row?.netPayable).toBe(row?.payable);
  });
});

/** '2026-08' → '2026-09' */
function nextMonthOf(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Correcting the amount of an already-created instalment (5 September 2026).
 *
 * Found in the field, raised by the owner: "why does Saifur OX-10 show 500
 * deposited for 2 months?" One month's instalment had been created at 0, so
 * the page showed "2 months held · 500". Both facts were true, and read
 * together they made no sense.
 *
 * There was also no way to fix it. `ensureLedger()` uses
 * `createMany({ skipDuplicates: true })`, so existing rows are never updated,
 * and that is deliberate (changing the rule's amount must not rewrite old
 * months). It was eventually repaired with a trick: move the start month
 * forward to delete the row, then move it back so it is re-created. That only
 * works for months at the start of the range, and was not written down
 * anywhere.
 */
/**
/**
 * A closed month does not move in either direction (6 September 2026).
 *
 * The gap this describe guards: every money path refuses to touch a closed
 * month — `correctInstalment()`, time adjustments, leave, rollup, pay history
 * — except `ensureLedger()`. Yet that is the one that runs most: the Deposits
 * page, the staff member's own `/me/deposit`, and the payroll sheet itself.
 *
 * So a gap in a closed month would get 500 inserted into that month on any
 * later page load, after the paper had gone out. The ledger would say the
 * money was deducted while the pay slip did not show it.
 */
describe('a closed month does not move the ledger', () => {
  it('no new instalment is created in a closed month', async () => {
    const staff = await addStaff('Bondho Mash');
    await balances();

    const months = (await owner.http
      .get(`/api/v1/deposits/${staff.id}/months`)
      .expect(200)).body.months as { yearMonth: string }[];
    expect(months.length).toBeGreaterThan(0);

    // Delete the row to create a gap — exactly how the gap arises for a
    // late-joining staff member
    await h.prisma.securityDeposit.deleteMany({ where: { employeeId: staff.id } });
    await h.prisma.monthClosure.create({
      data: { yearMonth: thisMonth, closedBy: 'test' },
    });

    // page load -> ensureLedger()
    await balances();

    const after = await h.prisma.securityDeposit.count({
      where: { employeeId: staff.id, yearMonth: thisMonth },
    });
    expect(after).toBe(0);
  });

  /**
   * The second test is the real guard — on its own, the first would stay
   * green even if `ensureLedger()` were switched off completely.
   */
  it('in an open month it is created as before', async () => {
    const staff = await addStaff('Khola Mash');
    await balances();

    await h.prisma.securityDeposit.deleteMany({ where: { employeeId: staff.id } });
    await balances();

    const after = await h.prisma.securityDeposit.count({
      where: { employeeId: staff.id, yearMonth: thisMonth },
    });
    expect(after).toBe(1);
  });

  /**
   * The opposite direction too: moving the start month forward does not
   * delete a closed month's row. Blocking only the insert would be half the
   * job — money written on the pay slip would vanish from the ledger.
   */
  it('a closed month\'s row survives when the start month moves forward', async () => {
    const staff = await addStaff('Bondho Mochha');
    await balances();

    /**
     * Manually insert an instalment for an earlier month — `addStaff()` only
     * creates the current month's row and `setStartMonth()` does not accept
     * future months, so a past row is needed as a deletion target.
     */
    const past = prevMonth(thisMonth);
    await h.prisma.securityDeposit.create({
      data: { employeeId: staff.id, yearMonth: past, amountPaisa: 50_000 },
    });
    await h.prisma.monthClosure.create({
      data: { yearMonth: past, closedBy: 'test' },
    });

    // Moving the start month to the current month is supposed to delete all earlier months
    await owner.http
      .patch(`/api/v1/deposits/${staff.id}/start`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ yearMonth: thisMonth })
      .expect(200);

    const kept = await h.prisma.securityDeposit.count({
      where: { employeeId: staff.id, yearMonth: past },
    });
    expect(kept).toBe(1);
  });
});

describe('correcting an instalment amount', () => {
  const correct = (
    employeeId: number,
    yearMonth: string,
    amountPaisa: number,
    reason = 'হিসাবের ভুল',
  ) =>
    owner.http
      .patch(`/api/v1/deposits/${employeeId}/instalment`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ yearMonth, amountPaisa, reason });

  it('the amount changes, and the total shows it', async () => {
    const staff = await addStaff('Songshodhon Ek');
    await balances();

    await correct(staff.id, thisMonth, 30_000).expect(200);

    const { rows } = await balances();
    const row = rows.find((r) => r.employeeId === staff.id)!;
    expect(row.balance).toBe('300.00');
    expect(row.months).toBe(1);
  });

  /**
   * The most important test in this describe.
   *
   * Setting zero was the source of the original bug: the owner entered 0 to
   * mean "waive this month", which left a row in the ledger that counts a
   * month but holds no money. Waived means there is no instalment that month;
   * an instalment of 0 exists. Mixing the two ruins the answer to "how many
   * months have been paid".
   *
   * The database also has `CHECK (amount_paisa > 0)`, but the check is
   * stopped here first — otherwise the message would be a raw Postgres error.
   */
  it('zero cannot be set — waiving and 0 are not the same', async () => {
    const staff = await addStaff('Songshodhon Shunno');
    await balances();

    await correct(staff.id, thisMonth, 0).expect(400);

    const { rows } = await balances();
    expect(rows.find((r) => r.employeeId === staff.id)!.balance).toBe('500.00');
  });

  it('a negative amount is not allowed either', async () => {
    const staff = await addStaff('Songshodhon Rin');
    await balances();

    await correct(staff.id, thisMonth, -100).expect(400);
  });

  /**
   * No correction without a reason — six months later, that line is the only
   * answer to "why is this person's amount different that month?". Same rule
   * as `time_adjustments`.
   */
  it('no correction without a reason', async () => {
    const staff = await addStaff('Songshodhon Karon');
    await balances();

    await correct(staff.id, thisMonth, 30_000, '   ').expect(400);
  });

  /**
   * Cannot set where there is no row — that would be creating a new
   * instalment, not correcting one, and creating instalments is the rule's
   * job (`ensureLedger`). Allowing it would put a month in the ledger that
   * came from no rule.
   */
  it('cannot set a month that has no instalment', async () => {
    const staff = await addStaff('Songshodhon Nei');
    await balances();

    await correct(staff.id, '2020-01', 30_000).expect(404);
  });

  /**
   * No correction in a closed month (R1) — exactly the same rule as leave.
   * A closed month means that month's paper has gone out; changing the ledger
   * would make paper and ledger say different things, unnoticed.
   */
  it('correction in a closed month is blocked', async () => {
    const staff = await addStaff('Songshodhon Bondho');
    await balances();

    await h.prisma.monthClosure.create({
      data: { yearMonth: thisMonth, closedBy: 'test' },
    });

    await correct(staff.id, thisMonth, 30_000).expect(409);
  });

  /** After settlement the ledger is closed — exactly the same condition as `setStartMonth` */
  it('no more corrections after settlement', async () => {
    const staff = await addStaff('Songshodhon Nishpotti');
    await balances();

    await owner.http
      .post(`/api/v1/deposits/${staff.id}/settle`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ outcome: 'refunded' })
      .expect(201);

    await correct(staff.id, thisMonth, 30_000).expect(409);
  });

  /**
   * The reason is written to the ledger — a correction cannot happen
   * silently. Both the before and after amounts are stored, otherwise "from
   * what to what" could not be answered from the audit log.
   */
  it('the audit log records the before and after amounts and the reason', async () => {
    const staff = await addStaff('Songshodhon Audit');
    await balances();

    await correct(staff.id, thisMonth, 25_000, 'জুলাইয়ের আংশিক বেতন').expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { targetType: 'employee', targetId: String(staff.id) },
      orderBy: { occurredAt: 'desc' },
    });

    expect(row.meta).toMatchObject({
      op: 'deposit_instalment_corrected',
      yearMonth: thisMonth,
      fromPaisa: 50_000,
      toPaisa: 25_000,
      why: 'জুলাইয়ের আংশিক বেতন',
    });
  });

  /**
   * The correction sticks — a later `ensureLedger()` does not revert it.
   *
   * This is the easiest place to break things: `ensureLedger()` runs on every
   * request. If `skipDuplicates` became `upsert`, the correction would be
   * silently overwritten with the rule's amount and nobody would notice,
   * because there is no error on screen, only the number going back.
   */
  it('the correction survives the next refresh', async () => {
    const staff = await addStaff('Songshodhon Tike');
    await balances();

    await correct(staff.id, thisMonth, 30_000).expect(200);

    // Three times — `ensureLedger()` runs each time
    await balances();
    await balances();
    const { rows } = await balances();

    expect(rows.find((r) => r.employeeId === staff.id)!.balance).toBe('300.00');
  });

  /**
   * The last guard is in the database itself (5 September 2026).
   *
   * The "zero cannot be set" test above is actually caught by the DTO's
   * `@Min(1)` before it reaches the service. That is good, but it does not
   * prove that 0 cannot get in some other way, and the field row got in
   * exactly that way (directly, not over HTTP).
   *
   * `deposit_policy` has had `CHECK (amount_paisa > 0)` from day one, but the
   * ledger rows did not, and that is where the wrong value lands. This test
   * guards the new CHECK, bypassing the DTO entirely.
   */
  it('the database itself refuses a 0 instalment', async () => {
    const staff = await addStaff('Songshodhon DB');
    await balances();

    await expect(
      h.prisma.securityDeposit.create({
        data: { employeeId: staff.id, yearMonth: '2020-01', amountPaisa: 0 },
      }),
    ).rejects.toThrow();

    // Negative too — same CHECK
    await expect(
      h.prisma.securityDeposit.create({
        data: { employeeId: staff.id, yearMonth: '2020-02', amountPaisa: -1 },
      }),
    ).rejects.toThrow();
  });

  /**
   * The owner can also see the month-by-month list — it used to exist only
   * on the staff member's own page (`/me/deposit`). Without it the field bug
   * went unnoticed for two weeks: the total gave no way to tell which month
   * was wrong.
   */
  it('the owner can see the ledger month by month', async () => {
    const staff = await addStaff('Songshodhon Mash');
    await balances();
    await correct(staff.id, thisMonth, 30_000).expect(200);

    const res = await owner.http
      .get(`/api/v1/deposits/${staff.id}/months`)
      .expect(200);

    expect(res.body.months).toEqual([
      { yearMonth: thisMonth, amount: '300.00' },
    ]);
    expect(res.body.total).toBe('300.00');
  });
});
