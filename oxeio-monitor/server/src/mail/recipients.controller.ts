import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Put,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { AppSettingsService } from '../settings/app-settings.service';
import {
  cleanAddresses,
  ENV_FALLBACK,
  MAIL_KINDS,
  RECIPIENTS_SETTING_KEY,
  recipientsSaveProblem,
  type MailKind,
  type RecipientsSaved,
} from './recipients.rules';
import { MailRecipients } from './recipients.service';

export interface RecipientsView {
  kinds: {
    kind: MailKind;
    saved: string[];
    effective: string[];
    /** null = the kind has no environment fallback */
    envVariable: string | null;
  }[];
}

/** Who receives which email — owner only, like every list that carries everyone's hours */
@Roles(UserRole.owner)
@Controller('settings/mail-recipients')
export class MailRecipientsController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly recipients: MailRecipients,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<RecipientsView> {
    const saved = (await this.settings.recipients()) ?? {};
    const kinds = await Promise.all(
      MAIL_KINDS.map(async (kind) => ({
        kind,
        saved: cleanAddresses(saved[kind] ?? []),
        effective: await this.recipients.for(kind),
        envVariable: ENV_FALLBACK[kind],
      })),
    );
    return { kinds };
  }

  /**
   * The body is validated by `recipientsSaveProblem` instead of a DTO class:
   * its keys are the kinds of email, and a class would have to list them twice.
   */
  @Put()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() body: unknown,
    @Ip() ip: string,
  ): Promise<RecipientsView> {
    const problem = recipientsSaveProblem(body);
    if (problem) throw new BadRequestException(problem);

    const next: RecipientsSaved = {};
    for (const [kind, list] of Object.entries(
      body as Record<MailKind, string[]>,
    )) {
      next[kind as MailKind] = cleanAddresses(list);
    }
    await this.settings.replace(RECIPIENTS_SETTING_KEY, next, actor.userId);
    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: RECIPIENTS_SETTING_KEY,
      ipAddress: ip,
      meta: {
        op: 'mail_recipients',
        counts: Object.fromEntries(
          Object.entries(next).map(([k, v]) => [k, v.length]),
        ),
      },
    });
    return this.read();
  }
}
