import { api } from './client';
import type { SettingSource } from './admin';

/** Settings → Error reporting (Sentry, or a self-hosted GlitchTip) */
export interface ErrorReportingView {
  enabled: boolean;
  dsn: string | null;
  host: string | null;
  environment: string;
  browser: boolean;
  source: SettingSource;
}

export interface ErrorReportingTest {
  ok: boolean;
  eventId: string | null;
  message: string;
}

export function getErrorReporting(signal?: AbortSignal): Promise<ErrorReportingView> {
  return api<ErrorReportingView>('/settings/error-reporting', { signal });
}

/** `dsn: ''` clears what was saved here — back to SENTRY_DSN, or off */
export function saveErrorReporting(body: {
  dsn: string;
  environment: string;
  browser: boolean;
}): Promise<ErrorReportingView> {
  return api<ErrorReportingView>('/settings/error-reporting', { method: 'PATCH', body });
}

export function testErrorReporting(): Promise<ErrorReportingTest> {
  return api<ErrorReportingTest>('/settings/error-reporting/test', { method: 'POST' });
}

export interface CrashReport {
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
  path: string;
}

/**
 * A page crashed — tell the server, which forwards it to Sentry when the
 * owner turned dashboard reporting on. Never throws, and a 401 here must not
 * sign anyone out: a crash report is the last thing that should end a session.
 */
export function reportCrash(report: CrashReport): Promise<void> {
  return api<void>('/error-reports', {
    method: 'POST',
    body: report,
    silent401: true,
  }).catch(() => undefined);
}
