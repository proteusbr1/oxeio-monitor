/**
 * The common part of downloading a file: name and MIME.
 *
 * Moved out of `reports.excel.ts` because after F06 there are two formats
 * (xlsx and pdf), and "importing the excel file to build a PDF's name" reads
 * oddly; more importantly, someone changing the Excel code could then
 * unknowingly change the PDF's name too.
 */

export type DownloadFormat = 'xlsx' | 'pdf';

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const PDF_MIME = 'application/pdf';

export const MIME_OF: Record<DownloadFormat, string> = {
  xlsx: XLSX_MIME,
  pdf: PDF_MIME,
};

/**
 * Careful: the file name is kept ASCII; a non-ASCII name in Content-Disposition
 * would need RFC 5987 encoding, and older clients would save it under a broken name.
 *
 * Careful: the extension is a parameter, not hardcoded inside. `.xlsx` used to
 * be hardcoded; when PDF was added, had that not been changed the browser
 * would have saved a PDF as `.xlsx` and Excel would say "file corrupt" when
 * opening it, though the file was fine.
 */
export function reportFilename(
  report: string,
  from: string,
  to: string,
  format: DownloadFormat,
): string {
  return `oxeio-${report}-${from}_${to}.${format}`;
}
