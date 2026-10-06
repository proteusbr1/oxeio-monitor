import { describe, expect, it } from 'vitest';

import {
  canSeeSalary,
  toEmployeeView,
  toEmployeeViews,
  type EmployeeRow,
  type OwnerEmployeeView,
} from '../src/staff/redact';

/**
 * `monthlySalary` is a plain `number` here: the shape of `Decimalish` is just
 * `toFixed(digits)`, and `number` satisfies it. That is why `redact.ts` does
 * not import Prisma's Decimal: tests need no database types.
 */
function row(overrides: Partial<EmployeeRow> = {}): EmployeeRow {
  return {
    id: 3,
    empCode: 'EMP-003',
    fullName: 'রুমানা হক',
    email: 'rumana@example.com',
    designation: 'Designer',
    department: 'Creative',
    // work type, next to designation, not a replacement for it
    receivesTasks: true,
    /** the person's own daily target; `null` means the policy's applies */
    dailyTaskTarget: null,
    policyId: 1,
    monthlySalary: 13000,
    payBasis: 'monthly',
    hourlyRate: null,
    joinedOn: new Date('2025-03-01T00:00:00.000Z'),
    leftOn: null,
    status: 'active',
    policySignedAt: new Date('2025-03-02T04:30:00.000Z'),
    policyDocPath: 'policies/emp-003.pdf',
    createdAt: new Date('2025-03-01T06:00:00.000Z'),
    ...overrides,
  };
}

describe('redact: who gets to see the salary (ADR-023, spec section 4.3)', () => {
  it('the owner sees the salary, as a string with two decimals', () => {
    const view = toEmployeeView(row(), 'owner') as OwnerEmployeeView;

    expect(view.monthlySalary).toBe('13000.00');
  });

  /** This single test is the reason for the whole file */
  it('the manager response has no such field at all: not null, absent', () => {
    const view = toEmployeeView(row(), 'manager');

    expect('monthlySalary' in view).toBe(false);
    expect(Object.keys(view)).not.toContain('monthlySalary');
  });

  it('staff themselves (role = employee) do not get the salary field either', () => {
    const view = toEmployeeView(row(), 'employee');

    expect('monthlySalary' in view).toBe(false);
  });

  /**
   * With `monthlySalary: undefined` the field does vanish from JSON, but `in`
   * would still say true. These two tests together catch that trick.
   */
  it('the word does not appear anywhere in the manager\'s JSON either', () => {
    const json = JSON.stringify(toEmployeeView(row(), 'manager'));

    expect(json).not.toContain('monthlySalary');
    expect(json).not.toContain('13000');
  });

  it('for the owner, an unset salary goes out as null: the field is still there', () => {
    // "salary not set" and "the manager cannot see it" are two different
    // facts; making both "no field" would leave the owner unable to tell
    // whose salary is still missing
    const view = toEmployeeView(
      row({ monthlySalary: null }),
      'owner',
    ) as OwnerEmployeeView;

    expect('monthlySalary' in view).toBe(true);
    expect(view.monthlySalary).toBeNull();
  });

  /**
   * The real test of whitelist versus blacklist.
   *
   * If `bankAccount` is added to the schema tomorrow and someone forgets to
   * update `redact.ts`, a blacklist approach (`delete copy.monthlySalary`)
   * would quietly send it in the manager's response. Here it does not go.
   */
  it('an unknown sensitive column on the row does not reach the response', () => {
    const future = {
      ...row(),
      bankAccount: '0123456789',
      nid: '1990123456789',
    } as EmployeeRow;

    for (const role of ['owner', 'manager'] as const) {
      const view = toEmployeeView(future, role);
      expect('bankAccount' in view).toBe(false);
      expect('nid' in view).toBe(false);
    }
  });

  it('date columns are YYYY-MM-DD, timestamps are full ISO', () => {
    const view = toEmployeeView(row(), 'owner');

    expect(view.joinedOn).toBe('2025-03-01');
    expect(view.leftOn).toBeNull();
    expect(view.policySignedAt).toBe('2025-03-02T04:30:00.000Z');
  });

  it('the same rule applies to every row of a list', () => {
    const rows = [row({ id: 1 }), row({ id: 2, monthlySalary: 10000 })];

    const asManager = toEmployeeViews(rows, 'manager');
    expect(asManager).toHaveLength(2);
    expect(asManager.every((v) => !('monthlySalary' in v))).toBe(true);

    const asOwner = toEmployeeViews(rows, 'owner') as OwnerEmployeeView[];
    expect(asOwner.map((v) => v.monthlySalary)).toEqual([
      '13000.00',
      '10000.00',
    ]);
  });

  it('canSeeSalary is true only for owner', () => {
    expect(canSeeSalary('owner')).toBe(true);
    expect(canSeeSalary('manager')).toBe(false);
    expect(canSeeSalary('employee')).toBe(false);
  });

  /**
   * `Number(13000.10).toString()` = '13000.1', one decimal. Showing salary
   * amounts like that would make the frontend display 10.5 sometimes and
   * 10.50 other times.
   */
  it('a salary with a fraction still keeps two decimals', () => {
    const view = toEmployeeView(
      row({ monthlySalary: 13000.1 }),
      'owner',
    ) as OwnerEmployeeView;

    expect(view.monthlySalary).toBe('13000.10');
  });
});
