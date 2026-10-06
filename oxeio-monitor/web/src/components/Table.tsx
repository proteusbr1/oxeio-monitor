import { Fragment } from 'react';
import type { ReactNode } from 'react';

/**
 * Generic table.
 *
 * Careful: E12: a wide table scrolls inside its own frame on a phone, not the
 * whole page. Without this the attendance report's 9 columns would stretch the
 * whole page sideways and the header navigation would shift too.
 *
 * Use `align: 'right'` for number columns: right-aligned numbers are easy to
 * compare by eye. `<Duration>`/`.num` already use tabular-nums.
 *
 * ```tsx
 * <Table
 *   rows={report.rows}
 *   rowKey={(r) => String(r.employeeId)}
 *   columns={[
 *     { key: 'name', header: 'Name', render: (r) => r.fullName },
 *     { key: 'h', header: 'Hours', align: 'right',
 *       render: (r) => <Duration seconds={r.workedSec} /> },
 *   ]}
 * />
 * ```
 */
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** The column's own class, e.g. `w-32` or `hidden sm:table-cell`. */
  className?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  /** Show the row dimmed, e.g. an inactive employee. */
  rowMuted,
  groupBefore,
  footer,
}: {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  rowMuted?: (row: T) => boolean;
  /**
   * A full-width band before a row, e.g. "Not working · 1".
   *
   * Careful: two separate `<Table>`s could not be used to split it. Each table
   * sizes its columns independently, so the numbers would no longer line up, and
   * aligned numbers are the only reason for a table.
   */
  groupBefore?: (row: T, index: number) => ReactNode;
  /** Total row: goes in `<tfoot>` and stays with the columns even when scrolled. */
  footer?: ReactNode;
}) {
  const align = (a?: Column<T>['align']): string =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  /**
   * Pin the first column (G124).
   *
   * Careful: the table scrolls in its own `overflow-x-auto` frame, which is good
   * because it does not drag the whole page. But with the Attendance report's 9
   * columns, scrolling right made you lose track of which row you were looking at,
   * and on a phone you almost always have to scroll. The rule is not new:
   * `HeatGrid` already does this; its absence here was the incomplete half of the pair.
   *
   * Careful: the background is `bg-inherit`, not a specific color. Hard-coding
   * `bg-surface` would stop a clickable row's `hover:bg-paper` from reaching the
   * first cell, so half the row would change color, which looks broken. Putting
   * the color on the `<tr>` and letting the cell inherit is the only way both
   * states look right.
   */
  const stickyCol = 'sticky left-0 z-10 border-r border-line';

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {columns.map((col, i) => (
              <th
                key={col.key}
                scope="col"
                className={`px-3 py-2 font-medium text-ink-3 whitespace-nowrap ${align(col.align)} ${
                  i === 0 ? `${stickyCol} bg-surface` : ''
                } ${col.className ?? ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row, index) => {
            const band = groupBefore?.(row, index);
            return (
          <Fragment key={rowKey(row, index)}>
            {band && (
              <tr className="bg-surface">
                {/* Careful: `colSpan`; otherwise the band would be squeezed into the first
                    column and the other columns would become empty cells */}
                <td colSpan={columns.length} className="px-3 pt-5 pb-2">
                  {band}
                </td>
              </tr>
            )}
            <tr
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              // Careful: `bg-surface` is mandatory here (see the note above); without a color
              // on the `<tr>` the sticky cell would be transparent and text beneath would
              // show through it while scrolling.
              className={`border-b border-line/70 bg-surface last:border-0 ${
                onRowClick ? 'cursor-pointer hover:bg-paper' : ''
              } ${rowMuted?.(row) ? 'text-ink-3' : ''}`}
            >
              {columns.map((col, i) => (
                <td
                  key={col.key}
                  className={`px-3 py-2 ${align(col.align)} ${
                    i === 0 ? `${stickyCol} bg-inherit` : ''
                  } ${col.className ?? ''}`}
                >
                  {col.render(row, index)}
                </td>
              ))}
            </tr>
          </Fragment>
            );
          })}
        </tbody>

        {footer && (
          <tfoot className="border-t border-line bg-paper font-medium">
            {footer}
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * Name + code: as repeatedly needed in a table's first column.
 * Careful: the code is in `.num` because `OX-001` and `OX-010` at the same width
 * are easier to find by eye.
 */
export function PersonCell({
  fullName,
  empCode,
  note,
  accent,
  accentTitle,
}: {
  fullName: string;
  empCode?: string;
  note?: ReactNode;
  /**
   * Shows the name bold and green, so it stands out when scanning the list.
   *
   * Optional, so the other five uses of `PersonCell` (reports, heatmap) stay unchanged.
   *
   * Careful: color is not the only signal; so is the bold weight. For someone
   * colour-blind, green and normal text can look the same, but everyone sees a
   * difference in weight.
   */
  accent?: boolean;
  /** Says on hover why it differs; otherwise the color stays unexplained. */
  accentTitle?: string;
}) {
  return (
    <div className="min-w-0">
      <div
        className={
          accent
            ? 'truncate font-bold text-ok'
            : 'truncate font-medium text-ink'
        }
        title={accent ? accentTitle : undefined}
      >
        {fullName}
      </div>
      {(empCode || note) && (
        <div className="num truncate text-[11px] text-ink-3">
          {empCode}
          {empCode && note ? ' · ' : ''}
          {note}
        </div>
      )}
    </div>
  );
}
