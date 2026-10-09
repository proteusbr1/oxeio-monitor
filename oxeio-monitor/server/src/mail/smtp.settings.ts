/**
 * SMTP settings — pure rules, no I/O.
 *
 * Saved on screen (Settings → Notifications) › the `SMTP_*` environment
 * variables › off. The screen only wins once it has a host, and its fields are
 * never mixed with the environment's: half of one and half of the other would
 * be a configuration nobody wrote.
 *
 * ⚠️ The password is write-only. `smtpView()` says whether one is set and
 *    nothing more; it never goes to the browser, the audit log or the log.
 */

export const SMTP_SETTING_KEY = 'smtp';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS from the first byte (port 465); false = STARTTLS */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface SmtpSaved {
  host?: string;
  port?: number;
  /** null = decide from the port (465 → true) */
  secure?: boolean | null;
  user?: string;
  pass?: string;
  from?: string;
}

export type SmtpSource = 'database' | 'env' | 'none';

export interface ResolvedSmtp {
  config: SmtpConfig | null;
  source: SmtpSource;
}

export interface SmtpView {
  configured: boolean;
  source: SmtpSource;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordSet: boolean;
  from: string;
}

/** What the SMTP card sends. An empty `pass` means "keep the stored one". */
export interface SmtpInput {
  host: string;
  port: number;
  secure?: boolean | null;
  user?: string;
  pass?: string;
  from?: string;
}

const DEFAULT_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

function portOf(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

function senderOf(from: string | undefined, host: string): string {
  return from?.trim() || `oXeio <no-reply@${host}>`;
}

export function resolveSmtp(
  saved: SmtpSaved | null,
  env: Record<string, string | undefined>,
): ResolvedSmtp {
  const dbHost = saved?.host?.trim() ?? '';
  if (dbHost) {
    const port = portOf(saved?.port);
    return {
      source: 'database',
      config: {
        host: dbHost,
        port,
        secure:
          typeof saved?.secure === 'boolean'
            ? saved.secure
            : port === IMPLICIT_TLS_PORT,
        user: saved?.user?.trim() || undefined,
        pass: saved?.pass || undefined,
        from: senderOf(saved?.from, dbHost),
      },
    };
  }

  const envHost = env.SMTP_HOST?.trim() ?? '';
  if (envHost) {
    const port = portOf(env.SMTP_PORT);
    return {
      source: 'env',
      config: {
        host: envHost,
        port,
        // the rule the .env always had: SMTP_SECURE=true forces TLS, otherwise 465 means TLS
        secure:
          (env.SMTP_SECURE ?? '').toLowerCase() === 'true'
            ? true
            : port === IMPLICIT_TLS_PORT,
        user: env.SMTP_USER?.trim() || undefined,
        pass: env.SMTP_PASS || undefined,
        from: senderOf(env.SMTP_FROM, envHost),
      },
    };
  }

  return { config: null, source: 'none' };
}

export function smtpView(resolved: ResolvedSmtp): SmtpView {
  const c = resolved.config;
  return {
    configured: c !== null,
    source: resolved.source,
    host: c?.host ?? '',
    port: c?.port ?? DEFAULT_PORT,
    secure: c?.secure ?? false,
    user: c?.user ?? '',
    passwordSet: Boolean(c?.pass),
    from: c?.from ?? '',
  };
}

/** `null` if the card can be saved, otherwise the reason (English; translated on screen) */
export function smtpSaveProblem(input: SmtpInput): string | null {
  if (!input.host?.trim()) return 'Give the SMTP server host';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return 'The SMTP port must be a number from 1 to 65535';
  }
  const from = input.from?.trim() ?? '';
  if (from && !/[^\s@<>]+@[^\s@<>]+/.test(from)) {
    return 'The sender must contain an email address';
  }
  return null;
}

/** The row to store: trimmed, with the old password kept when none was typed */
export function mergeSmtpSave(
  previous: SmtpSaved | null,
  input: SmtpInput,
): SmtpSaved {
  const typed = input.pass ?? '';
  return {
    host: input.host.trim(),
    port: input.port,
    secure: typeof input.secure === 'boolean' ? input.secure : null,
    user: input.user?.trim() ?? '',
    pass: typed.length > 0 ? typed : (previous?.pass ?? ''),
    from: input.from?.trim() ?? '',
  };
}
