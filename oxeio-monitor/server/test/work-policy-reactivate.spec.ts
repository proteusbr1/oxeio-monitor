import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../src/audit/audit.service';
import { WorkPoliciesService } from '../src/calendar/work-policies.service';
import type { SessionUser } from '../src/auth/types';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * **G85 — the code to open, along with the code to close.**
 *
 * `deactivate()` existed, `reactivate()` did not. So a policy once
 * deactivated stayed deactivated **forever**, and the only way back was SQL on the server.
 *
 * This was not caught in the field — it was caught **after the G84 fix, by
 * writing the rule down and looking at the rest of the code with the same
 * eyes**. That is the real gain of writing rules down: after fixing one bug
 * you can look for others of the same shape, instead of waiting for the next
 * to be caught in the field.
 *
 * Tested without a DB, because the questions here are about logic: **when it
 * stops, what it writes, and what it returns.**
 */

const ACTOR = { userId: 1 } as unknown as SessionUser;

const POLICY = {
  id: 4,
  name: 'Default',
  monthlyTargetHours: 208,
  expectedWorkdays: 26,
  weeklyOffDays: [5],
  screenshotFrom: '07:00',
  screenshotTo: '23:00',
  idleThresholdSec: 60,
  slotMinutes: 5,
  timezone: 'Etc/GMT-6',
  isActive: false,
};

function makeService(overrides: {
  findUnique?: unknown;
  update?: ReturnType<typeof vi.fn>;
  record?: ReturnType<typeof vi.fn>;
}) {
  const update =
    overrides.update ??
    vi.fn().mockResolvedValue({ ...POLICY, isActive: true });
  const record = overrides.record ?? vi.fn().mockResolvedValue(undefined);

  const prisma = {
    workPolicy: {
      findUnique: vi.fn().mockResolvedValue(overrides.findUnique),
      update,
    },
  } as unknown as PrismaService;

  const audit = { record } as unknown as AuditService;

  return {
    svc: new WorkPoliciesService(prisma, audit),
    update,
    record,
  };
}

describe('G85 · reactivating a work policy', () => {
  it('an inactive policy becomes active, and that shows in the returned view', async () => {
    const { svc, update } = makeService({
      findUnique: { ...POLICY, _count: { employees: 0 } },
    });

    const view = await svc.reactivate(ACTOR, 4, '10.0.0.1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { isActive: true },
    });
    expect(view.isActive).toBe(true);
  });

  it('404 on a policy that does not exist', async () => {
    const { svc } = makeService({ findUnique: null });

    await expect(svc.reactivate(ACTOR, 99, '10.0.0.1')).rejects.toThrow(
      NotFoundException,
    );
  });

  /**
   * 409 if already active — otherwise the audit log would pile up "changes"
   * where nothing really changed, just as the role-change route writes
   * nothing when the same value is set (G87).
   */
  it('409 if already active, and nothing is written', async () => {
    const { svc, update, record } = makeService({
      findUnique: { ...POLICY, isActive: true, _count: { employees: 0 } },
    });

    await expect(svc.reactivate(ACTOR, 4, '10.0.0.1')).rejects.toThrow(
      ConflictException,
    );
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('audit log gets both the op and the name', async () => {
    const { svc, record } = makeService({
      findUnique: { ...POLICY, _count: { employees: 0 } },
    });

    await svc.reactivate(ACTOR, 4, '10.0.0.1');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        targetId: 4,
        ipAddress: '10.0.0.1',
        meta: { op: 'reactivate', name: 'Default' },
      }),
    );
  });

  /**
   * The subtlest test. `deactivate()` ends with `toView(row, 0)`, and that is
   * **correct** — it does not proceed unless the count is zero.
   *
   * But here, assuming zero would be an **assumption**: an inactive policy can
   * have employees (if someone put them there via SQL, or if the rules change
   * in future), and then the screen would show "0 staff" while they really exist.
   */
  it('the staff count comes from a real count, not an assumed zero', async () => {
    const { svc } = makeService({
      findUnique: { ...POLICY, _count: { employees: 12 } },
    });

    const view = await svc.reactivate(ACTOR, 4, '10.0.0.1');

    expect(view.employeeCount).toBe(12);
  });
});
