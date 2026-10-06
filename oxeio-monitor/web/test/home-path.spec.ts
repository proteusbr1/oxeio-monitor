import { describe, expect, it } from 'vitest';

import { homePathFor } from '../src/api/auth';

describe('homePathFor — where each role lands', () => {
  it('a coordinator lands on the Task pool while the Tasks module is on', () => {
    expect(homePathFor('owner')).toBe('/');
    expect(homePathFor('manager')).toBe('/');
    expect(homePathFor('coordinator')).toBe('/tasks/all');
    expect(homePathFor('employee')).toBe('/me');
  });

  it('a coordinator lands on My data when the Tasks module is switched off', () => {
    expect(homePathFor('coordinator', false)).toBe('/me');
    expect(homePathFor('owner', false)).toBe('/');
    expect(homePathFor('employee', false)).toBe('/me');
  });
});
