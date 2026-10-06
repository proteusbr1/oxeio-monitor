import type { RejectReason, RejectedLine } from '../../api/tasks';

/**
 * **What a pasted line means**, so the Add tasks box can say before sending
 * how many tasks the paste will make and which lines will not go in.
 *
 * Careful: this is a **preview**, not a guard. The server parses the same
 * text again and its answer (`BulkResult`) is the one that counts — it alone
 * knows `already_exists`. The rules are kept the same as the server's so the
 * preview and the result do not disagree in front of the person pasting.
 *
 * A line is one of:
 *   - `reference`                 → a task with no link
 *   - `reference | link`          → a task with a link
 *   - `https://…` (a bare URL)    → the URL is both the reference and the link
 */

/** The server's limit per paste; more is refused whole, not cut silently. */
export const MAX_BULK_LINES = 500;
/** Column sizes on the server (`tasks.reference`, `tasks.link`). */
export const REFERENCE_MAX = 200;
export const LINK_MAX = 500;

export interface ParsedTask {
  reference: string;
  link: string | null;
}

const BARE_URL = /^https?:\/\/\S+$/i;

/**
 * A link is kept only when it is an absolute http(s) URL with no spaces —
 * the server's `isWebLink`. Other schemes (`javascript:`, `file:`) never pass:
 * the link becomes a clickable anchor on everyone's screen.
 */
export function isWebLink(raw: string): boolean {
  if (!BARE_URL.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One line → one task, or why not (the server's `taskOfLine`, in the same
 * order of checks, so the preview names the same reason the server will).
 *
 * Careful: only the **first** `|` splits; a link may itself contain `|` in
 * its query string, and splitting there would cut the link in two.
 */
export function parseLine(raw: string): ParsedTask | { reason: RejectReason } {
  const text = raw.trim();

  let reference: string;
  let link: string | null;

  const bar = text.indexOf('|');
  if (bar >= 0) {
    reference = text.slice(0, bar).trim();
    const right = text.slice(bar + 1).trim();
    link = right.length > 0 ? right : null;
    // "| https://…": the link is all there is, so it names the task too
    if (reference.length === 0 && link !== null) reference = link;
  } else if (BARE_URL.test(text)) {
    reference = text;
    link = text;
  } else {
    reference = text;
    link = null;
  }

  if (reference.length > REFERENCE_MAX) return { reason: 'too_long' };
  if (link !== null && link.length > LINK_MAX) return { reason: 'too_long' };
  if (link !== null && !isWebLink(link)) return { reason: 'bad_link' };
  // a bare "|" — nothing to name the task by
  if (reference.length === 0) return { reason: 'bad_link' };

  return { reference, link };
}

export interface BulkPreview {
  /** Non-empty lines: one task each. */
  lines: number;
  /** Lines that would make a task (before the server's `already_exists`). */
  ready: number;
  /** Lines the server would turn away, with the same reasons it uses. */
  rejected: RejectedLine[];
  /** More than `MAX_BULK_LINES` lines: the server refuses the paste. */
  overLimit: boolean;
}

export function previewBulk(text: string): BulkPreview {
  const seen = new Set<string>();
  const rejected: RejectedLine[] = [];
  let lines = 0;
  let ready = 0;

  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === '') return;
    lines += 1;

    const parsed = parseLine(raw);
    if ('reason' in parsed) {
      rejected.push({ line: i + 1, text: raw.trim(), reason: parsed.reason });
      return;
    }
    if (seen.has(parsed.reference)) {
      rejected.push({ line: i + 1, text: raw.trim(), reason: 'duplicate_in_paste' });
      return;
    }
    seen.add(parsed.reference);
    ready += 1;
  });

  return { lines, ready, rejected, overLimit: lines > MAX_BULK_LINES };
}
