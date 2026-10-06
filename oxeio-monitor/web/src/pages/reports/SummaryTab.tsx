import { getSummaryReport, type GroupBy, type SummaryRow } from '../../api/reports';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Hours } from '../../components/Duration';
import { ProgressBar } from '../../components/ProgressRing';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import {
  formatCount,
  formatDateShort,
  formatMonth,
  hoursToSeconds,
} from '../../lib/format';
import { MAX_SHOWN_ROWS, MetaNote, SignedHours, TrimmedNote } from './shared';

/**
 * Weekly/monthly summary: worked, target, shortfall, overtime.
 *
 * Important: **money for overtime hours is never shown here**, only hours. The OT
 *    rate (1x, 1.5x, or nothing) is not decided yet (open question O4). Putting an
 *    amount on screen would silently become company policy though nobody decided
 *    it. So the server also sends an `overtimeNote`, shown below verbatim.
 */
export function SummaryTab({
  from,
  to,
  employeeId,
  groupBy,
}: {
  from: string;
  to: string;
  employeeId: number | null;
  groupBy: GroupBy;
}) {
  const { data, error, loading, reload } = useApi(
    (signal) =>
      getSummaryReport(
        { from, to, employeeId: employeeId ?? undefined, groupBy },
        signal,
      ),
    [from, to, employeeId, groupBy],
  );

  if (loading && !data) return <Loading label="Loading summary…" />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data || data.rows.length === 0) {
    return (
      <Empty
        title="No summary for this range"
        hint="Summaries are built from the daily figures. Until the agent sends data this page stays empty — try other dates."
      />
    );
  }

  const shown = data.rows.slice(0, MAX_SHOWN_ROWS);

  /**
   * Careful: for months `bucket` = `'2026-08'`, for weeks the week-start date. But
   *    `bucketStart`/`bucketEnd` are **not** the full month/week: only the part that
   *    falls inside the range and the employment period. So both ends are shown for
   *    weeks, or "week from 10 August" would suggest all seven days are included.
   */
  const bucketLabel = (row: SummaryRow): string =>
    groupBy === 'month'
      ? formatMonth(row.bucket)
      : `${formatDateShort(row.bucketStart)} – ${formatDateShort(row.bucketEnd)}`;

  const columns: Column<SummaryRow>[] = [
    {
      key: 'person',
      header: 'Staff',
      render: (row) => (
        <PersonCell fullName={row.fullName} empCode={row.empCode} />
      ),
    },
    {
      key: 'bucket',
      header: groupBy === 'month' ? 'Month' : 'Week',
      render: (row) => (
        <span className="num whitespace-nowrap">{bucketLabel(row)}</span>
      ),
    },
    {
      key: 'workdays',
      header: 'Workdays',
      align: 'right',
      render: (row) => (
        <span className="num text-ink-3">{formatCount(row.workdays)}</span>
      ),
    },
    {
      key: 'daysWithWork',
      header: 'Days worked',
      align: 'right',
      render: (row) => (
        <span className="num">{formatCount(row.daysWithWork)}</span>
      ),
    },
    {
      key: 'worked',
      header: 'Worked',
      align: 'right',
      render: (row) => <Hours hours={row.workedHours} />,
    },
    {
      key: 'adjustment',
      header: 'Adjustment',
      align: 'right',
      render: (row) => <SignedHours hours={row.adjustmentHours} />,
    },
    {
      key: 'credited',
      header: 'Counted',
      align: 'right',
      render: (row) => (
        <Hours hours={row.creditedHours} className="font-semibold" />
      ),
    },
    {
      /**
       * Careful: the header says "days shown": this is the target for this row's days,
       *    not "how much should have been done so far". With just "Target", the
       *    reader would subtract the adjacent Counted and invent a shortfall of their
       *    own, one that includes days before the agent was installed.
       */
      key: 'target',
      header: 'Target · days shown',
      align: 'right',
      render: (row) => <Hours hours={row.targetHours} tone="muted" />,
    },
    {
      // Important: the bar turns **green** when full (a `ProgressBar` rule); reaching the
      //    target is not a problem, so it is not red. While in progress it is neutral
      //    `ink`; red appears in this table only in the shortfall column.
      key: 'pace',
      header: 'Progress',
      className: 'w-24',
      render: (row) => (
        <ProgressBar
          value={hoursToSeconds(row.creditedHours)}
          max={hoursToSeconds(row.targetHours)}
          ariaLabel="Target"
        />
      ),
    },
    {
      // Careful: shortfall is the only red number in this table: red means "needs
      //    attention", and making every column red would erase its meaning.
      // Careful: the header says "vs expected"; the number is **not** Target minus
      //    Counted. The server measures it only against days that were actually
      //    observed and have ended (`SummaryRow.shortfallHours`). Without saying so,
      //    the table would seem to disagree with itself.
      key: 'shortfall',
      header: 'Shortfall vs expected',
      align: 'right',
      render: (row) =>
        row.shortfallHours > 0 ? (
          <span className="num font-semibold text-brand-ink">
            <Hours hours={row.shortfallHours} />
          </span>
        ) : (
          <span className="num text-ink-3">—</span>
        ),
    },
    {
      key: 'overtime',
      header: 'Overtime',
      align: 'right',
      render: (row) =>
        row.overtimeHours > 0 ? (
          <Hours hours={row.overtimeHours} />
        ) : (
          <span className="num text-ink-3">—</span>
        ),
    },
  ];

  return (
    <>
      {/*
        Important: the `hint` sentence is the key to this table: the three numbers answer
        three different questions. Without it the reader would subtract Counted from
        Target, try to reconcile, and think the Shortfall column is wrong.
      */}
      <Card
        title={groupBy === 'month' ? 'Month by Month' : 'Week by Week'}
        hint="Counted = worked + adjustment. Shortfall is measured only against what was expected by yesterday — days before tracking started, and today, are never counted as a shortfall."
        padded={false}
      >
        <Table
          columns={columns}
          rows={shown}
          // Careful: one employee gets several buckets, so both are needed in the key
          rowKey={(row) => `${row.employeeId}-${row.bucket}`}
        />
        {data.rows.length > shown.length && (
          <TrimmedNote total={data.rows.length} />
        )}
      </Card>

      {/* Important: the server's own sentence; this is what keeps O4 open */}
      <Caveat>{data.overtimeNote}</Caveat>

      <MetaNote meta={data.meta} />
    </>
  );
}
