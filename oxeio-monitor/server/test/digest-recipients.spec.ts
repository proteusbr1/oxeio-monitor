import { describe, expect, it } from 'vitest';

import { digestRecipients } from '../src/digest/digest.recipients';

/**
 * Who the weekly digest goes to.
 *
 * The rule is short, but a mistake cannot be undone: this message contains
 * every staff member's name and hours. Once an email goes to the wrong
 * address it cannot be recalled.
 */
describe('digestRecipients', () => {
  const owners = ['owner@oxeio.local'];

  it('an explicit list wins when present', () => {
    expect(digestRecipients({ explicit: 'boss@x.com', owners })).toEqual([
      'boss@x.com',
    ]);
  });

  it('otherwise the active owners', () => {
    expect(digestRecipients({ explicit: undefined, owners })).toEqual(owners);
  });

  it('an empty string also counts as "not set"', () => {
    expect(digestRecipients({ explicit: '   ', owners })).toEqual(owners);
  });

  it('several, comma-separated', () => {
    expect(
      digestRecipients({ explicit: 'a@x.com, b@x.com', owners }),
    ).toEqual(['a@x.com', 'b@x.com']);
  });

  /**
   * Extra commas in `.env` are very common — without filtering, SMTP would
   * be handed an empty address and the whole send would fail.
   */
  it('blank entries are dropped', () => {
    expect(
      digestRecipients({ explicit: 'a@x.com,,  ,b@x.com', owners }),
    ).toEqual(['a@x.com', 'b@x.com']);
  });

  /** The same address twice would give one person two copies */
  it('duplicates once only', () => {
    expect(
      digestRecipients({ explicit: 'a@x.com, a@x.com', owners }),
    ).toEqual(['a@x.com']);
  });

  /** The same address in different letter case */
  it('duplicates are caught regardless of case', () => {
    expect(
      digestRecipients({ explicit: 'A@x.com, a@x.com', owners }),
    ).toEqual(['A@x.com']);
  });

  it('duplicates are also filtered in the owners list', () => {
    expect(
      digestRecipients({
        explicit: undefined,
        owners: ['o@x.com', 'O@x.com', 'p@x.com'],
      }),
    ).toEqual(['o@x.com', 'p@x.com']);
  });

  /** With nobody, empty — the caller then does not even try to send */
  it('an empty list when there is nobody', () => {
    expect(digestRecipients({ explicit: undefined, owners: [] })).toEqual([]);
  });
});
