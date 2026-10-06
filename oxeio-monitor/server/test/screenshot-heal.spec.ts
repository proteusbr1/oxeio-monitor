import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Prisma, type Device } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ClockDriftService,
  Drift,
} from '../src/agent/clock-drift.service';
import type { ScreenshotMetaDto } from '../src/agent/dto';
import { ScreenshotIngestService } from '../src/agent/screenshot-ingest.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { LocalScreenshotStorage } from '../src/storage/local.storage';

/**
 * G81: "the row exists" and "the file exists" are not the same thing.
 *
 * This file comes from a field bug, and the bug was completely silent. On the
 * VPS the gallery showed *"10 this day"*, yet all ten were broken icons: the
 * row exists, the file does not.
 *
 * What happened:
 *
 * ```
 * disk write fails -> agent retries -> DB says "row exists" (P2002)
 *                  -> server returns { accepted: 0, duplicate: true }
 *                  -> agent deletes the image from its outbox -> lost for good
 * ```
 *
 * It can be tested without a DB, because both questions here are about I/O:
 * whether the file is on disk, and whether it gets put there if not. So
 * Prisma is faked but the file system is real; otherwise the test would not
 * measure the very thing that broke.
 */

const DRIFT: Drift = { skewMs: 0, corrected: false } as unknown as Drift;

const DEVICE = { id: 61, employeeId: 3 } as unknown as Device;

const META: ScreenshotMetaDto = {
  clientUuid: '11111111-2222-3333-4444-555555555555',
  capturedAt: '2026-08-13T13:29:54.000Z',
  slotStart: '2026-08-13T13:25:00.000Z',
  monitorIndex: 0,
  width: 1920,
  height: 1080,
} as unknown as ScreenshotMetaDto;

function webp(bytes = 1234): Express.Multer.File {
  return {
    mimetype: 'image/webp',
    size: bytes,
    buffer: Buffer.alloc(bytes, 7),
  } as unknown as Express.Multer.File;
}

/** P2002: Prisma's UNIQUE violation error exactly, because the code recognises that */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oxeio-shot-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeService(prisma: Partial<PrismaService>): ScreenshotIngestService {
  const storage = new LocalScreenshotStorage(root);

  // clock correction is irrelevant here: return whatever came in
  const clock = {
    correct: (value: string) => new Date(value),
  } as unknown as ClockDriftService;

  return new ScreenshotIngestService(prisma as PrismaService, clock, storage);
}

describe('G81: can storage be written at startup', () => {
  it('when writable, it starts up quietly', async () => {
    const svc = makeService({});
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('creates the folder if missing: that is not a failure', async () => {
    const nested = join(root, 'a', 'b', 'c');
    const storage = new LocalScreenshotStorage(nested);
    const svc = new ScreenshotIngestService(
      {} as PrismaService,
      {} as ClockDriftService,
      storage,
    );

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    await expect(stat(nested)).resolves.toBeTruthy();
  });

  /**
   * This is the most important test in this file. In exactly this state the
   * server used to start up happily and silently lose every screenshot.
   *
   * It is measured with a real read-only folder, not a faked `access()`:
   * `access(W_OK)` can succeed and writing can still be blocked later, and
   * that gap is exactly what is being fixed.
   */
  // Skipped on Windows, and the reason is the OS, not the test: `chmod 0o555`
  // does not make a folder read-only there (there are no POSIX bits), so the
  // write succeeds and the test shows red. CI runs on Linux, where this is the
  // real guard. Without the skip, `npm run test:nodb` on Windows would always
  // show one red test, and "one is always red" is how a real red gets overlooked.
  it.skipIf(process.platform === 'win32')(
    'when it cannot be written it stops loudly, and the message says how to fix it',
    async () => {
      const locked = join(root, 'locked');
      await mkdir(locked, { recursive: true });
      // dr-xr-xr-x: can enter, cannot write
      await import('node:fs/promises').then((fs) => fs.chmod(locked, 0o555));

      const storage = new LocalScreenshotStorage(locked);
      const svc = new ScreenshotIngestService(
        {} as PrismaService,
        {} as ClockDriftService,
        storage,
      );

      await expect(svc.onModuleInit()).rejects.toThrow(
        /Screenshot storage is not writable/,
      );
      // The message does not just say "broken", it says what to do: otherwise
      // nobody would catch the Docker uid trap
      await expect(svc.onModuleInit()).rejects.toThrow(/chown -R 1000:1000/);
    },
  );
});

describe('G81: the duplicate path: row exists, file does not', () => {
  /**
   * A real duplicate: the row exists and so does the file. The agent may delete
   * it from the queue without worry: this is the old behaviour, and it is correct.
   */
  it('when the file is on disk, it reports a real duplicate', async () => {
    const existingPath = 'screenshots/2026/08/13/emp-003/192954_m0.webp';
    await mkdir(join(root, 'screenshots/2026/08/13/emp-003'), {
      recursive: true,
    });
    await writeFile(join(root, existingPath), Buffer.from('already here'));

    const findFirst = vi.fn().mockResolvedValue({
      id: 500n,
      filePath: existingPath,
      thumbPath: 'screenshots/2026/08/13/emp-003/192954_m0.thumb.webp',
    });
    const svc = makeService({
      screenshot: {
        create: vi.fn().mockRejectedValue(uniqueViolation()),
        findFirst,
      },
    } as unknown as Partial<PrismaService>);

    const result = await svc.ingest(DEVICE, DRIFT, META, webp());

    expect(result).toEqual({
      accepted: 0,
      duplicate: true,
      path: existingPath,
      thumbPath: 'screenshots/2026/08/13/emp-003/192954_m0.thumb.webp',
    });
    // the file was not touched at all
    await expect(readFile(join(root, existingPath), 'utf8')).resolves.toBe(
      'already here',
    );
  });

  /**
   * The core test: this failed before the fix.
   */
  it('when the file is missing it puts the bytes there, and reports success', async () => {
    const existingPath = 'screenshots/2026/08/13/emp-003/192954_m0.webp';

    const svc = makeService({
      screenshot: {
        create: vi.fn().mockRejectedValue(uniqueViolation()),
        findFirst: vi.fn().mockResolvedValue({
          id: 500n,
          filePath: existingPath,
          thumbPath: null,
        }),
      },
    } as unknown as Partial<PrismaService>);

    const result = await svc.ingest(DEVICE, DRIFT, META, webp(99));

    // accepted: 1, because from the agent's side the bytes arrived just now
    expect(result.accepted).toBe(1);
    expect(result.duplicate).toBe(false);
    expect(result.path).toBe(existingPath);

    const written = await readFile(join(root, existingPath));
    expect(written).toHaveLength(99);
  });

  /**
   * The subtlest test. On a retry, if the seconds of `captured_at` differ, the
   * computed file name differs too. Writing to the new path would leave the row
   * pointing at one file and the bytes in another: re-creating exactly the
   * mismatch that is being fixed.
   */
  it('writes to the row\'s own path, not to a freshly computed one', async () => {
    const rowPath = 'screenshots/2026/08/13/emp-003/000001_m0.webp';

    const svc = makeService({
      screenshot: {
        create: vi.fn().mockRejectedValue(uniqueViolation()),
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 7n, filePath: rowPath, thumbPath: null }),
      },
    } as unknown as Partial<PrismaService>);

    const result = await svc.ingest(DEVICE, DRIFT, META, webp());

    expect(result.path).toBe(rowPath);
    await expect(stat(join(root, rowPath))).resolves.toBeTruthy();
  });

  /**
   * The row was deleted in the meantime (the retention job, or someone by
   * hand). Rare, but then there is nothing to repair, and above all it must not
   * throw: otherwise the agent would get a 500 and retry the same image forever.
   */
  it('when the row itself is not found, it falls back to the old behaviour, no throw', async () => {
    const svc = makeService({
      screenshot: {
        create: vi.fn().mockRejectedValue(uniqueViolation()),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as Partial<PrismaService>);

    const result = await svc.ingest(DEVICE, DRIFT, META, webp());

    expect(result.accepted).toBe(0);
    expect(result.duplicate).toBe(true);
  });

  /** Errors other than P2002 must not be swallowed */
  it('any other DB error is not suppressed', async () => {
    const svc = makeService({
      screenshot: {
        create: vi.fn().mockRejectedValue(new Error('connection lost')),
        findFirst: vi.fn(),
      },
    } as unknown as Partial<PrismaService>);

    await expect(svc.ingest(DEVICE, DRIFT, META, webp())).rejects.toThrow(
      'connection lost',
    );
  });
});
