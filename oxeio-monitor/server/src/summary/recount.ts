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
