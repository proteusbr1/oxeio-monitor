import { BadRequestException } from '@nestjs/common';

import { workDateOf } from '../agent/util/work-time';
import { parseWorkDate } from './dashboard.math';

/**
 * Careful: without `date`, today in the work zone — not the server's. If the server runs
 *    in UTC, between local midnight and the zone's offset hour (6 am in a UTC+6 zone)
 *    the date of `new Date()` would show the previous day.
 */
export function resolveWorkDate(raw?: string): Date {
  if (raw === undefined) return workDateOf(new Date());

  const parsed = parseWorkDate(raw);
  if (!parsed) {
    throw new BadRequestException('date must be a valid YYYY-MM-DD date');
  }
  return parsed;
}
