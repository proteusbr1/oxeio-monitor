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
});
