import { describe, expect, it } from 'vitest';

import {
  cleanAddresses,
  recipientsFor,
  recipientsSaveProblem,
  type RecipientsSaved,
  splitList,
} from '../src/mail/recipients.rules';

const owners = ['owner@x.test'];

describe('cleanAddresses / splitList', () => {
  it('trims, drops blanks and case-insensitive duplicates, keeps order', () => {
    expect(cleanAddresses([' A@x.test', 'a@x.test', '', 'b@x.test '])).toEqual([
      'A@x.test',
      'b@x.test',
    ]);
    expect(splitList('a@x.test,, b@x.test ,')).toEqual([
      'a@x.test',
      'b@x.test',
    ]);
    expect(splitList(undefined)).toEqual([]);
  });
});

describe('recipientsFor — saved list › env › owners', () => {
  it('a saved list wins', () => {
    expect(
      recipientsFor({
        kind: 'dailyDigest',
        saved: { dailyDigest: ['d@x.test'] },
        env: { DIGEST_EMAIL_TO: 'e@x.test' },
        owners,
      }),
    ).toEqual(['d@x.test']);
  });

  it('a saved but empty list falls back to today’s rule — never to nobody', () => {
    expect(
      recipientsFor({
        kind: 'dailyDigest',
        saved: { dailyDigest: [] },
        env: {},
        owners,
      }),
    ).toEqual(owners);
  });

  it('each kind keeps its old environment variable', () => {
    const env = {
      ALERT_EMAIL_TO: 'ops@x.test',
      DIGEST_EMAIL_TO: 'boss@x.test',
    };
    expect(recipientsFor({ kind: 'alerts', saved: null, env, owners })).toEqual(
      ['ops@x.test'],
    );
    expect(
      recipientsFor({ kind: 'dailyDigest', saved: null, env, owners }),
    ).toEqual(['boss@x.test']);
    expect(
      recipientsFor({ kind: 'weeklyDigest', saved: null, env, owners }),
    ).toEqual(['boss@x.test']);
    expect(
      recipientsFor({ kind: 'monthClosed', saved: null, env, owners }),
    ).toEqual(['boss@x.test']);
  });

  it('alerts never fall back to DIGEST_EMAIL_TO, nor digests to ALERT_EMAIL_TO', () => {
    expect(
      recipientsFor({
        kind: 'alerts',
        saved: null,
        env: { DIGEST_EMAIL_TO: 'boss@x.test' },
        owners,
      }),
    ).toEqual(owners);
    expect(
      recipientsFor({
        kind: 'dailyDigest',
        saved: null,
        env: { ALERT_EMAIL_TO: 'ops@x.test' },
        owners,
      }),
    ).toEqual(owners);
  });
});

describe('recipientsFor — a damaged stored value', () => {
  const base = { kind: 'alerts' as const, env: {}, owners };

  it('a saved value that is not a list is ignored, never iterated', () => {
    const saved = { alerts: 'abc@x.test' } as unknown as RecipientsSaved;
    expect(recipientsFor({ ...base, saved })).toEqual(owners);
  });

  it('entries that are not strings are ignored', () => {
    const saved = {
      alerts: [1, null, { a: 1 }, ' ok@x.test '],
    } as unknown as RecipientsSaved;
    expect(recipientsFor({ ...base, saved })).toEqual(['ok@x.test']);
  });
});

describe('recipientsSaveProblem', () => {
  it('accepts known kinds with email lists', () => {
    expect(
      recipientsSaveProblem({ alerts: ['a@x.test'], monthClosed: [] }),
    ).toBeNull();
  });
  it('refuses unknown kinds, non-lists and bad addresses', () => {
    expect(recipientsSaveProblem({ nope: [] })).toMatch(/kind/);
    expect(recipientsSaveProblem({ alerts: 'a@x.test' })).toMatch(/list/);
    expect(recipientsSaveProblem({ alerts: ['not-an-email'] })).toMatch(
      /not-an-email/,
    );
    expect(
      recipientsSaveProblem({
        alerts: Array.from({ length: 21 }, (_, i) => `p${i}@x.test`),
      }),
    ).toMatch(/20/);
  });
});
