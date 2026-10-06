/**
 * **Who receives** the weekly summary — a pure rule, no I/O.
 *
 * A separate file, because the rule is small but the mistake is big: this
 * message contains each employee's **name and hours**. Once sent to the wrong
 * address it cannot be taken back.
 *
 * Careful: **managers are not sent it** — the same reasoning as alerts
 * (`alerts.dispatcher.ts`). The summary is the same thing as an owner-only
 * screen; sending it by email must not sidestep the role wall.
 */

export interface DigestRecipientsInput {
  /** `DIGEST_EMAIL_TO` — comma-separated, empty if not given */
  explicit: string | undefined;
  /** Emails of the active owners */
  owners: readonly string[];
}

/**
 * The explicit list if there is one, otherwise the active owners — in exactly
 * the same order as the alerts' `recipients()`, so two places never end up
 * behaving differently.
 *
 * Careful: blank entries and duplicates are filtered out: with `a@x.com,,a@x.com`
 * in `.env`, one person would get it twice, and SMTP would be thrown an empty address.
 */
export function digestRecipients(input: DigestRecipientsInput): string[] {
  const explicit = (input.explicit ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  const chosen = explicit.length > 0 ? explicit : input.owners;

  // Careful: compared in lower case — `A@x.com` and `a@x.com` are the same address
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of chosen) {
    const email = raw.trim();
    if (email.length === 0) continue;

    const key = email.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(email);
  }

  return out;
}
