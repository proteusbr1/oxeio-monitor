import { Controller, Get } from '@nestjs/common';

import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /// Docker healthcheck, the Live Board's "is the server up?" check, and the
  /// external uptime monitor (R4) all use this one endpoint. It must be reachable
  /// without login, hence @Public.
  ///
  /// Careful: **this returns HTTP 200 even when the database is down** and only
  /// writes `status: 'degraded'` in the body. That looks wrong, but a 503 is not
  /// allowed: Docker's healthcheck hits this same path, and a failed healthcheck
  /// restarts the container. Restarting the API does not fix a down database; it
  /// only creates a **restart loop** and loses the logs.
  ///
  /// So external monitoring must check the **keyword, not the status code**:
  /// a "Keyword" monitor in UptimeRobot with keyword `"db":"up"`
  /// (`deploy/README.md` › "External uptime monitoring"). Watching only the
  /// status code would show "UP" forever even with the database dead, the
  /// blind spot that outside monitor exists to cover.
  @Public()
  @Get()
  async check(): Promise<{
    status: 'ok' | 'degraded';
    db: 'up' | 'down';
    time: string;
    /**
     * Which build is running. The dashboard's corner badge compares this with
     * its own build.
     *
     * Careful: a half deploy (new web, old API) would otherwise be **completely
     * silent**: the page looks new while the API gives old answers, and finding
     * out "I shipped the fix, why doesn't it work?" would cost hours.
     */
    build: string;
    commit: string;
  }> {
    let db: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }

    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      time: new Date().toISOString(),
      // Careful: the defaults are `dev`/`local`. Without Docker (npm run
      // start:dev) the variables are unset, and "dev" beats showing made-up values.
      build: process.env.APP_BUILD || 'dev',
      commit: process.env.APP_COMMIT || 'local',
    };
  }
}
