import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RolloutStage } from '@prisma/client';

import { isNewer, pilotNeededFor } from '../agent/rollout';
import {
  parseUpdatePublicKey,
  signatureFromFile,
  verifyUpdateSignature,
} from '../agent/update-signature';
import { AuditService } from '../audit/audit.service';
import { storageRoot } from '../common/storage.config';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import type { SessionUser } from '../auth/types';
import type { PublishVersionDto, SetStageDto } from './devices.dto';

export interface AgentVersionView {
  version: string;
  sha256: string;
  sizeBytes: number | null;
  rolloutStage: RolloutStage;
  isMandatory: boolean;
  releaseNotes: string | null;
  releasedAt: string;
  /** Careful: is the file really on disk? Offering it when missing is dangerous */
  fileMissing: boolean;
  /** Published with the owner's signature (`<msi>.sig`) — see update-signature.ts */
  signed: boolean;
  /** How many devices are already running this version */
  devicesOn: number;
  /**
   * The PC that gets it first, regardless of bucket — `null` means none.
   */
  pilotDeviceId: number | null;
  /** For showing a name on screen — the employee's name, or the hostname if none */
  pilotLabel: string | null;
}

/**
 * **H04 · G59** — the route for rolling out new agent versions.
 *
 * Careful: <b>the `agent_versions` table used to be read only.</b>
 * `update.service.ts` looks there for the latest version, offers it in
 * stages, and supplies the sha256 for checking — the whole auto-update system
 * was built. But **there was no way anywhere to put a row into that table**:
 * no endpoint, no UI, not even the seed.
 *
 * The result showed in practice: MSI 0.2.0 was built, and the **only way to
 * get it onto the 15 PCs was to install it by hand on every machine**. H04's
 * staged rollout, canary, and stopping with `halted` — all built and idle.
 *
 * This was the fourth "contract written, caller never written" — after A05,
 * config fetch, adjustments and the signature record.
 */
@Injectable()
export class AgentVersionsService {
  private readonly logger = new Logger(AgentVersionsService.name);
  private readonly root: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // the owner's update key — Settings → Agent updates, or the .env
    private readonly settings: AppSettingsService,
    config: ConfigService,
  ) {
    // Careful: exactly the same calculation as `update.service.ts` — if the two
    // differed, a path stored here would read as "file missing" there.
    this.root = resolve(storageRoot(config));
  }

  /**
   * The pilot PC's name — the employee's name, or the hostname if none.
   *
   * Careful: the number (`pilotDeviceId`) is no use to anyone on screen; the
   * owner wants to know "whose PC". The hostname survives even if the employee
   * is removed, so the cell never puzzles with "device 6".
   */
  private async pilotLabelOf(deviceId: number | null): Promise<string | null> {
    if (deviceId === null) return null;

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { hostname: true, employee: { select: { fullName: true } } },
    });

    if (!device) return null;

    return device.employee?.fullName ?? device.hostname;
  }

  async list(): Promise<AgentVersionView[]> {
    const [rows, byVersion] = await Promise.all([
      this.prisma.agentVersion.findMany({ orderBy: { releasedAt: 'desc' } }),
      this.prisma.device.groupBy({
        by: ['agentVersion'],
        where: { status: 'active' },
        _count: { _all: true },
      }),
    ]);

    const counts = new Map(
      byVersion.map((d) => [d.agentVersion ?? '', d._count._all]),
    );

    return Promise.all(
      rows.map(async (r) => {
        const file = await this.statMsi(r.msiPath);
        return {
          version: r.version,
          sha256: r.sha256,
          sizeBytes: file?.size ?? null,
          rolloutStage: r.rolloutStage,
          isMandatory: r.isMandatory,
          releaseNotes: r.releaseNotes,
          releasedAt: r.releasedAt.toISOString(),
          fileMissing: file === null,
          signed: r.signature !== null,
          devicesOn: counts.get(r.version) ?? 0,
          pilotDeviceId: r.pilotDeviceId,
          pilotLabel: await this.pilotLabelOf(r.pilotDeviceId),
        };
      }),
    );
  }

  /**
   * Record a new version for rollout.
   *
   * <b>The sha256 does not have to be given — the server reads the file and
   * computes it itself.</b> It can be supplied by hand, in which case it is
   * **checked against that** and a mismatch gives 400.
   *
   * Careful: why this matters: after downloading, the agent checks the sha256
   * and discards the MSI on a mismatch. With one character wrong in a hand-entered
   * hash, 15 PCs would download the file, discard it, and download again —
   * forever. The log would say only "hash mismatch", and nobody would see that
   * the cause was a typo.
   */
  async publish(
    actor: SessionUser,
    dto: PublishVersionDto,
    ip: string,
  ): Promise<AgentVersionView> {
    const existing = await this.prisma.agentVersion.findUnique({
      where: { version: dto.version },
    });
    if (existing) {
      throw new ConflictException(
        `Version ${dto.version} is already published. Publish a new version number instead — agents compare versions, so re-publishing the same number would never reach anyone.`,
      );
    }

    // build.ps1 names every MSI after its version (oXeioAgent-0.5.0.msi). A number typed on
    // screen that differs from the file's would loop for ever: the PC installs the file, reports
    // the file's version, and is offered the typed one again.
    const named = versionInFileName(dto.msiPath);
    if (named !== null && named !== dto.version) {
      throw new BadRequestException(
        `The file is version ${named} (by its name) but the version given is ${dto.version}. Use ${named}, or the MSI built for ${dto.version}.`,
      );
    }

    const file = await this.statMsi(dto.msiPath);
    if (file === null) {
      throw new BadRequestException(
        `No MSI at "${dto.msiPath}" (looked under the storage root). Copy the built file there first.`,
      );
    }

    const sha256 = await this.hashFile(file.abs);
    if (dto.sha256 && dto.sha256.toLowerCase() !== sha256) {
      throw new BadRequestException(
        'The sha256 you gave does not match the file on disk. The agent checks this hash after downloading, so a wrong value would make every PC download and reject the file forever.',
      );
    }

    /**
     * Careful: the new version **must be newer** than the old one. Otherwise
     * `update.service.ts` would never offer it (`isNewer` false), and the owner
     * would think it had been rolled out — a silent failure.
     */
    const signature = await this.signatureFor(file.abs);

    const latest = await this.prisma.agentVersion.findFirst({
      orderBy: { releasedAt: 'desc' },
    });
    if (latest && !isNewer(dto.version, latest.version)) {
      throw new BadRequestException(
        `${dto.version} is not newer than the current ${latest.version}, so no agent would ever be offered it.`,
      );
    }

    // Default `canary` — the schema default too. Giving it to everyone at once
    // has to be a separate decision (by changing `stage`), and that is right:
    // if a bad build goes out there is no way back (G69).
    const stage = dto.rolloutStage ?? RolloutStage.canary;

    /**
     * **G168 — an empty bucket used to leave the version stuck forever.**
     *
     * Careful: the decision is taken **before creating**, so the row is born
     * with its pilot from the start — done in two steps, a heartbeat could
     * arrive in between and get an answer with no offer.
     */
    const autoPilot = await this.autoPilotFor(stage, dto.version, new Date());

    const row = await this.prisma.agentVersion.create({
      data: {
        version: dto.version,
        msiPath: dto.msiPath,
        sha256,
        signature,
        releaseNotes: dto.releaseNotes ?? null,
        rolloutStage: stage,
        isMandatory: dto.isMandatory ?? false,
        pilotDeviceId: autoPilot,
      },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'publish_agent_version',
      targetType: 'agent_version',
      targetId: row.version,
      ipAddress: ip,
      // Careful: `autoPilot` goes into the audit too — making one machine the
      // guinea pig is a decision, and silent decisions are not kept in this system
      meta: {
        sha256,
        signed: signature !== null,
        stage: row.rolloutStage,
        sizeBytes: file.size,
        autoPilotDeviceId: autoPilot,
      },
    });

    this.logger.warn(
      `agent ${row.version} published · ${row.rolloutStage} · ${file.size} bytes`,
    );

    if (autoPilot !== null) {
      this.logger.warn(
        `agent ${row.version}: no device fell in the ${row.rolloutStage} bucket, ` +
          `so device #${autoPilot} was picked as pilot — otherwise the rollout ` +
          'could never gather proof and would stay at this stage forever (G168)',
      );
    }

    return {
      version: row.version,
      sha256: row.sha256,
      sizeBytes: file.size,
      rolloutStage: row.rolloutStage,
      isMandatory: row.isMandatory,
      releaseNotes: row.releaseNotes,
      releasedAt: row.releasedAt.toISOString(),
      fileMissing: false,
      signed: signature !== null,
      devicesOn: 0,
      pilotDeviceId: row.pilotDeviceId,
      pilotLabel: await this.pilotLabelOf(row.pilotDeviceId),
    };
  }

  /**
   * Change the rollout stage — `canary` → `partial` → `all`, or `halted`.
   *
   * **`halted` is the only emergency brake.** If a bad update goes out there is
   * no automatic rollback (G69, deliberate) — those who already got it must be
   * fixed by hand. But stopping here **spares the rest at least**, and it takes
   * seconds.
   */
  async setStage(
    actor: SessionUser,
    version: string,
    dto: SetStageDto,
    ip: string,
  ): Promise<AgentVersionView> {
    const row = await this.prisma.agentVersion.findUnique({
      where: { version },
    });
    if (!row) throw new NotFoundException('No such version');

    /**
     * Careful: **the same trap applies when the stage is changed by hand**
     * (G168). If the owner moves from `all` down to `canary`, the bucket may
     * be empty again, and the version would be stuck there.
     *
     * An automatic pilot is set only when **there is no pilot and the owner
     * gave no new pilot** — the owner's choice is never overridden.
     */
    const keepsPilot =
      dto.pilotDeviceId !== undefined
        ? dto.pilotDeviceId !== null
        : row.pilotDeviceId !== null;

    const autoPilot = keepsPilot
      ? null
      : await this.autoPilotFor(dto.rolloutStage, version, new Date());

    const updated = await this.prisma.agentVersion.update({
      where: { version },
      data: {
        rolloutStage: dto.rolloutStage,
        ...(autoPilot === null ? {} : { pilotDeviceId: autoPilot }),
        /**
         * Careful: **changing the stage by hand also resets the clock.**
         * Otherwise right after the owner moved canary → partial, the job would
         * make it `all` on its next tick — because the proving machine passed
         * its six hours long ago. Staged release would mean nothing.
         */
        stageChangedAt: new Date(),
        ...(dto.isMandatory === undefined ? {} : { isMandatory: dto.isMandatory }),
        /**
         * Careful: **`undefined` and `null` are not the same.** If the field is
         * not sent, what was there stays; sending `null` removes the pilot.
         * Without this difference, merely changing the stage would silently wipe the pilot.
         */
        ...(dto.pilotDeviceId === undefined
          ? {}
          : { pilotDeviceId: dto.pilotDeviceId }),
      },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_agent_rollout',
      targetType: 'agent_version',
      targetId: version,
      ipAddress: ip,
      // Careful: both before and after — the answer to "who gave it to everyone,
      // and when" should be in this one row
      meta: {
        from: row.rolloutStage,
        to: updated.rolloutStage,
        ...(autoPilot === null ? {} : { autoPilotDeviceId: autoPilot }),
      },
    });

    this.logger.warn(
      `agent ${version} rollout ${row.rolloutStage} → ${updated.rolloutStage}`,
    );

    const file = await this.statMsi(updated.msiPath);
    const devicesOn = await this.prisma.device.count({
      where: { status: 'active', agentVersion: version },
    });

    return {
      version: updated.version,
      sha256: updated.sha256,
      sizeBytes: file?.size ?? null,
      rolloutStage: updated.rolloutStage,
      isMandatory: updated.isMandatory,
      releaseNotes: updated.releaseNotes,
      releasedAt: updated.releasedAt.toISOString(),
      fileMissing: file === null,
      signed: updated.signature !== null,
      devicesOn,
      pilotDeviceId: updated.pilotDeviceId,
      pilotLabel: await this.pilotLabelOf(updated.pilotDeviceId),
    };
  }

  /**
   * Careful: the path **must be inside** the storage root — `openMsi()` in
   * `update.service.ts` checks exactly this too. Without checking here the
   * owner could mistakenly enter `C:\Windows\...`, and it would be caught only
   * at download time with "File path is outside storage" — long after publishing.
   */
  /**
   * **Picking one device when the bucket is empty** (G168).
   *
   * Careful: the rule is not here — it is in the pure `pilotNeededFor()` in
   * `rollout.ts` (this file only fetches rows and writes). That is this
   * module's pattern: the decision can be tested without a database.
   *
   * Careful: returning `null` means **nothing to do** — either someone already
   * fell into the bucket, or the stage is `halted`/`all`, or there is no device at all.
   */
  private async autoPilotFor(
    stage: RolloutStage,
    version: string,
    now: Date,
  ): Promise<number | null> {
    const devices = await this.prisma.device.findMany({
      // Careful: `active` only — a revoked PC gets no updates, so it is no guinea pig either
      where: { status: 'active' },
      select: { id: true, machineGuid: true, lastSeenAt: true },
    });

    return pilotNeededFor(stage, devices, version, now);
  }

  private async statMsi(
    msiPath: string,
  ): Promise<{ abs: string; size: number } | null> {
    const abs = isAbsolute(msiPath)
      ? resolve(msiPath)
      : resolve(this.root, msiPath);

    if (!abs.startsWith(this.root)) return null;

    try {
      const info = await stat(abs);
      return info.isFile() ? { abs, size: info.size } : null;
    } catch {
      return null;
    }
  }

  /**
   * Careful: the whole file is **not** read into memory — the MSI is 62 MB, and
   * `readFile()` would need that much RAM on every publish. Hashing from a
   * stream uses constant memory.
   */
  /**
   * The owner's signature for this MSI: `<msi>.sig` next to it, as OpenSSL
   * writes it. None is fine — unless AGENT_UPDATE_PUBLIC_KEY is set, because
   * then the PCs carry that key and would refuse an unsigned update.
   * ⚠️ With the key set the signature is checked here, at publish: a wrong
   *    one would otherwise be downloaded and thrown away by every PC, forever.
   */
  private async signatureFor(abs: string): Promise<string | null> {
    let content: Buffer | null = null;
    try {
      content = await readFile(`${abs}.sig`);
    } catch {
      content = null;
    }

    const signature = content === null ? null : signatureFromFile(content);
    if (content !== null && signature === null) {
      throw new BadRequestException(
        `${abs}.sig is not a signature — make it with: openssl dgst -sha256 -sign <key.pem> -out <msi>.sig <msi>`,
      );
    }

    // the owner's public key; set = only signed versions can be published
    const updateKey = parseUpdatePublicKey((await this.settings.updateKey()).publicKey);
    if (updateKey === null) return signature;

    if (signature === null) {
      throw new BadRequestException(
        'AGENT_UPDATE_PUBLIC_KEY is set, so the PCs only install signed updates — put the signature next to the MSI (<msi>.sig) first. deploy/README.md › "Signed agent updates".',
      );
    }
    if (!(await verifyUpdateSignature(updateKey, createReadStream(abs), signature))) {
      throw new BadRequestException(
        'The signature in <msi>.sig does not match this MSI and AGENT_UPDATE_PUBLIC_KEY. Every signed PC would refuse it — sign this exact file with the matching private key.',
      );
    }
    return signature;
  }

  private hashFile(abs: string): Promise<string> {
    return new Promise((ok, fail) => {
      const hash = createHash('sha256');
      const stream = createReadStream(abs);
      stream.on('error', fail);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => ok(hash.digest('hex')));
    });
  }
}

/** `updates/oXeioAgent-0.5.0.msi` → `0.5.0`; `null` when the name carries no version */
export function versionInFileName(msiPath: string): string | null {
  const name = msiPath.split(/[\\/]/).pop() ?? '';
  return /(?<![\d.])(\d+\.\d+\.\d+)(?!\.?\d)/.exec(name)?.[1] ?? null;
}
