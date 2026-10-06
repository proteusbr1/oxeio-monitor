import { useState, type ReactNode } from 'react';

import { reportXlsxUrl, type GroupBy } from '../../api/reports';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
import { DateRange } from '../../components/DatePicker';
import { EmployeePicker } from '../../components/EmployeePicker';
import { ErrorNote } from '../../components/Field';
import { Button, Page } from '../../components/Page';
import { Empty } from '../../components/States';
import { Tabs, type TabItem } from '../../components/Tabs';
import { useXlsxDownload } from '../../lib/download';
import { formatDate, thisMonthRange } from '../../lib/format';
import { AttendanceTab } from './AttendanceTab';
import { ProductivityTab } from './ProductivityTab';
import { SummaryTab } from './SummaryTab';
import { MAX_REPORT_DAYS, rangeDays } from './shared';
import { seesEveryone } from '../../api/auth';

/**
 * Reports.
 *
 * Flow: pick a range, pick a type, table, Excel.
 *
 * The payroll sheet lives on its own page now (pages/payroll), with the
 * rest of the month's pay.
 *
 * Important: range, staff and groupBy all live on this page, not in the tabs. So
 *    switching tabs keeps the chosen dates, and the download link is always for
 *    exactly what is on screen; the two cannot drift apart.
 */

type TabId = 'attendance' | 'summary' | 'productivity';

const TABS: TabItem<TabId>[] = [
  { id: 'attendance', label: 'Attendance' },
  { id: 'summary', label: 'Summary' },
  { id: 'productivity', label: 'Apps & sites' },
];

/** The server's default is also 25; kept equal so the screen and Excel agree */
const TOP_LIMITS = [25, 50, 100, 200];

export function ReportsPage() {
  const { user } = useAuth();

  /**
   * Careful: for staff both `/reports/*` **and** `/employees` return 403 (both have a
   *   class-level `@Roles(owner, manager)`). Without a guard, a staff member who typed
   *   the URL would fire two requests that are certain to fail every time, and see the
   *   whole report structure including the employee-picker dropdown, just without the
   *   numbers. `MonthlyPage` and `SettingsPage` stop them the same way.
   */
  if (!seesEveryone(user?.role)) {
    return (
      <Page title="Reports">
        <Empty
          title="You don't have access"
          hint="Reports and exports are for the owner and managers only."
        />
      </Page>
    );
  }

  return <ReportsBoard />;
}

function ReportsBoard() {
  const { features } = useFeatures();
  const [picked, setPicked] = useState<TabId>('attendance');
  /**
   * Apps & websites switched off (Settings → Modules): no "Apps & sites" tab —
   * `/reports/productivity` answers 404 then. If it goes off while the tab is
   * open, the page falls back to Attendance rather than showing an error.
   */
  const tabs = features.appTracking
    ? TABS
    : TABS.filter((t) => t.id !== 'productivity');
  const tab: TabId =
    picked === 'productivity' && !features.appTracking ? 'attendance' : picked;
  // Careful: not `new Date().toISOString().slice(0,10)`; between midnight and the offset hour in
  //    zones ahead of UTC (6am in Asia/Dhaka) that gives the previous date and the report would open a day behind.
  const [range, setRange] = useState(() => thisMonthRange());
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('month');
  const [limit, setLimit] = useState(TOP_LIMITS[0]);

  const download = useXlsxDownload();

  const days = rangeDays(range.from, range.to);
  // Careful: the server accepts at most 370 days. Catch it early so a request that is
  //    sure to fail is never sent; for a large range it would wait several seconds
  //    and then return 400.
  const tooLong = days > MAX_REPORT_DAYS;

  const startDownload = (): void => {
    const query = {
      from: range.from,
      to: range.to,
      employeeId: employeeId ?? undefined,
      groupBy: tab === 'summary' ? groupBy : undefined,
      limit: tab === 'productivity' ? limit : undefined,
    };
    download.start(
      reportXlsxUrl(tab, query),
      `oxeio-${tab}-${range.from}_${range.to}.xlsx`,
    );
  };

  return (
    <Page
      title="Reports"
      subtitle={`${formatDate(range.from)} — ${formatDate(range.to)} · ${days} days`}
      actions={
        <Button
          onClick={startDownload}
          disabled={download.busy || tooLong}
          tone="primary"
          title="The file is built on the server first — a long range takes a moment"
        >
          {download.busy ? 'Preparing…' : 'Download Excel'}
        </Button>
      }
    >
      <Tabs
        items={tabs}
        active={tab}
        label="Report type"
        onChange={(next) => {
          setPicked(next);
          // The previous tab's download error must not linger on the new tab
          download.clear();
        }}
      />

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <>
            <DateRange
              from={range.from}
              to={range.to}
              onChange={setRange}
            />
            <EmployeePicker
              value={employeeId}
              onChange={setEmployeeId}
              allowAll
              allLabel="Everyone"
              // Careful: a departed employee's old months are needed in reports, so
              //    inactive staff stay in the list
              includeInactive
            />

            {tab === 'summary' && (
              <SelectField
                label="Group by"
                value={groupBy}
                onChange={(next) => setGroupBy(next as GroupBy)}
                options={[
                  { value: 'month', label: 'Month' },
                  { value: 'week', label: 'Week' },
                ]}
              />
            )}

            {tab === 'productivity' && (
              <SelectField
                label="Top how many"
                value={String(limit)}
                onChange={(next) => setLimit(Number(next))}
                options={TOP_LIMITS.map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            )}
        </>
      </div>

      {download.error && (
        <div className="mt-3">
          <ErrorNote>{download.error}</ErrorNote>
        </div>
      )}

      <div className="mt-4">
        {tooLong ? (
          <RangeTooLong days={days} />
        ) : tab === 'attendance' ? (
          <AttendanceTab
            from={range.from}
            to={range.to}
            employeeId={employeeId}
          />
        ) : tab === 'summary' ? (
          <SummaryTab
            from={range.from}
            to={range.to}
            employeeId={employeeId}
            groupBy={groupBy}
          />
        ) : (
          <ProductivityTab
            from={range.from}
            to={range.to}
            employeeId={employeeId}
            limit={limit}
          />
        )}
      </div>
    </Page>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-ink-3">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Careful: this is not "something went wrong", so not solid red; just a limit. The
 *    request is never sent, so the user does not have to wait either.
 */
function RangeTooLong({ days }: { days: number }): ReactNode {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-2">That range is too long</p>
      <p className="mx-auto mt-1.5 max-w-md text-xs text-ink-3">
        One report covers at most <span className="num">{MAX_REPORT_DAYS}</span>{' '}
        days; you asked for <span className="num">{days}</span>. Move the start
        date closer.
      </p>
    </div>
  );
}
