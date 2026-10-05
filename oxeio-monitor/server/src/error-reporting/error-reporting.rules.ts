import type { Source } from '../settings/app-settings.rules';

/**
 * Error reporting to Sentry (or anything that speaks its protocol, such as a
 * self-hosted GlitchTip). Off until a DSN is set — on Settings → Error
 * reporting, or `SENTRY_DSN` in the .env; the screen wins, as everywhere.
 */
export const ERROR_REPORTING_SETTING_KEY = 'errorReporting';

export const DEFAULT_SENTRY_ENVIRONMENT = 'production';

export interface ErrorReportingSaved {
  /** '' = cleared on screen → back to the .env */
  dsn?: string;
  environment?: string;
  /** also report crashes in the dashboard (sent through this server) */
  browser?: boolean;
  /** also report errors written to the server log (jobs, backups, deliveries) */
  logErrors?: boolean;
}

export interface ErrorReportingConfig {
  dsn: string | null;
  environment: string;
  browser: boolean;
  logErrors: boolean;
  source: Source;
}

/**
 * A DSN looks like `https://<public key>@<host>/<project id>`. Checked here so
 * a typo is refused on save instead of failing silently on the first crash.
 */
export function checkDsn(raw: string): string {
  const dsn = raw.trim();
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('That is not a DSN — copy it from Sentry: Project settings → Client Keys (DSN)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The DSN must start with https://');
  }
  if (!url.username) {
    throw new Error('The DSN has no key — it should look like https://<key>@<host>/<project>');
  }
  if (!/^\/(.+\/)?\d+$/.test(url.pathname)) {
    throw new Error('The DSN must end in the project number, e.g. …/4507123456');
  }
  return dsn;
}

/** Letters, digits, dots, dashes and underscores — what Sentry accepts */
export function checkEnvironment(raw: string): string {
  const env = raw.trim();
  if (env === '') return DEFAULT_SENTRY_ENVIRONMENT;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(env)) {
    throw new Error('The environment is a short name such as production or staging');
  }
  return env;
}

const has = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function resolveErrorReporting(
  saved: ErrorReportingSaved | null,
  env: {
    SENTRY_DSN?: string;
    SENTRY_ENVIRONMENT?: string;
    SENTRY_BROWSER?: string;
    SENTRY_LOG_ERRORS?: string;
  },
): ErrorReportingConfig {
  // the DSN decides on/off and the source; the other two follow the same
  // "screen first" rule on their own, so ticking "dashboard crashes" works
  // while the DSN still comes from the .env
  const dsn = has(saved?.dsn) ? saved.dsn.trim() : has(env.SENTRY_DSN) ? env.SENTRY_DSN.trim() : null;
  const source: Source = has(saved?.dsn) ? 'dashboard' : dsn ? 'environment' : 'default';

  const environment = has(saved?.environment)
    ? saved.environment.trim()
    : has(env.SENTRY_ENVIRONMENT)
      ? env.SENTRY_ENVIRONMENT.trim()
      : DEFAULT_SENTRY_ENVIRONMENT;

  const flag = (savedValue: boolean | undefined, envValue: string | undefined) =>
    dsn !== null &&
    (typeof savedValue === 'boolean'
      ? savedValue
      : envValue?.trim().toLowerCase() === 'true');

  return {
    dsn,
    environment,
    browser: flag(saved?.browser, env.SENTRY_BROWSER),
    logErrors: flag(saved?.logErrors, env.SENTRY_LOG_ERRORS),
    source,
  };
}

/** The DSN host only — what the screen shows next to "on" */
export function dsnHost(dsn: string | null): string | null {
  if (!dsn) return null;
  try {
    return new URL(dsn).host;
  } catch {
    return null;
  }
}
