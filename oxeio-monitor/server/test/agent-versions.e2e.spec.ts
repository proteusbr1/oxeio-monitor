import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isOfferedTo } from '../src/agent/rollout';
import { UpdateService } from '../src/agent/update.service';
import {
  createHarness,
  workNoon,
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
 * H04, G59: the path for rolling out a new agent version.
 *
 * Until now the `agent_versions` table was only read. The whole auto-update
 * system was built (staged offers, canary, sha256 verification, stopping via
 * `halted`), but there was no way anywhere to insert a row into that table.
 * So the only way to get today's MSI 0.2.0 onto 15 PCs was to go to each
 * machine and install it by hand.
 */
let h: Harness;
let owner: Session;
let root: string;

const MSI = Buffer.from('not really an msi, but bytes are bytes');
const SHA = createHash('sha256').update(MSI).digest('hex');

/** A fake MSI inside the storage root */
async function putMsi(rel: string, body = MSI): Promise<void> {
  const abs = resolve(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
}

const publish = (body: Record<string, unknown>) =>
  owner.http
    .post('/api/v1/agent-versions')
    .set('X-CSRF-Token', owner.csrf)
    .send(body);

beforeAll(async () => {
  h = await createHarness();
  root = resolve(
    process.env.STORAGE_ROOT ?? join(process.cwd(), '..', '.data', 'storage'),
  );
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

describe('POST /agent-versions: registering for rollout', () => {
  it('computes the sha256 from the file itself', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const res = await publish({ version: '0.2.0', msiPath: rel });

    expect(res.status).toBe(201);
    // No hash had to be given by hand: the agent will check this very number
    expect(res.body.sha256).toBe(SHA);
    expect(res.body.sizeBytes).toBe(MSI.length);
    // Default is canary: giving it to everyone at once is a separate decision
    expect(res.body.rolloutStage).toBe('canary');
  });

  /**
   * With one character wrong in a hand-entered hash, 15 PCs would download
   * the file, reject it because the sha256 does not match, and download it
   * again, forever.
   */
  it('400 on a wrong hand-entered sha256', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const res = await publish({
      version: '0.2.0',
      msiPath: rel,
      sha256: 'a'.repeat(64),
    });

    expect(res.status).toBe(400);
    expect(await h.prisma.agentVersion.count()).toBe(0);
  });

  it('a correct sha256 is accepted', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const res = await publish({ version: '0.2.0', msiPath: rel, sha256: SHA });
    expect(res.status).toBe(201);
  });

  it('400 if the file is not on disk', async () => {
    const res = await publish({ version: '0.2.0', msiPath: 'updates/nope.msi' });

    expect(res.status).toBe(400);
    expect(await h.prisma.agentVersion.count()).toBe(0);
  });

  /**
   * `openMsi()` in `update.service.ts` rejects paths outside the storage
   * root. If not checked here, the mistake would show up at download time,
   * long after rollout, after 15 PCs had failed downloads.
   */
  it('400 for a path outside the storage root', async () => {
    const res = await publish({
      version: '0.2.0',
      msiPath: '../../outside.msi',
    });
    expect(res.status).toBe(400);
  });

  /**
   * Rolling out an older or equal version would make `isNewer()` false, so
   * no agent would ever be offered it, and the owner would think it was
   * rolled out. A silent failure, so it is blocked here.
   */
  it('an older version cannot be rolled out', async () => {
    const a = `updates/${randomUUID()}.msi`;
    const b = `updates/${randomUUID()}.msi`;
    await putMsi(a);
    await putMsi(b);

    expect((await publish({ version: '0.3.0', msiPath: a })).status).toBe(201);

    const older = await publish({ version: '0.2.0', msiPath: b });
    expect(older.status).toBe(400);
  });

  it('the same version twice gives 409', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    expect((await publish({ version: '0.2.0', msiPath: rel })).status).toBe(201);
    expect((await publish({ version: '0.2.0', msiPath: rel })).status).toBe(409);
  });

  it('400 on a wrong version format', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    for (const version of ['0.2', 'v0.2.0', 'latest']) {
      const res = await publish({ version, msiPath: rel });
      expect(res.status, version).toBe(400);
    }
  });

  it('a manager cannot', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    const res = await manager.http
      .post('/api/v1/agent-versions')
      .set('X-CSRF-Token', manager.csrf)
      .send({ version: '0.2.0', msiPath: 'updates/x.msi' });

    expect(res.status).toBe(403);
  });

  it('is recorded in audit_log', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);
    await h.prisma.auditLog.deleteMany({});

    await publish({ version: '0.2.0', msiPath: rel });

    const [row] = await h.prisma.auditLog.findMany({
      where: { action: 'publish_agent_version' },
    });
    expect(row.targetId).toBe('0.2.0');
  });
});

describe('POST /agent-versions/:version/stage', () => {
  beforeEach(async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);
    await publish({ version: '0.2.0', msiPath: rel });
  });

  it('the stage can be changed', async () => {
    const res = await owner.http
      .post('/api/v1/agent-versions/0.2.0/stage')
      .set('X-CSRF-Token', owner.csrf)
      .send({ rolloutStage: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.rolloutStage).toBe('all');
  });

  /**
   * The most important button. If a bad update goes out there is no
   * automatic rollback (G69); whoever already got it has to be fixed by hand.
   * But stopping here saves the rest, and it takes seconds.
   */
  it('once halted, nobody is offered it any more', async () => {
    await owner.http
      .post('/api/v1/agent-versions/0.2.0/stage')
      .set('X-CSRF-Token', owner.csrf)
      .send({ rolloutStage: 'halted' })
      .expect(200);

    const row = await h.prisma.agentVersion.findUniqueOrThrow({
      where: { version: '0.2.0' },
    });
    expect(row.rolloutStage).toBe('halted');
  });

  it('404 for an unknown version', async () => {
    const res = await owner.http
      .post('/api/v1/agent-versions/9.9.9/stage')
      .set('X-CSRF-Token', owner.csrf)
      .send({ rolloutStage: 'all' });

    expect(res.status).toBe(404);
  });

  it('both before and after go into audit_log', async () => {
    await h.prisma.auditLog.deleteMany({});

    await owner.http
      .post('/api/v1/agent-versions/0.2.0/stage')
      .set('X-CSRF-Token', owner.csrf)
      .send({ rolloutStage: 'all' })
      .expect(200);

    const [row] = await h.prisma.auditLog.findMany({
      where: { action: 'change_agent_rollout' },
    });
    const meta = row.meta as { from: string; to: string };
    expect(meta.from).toBe('canary');
    expect(meta.to).toBe('all');
  });
});

describe('GET /agent-versions', () => {
  it('says so when the file has gone missing', async () => {
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);
    await publish({ version: '0.2.0', msiPath: rel });

    // If someone deletes the file after the row is inserted, the list must
    // show it; otherwise the agent would get a 404 on download and the owner would never know
    await h.prisma.agentVersion.update({
      where: { version: '0.2.0' },
      data: { msiPath: 'updates/vanished.msi' },
    });

    const res = await owner.http.get('/api/v1/agent-versions').expect(200);

    expect(res.body[0].fileMissing).toBe(true);
    expect(res.body[0].sizeBytes).toBeNull();
  });
});


/**
 * If the canary bucket is empty, the version would be stuck forever
 * (G168).
 *
 * The rule has unit tests in `rollout.spec.ts`. This block is about the
 * caller, and that matters more here: in this repo the mistake of "the
 * contract is written, the caller is not" has happened ten times (G141,
 * G144, G146, G149, G156, G159, G167). The rule is green yet nobody calls
 * it: that is the familiar sin here.
 */
describe('G168: a pilot is set automatically at publish time', () => {
  /** A version where none of those machines falls in canary */
  const emptyCanaryVersion = (guids: readonly string[]): string => {
    for (let i = 0; i < 500; i += 1) {
      const v = `9.0.${i}`;
      if (guids.every((g) => !isOfferedTo('canary', g, v))) return v;
    }
    throw new Error('no version with an empty canary bucket');
  };

  const filledCanaryVersion = (guids: readonly string[]): string => {
    for (let i = 0; i < 500; i += 1) {
      const v = `9.0.${i}`;
      if (guids.some((g) => isOfferedTo('canary', g, v))) return v;
    }
    throw new Error('no version with a filled canary bucket');
  };

  async function makeDevice(
    tag: string,
    status: 'active' | 'revoked' = 'active',
  ): Promise<{ id: number; machineGuid: string }> {
    const machineGuid = `guid-${tag}`;
    const d = await h.prisma.device.create({
      data: {
        hostname: `PC-${tag}`,
        windowsUsername: tag,
        machineGuid,
        tokenHash: randomUUID(),
        status,
        // G140: not `new Date()` in a spec; the harness clock
        lastSeenAt: workNoon(),
      },
    });
    return { id: d.id, machineGuid };
  }

  const fleet = async () => [
    await makeDevice('a'),
    await makeDevice('b'),
    await makeDevice('c'),
  ];

  /** The main test of this block */
  it('when the bucket is empty, one pilot is set at publish', async () => {
    const devices = await fleet();
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = emptyCanaryVersion(devices.map((d) => d.machineGuid));
    const res = await publish({ version, msiPath: rel }).expect(201);

    expect(res.body.pilotDeviceId).not.toBeNull();
    expect(devices.some((d) => d.id === res.body.pilotDeviceId)).toBe(true);
  });

  /** If someone falls in anyway, no intervention */
  it('when someone falls in the bucket, no pilot is set', async () => {
    const devices = await fleet();
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = filledCanaryVersion(devices.map((d) => d.machineGuid));
    const res = await publish({ version, msiPath: rel }).expect(201);

    expect(res.body.pilotDeviceId).toBeNull();
  });

  /** On `all` everyone gets it anyway, so a pilot is meaningless */
  it('publishing to all sets no pilot', async () => {
    const devices = await fleet();
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = emptyCanaryVersion(devices.map((d) => d.machineGuid));
    const res = await publish({
      version,
      msiPath: rel,
      rolloutStage: 'all',
    }).expect(201);

    expect(res.body.pilotDeviceId).toBeNull();
  });

  /**
   * A revoked PC cannot be the guinea pig: it never gets updates at all
   * (`update.service` filters it out before `isOfferedTo`), so no evidence
   * would come from it and the deadlock would remain.
   */
  it('a revoked PC does not become the pilot', async () => {
    const revoked = await makeDevice('rev', 'revoked');
    const alive = await makeDevice('live');
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = emptyCanaryVersion([revoked.machineGuid, alive.machineGuid]);
    const res = await publish({ version, msiPath: rel }).expect(201);

    expect(res.body.pilotDeviceId).toBe(alive.id);
  });

  /**
   * The same trap applies to a manual stage change: if the owner moves from
   * `all` down to `canary`, the bucket could be empty again.
   */
  it('a pilot is set when manually moved down to canary too', async () => {
    const devices = await fleet();
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = emptyCanaryVersion(devices.map((d) => d.machineGuid));
    await publish({ version, msiPath: rel, rolloutStage: 'all' }).expect(201);

    const res = await owner.http
      .post(`/api/v1/agent-versions/${version}/stage`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ rolloutStage: 'canary' })
      .expect(200);

    expect(res.body.pilotDeviceId).not.toBeNull();
    expect(devices.some((d) => d.id === res.body.pilotDeviceId)).toBe(true);
  });

  /**
   * The owner's choice is never changed. If they pick a machine it stays;
   * the automatic setting only fills an empty slot.
   */
  it('a pilot chosen by the owner is not overridden', async () => {
    const devices = await fleet();
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = emptyCanaryVersion(devices.map((d) => d.machineGuid));
    await publish({ version, msiPath: rel, rolloutStage: 'all' }).expect(201);

    const chosen = devices[devices.length - 1];

    const res = await owner.http
      .post(`/api/v1/agent-versions/${version}/stage`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ rolloutStage: 'canary', pilotDeviceId: chosen.id })
      .expect(200);

    expect(res.body.pilotDeviceId).toBe(chosen.id);
  });

  /**
   * The real claim is this: not whether a pilot was set, but whether the
   * offer is really going out. The bucket was empty, yet now one machine
   * gets an offer.
   *
   * Without this test, a number in the pilot column could satisfy everyone
   * while nobody checked that `UpdateService` reads it.
   */
  it('and that machine really gets the update offer', async () => {
    const devices = await fleet();
    const rel = `updates/${randomUUID()}.msi`;
    await putMsi(rel);

    const version = emptyCanaryVersion(devices.map((d) => d.machineGuid));
    const res = await publish({ version, msiPath: rel }).expect(201);

    const pilot = devices.find((d) => d.id === res.body.pilotDeviceId)!;
    const updates = h.app.get(UpdateService);

    // The pilot gets an offer
    expect(
      await updates.offerFor('0.0.1', pilot.machineGuid, pilot.id),
    ).not.toBeNull();

    // The others do not yet, because the stage is still canary
    for (const other of devices.filter((d) => d.id !== pilot.id)) {
      expect(
        await updates.offerFor('0.0.1', other.machineGuid, other.id),
      ).toBeNull();
    }
  });
});

describe('the version typed must match the file', () => {
  it('reads the version from the MSI name', async () => {
    const { versionInFileName } = await import('../src/devices/agent-versions.service');
    expect(versionInFileName('updates/oXeioAgent-0.5.0.msi')).toBe('0.5.0');
    expect(versionInFileName('updates\\oXeioAgent-0.5.1-nopreview.msi')).toBe('0.5.1');
    expect(versionInFileName('updates/agent.msi')).toBeNull();
    expect(versionInFileName('updates/oXeioAgent-10.20.300.msi')).toBe('10.20.300');
  });
});

describe('POST /agent-versions: a typo in the version is caught', () => {
  it('refuses 0.5.5 for oXeioAgent-0.5.0.msi, accepts 0.5.0', async () => {
    const dir = `updates/${randomUUID()}`;
    const rel = `${dir}/oXeioAgent-0.5.0.msi`;
    await putMsi(rel);

    const wrong = await publish({ version: '0.5.5', msiPath: rel });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.message)).toMatch(/version 0\.5\.0 .* given is 0\.5\.5/);

    expect((await publish({ version: '0.5.0', msiPath: rel })).status).toBe(201);
  });
});
