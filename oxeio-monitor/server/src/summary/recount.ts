import type { PrismaClient } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';

/**
 * Which days to count again after a rule that changes credited time (a
 * policy's measure): the months that may still be open — last month and this
 * one. Closed months are skipped by the dirty drain itself, so asking for
 * them is harmless; older months are closed or paid, and stay as they are.
 */
export function datesToRecount(today: Date): Date[] {
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1);
  const end = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const out: Date[] = [];
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t));
  return out;
}

/**
 * Queues days for the dirty drain (`SummaryService.drainDirty`) after
 * something they were counted from changed: a policy's measure or schedule,
 * leave, a holiday, a person's first or last day. The one place that writes
 * `summary_dirty` for such changes.
 *
 * Only days up to today: a day still to come has nothing to count, and
 * counting it would store an empty day ahead of time. A day already queued
 * stays queued once (`skipDuplicates`).
 */
export async function markDirty(
  prisma: { summaryDirty: Pick<PrismaClient['summaryDirty'], 'createMany'> },
  dates: readonly Date[],
  now: Date = new Date(),
): Promise<void> {
  const today = workDateOf(now).getTime();
  const times = [...new Set(dates.map((d) => d.getTime()))].filter(
    (t) => t <= today,
  );
  if (times.length === 0) return;
  await prisma.summaryDirty.createMany({
    data: times.map((t) => ({ workDate: new Date(t) })),
    skipDuplicates: true,
  });
}
