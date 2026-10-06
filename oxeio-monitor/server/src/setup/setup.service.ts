import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { WORK_TIMEZONE } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import type { SessionUser } from '../auth/types';
import { HolidaysService } from '../calendar/holidays.service';
import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { validateRegion } from '../settings/app-settings.rules';
import { AppSettingsService } from '../settings/app-settings.service';
import { ORGANIZATION_SETTING_KEY } from '../settings/organization';
import { REGION_SETTING_KEY } from '../settings/region-key';
import { DEFAULT_APP_CATEGORIES } from './default-categories';
import type { SetupDto } from './setup.dto';
import { checkCountry, checkOrganizationName, checkWorkRules, defaultWorkRules } from './setup.rules';

export interface SetupStatus {
  /** no owner yet — the wizard is shown instead of the login */
  needed: boolean;
}

export interface SetupResult {
  owner: Omit<SessionUser, 'issuedAt'>;
  /** the chosen time zone takes effect after a restart (the server restarts itself) */
  restartNeeded: boolean;
  holidaysAdded: number;
  holidayNotes: string[];
}

/**
 * First run: an install without an owner shows a setup wizard instead of the
 * login. Whoever reaches a fresh install first could claim it, so the wizard
 * needs a one-time token that only the person running the server can see: it
 * is printed in the server log at start (or set with SETUP_TOKEN).
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupService.name);
  private token: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly settings: AppSettingsService,
    private readonly holidays: HolidaysService,
    private readonly audit: AuditService,
    private readonly features: FeaturesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!(await this.needed())) return;
    this.token = process.env.SETUP_TOKEN?.trim() || randomBytes(24).toString('base64url');
    const base = (process.env.PUBLIC_URL?.trim() || process.env.CORS_ORIGIN?.trim() || '').replace(/\/$/, '');
    this.logger.warn(
      `First run — no owner yet. Open ${base || '<this server>'}/setup?token=${this.token} to set up oXeio.`,
    );
  }

  async needed(): Promise<boolean> {
    return (await this.prisma.user.count({ where: { role: UserRole.owner } })) === 0;
  }

  async status(): Promise<SetupStatus> {
    return { needed: await this.needed() };
  }

  /** The token, for tests */
  currentToken(): string | null {
    return this.token;
  }

  async run(dto: SetupDto, ip: string, now = new Date()): Promise<SetupResult> {
    if (!(await this.needed())) throw new ConflictException('oXeio is already set up — sign in instead');
    // a SETUP_TOKEN set by the admin always wins over the generated one
    const expected = process.env.SETUP_TOKEN?.trim() || this.token;
    if (!expected || !sameToken(dto.token, expected)) {
      throw new ForbiddenException(
        'The setup link is not valid. Use the link printed in the server log when it started.',
      );
    }

    // everything is checked before anything is written
    let organizationName: string;
    let country: string | null;
    let region: ReturnType<typeof validateRegion>;
    let rules: ReturnType<typeof checkWorkRules>;
    try {
      organizationName = checkOrganizationName(dto.organizationName);
      country = checkCountry(dto.country);
      region = validateRegion({
        timeZone: dto.timeZone,
        currency: dto.currency,
        displayLocale: dto.displayLocale ?? '',
      });
      rules = checkWorkRules(
        {
          monthlyTargetHours: dto.monthlyTargetHours,
          expectedWorkdays: dto.expectedWorkdays,
          weeklyOffDays: dto.weeklyOffDays,
        },
        defaultWorkRules(country),
      );
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const email = dto.ownerEmail.trim().toLowerCase();
    const passwordHash = await this.passwords.hash(dto.ownerPassword);

    const owner = await this.prisma.$transaction(async (tx) => {
      // a second wizard racing this one loses here
      if ((await tx.user.count({ where: { role: UserRole.owner } })) > 0) {
        throw new ConflictException('oXeio is already set up — sign in instead');
      }
      if (await tx.user.findUnique({ where: { email } })) {
        throw new ConflictException('That email already has a login');
      }
      const user = await tx.user.create({
        data: { email, fullName: dto.ownerName.trim(), passwordHash, role: UserRole.owner, mustChangePw: false },
      });

      if ((await tx.workPolicy.count()) === 0) {
        await tx.workPolicy.create({
          data: {
            name: 'Standard',
            monthlyTargetHours: rules.monthlyTargetHours,
            expectedWorkdays: rules.expectedWorkdays,
            weeklyOffDays: rules.weeklyOffDays,
            screenshotFrom: '07:00',
            screenshotTo: '23:00',
            idleThresholdSec: 60,
            slotMinutes: 5,
            timezone: region.timeZone ?? WORK_TIMEZONE,
            isActive: true,
          },
        });
      }

      if ((await tx.appCategory.count()) === 0) {
        await tx.appCategory.createMany({
          data: DEFAULT_APP_CATEGORIES.map(([matchType, pattern, displayName, category, priority]) => ({
            matchType,
            pattern,
            displayName,
            category,
            priority: priority ?? 100,
          })),
        });
      }
      return user;
    });

    await this.settings.save(REGION_SETTING_KEY, { ...region }, owner.id);
    await this.settings.save(ORGANIZATION_SETTING_KEY, { name: organizationName, country }, owner.id);
    // the original company's own modules start off on a new install; the
    // owner turns them on in Settings → Modules if they fit
    await this.features.save(
      { ...(await this.features.all()), designTargets: false, deposits: false },
      owner.id,
    );

    const sessionUser = {
      userId: owner.id,
      email: owner.email,
      role: owner.role,
      employeeId: null,
      mustChangePw: false,
    };

    let holidaysAdded = 0;
    const holidayNotes: string[] = [];
    if (country && dto.importHolidays !== false) {
      const year = now.getUTCFullYear();
      for (const y of [year, year + 1]) {
        try {
          const plan = await this.holidays.importPublic(
            { ...sessionUser, issuedAt: 0 },
            { country, year: y, allowPast: true, dryRun: false },
            ip,
            now,
          );
          holidaysAdded += plan.created;
          holidayNotes.push(...plan.problems);
        } catch (err) {
          // holidays are a convenience here — the install must not fail for them
          holidayNotes.push(err instanceof Error ? err.message : String(err));
          break;
        }
      }
    }

    await this.audit.record({
      userId: owner.id,
      action: 'change_setting',
      targetType: 'setting',
      targetId: 'setup',
      ipAddress: ip,
      meta: { op: 'setup', organizationName, country, timeZone: region.timeZone ?? null, holidaysAdded },
    });
    this.token = null;
    this.logger.log(`Set up for "${organizationName}" — owner ${email}`);

    return {
      owner: sessionUser,
      restartNeeded: (region.timeZone ?? WORK_TIMEZONE) !== WORK_TIMEZONE,
      holidaysAdded,
      holidayNotes,
    };
  }
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
