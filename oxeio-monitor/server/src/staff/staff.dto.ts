import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DATE_ONLY, TAKA, TAKA_MSG } from '../common/patterns';

// ── employees ───────────────────────────────────────────────────────────────

/**
 * `empCode` is deliberately not here: the server generates it.
 *
 * Careful: because of `forbidNonWhitelisted: true` (app.setup.ts), anyone who
 * sends it gets a 400 instead of being silently ignored. That is wanted:
 * "sent but not applied" is the most dangerous state for this field, since
 * people recognise the code by eye.
 */
export class CreateEmployeeDto {
  @IsString() @MinLength(1) @MaxLength(120)
  fullName!: string;

  @IsOptional() @IsEmail() @MaxLength(200)
  email?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;

  @IsOptional() @IsString() @MaxLength(120)
  department?: string;

  /**
   * **Gets tasks handed out** (Tasks module). Default `false`: someone who
   * does not receive tasks is **left out** of task targets, not given zero.
   */
  @IsOptional() @IsBoolean()
  receivesTasks?: boolean;

  @IsOptional() @IsInt() @Min(1)
  policyId?: number;

  @IsOptional() @Matches(TAKA, { message: TAKA_MSG })
  monthlySalary?: string;

  /** how they are paid: a monthly salary, an hourly rate, or not through oXeio */
  @IsOptional() @IsIn(['monthly', 'hourly', 'none'])
  payBasis?: 'monthly' | 'hourly' | 'none';

  @IsOptional() @Matches(TAKA, { message: 'hourlyRate must be a string such as "25" or "25.50"' })
  hourlyRate?: string;

  @IsOptional() @Matches(DATE_ONLY, { message: 'joinedOn must be in YYYY-MM-DD format' })
  joinedOn?: string;

  /**
   * **This person's own daily task target.**
   *
   * Careful: **when left empty the policy's number applies** (25 in
   * `work_policies`), not zero. Sending `null` clears the earlier value and
   * falls back to the policy.
   * **0 is valid**: it means "no target for this person"; counting continues
   * but nobody is behind.
   * The cap of 500 is there to catch typos, not as policy (same as the policy field).
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyTaskTarget?: number | null;
}
/**
 * Careful: every field is optional and `null` is accepted too, because
 * `@IsOptional()` skips validation for both null and undefined. This is
 * deliberate: sending `null` means "clear the value", omitting the field
 * means "leave it alone". The service tells the two apart by checking for
 * `undefined`.
 */
export class UpdateEmployeeDto {
  /**
   * `empCode` is not here either: once set, it never changes.
   *
   * Careful: the code is not just a label but a person's **identity**. It is
   * printed in reports, Excel, payroll sheets, Telegram summaries and on
   * paper. Changing it midway would make old paper and the new screen say
   * different things, with no visible error anywhere.
   * Data-wise there is no need either: file paths and all foreign keys use
   * the employee **id**, not `empCode`.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  fullName?: string;

  @IsOptional() @IsEmail() @MaxLength(200)
  email?: string | null;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string | null;

  @IsOptional() @IsString() @MaxLength(120)
  department?: string | null;

  /** Gets tasks handed out (Tasks module) */
  @IsOptional() @IsBoolean()
  receivesTasks?: boolean;

  @IsOptional() @IsInt() @Min(1)
  policyId?: number | null;

  /** A change writes a separate audit row (targetType = `employee_salary`). */
  @IsOptional() @Matches(TAKA, { message: TAKA_MSG })
  monthlySalary?: string | null;

  @IsOptional() @IsIn(['monthly', 'hourly', 'none'])
  payBasis?: 'monthly' | 'hourly' | 'none';

  @IsOptional() @Matches(TAKA, { message: 'hourlyRate must be a string such as "25" or "25.50"' })
  hourlyRate?: string | null;

  @IsOptional() @Matches(DATE_ONLY)
  joinedOn?: string | null;

  /**
   * **This person's own daily task target.**
   *
   * Careful: **when left empty the policy's number applies** (25 in
   * `work_policies`), not zero. Sending `null` clears the earlier value and
   * falls back to the policy.
   * **0 is valid**: it means "no target for this person"; counting continues
   * but nobody is behind.
   * The cap of 500 is there to catch typos, not as policy (same as the policy field).
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyTaskTarget?: number | null;
}
/**
 * `POST /employees/:id/policy-signed`: date of the signed monitoring policy.
 *
 * Why a separate endpoint instead of a field on `PATCH /employees/:id`: this
 * is not editing employee details but **recording a legal event**, the only
 * rollout precondition ([01 § Rollout](../../../docs/01-Planning.md)). Inside
 * the normal update it would blend into `employee_update` audit rows, and
 * "whose signature was taken when" could not be pulled out separately.
 *
 * Careful: there is **no scan upload yet**, only the date.
 * `monitoring-policy-template.md` says "scan and upload to the dashboard";
 * that is future work (the `upload_policy_doc` audit action is reserved for it).
 */
export class PolicySignedDto {
  /**
   * `YYYY-MM-DD`. Defaults to **today's work-zone date**.
   *
   * Careful: a date can be given because the paper is often signed earlier
   * and entered on the dashboard two days later. Treating the entry day as the
   * signing day would make the record disagree with the paper.
   */
  @IsOptional() @Matches(DATE_ONLY)
  signedOn?: string;
}
/**
 * Careful: there is deactivate, not delete. Deleting a row would orphan that
 * person's monthly totals, screenshots and audit trail.
 */
export class DeactivateEmployeeDto {
  /** Defaults to today's work-zone date when omitted. */
  @IsOptional() @Matches(DATE_ONLY, { message: 'leftOn must be in YYYY-MM-DD format' })
  leftOn?: string;

  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
/** The query also needs 'all', so Prisma's enum cannot be used directly. */
export const EMPLOYEE_STATUS_FILTERS = ['active', 'inactive', 'all'] as const;
export type EmployeeStatusFilter = (typeof EMPLOYEE_STATUS_FILTERS)[number];
export class EmployeeListQueryDto {
  /**
   * Defaults to `active`, so people who have left do not fill the list.
   *
   * Careful: no `?includeInactive=true` style boolean here, because in a query
   * string everything is a string and `Boolean('false')` is **true**. With
   * that trap, the "hide departed employees" checkbox would never work.
   */
  @IsOptional() @IsIn(EMPLOYEE_STATUS_FILTERS)
  status?: EmployeeStatusFilter;

  @IsOptional() @IsString() @MaxLength(120)
  search?: string;
}
