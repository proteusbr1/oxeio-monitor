import { setWorkTimeZone } from '../src/lib/format';

/**
 * Every test runs in a fixed work zone ahead of UTC, so the fixed instants in
 * the specs (e.g. 20:00 UTC = 02:00 the next day) keep their meaning whatever
 * the product default is (UTC) and whatever zone the machine running the
 * tests is in.
 *
 * `Etc/GMT-6` is UTC+6 with no place attached — the POSIX sign is inverted, so
 * GMT-6 means six hours *ahead* of UTC. A zone ahead of UTC is chosen on
 * purpose: between midnight and 06:00 local the UTC date is still the
 * previous day, which is exactly where `toISOString().slice(0, 10)` bugs hide.
 * It has no daylight saving, so the offset is the same all year.
 *
 * Specs that need another zone set it themselves (`work-timezone.spec.ts`).
 */
export const TEST_WORK_ZONE = { timeZone: 'Etc/GMT-6', utcOffsetMinutes: 360 };

setWorkTimeZone(TEST_WORK_ZONE);
