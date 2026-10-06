import type { PayrollRow, PayrollSheet } from '../../api/payroll';
import type { ApiResult } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Hours } from '../../components/Duration';
import { ProgressBar } from '../../components/ProgressRing';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import {
  formatDate,
  formatMonth,
  formatTaka,
  hoursToSeconds,
} from '../../lib/format';

/**
 * Monthly payroll hours sheet. **Owner-only**.
 *
 * Important: this component never renders on a manager's screen, because `ReportsPage`
 *    does not build the tab unless `user.role === 'owner'`. Showing a 403 is not
 *    enough: a tab called "Payroll" would be visible, revealing **that a salary
 *    system exists at all** (section 4.3, ADR-023).
 *
 * Careful: every call is written to the server's audit log (`payroll_view`), so it
 *    does not fetch needlessly, and `useApi` refetches only when the month changes.
 *
 * Careful: all hours and money are **strings** (Decimal). Never add or subtract
 *    them via `Number()`; `formatTaka()` only inserts commas, otherwise 13000.10
 *    would show as 13000.0999… on screen.
 */
/**
 * The sheet itself, from a result someone else loaded — the Payroll page
 * loads it once for both its checklist and this table, since every load of
 * the sheet is written to the audit log.
 */
export function PayrollSheetView({
  month,
  result,
}: {
  month: string;
  result: ApiResult<PayrollSheet | null>;
}) {
  const { data, error, loading, reload } = result;

  if (loading && !data) return <Loading label="Loading payroll…" />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  if (!data || data.rows.length === 0) {
    return (
      <Empty
        title={`No rows for ${formatMonth(month)}`}
        hint={
          data && data.missingSummary.length > 0
            ? `The monthly figures for these ${data.missingSummary.length} are not built yet: ${data.missingSummary.join(', ')}. The rows appear once the month ends or the nightly rollup runs.`
            : 'The monthly figures for that month are not built yet. Try an earlier month.'
        }
      />
    );
  }

  const columns: Column<PayrollRow>[] = [
    {
      key: 'person',
      header: 'Staff',
      render: (row) => (
        <PersonCell fullName={row.fullName} empCode={row.empCode} />
      ),
    },
    {
      key: 'target',
      header: 'Target',
      align: 'right',
      /**
       * Target is now **the employee's workdays x 8**, not a flat 208.
       *
       * Careful: when the employee was not there for the whole month, the day count
       * is shown below (`13 / 27 days`). Without it the owner would see one person's
       * target as 216h and another's as 104h with no explanation, and the lower
       * number in the pay column would have an invisible cause.
       */
      render: (row) => (
        <div className="flex flex-col items-end">
          <Hours hours={row.targetHours} tone="muted" />
          {row.workdays < row.monthWorkdays && (
            <span className="text-xs text-idle" title="Joined or left mid-month — target and salary are both prorated">
              {row.workdays} / {row.monthWorkdays} days
            </span>
          )}
        </div>
      ),
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
      key: 'shortfall',
      header: 'Shortfall',
      align: 'right',
      render: (row) =>
        Number(row.shortfallHours) > 0 ? (
          <span className="font-semibold text-brand-ink">
            <Hours hours={row.shortfallHours} />
          </span>
        ) : (
          <span className="num text-ink-3">—</span>
        ),
    },
    {
      /**
       * Careful: **hours only** in this column, no money. The OT rate has not been
       *    set (O4), so the server sends no amount either. Hardcoding "x 1.5" here
       *    would silently become company policy.
       */
      key: 'overtime',
      header: 'Overtime',
      align: 'right',
      render: (row) =>
        Number(row.overtimeHours) > 0 ? (
          <Hours hours={row.overtimeHours} />
        ) : (
          <span className="num text-ink-3">—</span>
        ),
    },
    {
      key: 'salary',
      header: 'Pay',
      align: 'right',
      // Careful: `null` = pay **not set**, not zero. Rendering `—` for both would
      //    look the same, and a forgotten salary entry would never be noticed.
      render: (row) =>
        row.payBasis === 'none' ? (
          <span className="text-[11.5px] text-ink-3">Not paid here</span>
        ) : row.payBasis === 'hourly' ? (
          row.hourlyRate === null ? (
            <span className="text-[11.5px] text-ink-3">Not set</span>
          ) : (
            <span className="num">{formatTaka(row.hourlyRate)} / h</span>
          )
        ) : row.monthlySalary === null ? (
          <span className="text-[11.5px] text-ink-3">Not set</span>
        ) : (
          <span className="num">{formatTaka(row.monthlySalary)} / month</span>
        ),
    },
    {
      key: 'rate',
      header: 'Hourly rate',
      align: 'right',
      render: (row) => (
        <span className="num text-ink-3">{formatTaka(row.hourlyRate)}</span>
      ),
    },
    {
      key: 'deduction',
      header: 'Deduction',
      align: 'right',
      render: (row) =>
        row.payBasis !== 'monthly' ? (
          <span className="num text-ink-3">—</span>
        ) : row.deduction !== null && Number(row.deduction) > 0 ? (
          <span className="num text-brand-ink">{formatTaka(row.deduction)}</span>
        ) : (
          <span className="num text-ink-3">{formatTaka(row.deduction)}</span>
        ),
    },
    {
      key: 'overtimePay',
      header: 'Overtime pay',
      align: 'right',
      render: (row) =>
        row.overtimePay !== null && Number(row.overtimePay) > 0 ? (
          <span className="num text-ok">{formatTaka(row.overtimePay)}</span>
        ) : (
          <span className="num text-ink-3">—</span>
        ),
    },
    {
      key: 'payable',
      header: 'Payable',
      align: 'right',
      render: (row) => (
        <span className="num">{formatTaka(row.payable)}</span>
      ),
    },
    {
      /**
       * This month's deposit instalment.
       *
       * Careful: `—` means no instalment this month (the ledger has not started or is
       *    settled). It is not 0, because an instalment of ৳0 does not exist.
       */
      key: 'deposit',
      header: 'Deposit',
      align: 'right',
      render: (row) =>
        row.securityDeposit === null ? (
          <span className="num text-ink-3">—</span>
        ) : (
          <span className="num text-brand-ink">
            {formatTaka(row.securityDeposit)}
          </span>
        ),
    },
    {
      /**
       * **Take-home pay**: the last word of the sheet, so it is bold.
       *
       * Careful: **this column did not exist until recently**, yet the server was
       * already sending the number and the warning below referred to it by name
       * (*"Net payable stops at zero"*). So the owner paid from `Payable`, without
       * deducting the deposit.
       *
       * Careful: `null` = salary not set, so net cannot be computed. Not zero.
       */
      key: 'net',
      header: 'Net payable',
      align: 'right',
      render: (row) =>
        row.netPayable === null ? (
          <span className="text-[11.5px] text-ink-3">Not set</span>
        ) : (
          <span className="num font-semibold">{formatTaka(row.netPayable)}</span>
        ),
    },
  ];

  return (
    <>
      <Card
        title={`Payroll Hours · ${formatMonth(month)}`}
        hint="Monthly salary: deduction = salary × shortfall ÷ target (only if the work policy deducts), shortfall counting only the days we actually watched. Hourly: hours counted × rate, plus paid leave. Overtime is paid when the work policy sets a multiplier. Net payable = payable − deposit. Every view of this sheet is written to the audit log."
        padded={false}
      >
        <Table
          columns={columns}
          rows={data.rows}
          rowKey={(row) => String(row.employeeId)}
          rowMuted={(row) => row.monthlySalary === null}
        />
      </Card>

      {/* the rules come from each person's work policy (Settings → Policies › Pay rules) */}
      {!data.rows.some((r) => r.overtimePay !== null && Number(r.overtimePay) > 0) && (
        <Caveat>
          No overtime is paid this month — a work policy pays it only when it sets an
          overtime multiplier (Settings → Policies & holidays › Pay rules).
        </Caveat>
      )}

      {data.missingSalary.length > 0 && (
        <Caveat>
          These <span className="num">{data.missingSalary.length}</span> have no
          salary on file, so no deduction or payable could be worked out for
          them (they are not treated as zero): {data.missingSalary.join(', ')}
        </Caveat>
      )}

      {data.missingSummary.length > 0 && (
        <Caveat>
          These <span className="num">{data.missingSummary.length}</span> have
          no figures for that month yet, so they are <b>not</b> in the table
          above: {data.missingSummary.join(', ')}
        </Caveat>
      )}

      {/*
        Careful: net stopping at zero must not happen silently. The server always sent
        this field; the screen just did not show it.
      */}
      {data.depositExceedsPayable.length > 0 && (
        <Caveat>
          For these{' '}
          <span className="num">{data.depositExceedsPayable.length}</span> the
          security-money instalment is larger than what they earned this month,
          so “Net payable” stops at zero and the full instalment could not be
          taken: {data.depositExceedsPayable.join(', ')}
        </Caveat>
      )}

      {/*
        Important: the numbers on this page can do the most harm, because this is where
        `d ÷ D` really cuts money. If a date moves, the printed sheet itself becomes
        wrong.
      */}
      {data.approximateHolidayDates.length > 0 && (
        <Caveat>
          <span className="num">{data.approximateHolidayDates.length}</span>{' '}
          holiday date
          {data.approximateHolidayDates.length > 1 ? 's' : ''} in this month{' '}
          {data.approximateHolidayDates.length > 1 ? 'are' : 'is'} not final yet
          (
          {data.approximateHolidayDates.map((d, i) => (
            <span key={d}>
              {i > 0 && ', '}
              <b className="num">{formatDate(d)}</b>
            </span>
          ))}
          ). If one moves, the working days for this month change — and the
          day fraction these payables are built on changes with them.
        </Caveat>
      )}
    </>
  );
}
