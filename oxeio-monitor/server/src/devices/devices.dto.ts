import { DeviceStatus, RolloutStage } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

// ── devices ─────────────────────────────────────────────────────────────────

export class DeviceListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  employeeId?: number;

  @IsOptional() @IsEnum(DeviceStatus)
  status?: DeviceStatus;
}
/**
 * The reason is mandatory — like `time_adjustments.reason`.
 * Stopping someone's machine remotely is an action whose explanation may be
 * needed six months later, when nobody will remember.
 */
export class RevokeDeviceDto {
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
export class RestoreDeviceDto {
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
export class CreateEnrollmentCodeDto {
  @IsInt() @Min(1)
  employeeId!: number;
}
// ── H04 · rolling out agent versions ────────────────────────────────────────

/**
 * Careful: `sha256` is **optional**, and that is the main decision: the server
 * reads the file and computes it itself. If given, it is **checked against
 * that** — a mismatch gives 400.
 *
 * With one character wrong in a hand-entered hash, 15 PCs would download the
 * file, reject it for the sha256 mismatch, and download again — forever. The
 * log would say only "hash mismatch", and nobody would see that the cause was a typo.
 */
export class PublishVersionDto {
  /**
   * Careful: SemVer — `isNewer()` in `rollout.ts` compares exactly this format.
   * Giving `0.2` or `v0.2.0` would make the comparison unpredictable.
   */
  @Matches(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, {
    message: 'version must look like 0.2.0',
  })
  version!: string;

  /** Path inside the storage root — `updates/oXeioAgent-0.2.0.msi` */
  @IsString() @MaxLength(400)
  msiPath!: string;

  @IsOptional() @IsString() @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'sha256 must be 64 hex characters',
  })
  sha256?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  releaseNotes?: string;

  @IsOptional() @IsEnum(RolloutStage)
  rolloutStage?: RolloutStage;

  @IsOptional() @IsBoolean()
  isMandatory?: boolean;
}
export class SetStageDto {
  @IsEnum(RolloutStage)
  rolloutStage!: RolloutStage;

  @IsOptional() @IsBoolean()
  isMandatory?: boolean;

  /**
   * **The one PC that gets it first, regardless of bucket.**
   *
   * Careful: sending `null` means **remove the pilot**, while not sending the
   * field means "leave it as it was" — two different things, so both
   * `@IsOptional()` and `@ValidateIf` are needed. Otherwise changing the stage
   * would silently wipe the pilot.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  pilotDeviceId?: number | null;
}
