import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkPolicy } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_TARGET } from '../audit/admin-audit';
import type { CreateWorkPolicyDto, UpdateWorkPolicyDto } from './calendar.dto';
import {
  captureWindowProblem,
  DEFAULT_CAPTURE_WINDOW,
  regimeData,
  type RegimeInput,
} from './work-policy.rules';
import { normaliseOffDays } from '../summary/weekly-off';

export interface WorkPolicyView {
  id: number;
  name: string;
  /** how the hours target is stated: month | week | day | none (work-regime.ts) */
  targetBasis: 'month' | 'week' | 'day' | 'none';
  /** Not money, so it goes as a number. */
  monthlyTargetHours: number;
  expectedWorkdays: number;
  weeklyTargetHours: number | null;
  dailyTargetHours: number | null;
  breakMinutes: number | null;
  /** overtime paid at this multiple; null = not paid */
  overtimeMultiplier: number | null;
  deductShortfall: boolean;
  weeklyOffDays: readonly number[];
  screenshotFrom: string | null;
  screenshotTo: string | null;
  /** false = no screenshots for this policy; the jiggler check keeps running */
  screenshotsEnabled: boolean;
  /** When the office is open: the window for the `agent_down` alert. null = open all day */
  officeFrom: string | null;
  officeTo: string | null;
  idleThresholdSec: number;
  /** Tasks per day; applies only to people who receive tasks (0 = no target) */
  dailyTaskTarget: number;
  slotMinutes: number;
  timezone: string;
  isActive: boolean;
  /** How many staff are on this policy: this is what to check before deactivating */
  employeeCount: number;
}

@Injectable()
export class WorkPoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<{ rows: WorkPolicyView[] }> {
    const rows = await this.prisma.workPolicy.findMany({
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
      include: { _count: { select: { employees: true } } },
    });

    return {
      rows: rows.map((p) => toView(p, p._count.employees)),
    };
  }

  async get(id: number): Promise<WorkPolicyView> {
    const row = await this.prisma.workPolicy.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!row) throw new NotFoundException('Work policy not found');
    return toView(row, row._count.employees);
  }

  /**
   * If no capture window is given, screenshots are taken whenever the
   * computer is in use (work-policy.rules.ts › DEFAULT_CAPTURE_WINDOW).
   */
  async create(
    actor: SessionUser,
    dto: CreateWorkPolicyDto,
    ip: string,
  ): Promise<WorkPolicyView> {
    const screenshotFrom =
      dto.screenshotFrom === undefined ? DEFAULT_CAPTURE_WINDOW.screenshotFrom : dto.screenshotFrom;
    const screenshotTo =
      dto.screenshotTo === undefined ? DEFAULT_CAPTURE_WINDOW.screenshotTo : dto.screenshotTo;
    this.assertWindow(screenshotFrom, screenshotTo);
    const regime = this.checkedRegime(dto);

    const row = await this.prisma.workPolicy.create({
      data: {
        name: dto.name,
        ...regime,
        ...(dto.monthlyTargetHours === undefined
          ? {}
          : { monthlyTargetHours: dto.monthlyTargetHours }),
        ...(dto.expectedWorkdays === undefined
          ? {}
          : { expectedWorkdays: dto.expectedWorkdays }),
        weeklyOffDays: normaliseOffDays(dto.weeklyOffDays ?? []),
        screenshotFrom,
        screenshotTo,
        // Careful: no default is set: empty means "open all day", the earlier
        // behavior. More alerts is safer than alerts quietly turning off on a new policy.
        officeFrom: dto.officeFrom ?? null,
        officeTo: dto.officeTo ?? null,
        ...(dto.idleThresholdSec === undefined
          ? {}
          : { idleThresholdSec: dto.idleThresholdSec }),
        ...(dto.slotMinutes === undefined ? {} : { slotMinutes: dto.slotMinutes }),
        ...(dto.screenshotsEnabled === undefined
          ? {}
          : { screenshotsEnabled: dto.screenshotsEnabled }),
        ...(dto.dailyTaskTarget === undefined
          ? {}
          : { dailyTaskTarget: dto.dailyTaskTarget }),
      },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.workPolicy,
      targetId: row.id,
      ipAddress: ip,
      meta: { op: 'create', name: row.name },
    });

    return toView(row, 0);
  }

  async update(
    actor: SessionUser,
    id: number,
    dto: UpdateWorkPolicyDto,
    ip: string,
  ): Promise<WorkPolicyView> {
    const before = await this.prisma.workPolicy.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Work policy not found');

    // Careful: if only one end is sent, it must be validated against the old
    // one. Looking at the new part alone would make "start 22:00" seem valid
    // when the old end was 18:00, not 23:00: the window would invert.
    // `undefined` = not sent (keep), `null` = whenever the computer is in use
    const screenshotFrom =
      dto.screenshotFrom === undefined ? before.screenshotFrom : dto.screenshotFrom;
    const screenshotTo =
      dto.screenshotTo === undefined ? before.screenshotTo : dto.screenshotTo;
    this.assertWindow(screenshotFrom, screenshotTo);

    /**
     * The office hours are validated **together** in the same way: if only one
     * end comes, it has to be paired with the old one.
     *
     * Careful: one difference: **leaving them empty is valid** here (= open
     * all day), so if neither is present there is no question of validating.
     */
    const officeFrom = dto.officeFrom ?? before.officeFrom;
    const officeTo = dto.officeTo ?? before.officeTo;
    if (officeFrom && officeTo) this.assertWindow(officeFrom, officeTo);

    const regime = this.checkedRegime(dto, before);

    const row = await this.prisma.workPolicy.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...regime,
        ...(dto.monthlyTargetHours === undefined
          ? {}
          : { monthlyTargetHours: dto.monthlyTargetHours }),
        ...(dto.expectedWorkdays === undefined
          ? {}
          : { expectedWorkdays: dto.expectedWorkdays }),
        ...(dto.weeklyOffDays === undefined
          ? {}
          : { weeklyOffDays: normaliseOffDays(dto.weeklyOffDays) }),
        screenshotFrom,
        screenshotTo,
        officeFrom,
        officeTo,
        ...(dto.idleThresholdSec === undefined
          ? {}
          : { idleThresholdSec: dto.idleThresholdSec }),
        ...(dto.slotMinutes === undefined ? {} : { slotMinutes: dto.slotMinutes }),
        ...(dto.screenshotsEnabled === undefined
          ? {}
          : { screenshotsEnabled: dto.screenshotsEnabled }),
        ...(dto.dailyTaskTarget === undefined
          ? {}
          : { dailyTaskTarget: dto.dailyTaskTarget }),
      },
      include: { _count: { select: { employees: true } } },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.workPolicy,
      targetId: id,
      ipAddress: ip,
      // Which config changed reaches the agent (the config version hash
      // changes), so "who changed idle threshold from 60 to 600" needs an answer
      meta: { op: 'update', fields: Object.keys(dto), name: row.name },
    });

    return toView(row, row._count.employees);
  }

  /**
   * Careful: not a delete, `is_active = false`. Employees point at the policy
   * through an FK, and which target an old month was calculated on is history too.
   */
  async deactivate(
    actor: SessionUser,
    id: number,
    ip: string,
  ): Promise<WorkPolicyView> {
    const before = await this.prisma.workPolicy.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!before) throw new NotFoundException('Work policy not found');
    if (!before.isActive) {
      throw new ConflictException('This policy has already been deactivated');
    }

    // The biggest trap. When `AgentConfigService.build(null)` gets no policy
    // it does `findFirst({ isActive: true })`, and if it finds nothing it
    // throws "no active work policy". So deactivating the last active policy
    // would break **every agent's config sync and enroll** for staff whose
    // `policy_id` is empty, and it would break in another module, so finding
    // the cause could take days.
    const activeCount = await this.prisma.workPolicy.count({
      where: { isActive: true },
    });
    if (activeCount <= 1) {
      throw new ConflictException(
        'The last active work policy cannot be deactivated — activate another one first',
      );
    }

    // Careful: if staff still point at it, the deactivated policy would keep
    // running their agent (`build(policyId)` does not check isActive), and the
    // word "inactive" would be a lie.
    if (before._count.employees > 0) {
      throw new ConflictException(
        `${before._count.employees} staff are still on this policy — move them to another policy first`,
      );
    }

    const row = await this.prisma.workPolicy.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.workPolicy,
      targetId: id,
      ipAddress: ip,
      meta: { op: 'deactivate', name: row.name },
    });

    return toView(row, 0);
  }

  /**
   * **G85: the reopening code alongside the closing code.**
   *
   * Until now `deactivate()` existed and `reactivate()` did not. So a policy
   * that was deactivated stayed that way **for good**, and the only way back
   * was SQL on the server.
   *
   * Careful: the harm is not as sharp as with staff login (G84): to
   * deactivate a policy all staff must first be moved off it, so nobody gets
   * stuck. But once pressed by mistake there is no way back, and nothing on
   * screen says so.
   *
   * Found after fixing G84, by writing the rule down and **reviewing the rest
   * of the code with the same eye**, rather than waiting to hit it in the field.
   */
  async reactivate(
    actor: SessionUser,
    id: number,
    ip: string,
  ): Promise<WorkPolicyView> {
    const before = await this.prisma.workPolicy.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!before) throw new NotFoundException('Work policy not found');
    if (before.isActive) {
      throw new ConflictException('This policy is already active');
    }

    const row = await this.prisma.workPolicy.update({
      where: { id },
      data: { isActive: true },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.workPolicy,
      targetId: id,
      ipAddress: ip,
      meta: { op: 'reactivate', name: row.name },
    });

    /**
     * Careful: the staff count here comes from `before`'s count, not an
     * assumed zero.
     *
     * Writing `toView(row, 0)` in `deactivate()` is **right**, because it
     * refuses to proceed unless the count is zero. But assuming zero here
     * would be a guess: a deactivated policy can have staff (if someone put
     * them there with SQL, or the rule changes later), and the screen would
     * show "0 staff" while they are in fact there.
     */
    return toView(row, before._count.employees);
  }

  /** The regime fields, checked (a weekly target needs its weekly hours…) */
  private checkedRegime(
    dto: RegimeInput,
    before?: Parameters<typeof regimeData>[1],
  ): RegimeInput {
    try {
      return regimeData(dto, before);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  private assertWindow(from: string | null, to: string | null): void {
    const problem = captureWindowProblem(from, to);
    if (problem) throw new BadRequestException(problem);
  }
}

function toView(policy: WorkPolicy, employeeCount: number): WorkPolicyView {
  return {
    id: policy.id,
    name: policy.name,
    // Decimal -> number. Careful: this could not be done for money, but hours
    // are not money, and `AgentConfigService` sends the agent exactly this way;
    // if the two differed, the dashboard and the agent would show different numbers.
    targetBasis: policy.targetBasis,
    monthlyTargetHours: Number(policy.monthlyTargetHours),
    expectedWorkdays: policy.expectedWorkdays,
    weeklyTargetHours: policy.weeklyTargetHours === null ? null : Number(policy.weeklyTargetHours),
    dailyTargetHours: policy.dailyTargetHours === null ? null : Number(policy.dailyTargetHours),
    breakMinutes: policy.breakMinutes,
    overtimeMultiplier: policy.overtimeMultiplier === null ? null : Number(policy.overtimeMultiplier),
    deductShortfall: policy.deductShortfall,
    weeklyOffDays: policy.weeklyOffDays,
    screenshotFrom: policy.screenshotFrom,
    screenshotTo: policy.screenshotTo,
    screenshotsEnabled: policy.screenshotsEnabled,
    officeFrom: policy.officeFrom,
    officeTo: policy.officeTo,
    idleThresholdSec: policy.idleThresholdSec,
    dailyTaskTarget: policy.dailyTaskTarget,
    slotMinutes: policy.slotMinutes,
    timezone: policy.timezone,
    isActive: policy.isActive,
    employeeCount,
  };
}
