import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { recipientsFor, type MailKind } from './recipients.rules';

/** The addresses for one kind of email, right now */
@Injectable()
export class MailRecipients {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
  ) {}

  async for(kind: MailKind): Promise<string[]> {
    const [saved, owners] = await Promise.all([
      this.settings.recipients(),
      this.prisma.user.findMany({
        where: { role: 'owner', isActive: true },
        select: { email: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return recipientsFor({
      kind,
      saved,
      env: process.env,
      owners: owners.map((o) => o.email),
    });
  }
}
