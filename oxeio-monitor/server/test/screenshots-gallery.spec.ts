import { describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import {
  formatWorkDate,
  GALLERY_PAGE_SIZE,
  pageSlice,
  parseWorkDate,
} from '../src/screenshots/gallery.math';

/**
 * E06: the gallery's pure calculations.
 *
 * Dates and pagination are both places where a mistake raises no exception;
 * you just see the wrong screenshots (or fewer of them).
 */

describe('gallery date parsing', () => {
  it('UTC midnight from YYYY-MM-DD: what Prisma\'s @db.Date wants', () => {
    const d = parseWorkDate('2026-08-10');
    expect(d?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  /**
   * The gallery looks for exactly the value ingest sets as `work_date`
   * (workDateOf); otherwise rows exist but the gallery is empty and nobody would know why.
   */
  it('matches exactly what ingest\'s workDateOf sets', () => {
    // 9am Dhaka on 10 August = 03:00 UTC
    const captured = new Date('2026-08-10T03:00:00.000Z');
    expect(parseWorkDate('2026-08-10')?.getTime()).toBe(
      workDateOf(captured).getTime(),
    );
  });

  it('a screenshot at 11pm Dhaka is still that day, though it is the next day in UTC', () => {
    // 11pm Dhaka on 10 August = 17:00 UTC on 10 August (same day)
    // 00:30 Dhaka on 11 August = 18:30 UTC on 10 August; but the capture
    // window is 07:00-23:00, so this does not happen in practice. Still, the boundary is matched.
    const late = new Date('2026-08-10T16:59:00.000Z'); // 22:59 Dhaka
    expect(formatWorkDate(workDateOf(late))).toBe('2026-08-10');
  });

  /**
   * This is the most useful test. The regex lets `2026-02-30` through, and
   * `Date.UTC(2026, 1, 30)` silently makes 2 March: a user asking for February
   * screenshots would get March ones, with no error.
   */
  it.each([
    ['2026-02-30', 'ফেব্রুয়ারিতে ৩০ তারিখ নেই'],
    ['2026-13-01', '১৩তম মাস নেই'],
    ['2026-00-10', '০ নম্বর মাস নেই'],
    ['2026-08-00', '০ তারিখ নেই'],
    ['2026-08-32', '৩২ তারিখ নেই'],
    ['2025-02-29', '২০২৫ লিপ ইয়ার নয়'],
  ])('%s rejected: %s', (iso) => {
    expect(parseWorkDate(iso)).toBeNull();
  });

  it('29 February of a leap year is valid', () => {
    expect(parseWorkDate('2028-02-29')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it.each(['2026-8-10', '10-08-2026', '2026/08/10', '', 'আজ'])(
    'null when the format is wrong: %s',
    (iso) => {
      expect(parseWorkDate(iso)).toBeNull();
    },
  );
});

describe('gallery pagination', () => {
  it('the first page starts from zero', () => {
    const s = pageSlice(1, 200);
    expect(s.skip).toBe(0);
    expect(s.take).toBe(GALLERY_PAGE_SIZE);
  });

  /**
   * Pages are counted from 1, skip from 0. An off-by-one would mean the first
   * page's screenshots never appear on any page.
   */
  it('the second page starts exactly one page later', () => {
    expect(pageSlice(2, 200).skip).toBe(GALLERY_PAGE_SIZE);
    expect(pageSlice(3, 200).skip).toBe(2 * GALLERY_PAGE_SIZE);
  });

  it('total pages: rounds up when it does not divide evenly', () => {
    expect(pageSlice(1, GALLERY_PAGE_SIZE).totalPages).toBe(1);
    expect(pageSlice(1, GALLERY_PAGE_SIZE + 1).totalPages).toBe(2);
  });

  /** "Page 1 / 0" must not be shown: even with no screenshots there is one page */
  it('with no screenshots at all, totalPages is 1', () => {
    expect(pageSlice(1, 0).totalPages).toBe(1);
  });

  it('asking past the last page gives a big skip: an empty list, not an error', () => {
    const s = pageSlice(10, 5);
    expect(s.skip).toBe(9 * GALLERY_PAGE_SIZE);
    expect(s.totalPages).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'a strange page number (%s) is brought down to 1',
    (page) => {
      const s = pageSlice(page, 200);
      expect(s.page).toBe(1);
      expect(s.skip).toBe(0);
    },
  );
});
