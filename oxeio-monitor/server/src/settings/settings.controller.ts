import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Logger,
  Patch,
  Post,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UserRole, type Prisma } from '@prisma/client';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { parseUpdatePublicKey } from '../agent/update-signature';
import { BackupCheck } from '../alerts/backup.check';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import {
  BACKUP_SETTING_KEY,
  REGION_SETTING_KEY,
  UPDATE_KEY_SETTING_KEY,
  validateRegion,
  type RegionView,
  type Source,
} from './app-settings.rules';
import { AppSettingsService } from './app-settings.service';
import { checkStorage, type StorageForm } from './storage-check';
import { STORAGE_SETTING_KEY, storageView, type StorageView } from './storage.settings';
import { SCREENSHOT_STORAGE, type ScreenshotStorage } from '../storage/screenshot-storage';

class SaveRegionDto {
  @IsOptional() @IsString() @MaxLength(64)
  timeZone?: string;

  @IsOptional() @IsString() @MaxLength(3)
  currency?: string;

  // null = "the dashboard's own formats"
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(35)
  displayLocale?: string | null;
}

class SaveStorageDto {
  @IsIn(['local', 's3'])
  driver!: 'local' | 's3';

  @IsOptional() @IsIn(['b2', 's3'])
  provider?: 'b2' | 's3';

  @IsOptional() @IsString() @MaxLength(100)
  bucket?: string;

  @IsOptional() @IsString() @MaxLength(300)
  endpoint?: string;

  @IsOptional() @IsString() @MaxLength(64)
  region?: string;

  @IsOptional() @IsString() @MaxLength(200)
  accessKeyId?: string;

  // empty = keep the secret already saved (it is never sent back to the screen)
  @IsOptional() @IsString() @MaxLength(300)
  secretAccessKey?: string;

  @IsOptional() @IsString() @MaxLength(100)
  prefix?: string;

  @IsOptional() @IsBoolean()
  forcePathStyle?: boolean;

  // take the key from the backup copy (Settings → Backup › Offsite copy)
  @IsOptional() @IsBoolean()
  useBackupKey?: boolean;
}

class SaveBackupModeDto {
  @IsIn(['internal', 'external'])
  mode!: 'internal' | 'external';
}

class SaveUpdateKeyDto {
  // null or empty = no key: unsigned updates can be published
  @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000)
  publicKey!: string | null;
}

/**
 * Settings the owner changes from the dashboard instead of the server's
 * `.env` — region (time zone, currency, date format), who backs up the
 * database, and the agent update key. A value saved here wins over the
 * environment variable, which stays the starting value (same as Telegram).
 */
@Roles(UserRole.owner)
@Controller('settings')
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly audit: AuditService,
    // the store this server started with — compared with what is saved
    @Inject(SCREENSHOT_STORAGE) private readonly store: ScreenshotStorage,
    // BackupCheck lives in OpsModule, which needs this (global) module first
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── region ────────────────────────────────────────────────────────────

  @Get('region')
  async region(): Promise<RegionView & { restartNeeded: boolean }> {
    const view = await this.settings.region();
    return { ...view, restartNeeded: view.timeZone.value !== view.runningTimeZone };
  }

  @Patch('region')
  async saveRegion(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveRegionDto,
    @Ip() ip: string,
  ): Promise<RegionView & { restartNeeded: boolean }> {
    let checked;
    try {
      checked = validateRegion(dto);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    await this.settings.save(REGION_SETTING_KEY, { ...checked }, actor.userId);
    await this.record(actor, ip, REGION_SETTING_KEY, { ...checked } as Prisma.InputJsonValue);
    return this.region();
  }

  /**
   * ⚠️ The time zone is read when the server starts (the nightly jobs are
   *    scheduled in it), so a new one needs a restart. This stops the
   *    process cleanly; Docker / Coolify (`restart: unless-stopped`) start
   *    it again in a few seconds. Owner only, and audited.
   */
  @Post('restart')
  @HttpCode(HttpStatus.ACCEPTED)
  async restart(@CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<{ ok: true }> {
    await this.record(actor, ip, 'server', { op: 'restart' });
    this.logger.warn(`Restart requested by ${actor.email} — stopping so the container starts again`);
    // after the answer has left
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
    return { ok: true };
  }

  // ── screenshot storage ────────────────────────────────────────────────

  @Get('storage')
  async storage(): Promise<StorageView> {
    return storageView(await this.settings.storageSaved(), await this.settings.storage(), {
      driver: this.store.driver,
      location: this.store.location,
    });
  }

  /** Checks the bucket without saving — the screen's "Test connection" */
  @Post('storage/test')
  @HttpCode(HttpStatus.OK)
  async testStorage(@Body() dto: SaveStorageDto): Promise<{ ok: boolean; message: string }> {
    if (dto.driver === 'local') return { ok: true, message: 'Screenshots on this server\'s disk.' };
    const form = await this.storageForm(dto);
    if ('message' in form) return { ok: false, message: form.message };
    const result = await checkStorage(form);
    return result.ok
      ? { ok: true, message: `Connected — a test file was written to and deleted from ${form.bucket}.` }
      : result;
  }

  /**
   * ⚠️ A bucket is saved only after the same check passes, so the next
   *    start cannot fail on a typo. The change takes effect at the next
   *    restart, and screenshots already taken stay where they are — the
   *    screen says so before saving.
   */
  @Patch('storage')
  async saveStorage(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveStorageDto,
    @Ip() ip: string,
  ): Promise<StorageView> {
    if (dto.driver === 'local') {
      await this.settings.replace(STORAGE_SETTING_KEY, { driver: 'local' }, actor.userId);
      await this.record(actor, ip, STORAGE_SETTING_KEY, { driver: 'local' });
      return this.storage();
    }

    const form = await this.storageForm(dto);
    if ('message' in form) throw new BadRequestException(form.message);
    const result = await checkStorage(form);
    if (!result.ok) throw new BadRequestException(result.message);

    const { options } = result;
    await this.settings.replace(
      STORAGE_SETTING_KEY,
      {
        driver: 's3',
        provider: form.provider,
        bucket: options.bucket,
        endpoint: options.endpoint ?? '',
        region: options.region,
        prefix: options.prefix,
        forcePathStyle: options.forcePathStyle,
        useBackupKey: dto.useBackupKey === true,
        // with the backup key, nothing secret is copied here
        ...(dto.useBackupKey
          ? {}
          : { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }),
      },
      actor.userId,
    );
    await this.record(actor, ip, STORAGE_SETTING_KEY, {
      driver: 's3',
      provider: form.provider,
      bucket: options.bucket,
      useBackupKey: dto.useBackupKey === true,
    });
    return this.storage();
  }

  /** The key to use: the backup copy's, the one typed, or the one already saved */
  private async storageForm(dto: SaveStorageDto): Promise<StorageForm | { message: string }> {
    const saved = await this.settings.storageSaved();
    let accessKeyId = dto.accessKeyId?.trim() ?? '';
    let secretAccessKey = dto.secretAccessKey?.trim() ?? '';

    if (dto.useBackupKey) {
      const key = await this.settings.backupKey();
      if (!key) return { message: 'There is no backup-copy key yet — fill in the key here instead.' };
      ({ keyId: accessKeyId, appKey: secretAccessKey } = key);
    } else if (!accessKeyId && !secretAccessKey && saved?.accessKeyId && saved.secretAccessKey) {
      // both left empty on screen = keep the key already saved
      ({ accessKeyId, secretAccessKey } = saved);
    } else if (!secretAccessKey && saved?.secretAccessKey && accessKeyId === saved.accessKeyId) {
      secretAccessKey = saved.secretAccessKey;
    }

    return {
      provider: dto.provider ?? 'b2',
      bucket: dto.bucket ?? '',
      endpoint: dto.endpoint,
      region: dto.region,
      accessKeyId,
      secretAccessKey,
      prefix: dto.prefix,
      forcePathStyle: dto.forcePathStyle,
    };
  }

  // ── backup ────────────────────────────────────────────────────────────

  @Get('backup')
  backupMode(): Promise<{ mode: 'internal' | 'external'; source: Source }> {
    return this.settings.backupMode();
  }

  @Patch('backup')
  async saveBackupMode(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveBackupModeDto,
    @Ip() ip: string,
  ) {
    await this.settings.save(BACKUP_SETTING_KEY, { mode: dto.mode }, actor.userId);
    await this.record(actor, ip, BACKUP_SETTING_KEY, { mode: dto.mode });
    // switched to external: the old backup alert goes now, not at the next check
    await this.moduleRef.get(BackupCheck, { strict: false }).closeIfExternal();
    return this.settings.backupMode();
  }

  // ── agent update key ──────────────────────────────────────────────────

  @Get('update-key')
  updateKey(): Promise<{ publicKey: string | null; source: Source }> {
    return this.settings.updateKey();
  }

  @Patch('update-key')
  async saveUpdateKey(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveUpdateKeyDto,
    @Ip() ip: string,
  ) {
    const text = dto.publicKey?.trim() || null;
    let publicKey: string | null = null;
    if (text) {
      try {
        parseUpdatePublicKey(text); // refuses anything that is not a public key
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message.replace('AGENT_UPDATE_PUBLIC_KEY', 'The key') : String(error));
      }
      // kept as one line of base64, the form build.ps1 and the agent use
      publicKey = text.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s/g, '');
    }

    await this.settings.save(UPDATE_KEY_SETTING_KEY, { publicKey }, actor.userId);
    await this.record(actor, ip, UPDATE_KEY_SETTING_KEY, { set: publicKey !== null });
    return this.settings.updateKey();
  }

  private record(actor: SessionUser, ip: string, targetId: string, meta: Prisma.InputJsonValue) {
    return this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId,
      ipAddress: ip,
      meta,
    });
  }
}
