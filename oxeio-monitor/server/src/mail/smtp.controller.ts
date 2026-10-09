import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { AppSettingsService } from '../settings/app-settings.service';
import { mailText } from './mail-text';
import { Mailer, type SendResult } from './mailer';
import {
  mergeSmtpSave,
  SMTP_SETTING_KEY,
  smtpSaveProblem,
  smtpView,
  type SmtpView,
} from './smtp.settings';

class SaveSmtpDto {
  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  /** null = decide from the port */
  @IsOptional()
  @IsBoolean()
  secure?: boolean | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  user?: string;

  /** empty = keep the stored password */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  pass?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  from?: string;
}

class TestSmtpDto {
  @IsOptional()
  @IsEmail()
  to?: string;
}

/**
 * SMTP from the screen, owner only: who receives everyone's figures is not a
 * manager's decision. The password goes in, never out.
 */
@Roles(UserRole.owner)
@Controller('settings/smtp')
export class SmtpSettingsController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<SmtpView> {
    return smtpView(await this.settings.smtp());
  }

  @Patch()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveSmtpDto,
    @Ip() ip: string,
  ): Promise<SmtpView> {
    const problem = smtpSaveProblem(dto);
    if (problem) throw new BadRequestException(problem);

    const next = mergeSmtpSave(await this.settings.smtpSaved(), dto);
    await this.settings.replace(SMTP_SETTING_KEY, { ...next }, actor.userId);

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: SMTP_SETTING_KEY,
      ipAddress: ip,
      // never the password: the audit log is read by managers and kept forever
      meta: {
        op: 'smtp',
        host: next.host,
        port: next.port,
        passwordChanged: (dto.pass ?? '').length > 0,
      },
    });

    return this.read();
  }

  /** Sends one email now and says what the server answered */
  @Post('test')
  async test(
    @CurrentUser() actor: SessionUser,
    @Body() dto: TestSmtpDto,
  ): Promise<SendResult & { to: string }> {
    const to = dto.to?.trim() || actor.email;
    const lang = (await this.settings.region()).language.value;
    const org = (await this.settings.organization()).name;

    const result = await this.mailer.deliver([to], {
      subject: mailText(lang, 'smtpTest.subject', { org }),
      text: mailText(lang, 'smtpTest.body', { by: actor.email }),
    });
    return { ...result, to };
  }
}
