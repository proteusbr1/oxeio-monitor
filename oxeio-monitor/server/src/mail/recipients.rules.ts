/**
 * Who receives each kind of email — pure rules.
 *
 * The mistake this guards against is big: these emails carry every person's
 * name and hours, and once sent they cannot be taken back. So the order is
 * fixed and the same for every kind: the list saved on screen › the kind's
 * old environment variable › the active owners. Managers are never added.
 */

export const RECIPIENTS_SETTING_KEY = 'mail.recipients';

export const MAIL_KINDS = [
  'alerts',
  'dailyDigest',
  'weeklyDigest',
  'monthClosed',
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export type RecipientsSaved = Partial<Record<MailKind, string[]>>;

/** The variable each kind read before this screen existed (alerts and digests never shared one) */
export const ENV_FALLBACK: Record<
  MailKind,
  'ALERT_EMAIL_TO' | 'DIGEST_EMAIL_TO'
> = {
  alerts: 'ALERT_EMAIL_TO',
  dailyDigest: 'DIGEST_EMAIL_TO',
  weeklyDigest: 'DIGEST_EMAIL_TO',
  monthClosed: 'DIGEST_EMAIL_TO',
};

const MAX_PER_KIND = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isMailKind(value: unknown): value is MailKind {
  return (
    typeof value === 'string' &&
    (MAIL_KINDS as readonly string[]).includes(value)
  );
}

/** Trimmed, blanks dropped, `A@x` and `a@x` sent once — first spelling kept */
export function cleanAddresses(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const email = entry.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export function splitList(value: string | undefined): string[] {
  return cleanAddresses((value ?? '').split(','));
}

export interface RecipientsInput {
  kind: MailKind;
  saved: RecipientsSaved | null;
  env: Record<string, string | undefined>;
  owners: readonly string[];
}

export function recipientsFor(input: RecipientsInput): string[] {
  const saved = cleanAddresses(input.saved?.[input.kind] ?? []);
  if (saved.length > 0) return saved;

  const fromEnv = splitList(input.env[ENV_FALLBACK[input.kind]]);
  if (fromEnv.length > 0) return fromEnv;

  return cleanAddresses(input.owners);
}

/** `null` if the body can be stored, otherwise the reason */
export function recipientsSaveProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Send an object of email lists, one per kind of email';
  }
  for (const [kind, list] of Object.entries(value)) {
    if (!isMailKind(kind)) return `Unknown kind of email: ${kind}`;
    if (!Array.isArray(list)) return `The ${kind} recipients must be a list`;
    if (list.length > MAX_PER_KIND)
      return `At most ${MAX_PER_KIND} addresses per kind of email`;
    for (const email of list) {
      if (typeof email !== 'string' || !EMAIL.test(email.trim())) {
        return `Not an email address: ${String(email)}`;
      }
    }
  }
  return null;
}
