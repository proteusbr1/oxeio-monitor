import { randomBytes, randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { hashEnrollmentCode } from '../devices/enrollment-code';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentConfigService, type AgentConfig } from './agent-config.service';
import { hashToken } from './device-auth.guard';
import type { EnrollDto, EnrollLoginDto } from './dto';

/** The part common to both paths: who and where the machine is. */
type EnrollFacts = Omit<EnrollDto, 'enrollmentCode'>;

/**
 * **Device identity: the machine plus who is signed in.**
 *
 * Careful: `machineGuid` alone is not enough. It belongs to the **machine**, not
 * the user. If two staff work on one PC under different Windows accounts, they
 * need separate rows, yet their GUID is identical. The schema already had
 * `@@unique([hostname, windowsUsername])`; that was the real identity, but
 * enroll did not use it.
 */
const identityOf = (dto: EnrollFacts) => ({
  hostname: dto.hostname,
  windowsUsername: dto.windowsUsername,
});

export interface EnrollResult {
  deviceId: number;
  /** Careful: sent only this once; the server stores only the sha256. */
  deviceToken: string;
  employee: { id: number; empCode: string; fullName: string };
  configVersion: string;
  config: AgentConfig;
}

/**
 * When 2FA is on, this is the first response: the agent then shows the
 * six-digit field.
 *
 * Careful: it is signalled with a separate `status` field, not by throwing an
 * error: not sending a code is not an attack, just the normal first step. With a
 * 401 the agent would show "wrong password" and staff would keep typing the
 * correct password again and again.
 */
export type EnrollLoginResult = EnrollResult | { status: 'needs_totp' };

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configs: AgentConfigService,
    private readonly auth: AuthService,
  ) {}

  /**
   * **H05** - with a single-use code (the scripted rollout path).
   *
   * Careful: this path is kept deliberately. When installing on 15 PCs at once,
   * nobody can sit at each keyboard and type. When a person is present,
   * `enrollWithLogin()` is simpler and more accurate.
   */
  async enroll(dto: EnrollDto): Promise<EnrollResult> {
    // Careful: the hash is created and verified by **the same function** on both
    //    sides. Written separately, one would one day change and every
    //    enrollment would break silently.
    const codeHash = hashEnrollmentCode(dto.enrollmentCode);

    const code = await this.prisma.enrollmentCode.findUnique({
      where: { codeHash },
      select: { id: true, employeeId: true, usedAt: true, expiresAt: true },
    });

    // "Does not exist", "already used" and "expired" all get the same message;
    // otherwise guessing codes would be easier (H05 · G18).
    if (!code || code.usedAt || code.expiresAt <= new Date()) {
      throw new UnauthorizedException('Enrolment code is invalid or expired');
    }

    return this.bind(code.employeeId, dto, code.id);
  }

  /**
   * **Staff add their own PC using their own email and password.**
   *
   * Why this second path: with codes, the owner had to create a separate code
   * for each PC, have it used within 24 hours, and match **which code went on
   * which machine** by hand. A wrong match produced no error; one person's
   * worked hours were simply credited to another, and it was noticed only at
   * month end.
   *
   * Here the person at the keyboard **proves who they are themselves**, so the
   * binding is more accurate, not less.
   *
   * Careful: this gives staff no new power. They can **add** their own tracking
   * but cannot remove it. The password is turned into a device token right
   * here, and the agent stores it nowhere.
   *
   * Careful: verification happens in `AuthService.login()`, not copied here, so
   * the login's three safeguards come for free: brute-force throttle, 2FA, and
   * `login`/`login_failed` in `audit_log`. Written separately, all three would
   * be missing and this endpoint would become the easiest door for guessing
   * passwords, easier even than the session login, since there is no CSRF or
   * cookie here.
   */
  async enrollWithLogin(
    dto: EnrollLoginDto,
    ip: string,
  ): Promise<EnrollLoginResult> {
    const outcome = await this.auth.login(dto.email, dto.password, ip, dto.totp);

    if (outcome.status === 'needs_totp') return { status: 'needs_totp' };

    /**
     * Careful: for owner and manager `users.employee_id` is usually null: they
     * have no staff row, so there is nowhere to accumulate hours. Installing the
     * agent on such an account would leave it unclear whose device it is.
     */
    if (outcome.user.employeeId === null) {
      throw new ForbiddenException(
        'This account is not linked to a staff record. Sign in with the staff account for this PC.',
      );
    }

    // Careful: `mustChangePw` is **not** enforced here. The agent reads no data,
    //    it only sends; and telling someone on day one to "first go to the web
    //    and change your password" would block the install itself.
    return this.bind(outcome.user.employeeId, dto, null);
  }

  /**
   * **A device row belongs to one person only; it never changes hands silently.**
   *
   * Careful, the bug this fixes: the `upsert` key was only `machineGuid`, and on
   * a conflict **both `employeeId` and `tokenHash` were overwritten**. So two
   * agents sending the same `machineGuid` passed one row back and forth, and
   * each time:
   *
   *   - the previous session's token stopped working, so that agent silently got
   *     401s and **could send nothing** (to the owner: "suddenly offline");
   *   - the previous employee's device count dropped to **zero**, so the Staff
   *     screen showed "Ready to install" and the Live Board "No agent yet".
   *
   * Careful: the whole thing was **silent**: no error, no log. It was noticed
   * only through that employee's missing hours, days later.
   *
   * The identity is now **(hostname, windowsUsername)**: the machine **and** who
   * is signed in, together. `machineGuid` alone is not enough, because it is
   * **the machine's, not the user's**: two staff on one PC under different
   * Windows accounts need separate rows, yet the GUID is the same.
   *
   * Careful: this is not a guess; it showed up in the office's own logs:
   * "Intern" and "Intern 2" on `DESKTOP-BJNQ6OF`, "Sumaiya" and "user" on
   * `DESKTOP-KP1DT93`.
   *
   * **A legitimate handover path stays open:** once a device is `revoked`, a new
   * employee can take it. So when the same Windows account changes hands, the
   * owner revokes it once in Settings -> Devices, a deliberate step.
   */
  private async assertNotSomeoneElses(
    tx: Prisma.TransactionClient,
    dto: EnrollFacts,
    employeeId: number,
  ): Promise<void> {
    const existing = await tx.device.findUnique({
      where: { hostname_windowsUsername: identityOf(dto) },
      select: {
        status: true,
        hostname: true,
        windowsUsername: true,
        employeeId: true,
        employee: { select: { empCode: true } },
      },
    });

    // New machine, one that belongs to nobody, or the same employee installing
    // again: all three are normal.
    if (
      !existing ||
      existing.employeeId === null ||
      existing.employeeId === employeeId
    ) {
      return;
    }

    // A revoke means the owner released it on purpose, so it can be taken.
    if (existing.status !== 'active') return;

    /**
     * Careful: reaching here means two different staff are signing in on **the
     * same machine's same Windows account**, i.e. they share one login. That
     * cannot be accepted silently: both people's hours would merge into one row
     * and could no longer be told apart.
     */
    this.logger.warn(
      `enrol refused: "${existing.hostname}\\${existing.windowsUsername}" ` +
        `already belongs to ${existing.employee?.empCode ?? `employee #${existing.employeeId}`} — ` +
        `attempt for employee #${employeeId} (machineGuid ${dto.machineGuid}). ` +
        'Two staff are sharing one Windows account: give the second person their own Windows login, ' +
        'or revoke the device first (Settings → Devices).',
    );

    /**
     * Careful: the message has the **empCode, not the name**. It appears on
     * the staff member's screen, and staff usually cannot see the list of
     * colleagues. The code is enough for the owner, who will take the next step.
     */
    throw new ConflictException(
      `This Windows account is already registered to ${existing.employee?.empCode ?? 'another staff member'}. ` +
        'Sign in to your own Windows account on this PC, or ask the owner to revoke it first (Settings → Devices).',
    );
  }

  /**
   * The last step of both paths: the device row, the `agent_start` event, and
   * the config.
   *
   * Careful: kept in one place deliberately. Written twice, one day one path
   * would set `status: 'active'` and the other not, or one would emit the event
   * and the other not, and the difference would show only on machines enrolled
   * through that path.
   */
  private async bind(
    employeeId: number,
    dto: EnrollFacts,
    /** The code's id if via a code (single use, so it must be closed); null for login. */
    codeId: number | null,
  ): Promise<EnrollResult> {
    const deviceToken = randomBytes(32).toString('base64url'); // 256 bits
    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertNotSomeoneElses(tx, dto, employeeId);

        // Installing again on the same machine's same Windows account updates the
        //    existing row rather than creating a new one. Another account means
        //    another row.
        // Careful: `machineGuid` is set in **update too**: after a Windows
        //    reinstall or a GUID change the value would stay old, and H04's rollout
        //    bucket would be computed for the wrong machine.
        const device = await tx.device.upsert({
          where: { hostname_windowsUsername: identityOf(dto) },
          update: {
            employeeId,
            machineGuid: dto.machineGuid,
            osVersion: dto.osVersion ?? null,
            agentVersion: dto.agentVersion ?? null,
            tokenHash: hashToken(deviceToken),
            monitors: dto.monitors ?? 1,
            status: 'active',
            enrolledAt: now,
            lastSeenAt: now,
          },
          create: {
            hostname: dto.hostname,
            windowsUsername: dto.windowsUsername,
            employeeId,
            machineGuid: dto.machineGuid,
            osVersion: dto.osVersion ?? null,
            agentVersion: dto.agentVersion ?? null,
            tokenHash: hashToken(deviceToken),
            monitors: dto.monitors ?? 1,
            status: 'active',
            lastSeenAt: now,
          },
        });

        // Single use: closed right here.
        if (codeId !== null) {
          await tx.enrollmentCode.update({
            where: { id: codeId },
            data: { usedAt: now, usedByDeviceId: device.id },
          });
        }

        await tx.event.create({
          data: {
            deviceId: device.id,
            employeeId,
            clientUuid: randomUUID(),
            type: 'agent_start',
            occurredAt: now,
            meta: {
              enrolled: true,
              hostname: dto.hostname,
              agentVersion: dto.agentVersion ?? null,
              // Careful: which path was used is kept in the event itself; six
              //    months later it is the only clue to "how was this machine added?"
              via: codeId === null ? 'login' : 'code',
            },
          },
        });

        const employee = await tx.employee.findUniqueOrThrow({
          where: { id: employeeId },
          select: { id: true, empCode: true, fullName: true, policyId: true },
        });

        const { version, config } = await this.configs.build(employee.policyId);

        this.logger.log(
          `device ${device.id} (${dto.hostname}) → employee ${employee.empCode}` +
            (codeId === null ? ' [login]' : ' [code]'),
        );

        return {
          deviceId: device.id,
          deviceToken,
          employee: {
            id: employee.id,
            empCode: employee.empCode,
            fullName: employee.fullName,
          },
          configVersion: version,
          config,
        };
      });
    } catch (err) {
      // devices(hostname, windows_username) UNIQUE: trying to insert another row
      // with the same name but a different machine_guid is stopped here
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `Another device is already registered as "${dto.hostname}\\${dto.windowsUsername}"`,
        );
      }
      throw err;
    }
  }
}
