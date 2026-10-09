import type { PeriodSummary } from '../../api/hoursStatement';
import { translate } from '../../i18n';
import {
  formatDateMedium,
  formatDateShort,
  formatDateTime,
} from '../../lib/format';

/** '173 h 25 min' — the shape payroll forms ask for; the sign is kept ('−0 h 50 min') */
export function hm(totalMin: number): string {
  const sign = totalMin < 0 ? '−' : '';
  const abs = Math.abs(Math.trunc(totalMin));
  return `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, '0')} min`;
}

export type LineStatus = 'live' | 'to_post' | 'posted' | 'posted_different';

/**
 * Where a line stands: `live` on the open period (no stored line yet), then
 * waiting to be posted, posted as proposed, or posted with another value.
 */
export function lineStatus(line: {
  id: number | null;
  postedAt: string | null;
  postedMin: number | null;
}): LineStatus {
  if (line.id === null) return 'live';
  if (line.postedAt === null) return 'to_post';
  return line.postedMin === null ? 'posted' : 'posted_different';
}

/** English keys, translated where shown */
export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  live: 'In progress',
  to_post: 'To post',
  posted: 'Posted',
  posted_different: 'Posted, different value',
};

/** '26 Sep – 25 Oct 2026' */
export function periodLabel(start: string, end: string): string {
  return `${formatDateShort(start)} – ${formatDateMedium(end)}`;
}

/**
 * Which period the screen opens on: the one asked for (`?period=`, the
 * email's link) when it exists, else the newest frozen one, else the open
 * one. `periods` comes newest first.
 */
export function pickPeriod(
  periods: readonly PeriodSummary[],
  requested: number | null,
): PeriodSummary | null {
  return (
    periods.find((p) => p.id === requested) ??
    periods.find((p) => !p.open) ??
    periods[0] ??
    null
  );
}

/**
 * The owner may send any frozen statement again: after fixing the email
 * settings, or because a sent one was lost. The open period has nothing to send.
 */
export function canResend(period: PeriodSummary): boolean {
  return !period.open;
}

/** One line under the picker: how the email went. `null` for the open period. */
export function deliveryLine(
  period: PeriodSummary,
): { text: string; problem: boolean } | null {
  if (period.open) return null;
  switch (period.deliveryStatus) {
    case 'sent':
      return {
        text: translate('Sent on {{date}}', {
          date: formatDateTime(period.sentAt),
        }),
        problem: false,
      };
    case 'not_configured':
      return { text: translate('Not sent: SMTP is not set up'), problem: true };
    case 'no_recipients':
      return {
        text: translate(
          'No recipients — add a finance login or an address in Settings → Notifications',
        ),
        problem: true,
      };
    case 'failed':
      // the server's detail reaches the owner only; finance gets `null`
      return {
        text:
          period.deliveryError === null
            ? translate('The email could not be sent')
            : translate('Failed: {{error}}', { error: period.deliveryError }),
        problem: true,
      };
    case 'no_staff':
      return {
        text: translate('Not sent: nobody was paid by the hour in this period'),
        problem: false,
      };
    case 'pending':
    case null:
      return { text: translate('Waiting to be sent'), problem: false };
  }
}

/** A total in minutes as the dialog's two fields; a negative total keeps its sign on the hours */
export function splitHm(totalMin: number): { hours: string; minutes: string } {
  const abs = Math.abs(Math.trunc(totalMin));
  return {
    hours: `${totalMin < 0 ? '-' : ''}${Math.floor(abs / 60)}`,
    minutes: String(abs % 60),
  };
}

/**
 * The dialog's two fields back to minutes — `null` when they do not make a
 * duration. A leading minus on the hours makes the whole value negative
 * ('-0' and '50' is −50).
 */
export function joinHm(hours: string, minutes: string): number | null {
  const h = hours.trim().replace('−', '-');
  const m = minutes.trim() === '' ? '0' : minutes.trim();
  if (!/^-?\d+$/.test(h) || !/^\d+$/.test(m)) return null;
  const mm = Number(m);
  if (mm > 59) return null;
  const total = Math.abs(Number(h)) * 60 + mm;
  return h.startsWith('-') ? -total : total;
}
