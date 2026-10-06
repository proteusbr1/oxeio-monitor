import 'reflect-metadata';

import { readFileSync } from 'node:fs';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { PrismaClient } from '@prisma/client';

import { fixedOffsetMinutes } from './agent/util/fixed-offset';
import { configureApp } from './app.setup';
import { ReportingLogger } from './error-reporting/reporting-logger';
import { REGION_SETTING_KEY } from './settings/region-key';

/**
 * I01 — the decision to turn TLS on.
 *
 * This must happen **before** `NestFactory.create()`: Node's HTTP and HTTPS
 * servers are different things, and once the server exists there is no way to
 * say "TLS from now on". So `ConfigService` cannot be used here (it lives in the
 * DI container, which does not exist yet); `process.env` is read directly.
 * Careful: the two variables therefore do nothing from `.env` unless they reach
 * the process environment; they must come from docker-compose or systemd.
 *
 * Three states, deliberately distinct:
 *
 * 1. **Both empty** → HTTP. No hassle making certs in development, and the
 *    previous behaviour stays exactly as it was.
 *
 * 2. **Both set** → HTTPS.
 *
 * 3. **One set, the other not** → the process refuses to start.
 *
 * Important: in the third state we do not "run with what we have" or "fall back
 * to HTTP"; this is the key decision here. A silent fall back to HTTP in
 * production would leave the server running, the dashboard opening, and the
 * agents sending their **device tokens in plaintext** over the LAN, where any
 * machine in the office could capture them. Nobody would notice, because
 * everything would look fine from outside. One typo (`TLS_KEY` vs
 * `TLS_KEYFILE`) could leave a security hole open for months.
 */
function loadTlsOptions(): { key: Buffer; cert: Buffer } | undefined {
  const certPath = process.env.TLS_CERT?.trim();
  const keyPath = process.env.TLS_KEY?.trim();

  if (!certPath && !keyPath) return undefined;

  if (!certPath || !keyPath) {
    const missing = certPath ? 'TLS_KEY' : 'TLS_CERT';
    throw new Error(
      `TLS is only half configured — ${missing} is missing. ` +
        'Set both TLS_CERT and TLS_KEY, or neither (then it runs on HTTP).',
    );
  }

  // Careful: readFileSync is synchronous on purpose. It runs once in the life of
  // the process, and if it fails there is no point starting the server. With
  // async the mistake would surface later, somewhere else.
  const read = (label: string, path: string): Buffer => {
    try {
      return readFileSync(path);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not read ${label} (${path}) — ${why}`);
    }
  };

  return {
    cert: read('TLS_CERT', certPath),
    key: read('TLS_KEY', keyPath),
  };
}

/**
 * The work-day zone saved on Settings → Region, applied before anything
 * reads WORK_TIMEZONE.
 *
 * ⚠️ It has to happen here, before the app is imported: `dhaka-time.ts` and
 *    the `@Cron({ timeZone })` options read the zone the moment they are
 *    loaded. That is also why a new zone needs a restart.
 * ⚠️ Never stops the start: no database yet, no saved zone, or a saved zone
 *    that fails the check (e.g. a DST rule changed) — the .env value stays,
 *    and the reason is logged. A bad setting must not lock the server in a
 *    restart loop with no screen left to fix it from.
 */
async function applySavedTimeZone(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const prisma = new PrismaClient();
  try {
    const row = await prisma.setting.findUnique({
      where: { key: REGION_SETTING_KEY },
      select: { value: true },
    });
    const saved = (row?.value as { timeZone?: unknown } | null)?.timeZone;
    if (typeof saved !== 'string' || saved.trim() === '') return;

    const zone = saved.trim();
    fixedOffsetMinutes(zone);
    process.env.WORK_TIMEZONE = zone;
    // log timestamps follow it too
    process.env.TZ = zone;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.warn(`Saved time zone not applied, keeping WORK_TIMEZONE from the environment: ${why}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function bootstrap(): Promise<void> {
  const httpsOptions = loadTlsOptions();

  await applySavedTimeZone();
  // ⚠️ imported only now, after the zone is known (see applySavedTimeZone)
  const { AppModule } = await import('./app.module');
  // the same goes for anything that reaches the settings (and so the zone)
  const { ErrorReporter } = await import('./error-reporting/error-reporter.service');

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    httpsOptions,
  });
  // errors in the log also go to Sentry when the owner turned that on
  app.useLogger(new ReportingLogger(app.get(Logger), app.get(ErrorReporter)));

  const config = app.get(ConfigService);

  configureApp(app, {
    corsOrigin: config.get<string>('CORS_ORIGIN', 'http://localhost:5173'),
  });

  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');

  // Careful: the scheme must be in the log. From "server is running" an admin
  // could assume TLS is on; without the protocol written down, the mistake would
  // only surface on the day an agent fails to connect.
  app
    .get(Logger)
    .log(`oXeio API ${httpsOptions ? 'https' : 'http'}://0.0.0.0:${port}`);
}

// Careful: an uncaught rejection kills Node with an ugly stack trace, and the
// owner of the 15 PCs cannot make sense of it. A misconfigured TLS stops here:
// one clear line, then exit 1 (this also makes it clear why docker's
// `restart: unless-stopped` should not retry forever).
void bootstrap().catch((error: unknown) => {
  const why = error instanceof Error ? error.message : String(error);
  // Careful: `console`, not the pino logger. At this stage the DI container may
  // have collapsed, so the logger itself may not exist.
  console.error(`oXeio API failed to start: ${why}`);
  process.exit(1);
});
