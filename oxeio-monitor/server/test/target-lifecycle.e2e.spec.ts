import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TargetsService } from '../src/targets/targets.service';
import { createHarness, resetDatabase, workNoon, type Harness } from './setup/harness';
let h: Harness;
let service: TargetsService;
beforeAll(async () => { h = await createHarness(); service = h.app.get(TargetsService); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await resetDatabase(h.prisma, h.app); });
async function target(status: 'done' | 'assigned' = 'done') {
  const owner = await h.prisma.user.findFirstOrThrow();
  const old = new Date(workNoon().getTime() - 2 * 86400000);
  const row = await h.prisma.designTarget.create({ data: {
    asin: 'B012345678', addedById: owner.id, status,
    completedAt: status === 'done' ? old : null,
    completedById: status === 'done' ? owner.id : null,
    completedVia: status === 'done' ? 'manual' : null,
  } });
  return { row, owner, old };
}
describe('A03–A05 target lifecycle regressions', () => {
  it('repeated Done preserves the completion date and attribution', async () => {
    const { row, owner, old } = await target();
    await expect(service.update(row.id, 'done', workNoon(), owner.id)).resolves.toEqual({ ok: true });
    const after = await h.prisma.designTarget.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.completedAt).toEqual(old);
    expect(after.completedById).toBe(row.completedById);
    expect(await service.update(999999, 'done', workNoon(), owner.id)).toEqual({ ok: false });
  });
  it('returning to the pool clears every dependent production stage', async () => {
    const { row, owner, old } = await target();
    await h.prisma.designTarget.update({ where: { id: row.id }, data: {
      checkedAt: old, checkedById: owner.id, errorFoundAt: old,
      fixedAt: old, fixedById: owner.id, uploadedAt: old, liveAt: old, liveAsin: 'B987654321',
    } });
    await service.update(row.id, 'pool', workNoon(), owner.id);
    const after = await h.prisma.designTarget.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('pool');
    for (const key of ['assignedToId', 'assignedAt', 'startedAt', 'completedAt', 'completedById', 'completedVia', 'checkedAt', 'checkedById', 'errorFoundAt', 'fixedAt', 'fixedById', 'uploadedAt', 'liveAt', 'liveAsin'] as const) {
      expect(after[key], key).toBeNull();
    }
  });
  it('does not overwrite completion committed while the delete waits for a row lock', async () => {
    const { row, owner } = await target('assigned');
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const completion = h.prisma.$transaction(async (tx) => {
      await tx.designTarget.update({ where: { id: row.id }, data: { status: 'done', completedAt: workNoon() } });
      ready();
      await gate;
    }, { timeout: 15000 });
    await locked;
    const deletion = service.softDelete([row.id], owner.id, '127.0.0.1', 'not_found');
    // Observe PostgreSQL blocking the actual DELETE-status update, not a guessed delay.
    try {
      let waiting = false;
      for (let i = 0; i < 60; i++) {
        const rows = await h.prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query LIKE '%design_targets%') AS waiting`;
        if (rows[0]?.waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally { release(); }
    await completion;
    expect(await deletion).toEqual({ deleted: 0, keptDone: 1 });
    expect((await h.prisma.designTarget.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('done');
    expect(await h.prisma.auditLog.count({ where: { action: 'design_deleted' } })).toBe(0);
  });
});
