import { getAttendanceReport, type AttendanceRow } from '../../api/reports';
import { useApi } from '../../api/useApi';
import { Card, Stat, StatRow } from '../../components/Card';
import { Hours } from '../../components/Duration';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import { formatCount, formatDateShort, weekdayOf } from '../../lib/format';
import {
  DAY_TYPE_LABEL,
  MAX_SHOWN_ROWS,
  MetaNote,
  Pill,
  SignedHours,
  TrimmedNote,
} from './shared';

/**
 * Daily attendance report: one row per employee per day.
 *
 * Important: **there is no "who arrived when" here and never will be** (ADR-011).
 *    The server does not send `first_activity_at`, and if it did we still would not
 *    show it: a "start time" column would turn this sheet into a lateness report,
 *    and lateness tracking is not part of this product. The report only says how
 *    many hours were worked.
 */
export function AttendanceTab({
  from,
  to,
  employeeId,
}: {
  from: string;
  to: string;
  employeeId: number | null;
}) {
  const { data, error, loading, reload } = useApi(
    (signal) =>
      // Careful: `employeeId: null` must not be sent; `qs()` drops null, so "everyone"
      //    means not sending the parameter at all.
      getAttendanceReport(
        { from, to, employeeId: employeeId ?? undefined },
        signal,
      ),
    [from, to, employeeId],
  );

  if (loading && !data) return <Loading label="Loading attendance…" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data || data.rows.length === 0) {
    return (
      <Empty
        title="No rows in this range"
        hint="Staff may have joined or left outside these dates, or the agent has not sent anything yet. Try other dates."
      />
    );
  }

  const { totals } = data;
  const shown = data.rows.slice(0, MAX_SHOWN_ROWS);

  const columns: Column<AttendanceRow>[] = [
    {
      key: 'person',
      header: 'Staff',
      render: (row) => (
        <PersonCell
          fullName={row.fullName}
          empCode={row.empCode}
          note={row.department ?? undefined}
        />
      ),
    },
    {
      key: 'date',
      header: 'Date',
      render: (row) => (
        <span className="whitespace-nowrap">
          <span className="num">{formatDateShort(row.date)}</span>
          <span className="ml-1.5 text-[11px] text-ink-3">
            {weekdayOf(row.date)}
          </span>
        </span>
      ),
    },
    {
      key: 'dayType',
      header: 'Day',
      render: (row) => (
        <Pill muted={row.dayType !== 'workday'}>
          {DAY_TYPE_LABEL[row.dayType]}
        </Pill>
      ),
    },
    {
      key: 'worked',
      header: 'Worked',
      align: 'right',
      render: (row) => <Hours hours={row.workedHours} />,
    },
    {
      // Careful: grey, because idle time is **not counted**. In black it would look
      //    as if it were added to the worked hours.
      key: 'idle',
      header: 'Idle',
      align: 'right',
      render: (row) => <Hours hours={row.idleHours} tone="muted" />,
    },
    {
      key: 'adjustment',
      header: 'Adjustment',
      align: 'right',
      render: (row) => <SignedHours hours={row.adjustmentHours} />,
    },
    {
      // Important: this is the real column: worked + adjustment, the one that matches the target
      key: 'credited',
      header: 'Counted',
      align: 'right',
      render: (row) => (
        <Hours hours={row.creditedHours} className="font-semibold" />
      ),
    },
    {
      key: 'target',
      header: 'Target',
      align: 'right',
      render: (row) => <Hours hours={row.targetHours} tone="muted" />,
    },
    /**
     * **Designs finished today**, per designer.
     *
     * Careful: the number already existed in Excel but **not on screen**, so you had
     * to download the file to see it.
     *
     * Careful: there used to be two columns (Opened and Finished). **"Opened" was
     * removed** (owner's decision): that count could not tell "who makes" apart from
     * "who views".
     *
     * Careful: the cell is **empty** at 0, not "0". A 0 in the row of a non-design
     * employee would mean "measured and found zero", which would be false.
     */
    {
      key: 'designs',
      header: 'Designs',
      align: 'right',
      render: (row) =>
        row.designsDone === null ? (
          <span className="text-ink-3">—</span>
        ) : (
          // Green: the only number that means "work finished"
          <span className="num font-medium text-ok">{row.designsDone}</span>
        ),
    },
  ];

  return (
    <>
      <StatRow>
        <Stat label="Staff" value={formatCount(totals.employees)} />
        <Stat label="Rows" value={formatCount(totals.rows)} />
        <Stat label="Days with work" value={formatCount(totals.daysWithWork)} />
        <Stat
          label="Total worked"
          value={<Hours hours={totals.workedHours} />}
        />
        <Stat
          label="Total counted"
          value={<Hours hours={totals.creditedHours} />}
        />
        {/*
          Careful: the label says "days listed": the number is the sum of the Target
          column below, not "how much should have been done so far". It includes days
          before tracking began and today's unfinished day, so subtracting it from
          Total counted gives a false shortfall. Expected hours come from
          `meta.expectedHours`, which the Monthly page shows.
        */}
        <Stat
          label="Total target · days listed"
          value={<Hours hours={totals.targetHours} />}
          tone="muted"
        />
      </StatRow>

      <div className="mt-4">
        <Card title="Day by Day" padded={false}>
          <Table
            columns={columns}
            rows={shown}
            // Careful: one employee has several days, so the key needs both; with only
            //    employeeId React would mix up the rows.
            rowKey={(row) => `${row.employeeId}-${row.date}`}
            rowMuted={(row) => row.status === 'no_activity'}
            footer={
              <tr>
                <td className="px-3 py-2" colSpan={3}>
                  Total
                </td>
                <td className="num px-3 py-2 text-right">
                  <Hours hours={totals.workedHours} />
                </td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="num px-3 py-2 text-right">
                  <Hours hours={totals.creditedHours} />
                </td>
                <td className="num px-3 py-2 text-right">
                  <Hours hours={totals.targetHours} tone="muted" />
                </td>
              </tr>
            }
          />
          {data.rows.length > shown.length && (
            <TrimmedNote total={data.rows.length} />
          )}
        </Card>
      </div>

      <MetaNote meta={data.meta} />
    </>
  );
}
