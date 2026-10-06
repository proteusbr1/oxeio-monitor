import { Workbook } from 'exceljs';

/**
 * F05: building the .xlsx (exceljs).
 *
 * One rule here: **what is a number is written as a number.** If hours were
 * written as "7h 32m" they would be text in Excel, and then neither summing the
 * selected column nor sorting largest to smallest would work, though those
 * are the first things people do after downloading a report.
 */

export type CellValue = string | number | null;

/** Hours and percentages: two decimals shown, but the whole number is kept inside */
export const NUM_FMT_2 = '0.00';

export interface ExcelColumn<T> {
  header: string;
  /** In Excel's character-width unit; long English headers take a bit more room */
  width: number;
  numFmt?: string;
  value: (row: T) => CellValue;
}

interface ErasedColumn {
  header: string;
  width: number;
  numFmt?: string;
  value: (row: unknown) => CellValue;
}

export interface SheetSpec {
  name: string;
  columns: ErasedColumn[];
  rows: readonly unknown[];
}

/**
 * A wrapper to put a type-safe column definition into a workbook beside other
 * sheets. (Each sheet's row type differs, so the generic is erased right here.)
 */
export function sheetOf<T>(
  name: string,
  columns: ExcelColumn<T>[],
  rows: readonly T[],
): SheetSpec {
  return {
    name,
    columns: columns.map((c) => ({
      header: c.header,
      width: c.width,
      numFmt: c.numFmt,
      value: (row: unknown) => c.value(row as T),
    })),
    rows,
  };
}

/**
 * The range, creation time and truncation notes go **on a separate sheet**, not
 * above the data. Putting two or three title lines above the table breaks
 * filtering, sorting and "select the column and sum", because the header and
 * the first row are no longer the same row.
 */
export async function buildWorkbook(
  sheets: SheetSpec[],
  info: [string, string][],
): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'oXeio Monitoring';
  wb.created = new Date();

  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);

    ws.columns = spec.columns.map((c) => ({
      header: c.header,
      width: c.width,
      style: c.numFmt ? { numFmt: c.numFmt } : undefined,
    }));

    for (const row of spec.rows) {
      ws.addRow(spec.columns.map((c) => c.value(row)));
    }

    const header = ws.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
    header.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
    });

    // The header stays pinned: on a 5000-row attendance sheet you cannot tell
    // which column is which without this
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (spec.columns.length > 0) {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: spec.columns.length },
      };
    }
  }

  const infoSheet = wb.addWorksheet('Info');
  infoSheet.columns = [
    { header: 'Item', width: 28 },
    { header: 'Value', width: 46 },
  ];
  for (const [key, value] of info) infoSheet.addRow([key, value]);
  infoSheet.getRow(1).font = { bold: true };

  // exceljs's type says Buffer, but at runtime some versions give an ArrayBuffer;
  // Buffer.from() handles both, and res.send() then surely gets binary.
  const written = await wb.xlsx.writeBuffer();
  return Buffer.from(written);
}

// The file name and MIME are now in `reports.download.ts`: after F06 they are
// no longer only an Excel matter.
