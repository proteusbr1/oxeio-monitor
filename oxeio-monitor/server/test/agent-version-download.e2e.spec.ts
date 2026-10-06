import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * Downloading the MSI, for manual installation.
 *
 * Why it was needed: agents from before 0.4.1 have no "Install update" tray
 * menu at all. The 11 PCs in the fleet are on 0.3.7/0.3.8, so even when the
 * server sends an offer nothing shows there, and it has to be installed by
 * hand once. Yet there was no way to get the MSI by hand:
 * `/agent/update/download` opens only with a device token, and the owner has
 * no token.
 */
let h: Harness;
let owner: Session;

const CONTENT = Buffer.from('not-a-real-msi-but-bytes-are-bytes');
const SHA = createHash('sha256').update(CONTENT).digest('hex');

async function publishVersion(version: string, relPath: string) {
  // The file must really exist on disk: publish itself checks the hash
  const root = process.env.STORAGE_ROOT!;
  await mkdir(join(root, 'updates'), { recursive: true });
  await writeFile(join(root, relPath), CONTENT);

  await owner.http
    .post('/api/v1/agent-versions')
    .set('X-CSRF-Token', owner.csrf)
    .send({ version, msiPath: relPath, sha256: SHA })
    .expect(201);
}

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

describe('GET /agent-versions/:version/download', () => {
  it('the owner can download the MSI, and the bytes are identical', async () => {
    await publishVersion('9.9.9', 'updates/oXeioAgent-9.9.9.msi');

    const res = await owner.http
      .get('/api/v1/agent-versions/9.9.9/download')
      // Without `responseType('blob')`, superagent does not even buffer a body
      // of an unknown content type: `res.body` would come back as an empty
      // object, and the test would fail for the wrong reason.
      .responseType('blob')
      .expect(200);

    expect(Buffer.from(res.body as Buffer).equals(CONTENT)).toBe(true);
    expect(res.headers['content-disposition']).toContain('oXeioAgent-9.9.9.msi');
  });

  /** Before installers circulate by hand, we need to know who downloaded which */
  it('the download is recorded in audit_log', async () => {
    await publishVersion('9.9.9', 'updates/oXeioAgent-9.9.9.msi');
    await owner.http.get('/api/v1/agent-versions/9.9.9/download').expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { action: 'agent_version.download' },
    });
    expect(row.targetId).toBe('9.9.9');
  });

  /**
   * Not even the manager: the whole controller is owner-only. What software
   * runs on the 15 PCs is the owner's decision, and handing out the installer
   * is part of that decision.
   */
  it('a manager cannot', async () => {
    await publishVersion('9.9.9', 'updates/oXeioAgent-9.9.9.msi');

    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/agent-versions/9.9.9/download').expect(403);
  });

  it('404 for an unknown version', async () => {
    await owner.http.get('/api/v1/agent-versions/1.2.3/download').expect(404);
  });

  /**
   * Important: the file must be inside the storage root. This guard sits in
   * `UpdateService.openMsi()` and is reused here; joining the path ourselves
   * would put the guard in two places, and one day one would be fixed and
   * not the other.
   */
  it('a path outside storage is caught', async () => {
    await h.prisma.agentVersion.create({
      data: {
        version: '9.9.8',
        msiPath: '../../../etc/passwd',
        sha256: SHA,
        rolloutStage: 'canary',
      },
    });

    await owner.http.get('/api/v1/agent-versions/9.9.8/download').expect(404);
  });
});
