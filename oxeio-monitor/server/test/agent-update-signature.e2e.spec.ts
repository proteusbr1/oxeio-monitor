import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Harness, Session } from './setup/harness';

/**
 * Publishing a signed agent version, with AGENT_UPDATE_PUBLIC_KEY set: the
 * server checks the owner's signature before any PC is offered the MSI, and
 * passes it on in the offer. Without the key the old behaviour stays —
 * agent-versions.e2e.spec.ts runs that way, untouched.
 */
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const PUBLIC_B64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

const MSI = Buffer.from(`not really an msi ${randomUUID()}`);
const SIGNATURE = sign('sha256', MSI, privateKey);

let h: Harness;
let owner: Session;
let harness: typeof import('./setup/harness');
let root: string;

beforeAll(async () => {
  vi.stubEnv('AGENT_UPDATE_PUBLIC_KEY', PUBLIC_B64);
  vi.resetModules();
  harness = await import('./setup/harness');
  h = await harness.createHarness();
  root = resolve(
    process.env.STORAGE_ROOT ?? join(process.cwd(), '..', '.data', 'storage'),
  );
});

afterAll(async () => {
  await h?.close();
  vi.unstubAllEnvs();
  vi.resetModules();
});

beforeEach(async () => {
  await harness.resetDatabase(h.prisma, h.app);
  owner = await harness.loginReady(
    h,
    harness.OWNER_EMAIL,
    harness.OWNER_PASSWORD,
  );
});

async function putMsi(sig: Buffer | null, body = MSI): Promise<string> {
  const rel = `updates/${randomUUID()}.msi`;
  const abs = resolve(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
  if (sig) await writeFile(`${abs}.sig`, sig);
  return rel;
}

const publish = (msiPath: string, version = '0.2.0') =>
  owner.http
    .post('/api/v1/agent-versions')
    .set('X-CSRF-Token', owner.csrf)
    .send({ version, msiPath, rolloutStage: 'all' });

describe('signed agent updates (AGENT_UPDATE_PUBLIC_KEY set)', () => {
  it('a correctly signed MSI is published and offered with its signature', async () => {
    const res = await publish(await putMsi(SIGNATURE)).expect(201);
    expect(res.body.signed).toBe(true);

    const { UpdateService } = await import('../src/agent/update.service');
    const offer = await h.app
      .get(UpdateService)
      .offerFor('0.1.0', 'any-machine', null);
    expect(offer?.signature).toBe(SIGNATURE.toString('base64'));
  });

  it('no signature → refused: every PC with the key would throw it away', async () => {
    const res = await publish(await putMsi(null)).expect(400);
    expect(res.body.message).toMatch(/signed updates/);
  });

  it('a signature for another file → refused', async () => {
    const res = await publish(
      await putMsi(SIGNATURE, Buffer.from('a different msi')),
    ).expect(400);
    expect(res.body.message).toMatch(/does not match/);
  });

  it('a .sig that is not a signature → refused, with the command to make one', async () => {
    const res = await publish(await putMsi(Buffer.from('oops'))).expect(400);
    expect(res.body.message).toMatch(/openssl dgst/);
  });
});
