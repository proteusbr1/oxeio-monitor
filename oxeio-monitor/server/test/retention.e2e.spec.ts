import { randomUUID } from 'node:crypto';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/dhaka-time';
import { RetentionJob } from '../src/summary/retention.job';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  dhakaNoon,
} from './setup/harness';

/**
 * K01: the job that deletes screenshots older than 90 days.
 *
 * Why these tests were needed: the job was written and `@Cron` was in place,
 * but the job body had never been run: there was not a single test. Yet the
 * policy tells staff in writing that "screenshots delete themselves after 90
 * days". If that does not happen it is a broken promise, and it would only
 * be noticed when the disk fills up, about a year later.
 *
 * This file writes and deletes real files (`STORAGE_ROOT` ->
 * `server/test/.tmp-test-storage`, set in vitest.config.ts). With a mocked fs,
 * exactly the things that can go wrong (path arithmetic, folders becoming
 * empty, ENOENT) would not be tested at all.
 */
let h: Harness;
let job: RetentionJob;
let employeeId: number;
let deviceId: number;
let root: string;

/** A screenshot row plus real files on disk (full image + thumb) */
async function makeShot(opts: {
  daysAgo: number;
  deletedAt?: Date | null;
  /** whether the files really get written to disk: to fake an incomplete earlier run */
  writeFiles?: boolean;
  /** path override: to build the unsafe case by slipping in `..` */
  filePath?: string;
}): Promise<{ id: bigint; filePath: string; thumbPath: string }> {
  /**
   * `work_date` must be set by the Dhaka calculation, not UTC.
   *
   * The job's cutoff `retentionCutoff()` = `workDateOf(now) - 90 days`, i.e.
   * it uses the Dhaka workday. The fixture used to take the UTC date from
   * `Date.now()`, and between midnight and 6am (Dhaka is UTC+6) the UTC date
   * is a day behind. So `daysAgo: 90` really built a row 91 Dhaka days old,
   * and the boundary test failed every night in those six hours.
   *
   * It was caught exactly that way: by running at 00:30. Run in the daytime,
   * it would have stayed green forever.
   */
  const when = dhakaNoon(-opts.daysAgo);
  const day = workDateOf(when).toISOString().slice(0, 10);
  const uuid = randomUUID();

  const filePath = opts.filePath ?? `${day.replace(/-/g, '/')}/emp-001/${uuid}.webp`;
  const thumbPath = `${day.replace(/-/g, '/')}/emp-001/thumb/${uuid}.webp`;

  if (opts.writeFiles !== false) {
    for (const rel of [filePath, thumbPath]) {
      const abs = resolve(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, 'x');
    }
  }

  const row = await h.prisma.screenshot.create({
    data: {
      employeeId,
      deviceId,
      clientUuid: uuid,
      workDate: new Date(`${day}T00:00:00Z`),
      slotStart: when,
      capturedAt: when,
      filePath,
      thumbPath,
      deletedAt: opts.deletedAt ?? null,
    },
  });

  return { id: row.id, filePath, thumbPath };
}

const exists = async (rel: string): Promise<boolean> => {
  try {
    await access(resolve(root, rel));
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  h = await createHarness();
  job = h.app.get(RetentionJob);
  root = resolve(process.env.STORAGE_ROOT ?? join(process.cwd(), '..', '.data', 'storage'));
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const { code } = await createEmployeeWithCode(h.prisma);
  const device = await enrollDevice(h, code);
  employeeId = device.employeeId;
  deviceId = device.deviceId;
});

describe('retention job: the body really runs', () => {
  it('a screenshot older than 90 days: the row and both files on disk go', async () => {
    const old = await makeShot({ daysAgo: 120 });

    const result = await job.runOnce();

    expect(result.skipped).toBe(false);
    expect(result.marked).toBe(1);
    // A06: two files, the full image and the thumbnail. If only the full one
    // were deleted this number would be 1, and the thumb/ folder would stay on disk forever.
    expect(result.filesDeleted).toBe(2);
    expect(result.rowsDeleted).toBe(1);
    expect(result.failed).toBe(0);

    expect(await exists(old.filePath)).toBe(false);
    expect(await exists(old.thumbPath)).toBe(false);
    expect(await h.prisma.screenshot.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('a recent screenshot is not even touched', async () => {
    const fresh = await makeShot({ daysAgo: 10 });

    const result = await job.runOnce();

    expect(result.marked).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    expect(await exists(fresh.filePath)).toBe(true);

    const row = await h.prisma.screenshot.findUnique({ where: { id: fresh.id } });
    expect(row?.deletedAt).toBeNull();
  });

  /**
   * Just either side of the boundary. `retentionCutoff` goes back 90 days from
   * today's Dhaka date and the condition is `workDate < cutoff`, so a
   * screenshot exactly 90 days old stays and a 91-day-old one goes. Writing
   * `<=` would give 89 days instead of the promised 90, and nobody would notice.
   */
  it('exactly 90 days old stays, 91 days old goes', async () => {
    const ninety = await makeShot({ daysAgo: 90 });
    const ninetyOne = await makeShot({ daysAgo: 91 });

    await job.runOnce();

    expect(await h.prisma.screenshot.findUnique({ where: { id: ninety.id } })).not.toBeNull();
    expect(await h.prisma.screenshot.findUnique({ where: { id: ninetyOne.id } })).toBeNull();
  });

  /**
   * The core claim of the job's design: if the process dies midway, a marked
   * row is left behind and the next run finishes from there. Here that state
   * is built by hand: `deleted_at` set, but the files already gone.
   */
  it('finishes what an earlier incomplete run left (no file = success)', async () => {
    const half = await makeShot({
      daysAgo: 120,
      deletedAt: dhakaNoon(),
      writeFiles: false,
    });

    const result = await job.runOnce();

    // the mark was already done, so nothing new is marked in this run
    expect(result.marked).toBe(0);
    expect(result.filesMissing).toBe(2);
    expect(result.filesDeleted).toBe(0);
    expect(result.rowsDeleted).toBe(1);
    expect(await h.prisma.screenshot.findUnique({ where: { id: half.id } })).toBeNull();
  });

  it('running a second time changes nothing (idempotent)', async () => {
    await makeShot({ daysAgo: 120 });

    const first = await job.runOnce();
    const second = await job.runOnce();

    expect(first.rowsDeleted).toBe(1);
    expect(second.marked).toBe(0);
    expect(second.rowsDeleted).toBe(0);
    expect(second.filesDeleted).toBe(0);
    expect(second.failed).toBe(0);
  });

  /**
   * The most important test. `file_path` is a database column; if a `..` got
   * in, the job would `unlink` a file outside storage. The row is kept on
   * purpose: deleting it would lose the report of the problem.
   */
  it('does not touch a path outside the storage root, and keeps the row', async () => {
    const evilRel = '../outside-the-root.webp';
    const evilAbs = resolve(root, evilRel);
    await writeFile(evilAbs, 'do-not-delete-me');

    try {
      const bad = await makeShot({
        daysAgo: 120,
        filePath: evilRel,
        writeFiles: false,
      });

      const result = await job.runOnce();

      expect(result.unsafePaths).toBe(1);
      expect(result.rowsDeleted).toBe(0);
      // the file is still there
      await expect(access(evilAbs)).resolves.toBeUndefined();
      // the row too: it will complain again on the next run
      expect(await h.prisma.screenshot.findUnique({ where: { id: bad.id } })).not.toBeNull();
    } finally {
      // This one file is deliberately written outside `STORAGE_ROOT`, so it
      // does not go with the deletion of `.tmp-test-storage/`, and that folder
      // is what git ignores. If we did not delete it ourselves it would be left in `server/`.
      await unlink(evilAbs).catch(() => {});
    }
  });

  /**
   * The path is `.../YYYY/MM/DD/emp-001/` and the thumb is `.../emp-001/thumb/`.
   * If the deepest folder is not removed first, `emp-001` would be stuck on
   * ENOTEMPTY forever.
   */
  it('also removes folders that have become empty', async () => {
    const old = await makeShot({ daysAgo: 120 });
    const dayDir = dirname(dirname(old.filePath)); // …/YYYY/MM/DD

    await job.runOnce();

    expect(await exists(dirname(old.thumbPath))).toBe(false);
    expect(await exists(dirname(old.filePath))).toBe(false);
    expect(await exists(dayDir)).toBe(false);
  });
});

describe('POST /ops/retention/run', () => {
  it('the owner can run it by hand', async () => {
    const old = await makeShot({ daysAgo: 120 });
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post('/api/v1/ops/retention/run')
      .set('X-CSRF-Token', s.csrf)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(false);
    expect(res.body.marked).toBe(1);
    expect(res.body.rowsDeleted).toBe(1);
    expect(await h.prisma.screenshot.findUnique({ where: { id: old.id } })).toBeNull();
  });

  /**
   * The CSRF token is sent on purpose: otherwise CSRF would answer 403 and
   * the test would pass for the wrong reason; the role guard would never be tested.
   */
  it('a manager cannot: the whole controller is owner-only', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    const res = await s.http
      .post('/api/v1/ops/retention/run')
      .set('X-CSRF-Token', s.csrf)
      .send({});

    expect(res.status).toBe(403);
  });

  it('cannot be run without logging in', async () => {
    const res = await h.http().post('/api/v1/ops/retention/run').send({});
    expect(res.status).toBe(401);
  });
});
