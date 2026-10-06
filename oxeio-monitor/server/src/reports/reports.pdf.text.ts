import { WORK_TIMEZONE, workPathParts } from '../agent/util/work-time';

/**
 * F06: the pure calculation of which text can **be printed at all** in a PDF.
 * pdfkit is not imported here, so all of it can be tested without the DB or the library.
 *
 * **This file is where F06's biggest decision lives: the PDF is in English.**
 *
 * The 14 fonts that come with pdfkit (Helvetica, Times, Courier ...) are
 * encoded in **WinAnsi**, so they have no glyph for any character outside
 * Latin-1. Writing Bengali (or any other non-Latin script) raises no error; the spot is just left **blank** or
 * a box appears. So the failure is silent: the server returns 200, the file
 * downloads, and when opened the name column is empty.
 *
 * Printing Bengali would mean embedding a TTF. That was not done, because:
 *
 * 1. The repo has **no Bengali font file**: putting a licensed binary font in
 *    the repo means licensing, size and build-copy rules, three separate
 *    decisions. Nobody took them.
 * 2. Bengali needs not just glyphs but **shaping** (conjuncts, the vowel sign
 *    that sits before the consonant, reph). fontkit has an Indic shaper, but it
 *    cannot be trusted without checking by eye with the real font. A PDF with
 *    broken conjuncts is worse than an English one: it looks right and reads wrong.
 * 3. The real substance of a PDF is numbers (hours, dates, employee codes),
 *    which are ASCII anyway. Bengali would only be in the labels.
 *
 * A gap still remains: **employee names may be in a non-Latin script (Bengali, in the first deployment) in the database**. If
 * those were printed silently blank, a reader would think the data was missing.
 * So [personLabel()](#) checks whether the name can be printed and, if not,
 * puts in the **employee code** and reports `lossy`, and the PDF footnote
 * states the reason based on that flag.
 *
 * If a Bengali name is needed there is Excel (F05): UTF-8, no problem at all.
 */

/** What goes in when it cannot be printed; leaving it blank with nothing is the worst */
export const UNPRINTABLE = '?';

/** An empty table cell: `null`/`undefined`/empty string all become this */
export const EMPTY_CELL = '-';

/**
 * Unicode punctuation → ASCII.
 *
 * These **exist** in WinAnsi, but are replaced anyway: if the same dash is `–`
 * in one place and `-` in another, measuring and comparing column widths both
 * become unpredictable. The fewer kinds of bytes in the printed text, the fewer surprises.
 */
const PUNCTUATION: ReadonlyMap<string, string> = new Map([
  [' ', ' '], // NBSP
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'], // en dash
  ['—', '-'], // em dash
  ['…', '...'],
  ['•', '*'],
]);

/**
 * Characters that can be printed in WinAnsi: ASCII printable + the Latin-1 supplement.
 *
 * WinAnsi's 0x80–0x9F block has a few more characters (€, †, ‰ ...), but they
 * are left out on purpose: reports do not need them, and the shorter the list
 * the fewer "why did it break on this one character" mysteries.
 */
const PRINTABLE = /^[\x20-\x7E¡-ÿ]*$/;

export interface PdfText {
  text: string;
  /** Some characters could not be printed: the footnote needs to say why */
  lossy: boolean;
}

/**
 * Makes any text fit for printing.
 *
 * Characters that cannot be printed are **not deleted**, `?` goes in. Deleted,
 * a Bengali name would become an empty string, which would look the same as
 * "no name". A `?` at least says something was here.
 */
export function toPdfText(value: string | null | undefined): PdfText {
  if (value === null || value === undefined || value.length === 0) {
    return { text: EMPTY_CELL, lossy: false };
  }

  let normalized = '';
  for (const ch of value) {
    normalized += PUNCTUATION.get(ch) ?? ch;
  }

  if (PRINTABLE.test(normalized)) {
    return { text: normalized, lossy: false };
  }

  let out = '';
  for (const ch of normalized) {
    out += PRINTABLE.test(ch) ? ch : UNPRINTABLE;
  }

  return { text: out, lossy: true };
}

/**
 * What goes in the employee name cell.
 *
 * If the name can be printed, the name. If not, the **employee code**, not
 * `???? ?????`. Nobody could recognise an employee from a row of question
 * marks, yet the code is in the next column and everyone knows it. Seeing the
 * same code in two cells at least shows that "the name did not come out in
 * this font", and the footnote says exactly that.
 *
 * If the code cannot be printed either (it should not happen: codes are
 * ASCII), `?` goes in, not blank.
 */
export function personLabel(fullName: string, empCode: string): PdfText {
  const name = toPdfText(fullName);
  if (!name.lossy) return name;

  const code = toPdfText(empCode);
  return { text: code.text, lossy: true };
}

/**
 * Hours → printed text.
 *
 * In Excel, hours go as **numbers** (the core rule of reports.excel.ts), but a
 * PDF has no way to sum or sort: it is a picture. So the opposite decision
 * here: always **fixed-width text** with two decimals, so the decimal points
 * line up in the column.
 */
export function hoursText(hours: number): string {
  if (!Number.isFinite(hours)) return EMPTY_CELL;
  return hours.toFixed(2);
}

/**
 * Cuts text short, ending with `...`.
 *
 * `measure` comes from outside (pdfkit's `widthOfString`) so the function
 * stays pure; otherwise testing this logic would need the whole PDF engine.
 *
 * Without cutting, pdfkit would print the text **over** the next column (it
 * does not know the cell's limits), and two numbers would blend, reading as a
 * third, wrong number.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string {
  if (maxWidth <= 0) return '';
  if (measure(text) <= maxWidth) return text;

  const ellipsis = '...';
  // If even `...` does not fit, as much raw text as fits: even half a word is
  // better than an empty cell
  if (measure(ellipsis) > maxWidth) {
    let raw = '';
    for (const ch of text) {
      if (measure(raw + ch) > maxWidth) break;
      raw += ch;
    }
    return raw;
  }

  let out = '';
  for (const ch of text) {
    if (measure(out + ch + ellipsis) > maxWidth) break;
    out += ch;
  }

  return out + ellipsis;
}

/**
 * `generated_at` (ISO/UTC) → work-zone time fit to print on the letterhead.
 *
 * `toLocaleString()` is deliberately not used: it depends on the server's
 * timezone and ICU data, and Docker's slim images often have ICU trimmed. The
 * same code would then print work-zone time on one machine and UTC on another,
 * with the zone name written beside both.
 */
export function workStamp(instant: Date): string {
  const { year, month, day, hhmmss } = workPathParts(instant);
  return `${year}-${month}-${day} ${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)} (${WORK_TIMEZONE})`;
}

/**
 * About the rows that will not be printed in the PDF.
 *
 * The limit exists because 370 days × 15 people = 5500 rows, a 150-page PDF
 * that would block the event loop for a few seconds to build, and nobody would
 * read it. But it is not cut silently: the number of dropped rows is written in
 * the file, along with a pointer to Excel for the full data.
 */
export const MAX_PDF_ROWS = 2000;

export function truncationNote(total: number, shown: number): string | null {
  if (total <= shown) return null;
  return `Only the first ${shown} of ${total} rows are shown. Download the Excel (xlsx) export for the complete data.`;
}
