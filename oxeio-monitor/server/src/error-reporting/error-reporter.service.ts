import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  defaultStackParser,
  makeNodeTransport,
  NodeClient,
  Scope,
  type ErrorEvent,
} from '@sentry/node';

import { AppSettingsService } from '../settings/app-settings.service';
import type { ErrorReportingConfig } from './error-reporting.rules';

/** What the dashboard sends when a page crashes */
export interface BrowserReport {
  name: string;
  message: string;
  stack: string | null;
  componentStack: string | null;
  /** the page, e.g. /staff/12 — reported as /staff/:id */
  path: string;
}

/** A log error repeating sooner than this is not sent again */
const LOG_REPEAT_MS = 60 * 60_000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Emails out of free text — error messages sometimes quote an address */
export function redact(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/** `/staff/12?tab=x` → `/staff/:id` — ids and query strings stay here */
export function pagePattern(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? '/';
  return (
    bare
      .split('/')
      .map((part) => (/^\d+$/.test(part) || /^[0-9a-f-]{16,}$/i.test(part) ? ':id' : part))
      .join('/')
      .slice(0, 200) || '/'
  );
}

/**
 * Only what helps fix the bug leaves this server: the error's type, message
 * and stack, the route pattern, the version. No request, user, cookies, IP,
 * host name or breadcrumbs — this system holds salaries, names and
 * screenshots, and Sentry is someone else's server.
 */
export function scrub(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.contexts;
  event.server_name = 'oxeio-api';
  if (event.message) event.message = redact(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redact(value.value);
  }
  return event;
}

export interface TestOutcome {
  ok: boolean;
  eventId: string | null;
  message: string;
}

/** Sentry's HTTP answer, in words the owner can act on */
export function testOutcome(status: number | null, eventId: string | null): TestOutcome {
  if (status !== null && status >= 200 && status < 300) {
    return { ok: true, eventId, message: 'Sent — it should show up in Sentry within a minute.' };
  }
  if (status === 401 || status === 403) {
    return { ok: false, eventId: null, message: `Sentry refused the key (HTTP ${status}) — copy the DSN again.` };
  }
  if (status === 404) {
    return { ok: false, eventId: null, message: 'Sentry does not know that project (HTTP 404) — check the number at the end of the DSN.' };
  }
  if (status === 429) {
    return { ok: false, eventId: null, message: 'Sentry is rate-limiting this project (HTTP 429) — try again later.' };
  }
  if (status !== null) {
    return { ok: false, eventId: null, message: `Sentry answered HTTP ${status}.` };
  }
  return { ok: false, eventId: null, message: 'Could not reach the Sentry server — is the host in the DSN right, and can this server reach it?' };
}

/**
 * Sends errors to Sentry with a client of its own, not `Sentry.init()`: no
 * automatic instrumentation of HTTP, the database or the console (which is
 * where request data and personal details would slip in), and the DSN can
 * change from the screen without a restart.
 */
@Injectable()
export class ErrorReporter implements OnApplicationBootstrap {
  private readonly logger = new Logger(ErrorReporter.name);
  private client: NodeClient | null = null;
  private scope: Scope | null = null;
  private config: ErrorReportingConfig | null = null;
  /** Sentry's answer to the last event sent — the test button reports it */
  private lastStatus: number | null = null;

  constructor(private readonly settings: AppSettingsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reload();
  }

  /** Reads the settings again and swaps the client — after a save */
  async reload(): Promise<ErrorReportingConfig> {
    const config = await this.settings.errorReporting();
    const old = this.client;

    this.config = config;
    this.logSentAt.clear();
    this.client = null;
    this.scope = null;

    if (config.dsn) {
      try {
        const client = new NodeClient({
          dsn: config.dsn,
          environment: config.environment,
          release: process.env.APP_COMMIT || undefined,
          transport: (options) => {
            const transport = makeNodeTransport(options);
            return {
              ...transport,
              send: async (envelope) => {
                const response = await transport.send(envelope);
                this.lastStatus = response.statusCode ?? null;
                return response;
              },
            };
          },
          stackParser: defaultStackParser,
          integrations: [],
          beforeSend: scrub,
        });
        client.init();
        const scope = new Scope();
        scope.setClient(client);
        this.client = client;
        this.scope = scope;
        this.logger.log(`Error reporting on (${config.environment})`);
      } catch (err) {
        // a bad DSN from the .env must not take the server down
        this.logger.error(
          `Error reporting not started: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (old) void old.close(2000);
    return config;
  }

  get enabled(): boolean {
    return this.scope !== null;
  }

  get browserEnabled(): boolean {
    return this.enabled && this.config?.browser === true;
  }

  get logErrorsEnabled(): boolean {
    return this.enabled && this.config?.logErrors === true;
  }

  /** when each log message was last sent — see `captureLog()` */
  private readonly logSentAt = new Map<string, number>();

  /**
   * An error written to the server log (a job, a backup, a delivery that
   * caught its own failure). The same message from the same place is sent
   * at most once an hour: an hourly check failing all night is one problem,
   * not twelve.
   */
  captureLog(message: string, context: string, stack?: string, now = Date.now()): string | null {
    if (!this.scope || !this.logErrorsEnabled) return null;

    // numbers vary between runs (ids, counts, times); the problem does not
    // (and the shape is sent as the grouping key, so it is masked too)
    const shape = `${context}|${redact(message).replace(/\d+/g, '#').slice(0, 300)}`;
    const last = this.logSentAt.get(shape);
    if (last !== undefined && now - last < LOG_REPEAT_MS) return null;
    this.logSentAt.set(shape, now);
    if (this.logSentAt.size > 500) this.logSentAt.clear();

    return this.scope.captureMessage(redact(message.slice(0, 2000)), 'error', {
      captureContext: {
        tags: { source: 'log', context },
        fingerprint: [shape],
        extra: stack ? { stack: redact(stack.slice(0, 8000)) } : {},
      },
    });
  }

  /** A server error — returns the Sentry event id, or null when off */
  capture(error: unknown, tags: Record<string, string> = {}): string | null {
    if (!this.scope) return null;
    return this.scope.captureException(error, {
      captureContext: { tags: { source: 'server', ...tags } },
    });
  }

  /** A crash in someone's dashboard, sent here by the page */
  captureBrowser(report: BrowserReport, role: string): string | null {
    if (!this.scope || !this.browserEnabled) return null;

    const error = new Error(redact(report.message.slice(0, 1000)));
    error.name = report.name.slice(0, 100) || 'Error';
    // the browser's stack, not this server's — kept as text
    error.stack = `${error.name}: ${error.message}\n${(report.stack ?? '').slice(0, 8000)}`;

    return this.scope.captureException(error, {
      captureContext: {
        tags: { source: 'browser', page: pagePattern(report.path), role },
        extra: report.componentStack
          ? { componentStack: report.componentStack.slice(0, 4000) }
          : {},
      },
    });
  }

  /** "Send test error" on the settings screen — waits until it is sent */
  async sendTest(): Promise<TestOutcome> {
    if (!this.scope || !this.client) {
      return { ok: false, eventId: null, message: 'Error reporting is off — save a DSN first.' };
    }

    this.lastStatus = null;
    const eventId = this.scope.captureException(
      new Error('oXeio test error — sent from Settings → Error reporting'),
      { captureContext: { tags: { source: 'test' }, level: 'info' } },
    );
    await this.client.flush(8000);
    return testOutcome(this.lastStatus, eventId);
  }

  /** Waits for queued events — for tests */
  async flush(): Promise<boolean> {
    return this.client ? this.client.flush(5000) : true;
  }
}
