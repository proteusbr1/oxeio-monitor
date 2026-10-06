import PDFDocument from 'pdfkit';

import {
  workStamp,
  MAX_PDF_ROWS,
  truncateToWidth,
  truncationNote,
} from './reports.pdf.text';

/**
 * F06: the PDF-building engine (pdfkit). What each report looks like is in
 * [reports.pages.ts](./reports.pages.ts), just as in Excel `reports.excel.ts`
 * (engine) and `reports.sheets.ts` (layout) are separate.
 *
 * **The PDF's language is English**; the reason and the only alternative are
 * written at the top of [reports.pdf.text.ts](./reports.pdf.text.ts). In one
 * sentence: pdfkit's built-in font prints non-Latin scripts **silently blank**,
 * and the repo embeds no other font.
 *
 * No database or HTTP here, only input → Buffer. So changing how the PDF looks
 * does not touch the query code.
 */

/** A4 landscape: 9-12 columns do not fit in portrait, and squeezing them in would
 *  make the font so small the numbers could not be read on paper */
const PAGE = { size: 'A4' as const, layout: 'landscape' as const, margin: 36 };

/** Inner width of landscape A4 (842pt − 36pt on each side) */
export const CONTENT_WIDTH = 770;

const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

const TITLE_SIZE = 16;
const META_SIZE = 8.5;
const HEAD_SIZE = 7.5;
const BODY_SIZE = 7.5;
const NOTE_SIZE = 7.5;

const ROW_HEIGHT = 12.5;
const HEAD_HEIGHT = 15;
/** Gap on both sides inside a cell, otherwise numbers would touch the column line */
const CELL_PAD = 3;

export interface PdfColumn<T> {
  header: string;
  /** In points; the sum of all of them should be `CONTENT_WIDTH` */
  width: number;
  /** Number columns on the right, otherwise decimal points do not line up */
  align?: 'left' | 'right';
  value: (row: T) => string;
}

interface ErasedColumn {
  header: string;
  width: number;
  align?: 'left' | 'right';
  value: (row: unknown) => string;
}

export interface PdfTable {
  columns: ErasedColumn[];
  rows: readonly unknown[];
}

/** Type-safe column definition → the engine's generic-free form (like sheetOf) */
export function tableOf<T>(
  columns: PdfColumn<T>[],
  rows: readonly T[],
): PdfTable {
  return {
    columns: columns.map((c) => ({
      header: c.header,
      width: c.width,
      align: c.align,
      value: (row: unknown) => c.value(row as T),
    })),
    rows,
  };
}

export interface LetterheadSpec {
  /** The organisation's name, from `ORG_NAME` */
  orgName: string;
  /** The report's name, in English */
  reportTitle: string;
  rangeFrom: string;
  rangeTo: string;
  /** ISO; printed in work-zone time */
  generatedAt: string;
}

export interface PdfSpec {
  letterhead: LetterheadSpec;
  table: PdfTable;
  /** A short total under the table (label, value) */
  totals?: [string, string][];
  /** What needs to be said before/after the print: warnings, policy, truncation */
  notes?: string[];
}

/**
 * Builds the PDF and returns a Buffer.
 *
 * pdfkit writes to a stream, so the Buffer cannot be had without catching the
 * `end` event. The listener has to be attached **before** calling `doc.end()`;
 * otherwise in a small document the first chunk could be lost and the file come out broken.
 */
export async function buildPdf(spec: PdfSpec): Promise<Buffer> {
  const doc = new PDFDocument({
    ...PAGE,
    bufferPages: true,
    info: {
      Title: `${spec.letterhead.reportTitle} ${spec.letterhead.rangeFrom} - ${spec.letterhead.rangeTo}`,
      Author: spec.letterhead.orgName,
      Creator: 'oXeio Monitoring',
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  render(doc, spec);
  doc.end();

  return done;
}

function render(doc: PDFKit.PDFDocument, spec: PdfSpec): void {
  const { columns, rows } = spec.table;
  const shown = rows.slice(0, MAX_PDF_ROWS);
  const cut = truncationNote(rows.length, shown.length);

  letterhead(doc, spec.letterhead, rows.length);

  let y = doc.y + 6;
  y = tableHeader(doc, columns, y);

  const bottom = doc.page.height - doc.page.margins.bottom - 18;

  for (const row of shown) {
    if (y + ROW_HEIGHT > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      y = tableHeader(doc, columns, y);
    }
    y = tableRow(doc, columns, row, y);
  }

  // A zero-row result is a result too: nobody looking at an empty page should
  // think "the report broke"
  if (shown.length === 0) {
    doc
      .font(FONT)
      .fontSize(BODY_SIZE)
      .fillColor('#666666')
      .text(
        'No rows for this range.',
        doc.page.margins.left + CELL_PAD,
        y + 4,
        { width: CONTENT_WIDTH },
      );
    y += ROW_HEIGHT + 4;
  }

  footer(doc, spec, y, cut);
  pageNumbers(doc, spec.letterhead);
}

function letterhead(
  doc: PDFKit.PDFDocument,
  head: LetterheadSpec,
  totalRows: number,
): void {
  const left = doc.page.margins.left;

  doc
    .font(FONT_BOLD)
    .fontSize(TITLE_SIZE)
    .fillColor('#111111')
    .text(head.orgName, left, doc.page.margins.top, { width: CONTENT_WIDTH });

  doc
    .font(FONT_BOLD)
    .fontSize(META_SIZE + 2)
    .text(head.reportTitle, { width: CONTENT_WIDTH });

  doc
    .font(FONT)
    .fontSize(META_SIZE)
    .fillColor('#444444')
    .text(
      `Period: ${head.rangeFrom} to ${head.rangeTo}   |   ` +
        `Generated: ${workStamp(new Date(head.generatedAt))}   |   ` +
        `Rows: ${totalRows}`,
      { width: CONTENT_WIDTH },
    );

  // A line between the heading and the table: on paper this is "the letterhead ends here"
  const lineY = doc.y + 4;
  doc
    .moveTo(left, lineY)
    .lineTo(left + CONTENT_WIDTH, lineY)
    .lineWidth(0.8)
    .strokeColor('#111111')
    .stroke();

  doc.y = lineY;
}

function tableHeader(
  doc: PDFKit.PDFDocument,
  columns: ErasedColumn[],
  y: number,
): number {
  const left = doc.page.margins.left;

  doc.rect(left, y, CONTENT_WIDTH, HEAD_HEIGHT).fillColor('#EFEFEF').fill();

  doc.font(FONT_BOLD).fontSize(HEAD_SIZE).fillColor('#111111');
  cells(doc, columns, y + 4, (c) => c.header);

  doc
    .moveTo(left, y + HEAD_HEIGHT)
    .lineTo(left + CONTENT_WIDTH, y + HEAD_HEIGHT)
    .lineWidth(0.5)
    .strokeColor('#999999')
    .stroke();

  return y + HEAD_HEIGHT + 2;
}

function tableRow(
  doc: PDFKit.PDFDocument,
  columns: ErasedColumn[],
  row: unknown,
  y: number,
): number {
  doc.font(FONT).fontSize(BODY_SIZE).fillColor('#222222');
  cells(doc, columns, y, (c) => c.value(row));
  return y + ROW_HEIGHT;
}

/**
 * Placing all the cells of one row.
 *
 * Every cell gets `width` **and** `lineBreak: false`; both are needed. Without
 * `lineBreak` a long name would wrap onto the next line by itself and rows would
 * print over each other; without `width` the text would run over the
 * neighbouring column. Before that it is cut with `truncateToWidth`, so the
 * cut spot shows `...`; pdfkit itself cuts silently.
 */
function cells(
  doc: PDFKit.PDFDocument,
  columns: ErasedColumn[],
  y: number,
  textOf: (c: ErasedColumn) => string,
): void {
  let x = doc.page.margins.left;

  for (const column of columns) {
    const inner = column.width - CELL_PAD * 2;
    const text = truncateToWidth(textOf(column), inner, (s) =>
      doc.widthOfString(s),
    );

    doc.text(text, x + CELL_PAD, y, {
      width: inner,
      align: column.align ?? 'left',
      lineBreak: false,
    });

    x += column.width;
  }
}

function footer(
  doc: PDFKit.PDFDocument,
  spec: PdfSpec,
  startY: number,
  cut: string | null,
): void {
  const notes = [...(spec.notes ?? [])];
  if (cut) notes.unshift(cut);

  if ((spec.totals?.length ?? 0) === 0 && notes.length === 0) return;

  const left = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom - 18;
  let y = startY + 8;

  // The footnotes must not be cut off at the bottom of the page: a new page if there is no room
  if (y + (spec.totals?.length ?? 0) * 11 + notes.length * 20 > bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  if (spec.totals && spec.totals.length > 0) {
    doc.font(FONT_BOLD).fontSize(NOTE_SIZE).fillColor('#111111');
    for (const [label, value] of spec.totals) {
      doc.text(`${label}: ${value}`, left, y, {
        width: CONTENT_WIDTH,
        lineBreak: false,
      });
      y += 11;
    }
    y += 4;
  }

  doc.font(FONT).fontSize(NOTE_SIZE).fillColor('#555555');
  for (const note of notes) {
    doc.text(note, left, y, { width: CONTENT_WIDTH });
    y = doc.y + 3;
  }
}

/**
 * "Page n of m" at the bottom of every page.
 *
 * This is impossible without `bufferPages: true`: the total page count is not
 * known before the last row is printed, yet the number has to be written on the
 * **first** page too. Without page numbers on a printed report, nobody would
 * notice if a page went missing.
 */
function pageNumbers(doc: PDFKit.PDFDocument, head: LetterheadSpec): void {
  const range = doc.bufferedPageRange();

  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    const y = doc.page.height - doc.page.margins.bottom - 10;
    doc
      .font(FONT)
      .fontSize(7)
      .fillColor('#777777')
      // The separator is ASCII `|`: `·` does exist in WinAnsi, but the footer
      // does not go through `toPdfText()`, so keeping everything within ASCII
      // is the only sure way
      .text(
        `${head.orgName} | ${head.reportTitle} | ${head.rangeFrom} to ${head.rangeTo}`,
        doc.page.margins.left,
        y,
        { width: CONTENT_WIDTH / 2, lineBreak: false },
      )
      .text(
        `Page ${i + 1} of ${range.count}`,
        doc.page.margins.left + CONTENT_WIDTH / 2,
        y,
        { width: CONTENT_WIDTH / 2, align: 'right', lineBreak: false },
      );
  }
}
