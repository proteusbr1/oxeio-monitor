import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMsiPath } from '../src/agent/msi-path';

/**
 * L5: the MSI path check used a bare `startsWith(root)`, so a sibling folder
 * whose name merely starts with the root's name counted as "inside".
 */
const ROOT = resolve('/data/storage');

describe('resolveMsiPath', () => {
  it('a path under the root resolves', () => {
    expect(resolveMsiPath(ROOT, 'updates/oXeioAgent-0.5.0.msi')).toBe(
      join(ROOT, 'updates', 'oXeioAgent-0.5.0.msi'),
    );
  });

  it('traversal out of the root is refused', () => {
    expect(resolveMsiPath(ROOT, '../../etc/passwd')).toBeNull();
  });

  it('a sibling folder sharing the prefix is refused (storage-old, storage2)', () => {
    expect(resolveMsiPath(ROOT, resolve('/data/storage-old/x.msi'))).toBeNull();
    expect(resolveMsiPath(ROOT, '../storage2/x.msi')).toBeNull();
  });

  it('the root itself is not a file', () => {
    expect(resolveMsiPath(ROOT, '.')).toBeNull();
  });

  // M2: agents upload into screenshots/, so nothing there is ever an update
  it('the screenshots area is refused, relative or absolute', () => {
    expect(resolveMsiPath(ROOT, 'screenshots/2026/08/13/emp-003/a.msi')).toBeNull();
    expect(resolveMsiPath(ROOT, join(ROOT, 'screenshots', 'x.msi'))).toBeNull();
    expect(resolveMsiPath(ROOT, 'updates/../screenshots/x.msi')).toBeNull();
  });

  it('a folder that only starts with "screenshots" is not the screenshots area', () => {
    expect(resolveMsiPath(ROOT, 'screenshots-old/x.msi')).toBe(
      join(ROOT, 'screenshots-old', 'x.msi'),
    );
  });
});
