import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TasksService } from '../src/tasks/tasks.service';
import { createHarness, resetDatabase, workNoon, type Harness } from './setup/harness';

let h: Harness;
let service: TasksService;

beforeAll(async () => {
  h = await createHarness();
  service = h.app.get(TasksService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

async function task(status: 'done' | 'assigned' = 'done') {
  const owner = await h.prisma.user.findFirstOrThrow();
  const old = new Date(workNoon().getTime() - 2 * 86400000);
  const row = await h.prisma.task.create({
    data: {
      reference: 'INV-1001',
      link: 'https://example.com/inv/1001',
      addedById: owner.id,
      status,
      completedAt: status === 'done' ? old : null,
      completedById: status === 'done' ? owner.id : null,
      completedVia: status === 'done' ? 'manual' : null,
    },
  });
  return { row, owner, old };
}

describe('task lifecycle regressions', () => {
  it('repeated Done preserves the completion date and attribution', async () => {
    const { row, owner, old } = await task();

    await expect(service.update(row.id, 'done', workNoon(), owner.id)).resolves.toEqual({ ok: true });

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.completedAt).toEqual(old);
    expect(after.completedById).toBe(row.completedById);
    expect(await service.update(999999, 'done', workNoon(), owner.id)).toEqual({ ok: false });
  });

  it('returning to the pool clears every dependent stage', async () => {
    const { row, owner, old } = await task();
    await h.prisma.task.update({
      where: { id: row.id },
      data: {
        checkedAt: old,
        checkedById: owner.id,
        errorFoundAt: old,
        fixedAt: old,
        fixedById: owner.id,
        deliveredAt: old,
        publishedAt: old,
        publishedRef: 'ORDER-55',
      },
    });

    await service.update(row.id, 'pool', workNoon(), owner.id);

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('pool');
    for (const key of [
      'assignedToId',
      'assignedAt',
      'startedAt',
      'completedAt',
      'completedById',
      'completedVia',
      'checkedAt',
      'checkedById',
      'errorFoundAt',
      'fixedAt',
      'fixedById',
      'deliveredAt',
      'publishedAt',
      'publishedRef',
    ] as const) {
      expect(after[key], key).toBeNull();
    }
    // The identity of the task is kept
    expect(after.reference).toBe('INV-1001');
    expect(after.link).toBe('https://example.com/inv/1001');
  });

  it('does not overwrite completion committed while the delete waits for a row lock', async () => {
    const { row, owner } = await task('assigned');
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((r) => {
      ready = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const completion = h.prisma.$transaction(
      async (tx) => {
        await tx.task.update({
          where: { id: row.id },
          data: { status: 'done', completedAt: workNoon() },
        });
        ready();
        await gate;
      },
      { timeout: 15000 },
    );
    await locked;

    const deletion = service.softDelete([row.id], owner.id, '127.0.0.1', 'not_needed');

    // Observe PostgreSQL blocking the actual status update, not a guessed delay.
    // Prisma quotes table names, so `"tasks"` matches the update on this table only.
    try {
      let waiting = false;
      for (let i = 0; i < 60; i++) {
        const rows = await h.prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query LIKE '%"tasks"%') AS waiting`;
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
    }

    await completion;
    expect(await deletion).toEqual({ deleted: 0, keptDone: 1 });
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('done');
    expect(await h.prisma.auditLog.count({ where: { action: 'task_deleted' } })).toBe(0);
  });
});
