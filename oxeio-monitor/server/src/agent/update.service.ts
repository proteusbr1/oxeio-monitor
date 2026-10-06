import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReadStream } from 'node:fs';

import { storageRoot } from '../common/storage.config';
import { PrismaService } from '../prisma/prisma.service';
import { isNewer, isOfferedTo } from './rollout';

export interface UpdateOffer {
  version: string;
  sha256: string;
  url: string;
  mandatory: boolean;
  releaseNotes: string | null;
  /** The owner's signature (base64 DER) — null when published unsigned */
  signature: string | null;
}

@Injectable()
export class UpdateService {
  private readonly root: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.root = resolve(
      storageRoot(config),
    );
  }

  /**
   * G34 - the auto-update flow ([02-Workflow §8](../../docs/history/02-Workflow.md))
   * existed, but there was no endpoint to download the MSI.
   *
   * Nothing is offered when `rollout_stage = halted`, so a bad update can be
   * stopped right there.
   */
  async offerFor(
    currentVersion: string,
    machineGuid?: string | null,
    /** Which device is asking; used to match the pilot device. */
    deviceId?: number | null,
  ): Promise<UpdateOffer | null> {
    const latest = await this.prisma.agentVersion.findFirst({
      where: { rolloutStage: { not: 'halted' } },
      orderBy: { releasedAt: 'desc' },
    });

    if (!latest || !isNewer(latest.version, currentVersion)) return null;

    // H04 - staged rollout. If machineGuid is unknown, **nothing is offered**:
    // withholding an update from an unknown device is safer, because the whole
    // point of a canary is "a handful of machines first".
    /**
     * A pilot device skips the rollout bucket, but never without a
     * `machineGuid`, so an anonymous call can never receive an offer.
     */
    const isPilot =
      latest.pilotDeviceId !== null &&
      deviceId !== null &&
      deviceId !== undefined &&
      latest.pilotDeviceId === deviceId;

    if (!machineGuid) return null;
    if (
      !isOfferedTo(latest.rolloutStage, machineGuid, latest.version, isPilot)
    ) {
      return null;
    }

    return {
      version: latest.version,
      sha256: latest.sha256,
      url: `/api/v1/agent/update/download?version=${encodeURIComponent(latest.version)}`,
      mandatory: latest.isMandatory,
      releaseNotes: latest.releaseNotes,
      // the owner's signature, passed on untouched (update-signature.ts)
      signature: latest.signature,
    };
  }

  async openMsi(version: string): Promise<{ stream: ReadStream; size: number }> {
    const row = await this.prisma.agentVersion.findUnique({
      where: { version },
    });
    if (!row) throw new NotFoundException('No such version');

    // msi_path must stay inside storage; this blocks downloading arbitrary
    // files from outside (path traversal)
    const abs = isAbsolute(row.msiPath)
      ? resolve(row.msiPath)
      : resolve(this.root, row.msiPath);

    if (!abs.startsWith(this.root)) {
      throw new NotFoundException('File path is outside storage');
    }

    try {
      const info = await stat(abs);
      return { stream: createReadStream(abs), size: info.size };
    } catch {
      throw new NotFoundException('MSI file not found on disk');
    }
  }
}
