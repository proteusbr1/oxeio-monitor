import { SegmentState } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MAX_BATCH_SIZE } from './agent.constants';

/**
 * Careful: `clientUuid` is deliberately `@IsOptional()`.
 * Spec § 4.1 says "422 if missing", but ValidationPipe would throw 400.
 * So presence is checked in the service (`assertClientUuids`), so that the
 * status the spec asks for is the one returned. A malformed value is still a 400.
 */
class WithClientUuid {
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

// ── enroll ──────────────────────────────────────────────────────────────────

/**
 * Who and where the machine is: the part common to **both enrollment paths**.
 *
 * Careful: kept in a separate base class so the fields are not duplicated in
 * the two DTOs. If duplicated, one day `machineGuid`'s length limit would change
 * in one and not the other, and the difference would show only on machines
 * enrolled through that path.
 *
 * Careful: `OmitType()` from `@nestjs/mapped-types` could also do it, but it is
 * not in this repo's dependencies; a new package was not pulled in just to
 * share some fields (project rule).
 */
class EnrollFactsDto {
  @IsString()
  @MaxLength(200)
  hostname!: string;

  @IsString()
  @MaxLength(200)
  windowsUsername!: string;

  /** Hardware-based permanent id; changes if the PC is replaced. */
  @IsString()
  @MaxLength(200)
  machineGuid!: string;

  @IsOptional() @IsString() @MaxLength(100) osVersion?: string;
  @IsOptional() @IsString() @MaxLength(50) agentVersion?: string;
  @IsOptional() @IsInt() @Min(1) @Max(8) monitors?: number;
}

/** H05 - with a single-use code (the scripted rollout path). */
export class EnrollDto extends EnrollFactsDto {
  @IsString()
  @MaxLength(64)
  enrollmentCode!: string;
}

/**
 * Add a device with **the staff member's own login** instead of a code.
 *
 * Careful: the password deliberately has no `@MinLength`. Validation is in
 * `AuthService.login()`, where a wrong password and a short password get the
 * **same** answer. Rejecting here would let an outsider tell 400 from 401 and
 * learn how short an account's password is.
 */
export class EnrollLoginDto extends EnrollFactsDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;

  /** I06 - the six-digit code when 2FA is on. Absent on the first attempt. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  totp?: string;
}

// ── heartbeat ───────────────────────────────────────────────────────────────

export class HeartbeatDto {
  @IsEnum(SegmentState)
  state!: SegmentState;

  @IsInt() @Min(0) @Max(86_400)
  activeSecToday!: number;

  @IsOptional() @IsInt() @Min(0)
  queueDepth?: number;

  @IsOptional() @IsString() @MaxLength(64)
  configVersion?: string;

  /**
   * The version the agent itself is running.
   *
   * It is set once at enroll, but used to stay old after an upgrade.
   * Careful: this is not just dashboard cosmetics; the heartbeat decides whether
   * to offer an update **by looking at this number**. If stale, the server would
   * keep offering the same update to an agent that had already updated
   * ([G59](../../../docs/history/08-Gap-Analysis.md)).
   */
  @IsOptional() @IsString() @MaxLength(50)
  agentVersion?: string;

  /**
   * The agent's report on its own parts. ⚠️ `@Allow()`, no shape checks: a
   * 400 here would also drop the heartbeat's commands (revoke among them),
   * so the value is cleaned in `capabilities.rules.ts` instead of refused.
   */
  @IsOptional() @Allow()
  capabilities?: unknown;
}

// ── segments ────────────────────────────────────────────────────────────────

export class SegmentDto extends WithClientUuid {
  @IsEnum(SegmentState)
  state!: SegmentState;

  @Type(() => Date) @IsDate()
  startedAt!: Date;

  @Type(() => Date) @IsDate()
  endedAt!: Date;

  /** From the monotonic clock; survives clock changes (§ 3.2). */
  @IsInt() @Min(0) @Max(86_400)
  durationSec!: number;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  inputScore?: number;
}

export class SegmentBatchDto {
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_SIZE)
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments!: SegmentDto[];
}

// ── app usage ───────────────────────────────────────────────────────────────

export class AppUsageDto extends WithClientUuid {
  @Type(() => Date) @IsDate() startedAt!: Date;
  @Type(() => Date) @IsDate() endedAt!: Date;

  @IsInt() @Min(0) @Max(86_400)
  durationSec!: number;

  @IsString() @MaxLength(260)
  processName!: string;

  @IsOptional() @IsString() @MaxLength(260) appName?: string;
  @IsOptional() @IsString() @MaxLength(1000) windowTitle?: string;

  /** Careful: domain only, never a full URL (ADR-013). */
  @IsOptional() @IsString() @MaxLength(260) domain?: string;

  @IsOptional() @IsBoolean() isBrowser?: boolean;

  /**
   * **R22a** - the state in which the fragment was seen.
   *
   * Careful: **`@IsOptional()` is essential.** Older agents in the fleet
   * (0.3.7/0.3.8) do not send this field. If it were required, every batch from
   * them would get a **400**, and a 400 means Permanent to the agent, which
   * **deletes the data** (G49). A one-line mistake would lose the whole
   * office's app usage.
   *
   * When absent, the database default `active` is used, and that is correct:
   * old agents recorded only in the ACTIVE state.
   */
  @IsOptional() @IsIn(['active', 'idle', 'locked']) state?: 'active' | 'idle' | 'locked';
}

export class AppUsageBatchDto {
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_SIZE)
  @ValidateNested({ each: true })
  @Type(() => AppUsageDto)
  items!: AppUsageDto[];
}

// ── events ──────────────────────────────────────────────────────────────────

export class EventDto extends WithClientUuid {
  @IsString() @MaxLength(50)
  type!: string;

  @Type(() => Date) @IsDate()
  occurredAt!: Date;

  @IsOptional()
  meta?: Record<string, unknown>;
}

export class EventBatchDto {
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_SIZE)
  @ValidateNested({ each: true })
  @Type(() => EventDto)
  events!: EventDto[];
}

// ── screenshot ──────────────────────────────────────────────────────────────

/** The `meta` part of multipart (arrives as a JSON string). */
export class ScreenshotMetaDto extends WithClientUuid {
  @Type(() => Date) @IsDate()
  slotStart!: Date;

  /** The actual random time within the slot. */
  @Type(() => Date) @IsDate()
  capturedAt!: Date;

  @IsInt() @Min(0) @Max(7)
  monitorIndex!: number;

  @IsOptional() @IsInt() @Min(1) width?: number;
  @IsOptional() @IsInt() @Min(1) height?: number;
  @IsOptional() @IsString() @MaxLength(260) activeApp?: string;
  @IsOptional() @IsString() @MaxLength(1000) activeTitle?: string;
}
