/**
 * Publishes an agent version from the server's command line — for the
 * person (or tool) that runs the server, without the owner's dashboard
 * session. The checks and the audit live in `src/devices/publish-cli.ts`.
 *
 * -- How to run (inside the API container) ----------------------------------
 *
 *   node dist/scripts/publish-agent-version.js --version 0.5.1 \
 *     --msi updates/oXeioAgent-0.5.1.msi --sha256 <hash> --stage all --dry-run
 *
 * then the same without `--dry-run`. Copy the MSI into the storage folder
 * first (`<storage root>/updates/`).
 *
 * Careful: like `recover-owner.ts`, it opens no new door: running it needs a
 * shell on the server, which already reaches the database. It only puts that
 * power on the same checked, audited path as the dashboard; the audit log
 * shows `via: system:cli` with no user.
 *
 * It lives in `src/` (not `scripts/`) for the same reason as
 * `recover-owner.ts`: the production image has only `dist/`.
 */
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../audit/audit.service';
import { AgentVersionsService } from '../devices/agent-versions.service';
import { runPublish } from '../devices/publish-cli';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';

async function main(): Promise<number> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new AgentVersionsService(
      prisma,
      new AuditService(prisma),
      new AppSettingsService(prisma),
      new ConfigService(),
    );
    return await runPublish(service, process.argv.slice(2), (line) => console.log(line));
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
