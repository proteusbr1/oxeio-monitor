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

/**
 * The real client IP behind the proxy.
 *
 * This file guards against two bugs:
 *
 * 1. The login lock became a single bucket. The throttle counts per IP
 *    (G116), but because Express did not trust the proxy, `req.ip` was the
 *    address of the Caddy container, the same for everyone. So 50 wrong
 *    logins from anywhere locked out the whole office, owner included.
 *
 * 2. The IP in the audit log was meaningless. For the question "who looked
 *    at my screenshots" (I08), every row carried the same internal address.
 *    Counted in the field: all 494 rows over 7 days had `172.18.0.4`.
 *
 * Why unit tests were not enough: `LoginThrottleService` itself was always
 * correct, and `login-throttle-ip.spec.ts` proved that. The gap was at the
 * seam, in which number Express puts in `req.ip`. This repo has had bugs in
 * exactly this shape again and again: the rule is right, the plumbing wrong.
 */
let h: Harness;
let owner: Session;

/** Two different public IPs for testing (RFC 5737, documentation range) */
const ALICE = '203.0.113.9';
const BOB = '198.51.100.4';

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

/**
 * Viewing payroll is an audited event (`payroll_view`), so it is the easiest
 * way to learn which IP the server wrote.
 */
async function viewPayrollFrom(ip: string): Promise<void> {
  await owner.http
    .get('/api/v1/payroll?month=2026-08')
    .set('X-Forwarded-For', ip)
    .expect(200);
}

const lastAuditIp = async (): Promise<string | null> => {
  const row = await h.prisma.auditLog.findFirst({
    where: { action: 'payroll_view' },
    orderBy: { occurredAt: 'desc' },
    select: { ipAddress: true },
  });
  return row?.ipAddress ?? null;
};

describe('the real IP behind the proxy', () => {
  /**
   * The main test of this file. The IP the proxy sends is what lands in the
   * audit log, not the proxy's own address.
   */
  it('the IP from `X-Forwarded-For` lands in the audit log', async () => {
    await viewPayrollFrom(ALICE);

    expect(await lastAuditIp()).toBe(ALICE);
  });

  /**
   * Careful: the second test is the real guard. The first alone could stay
   * green even by returning a constant. Whether two different IPs write
   * different rows proves the value really is the client's.
   */
  it('different clients write different IPs', async () => {
    await viewPayrollFrom(ALICE);
    const first = await lastAuditIp();

    await viewPayrollFrom(BOB);
    const second = await lastAuditIp();

    expect(first).toBe(ALICE);
    expect(second).toBe(BOB);
    expect(first).not.toBe(second);
  });

  /**
   * Careful: more than one hop is not trusted, and that is the security
   * boundary. The more hops `trust proxy` trusts, the deeper a client can
   * forge `X-Forwarded-For`; it could then pick its own IP and dodge the login
   * lock.
   *
   * If the client adds a fake hop itself, Express steps back exactly one
   * place from the right: not the first name the client put there, but the one
   * just before the real connection.
   */
  it('an extra forged hop is not trusted', async () => {
    await owner.http
      .get('/api/v1/payroll?month=2026-08')
      // The client claims to be 10.0.0.1, and the proxy wrote its real IP
      .set('X-Forwarded-For', `10.0.0.1, ${ALICE}`)
      .expect(200);

    expect(await lastAuditIp()).toBe(ALICE);
  });

  /**
   * With no header it is the direct connection's address: that is exactly
   * what happens in development and tests, and nothing should break there.
   */
  it('without the header, the direct connection address', async () => {
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(200);

    const ip = await lastAuditIp();
    expect(ip).not.toBeNull();
    expect(ip).not.toBe(ALICE);
  });
});
