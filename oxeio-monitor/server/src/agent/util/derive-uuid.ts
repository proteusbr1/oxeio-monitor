import { createHash } from 'node:crypto';

/**
 * When a record is split at midnight, each piece needs its own `client_uuid`,
 * but the column is UNIQUE and dedupe relies on it (§ 2.1-d).
 *
 * So the id is **deterministic**, not random: if the agent resends the same
 * record, the pieces get exactly the same ids and `ON CONFLICT DO NOTHING`
 * works as intended.
 *
 * Index 0 keeps the original id, so records that are not split stay unchanged.
 */
export function deriveUuid(base: string, index: number): string {
  if (index === 0) return base;

  const digest = createHash('sha256').update(`${base}:${index}`).digest();
  const b = Buffer.from(digest.subarray(0, 16));

  // Shape it like a UUID v4 (it is not actually random, but it must follow the
  // format to fit Postgres's uuid type).
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;

  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
