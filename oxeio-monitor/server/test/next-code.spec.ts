import { describe, expect, it } from 'vitest';

import { nextEmployeeCode } from '../src/staff/next-code';

/**
 * Suggesting the next staff code.
 *
 * A mistake in this function is silent: if it suggests a wrong code, saving
 * gives 409 and the owner thinks the system is broken — when the number was
 * just one too low. So boundary cases dominate here.
 */
describe('nextEmployeeCode', () => {
  it('OX-001 when there is nobody', () => {
    expect(nextEmployeeCode([])).toBe('OX-001');
  });

  it('continues in sequence', () => {
    expect(nextEmployeeCode(['OX-001', 'OX-002'])).toBe('OX-003');
  });

  /**
   * The real-data case. The owner's list has two styles side by side —
   * `OX-001` (set by hand) and `OX-01` ... `OX-12` (from the seed).
   *
   * Taking "the widest one" would make the next `OX-013`, jumping out of the
   * running sequence. It should continue from where they stopped.
   */
  it('with mixed widths it follows the style of the largest number', () => {
    const codes = ['OX-001', 'OX-01', 'OX-02', 'OX-11', 'OX-12'];
    expect(nextEmployeeCode(codes)).toBe('OX-13');
  });

  it('even when out of order, the largest is the basis', () => {
    expect(nextEmployeeCode(['OX-07', 'OX-02', 'OX-11', 'OX-05'])).toBe('OX-12');
  });

  /** 99 -> 100: when the width is exceeded it must not be truncated */
  it('when the width is exceeded the number just grows', () => {
    expect(nextEmployeeCode(['OX-99'])).toBe('OX-100');
    expect(nextEmployeeCode(['OX-999'])).toBe('OX-1000');
  });

  /**
   * Codes that are not numeric can exist (`ADMIN`, `OX_5`, `INTERN-A`) —
   * they are skipped, otherwise `NaN` would produce `OX-NaN`.
   */
  it('codes that do not fit the pattern are skipped', () => {
    expect(nextEmployeeCode(['ADMIN', 'INTERN-A', 'OX-04', 'X'])).toBe('OX-05');
  });

  it('when every code is outside the pattern, start from the beginning', () => {
    expect(nextEmployeeCode(['ADMIN', 'BOSS'])).toBe('OX-001');
  });

  /**
   * The prefix is the most common one, not the one on the largest code.
   *
   * If someone once entered `TMP-99`, every later suggestion would become
   * `TMP-` while everyone else is `OX-`.
   */
  it('the prefix takes the common one, not the outlier', () => {
    const codes = ['OX-01', 'OX-02', 'OX-03', 'TMP-99'];
    expect(nextEmployeeCode(codes)).toBe('OX-100');
  });

  it('with another prefix it keeps that one', () => {
    expect(nextEmployeeCode(['EMP-05', 'EMP-06'])).toBe('EMP-07');
  });

  /** There can be leading/trailing spaces (hand-entered data) */
  it('trims whitespace', () => {
    expect(nextEmployeeCode([' OX-07 '])).toBe('OX-08');
  });

  /**
   * An inactive staff member's code must be counted too — otherwise a
   * dismissed person's code would be suggested again, and saving would give
   * 409. Yet on screen (with the active filter) nobody with that code would
   * be visible, so the cause could not be understood.
   *
   * The function itself does not know active/inactive — it is the caller's
   * responsibility to send all codes. That is done in `employees.service.ts`
   * with a query without a `where`.
   */
  it('everything given in the list is counted', () => {
    expect(nextEmployeeCode(['OX-01', 'OX-09'])).toBe('OX-10');
  });
});
