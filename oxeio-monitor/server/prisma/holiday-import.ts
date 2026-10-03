/**
 * Holidays from a file — CSV or ICS — for any country, state or city.
 *
 * The seed only knows Bangladesh (`holiday-sets.ts`). Everyone else takes
 * their calendar from an official source and imports it with
 * `prisma/import-holidays.ts`, which writes through the same planner as the
 * seed — so current and past months are never touched without consent.
 *
 * This file only reads text; nothing here touches the database.
 *
 * CSV — one holiday per line, header optional:
 *   date,name,type
 *   2027-01-01,New Year's Day,public
 *   2027-02-09,"Carnival, Tuesday",optional
 *
 * ICS — all-day events (`DTSTART;VALUE=DATE:20270101`); a multi-day event
 * becomes one holiday per day. Events with a time of day are skipped: a
 * holiday is a date, and turning a time into a date needs a zone.
 */
import { isRealDate, type HolidayEntry } from './holidays.data';

/** The holiday types the Settings → Holidays screen offers */
export const HOLIDAY_TYPES = ['public', 'optional', 'company'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];

export interface ImportedHoliday {
  entry: HolidayEntry;
  type: HolidayType;
}

export interface ImportResult {
  holidays: ImportedHoliday[];
  /** Lines or events that were skipped, with the reason — printed, never silent */
  problems: string[];
}

function toEntry(date: string, name: string): HolidayEntry {
  // a date from an official calendar is a decision, not an estimate
  return { date, name, nameEn: name, approximate: false };
}

/**
 * ⚠️ One holiday per date — `holidays.holiday_date` is unique. A second row
 *    for the same date is reported, not merged: two names for one day is a
 *    question for whoever made the file.
 */
function dedupe(
  rows: ImportedHoliday[],
  problems: string[],
): ImportedHoliday[] {
  const seen = new Map<string, string>();
  const out: ImportedHoliday[] = [];
  for (const row of rows) {
    const first = seen.get(row.entry.date);
    if (first !== undefined) {
      problems.push(
        `${row.entry.date}: "${row.entry.name}" skipped — the date is already "${first}"`,
      );
      continue;
    }
    seen.set(row.entry.date, row.entry.name);
    out.push(row);
  }
  return out.sort((a, b) => a.entry.date.localeCompare(b.entry.date));
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Splits one CSV line, honouring "quoted, fields" and "" as an escaped quote */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

export function parseHolidayCsv(text: string): ImportResult {
  const problems: string[] = [];
  const rows: ImportedHoliday[] = [];

  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;

    const [date = '', name = '', typeRaw = ''] = splitCsvLine(line);
    // a header line, in any case
    if (index === 0 && date.toLowerCase() === 'date') return;

    const where = `line ${index + 1}`;
    if (!isRealDate(date)) {
      problems.push(`${where}: "${date}" is not a YYYY-MM-DD date`);
      return;
    }
    if (name === '') {
      problems.push(`${where}: ${date} has no name`);
      return;
    }
    const type = (typeRaw.toLowerCase() || 'public') as HolidayType;
    if (!HOLIDAY_TYPES.includes(type)) {
      problems.push(
        `${where}: type "${typeRaw}" is not one of ${HOLIDAY_TYPES.join(', ')}`,
      );
      return;
    }
    rows.push({ entry: toEntry(date, name), type });
  });

  return { holidays: dedupe(rows, problems), problems };
}

// ── ICS (RFC 5545, the part a holiday calendar uses) ────────────────────────

/** Folded lines (RFC 5545 § 3.1) start with a space or tab — joined back */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

const ICS_DATE = /^(\d{4})(\d{2})(\d{2})$/;

function icsDate(value: string): string | null {
  const m = ICS_DATE.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function parseHolidayIcs(text: string): ImportResult {
  const problems: string[] = [];
  const rows: ImportedHoliday[] = [];

  let inEvent = false;
  let start: string | null = null;
  let end: string | null = null;
  let timed = false;
  let summary = '';

  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      start = end = null;
      timed = false;
      summary = '';
      continue;
    }
    if (!inEvent) continue;

    if (line === 'END:VEVENT') {
      inEvent = false;
      const name = summary || '(no name)';
      if (timed) {
        problems.push(
          `"${name}": has a time of day — only all-day events are holidays`,
        );
        continue;
      }
      if (start === null) {
        problems.push(`"${name}": no start date`);
        continue;
      }
      // DTEND is exclusive for all-day events; absent = one day
      const last = end === null ? start : end;
      let day = start;
      do {
        rows.push({ entry: toEntry(day, name), type: 'public' });
        day = nextDay(day);
      } while (day < last);
      continue;
    }

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1);
    const prop = key.split(';')[0];

    if (prop === 'SUMMARY') summary = unescapeText(value);
    if (prop === 'DTSTART' || prop === 'DTEND') {
      const date = icsDate(value);
      if (date === null) {
        timed = true;
      } else if (prop === 'DTSTART') {
        start = date;
      } else {
        end = date;
      }
    }
  }

  return { holidays: dedupe(rows, problems), problems };
}

/** By extension: `.ics` → ICS, anything else → CSV */
export function parseHolidayFile(fileName: string, text: string): ImportResult {
  return fileName.toLowerCase().endsWith('.ics')
    ? parseHolidayIcs(text)
    : parseHolidayCsv(text);
}
