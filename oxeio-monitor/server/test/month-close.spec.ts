import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MonthCloseService } from '../src/calendar/month-close.service';
import type { AuditService } from '../src/audit/audit.service';
import type { SessionUser } from '../src/auth/types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { MonthDeliveryService } from '../src/reports/month-delivery.service';

/**
 * R1 — closing a month.
 *
 * The danger this feature prevents: the numbers in `monthly_summary` are
 * recomputed every time, and the computation reads the holiday list as it is
 * at that moment. So even after pay was disbursed, a holiday date moving
 * would change d and D — and there would be no way to prove which numbers
 * the pay was based on.
 *
 * The tests here are about boundaries, because the mistakes are at the
 * boundaries: closing the current month, closing twice, a wrongly shaped key.
 */

const OWNER: SessionUser = {
  userId: 1,
  email: 'owner@example.com',
  role: 'owner',
} as SessionUser;

function makeService(closures: Record<string, { closedAt: Date; closedBy: string; note: string | null }> = {}) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const prisma = {
    monthClosure: {
      findUnique: vi.fn(({ where }: { where: { yearMonth: string } }) =>
        Promise.resolve(
          closures[where.yearMonth]
            ? { yearMonth: where.yearMonth, ...closures[where.yearMonth] }
            : null,
        ),
      ),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data, closedAt: new Date('2026-09-03T10:00:00Z') }),
      ),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };

  /**
   * R26 — when a month is closed, the accounts file is sent. Here it is a
   * fake, and the fake is enough: the call is fire-and-forget, so `close()`'s
   * result does not depend on it. But whether it is called can be tested.
   */
  const delivery = {
    deliverClosedMonth: vi.fn().mockResolvedValue({
      telegram: 'not_configured',
      email: 'not_configured',
    }),
  };

  return {
    svc: new MonthCloseService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      delivery as unknown as MonthDeliveryService,
    ),
    prisma,
    audit,
    delivery,
  };
}

describe('MonthCloseService', () => {
  beforeEach(() => {
    // Fix "today" — otherwise the test would break when the month changed, and
    // from the failure it would look like the code was wrong, when the calendar had just moved on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
  });

  describe('closing', () => {
    it('a finished month is closed', async () => {
      const { svc, audit } = makeService();
      const row = await svc.close(OWNER, '2026-08', 'Salary paid on 3 September', '1.2.3.4');

      expect(row.yearMonth).toBe('2026-08');
      expect(row.closedBy).toBe('owner@example.com');
      expect(row.note).toBe('Salary paid on 3 September');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'month_closed', targetId: '2026-08' }),
      );
    });

    /**
     * R26 — after closing, the accounts file is sent.
     */
    it('on closing, that month\'s report is sent', async () => {
      const { svc, delivery } = makeService();
      await svc.close(OWNER, '2026-08', undefined, 'ip');

      expect(delivery.deliverClosedMonth).toHaveBeenCalledWith('2026-08');
    });

    /**
     * The most important R26 test. Even if delivery fails the month stays
     * closed — the row was committed before it. If it were the other way, the
     * owner would see a 500, retry and get 409 ("the month is already
     * closed"), and have no way to tell that nothing was broken.
     */
    it('even if sending the report fails the month stays closed', async () => {
      const { svc, delivery } = makeService();
      delivery.deliverClosedMonth.mockRejectedValueOnce(new Error('telegram down'));

      const row = await svc.close(OWNER, '2026-08', undefined, 'ip');

      expect(row.yearMonth).toBe('2026-08');

      // A microtask, not `setImmediate` — fake timers are on in this spec
      // (`vi.useFakeTimers()` above), so a macrotask would never run and the
      // test would hang for 30 seconds and time out.
      await Promise.resolve();
      await Promise.resolve();
      expect(delivery.deliverClosedMonth).toHaveBeenCalledWith('2026-08');
    });

    /**
     * The most important test. If the current month could be closed, today's
     * hours would stop being added — and the failure would be silent: someone
     * would say "today's hours are not showing up" and nobody would come to
     * the month-close page to look for the cause.
     */
    it('the current month cannot be closed', async () => {
      const { svc } = makeService();
      await expect(svc.close(OWNER, '2026-09', undefined, 'ip')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('nor a future month', async () => {
      const { svc } = makeService();
      await expect(svc.close(OWNER, '2026-12', undefined, 'ip')).rejects.toThrow(
        BadRequestException,
      );
    });

    /**
     * Closing a second time keeps the first person's name and date — if the
     * record changed, the answer to "when was it frozen" would be lost.
     */
    it('cannot be closed twice, and the first record stays', async () => {
      const { svc, prisma } = makeService({
        '2026-08': { closedAt: new Date('2026-09-01T09:00:00Z'), closedBy: 'first@example.com', note: null },
      });

      await expect(svc.close(OWNER, '2026-08', undefined, 'ip')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.monthClosure.create).not.toHaveBeenCalled();
    });

    it.each(['2026-8', '2026-13', '26-08', 'aug-2026', ''])(
      'a wrongly shaped key is rejected — %s',
      async (bad) => {
        const { svc } = makeService();
        await expect(svc.close(OWNER, bad, undefined, 'ip')).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('an empty note becomes `null`, not an empty string', async () => {
      const { svc, prisma } = makeService();
      await svc.close(OWNER, '2026-08', '   ', 'ip');
      expect(prisma.monthClosure.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ note: null }) }),
      );
    });
  });

  describe('opening', () => {
    it('404 when it is not closed', async () => {
      const { svc } = makeService();
      await expect(svc.reopen(OWNER, '2026-08', 'ip')).rejects.toThrow(NotFoundException);
    });

    /**
     * The audit row for opening must hold the old closing details — the row
     * is deleted from the DB, so this is the only place where "who closed it
     * and when" survives. Without it, the history of changing numbers after
     * pay by reopening the month would be incomplete.
     */
    it('the opening record keeps the old closing details', async () => {
      const { svc, audit } = makeService({
        '2026-08': { closedAt: new Date('2026-09-01T09:00:00Z'), closedBy: 'first@example.com', note: null },
      });

      await svc.reopen(OWNER, '2026-08', 'ip');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'month_reopened',
          meta: expect.objectContaining({ closedBy: 'first@example.com' }),
        }),
      );
    });
  });
});
