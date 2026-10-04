import { describe, expect, it } from 'vitest';

import { homePathFor } from '../src/api/auth';

describe('homePathFor — where each role lands', () => {
  it('as before when the design targets module is on', () => {
    expect(homePathFor('owner')).toBe('/');
    expect(homePathFor('manager')).toBe('/');
    expect(homePathFor('researcher')).toBe('/targets/all');
    expect(homePathFor('employee')).toBe('/me');
  });

  it('a researcher lands on My data when design targets are switched off', () => {
    expect(homePathFor('researcher', false)).toBe('/me');
    expect(homePathFor('owner', false)).toBe('/');
    expect(homePathFor('employee', false)).toBe('/me');
  });
});
