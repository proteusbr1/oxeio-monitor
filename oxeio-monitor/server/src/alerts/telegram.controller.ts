import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsString, MaxLength } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramChannel } from './telegram.channel';
import {
  resolveTelegram,
  telegramView,
  TELEGRAM_SETTING_KEY,
  type TelegramSettingsView,
} from './telegram.settings';

class SaveTelegramDto {
  /**
   * Careful: an empty string is **valid**, meaning "delete it and go back to
   * `.env`". So no `@IsNotEmpty()`, otherwise a wrongly entered token could not be removed.
   */
  @IsString() @MaxLength(200)
  botToken!: string;

  @IsString() @MaxLength(64)
  chatId!: string;
}

/**
 * **Telegram config from the screen** (G08).
 *
 * Why it was needed: the token and chat id lived only in `.env`, so changing
 * them meant SSH to the VPS, editing the file and restarting the container.
 * That is practically impossible for the owner, so one mistake would stay
 * wrong for months.
 *
 * Careful: owner-only. The Telegram channel carries staff names and hours, so
 * who receives them is not the manager's decision.
 */
@Roles(UserRole.owner)
@Controller('settings/telegram')
export class TelegramSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramChannel,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<TelegramSettingsView> {
    const row = await this.prisma.setting.findUnique({
      where: { key: TELEGRAM_SETTING_KEY },
    });

    /**
     * Careful: always goes through `telegramView()`, **never the raw row**.
     * The row holds the full token, and sent to the browser it would show up
     * in DevTools, proxy logs or screen shares. Only the last four characters
     * go to the screen.
     */
    return telegramView(
      resolveTelegram((row?.value as Record<string, string> | undefined) ?? null, {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
      }),
    );
  }

  @Patch()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveTelegramDto,
    @Ip() ip: string,
  ): Promise<TelegramSettingsView> {
    const botToken = dto.botToken.trim();
    const chatId = dto.chatId.trim();

    await this.prisma.setting.upsert({
      where: { key: TELEGRAM_SETTING_KEY },
      update: { value: { botToken, chatId }, updatedById: actor.userId },
      create: {
        key: TELEGRAM_SETTING_KEY,
        value: { botToken, chatId },
        updatedById: actor.userId,
      },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: TELEGRAM_SETTING_KEY,
      ipAddress: ip,
      /**
       * Careful: **the token does not go into the audit log either**, only
       * "whether it is set". Both owner and manager can see the audit log, and
       * once a secret is written there it cannot be removed.
       */
      meta: { op: 'telegram', tokenSet: botToken.length > 0, chatId },
    });

    return this.read();
  }

  /**
   * **Whether it really works: a test message.**
   *
   * Careful: without this the owner would save and wait **until Friday**, and
   * if nothing arrived then they would learn something was wrong, with no way
   * to find out what.
   */
  @Patch('test')
  async test(@CurrentUser() actor: SessionUser): Promise<{ outcome: string }> {
    const outcome = await this.telegram.send(
      `oXeio — test message from ${actor.email}. If you can read this, the setup works.`,
    );

    return { outcome };
  }
}
