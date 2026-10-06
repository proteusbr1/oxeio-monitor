import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { listLeaves, listMonthClosures } from '../../api/payroll';
import { ApiError } from '../../api/client';
import { getPayroll, type PayrollSheet } from '../../api/payroll';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { MonthPicker } from '../../components/DatePicker';
import { Page } from '../../components/Page';
import { ErrorBox } from '../../components/States';
import { Tabs } from '../../components/Tabs';
import { useFeatures } from '../../features/FeaturesContext';
import { formatDate, formatMonth, todayInDhaka } from '../../lib/format';
import { DepositsTab } from './DepositsTab';
import { LeaveTab } from './LeaveTab';
import { MonthsTab } from './MonthsTab';
import { PayrollSheetView } from './PaySheet';
import { SalariesTab } from './SalariesTab';

/**
 * Payroll — everything that goes into a month's pay, in the order it is
 * done: salaries, leave, deposits, the sheet, closing the month. One month
 * picker drives the tabs that are about a month; the checklist on top says
 * what is still open.
 *
 * Leave and closing a month also move the HOURS (leave lowers the target, a
 * closed month stops moving), so with the payroll module switched off the
 * page stays, as "Leave & months", without the pay tabs.
 */
type TabId = 'sheet' | 'salaries' | 'leave' | 'deposits' | 'close';

export function PayrollPage() {
  const { user } = useAuth();
  const { features } = useFeatures();
  const [params, setParams] = useSearchParams();

  const thisMonth = todayInDhaka().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '')
    ? (params.get('month') as string)
    : thisMonth;

  const tabs: { id: TabId; label: string }[] = [
    ...(features.payroll
      ? [
          { id: 'sheet' as const, label: 'Pay sheet' },
          { id: 'salaries' as const, label: 'Salaries' },
        ]
      : []),
    { id: 'leave', label: 'Leave' },
    ...(features.deposits ? [{ id: 'deposits' as const, label: 'Deposits' }] : []),
    { id: 'close', label: 'Close month' },
  ];
  const raw = params.get('tab');
  const active: TabId = tabs.some((t) => t.id === raw) ? (raw as TabId) : tabs[0].id;

  const go = (next: { tab?: TabId; month?: string }) =>
    setParams(
      { tab: next.tab ?? active, month: next.month ?? month },
      { replace: true },
    );

  // loaded once for the checklist and the sheet — each load is audited
  const sheet = useApi(
    (signal) => (features.payroll ? getPayroll(month, signal) : Promise.resolve(null)),
    [month, features.payroll],
  );
  const leave = useApi((signal) => listLeaves(month, signal), [month]);
  const closures = useApi(listMonthClosures, []);

  const title = features.payroll ? 'Payroll' : 'Leave & months';

  if (user?.role !== 'owner') {
    return (
      <Page title={title}>
        <ErrorBox error={new ApiError(403, "You don't have access")} />
      </Page>
    );
  }

  const closed = closures.data?.rows.find((c) => c.yearMonth === month) ?? null;

  return (
    <Page
      title={title}
      subtitle={
        features.payroll
          ? 'Everything that goes into the month’s pay, in the order it is done'
          : 'Agreed days off, and freezing a finished month'
      }
      actions={
        // always shown: the checklist is about this month on every tab
        <div className="w-44">
          <MonthPicker value={month} onChange={(m) => go({ month: m })} />
        </div>
      }
    >
      {features.payroll && (
        <Checklist
          month={month}
          sheet={sheet.data}
          leaveDays={leave.data?.rows.length ?? null}
          closed={closed ? { at: closed.closedAt, by: closed.closedBy } : null}
          deposits={features.deposits}
          onOpen={(tab) => go({ tab })}
        />
      )}

      <Tabs items={tabs} active={active} onChange={(tab) => go({ tab })} label="Payroll" />

      <div className="mt-4">
        {active === 'sheet' && <PayrollSheetView month={month} result={sheet} />}
        {active === 'salaries' && <SalariesTab />}
        {active === 'leave' && (
          <LeaveTab month={month} />
        )}
        {active === 'deposits' && <DepositsTab />}
        {active === 'close' && <MonthsTab />}
      </div>
    </Page>
  );
}

type Tone = 'done' | 'todo' | 'problem' | 'info';

/** What is still open for this month — each step opens its tab */
function Checklist({
  month,
  sheet,
  leaveDays,
  closed,
  deposits,
  onOpen,
}: {
  month: string;
  sheet: PayrollSheet | null;
  leaveDays: number | null;
  closed: { at: string; by: string } | null;
  deposits: boolean;
  onOpen: (tab: TabId) => void;
}) {
  const names = (list: string[]) =>
    list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3}`;

  const steps: { tab: TabId; label: string; tone: Tone; text: ReactNode }[] = [
    {
      tab: 'salaries',
      label: 'Salaries',
      tone: !sheet ? 'info' : sheet.missingSalary.length > 0 ? 'problem' : 'done',
      text: !sheet
        ? '…'
        : sheet.missingSalary.length > 0
          ? `Missing for ${names(sheet.missingSalary)}`
          : 'Everyone has one',
    },
    {
      tab: 'leave',
      label: 'Leave',
      tone: 'info',
      text:
        leaveDays === null
          ? '…'
          : leaveDays === 0
            ? 'None recorded — anyone away counts as short'
            : `${leaveDays} day${leaveDays === 1 ? '' : 's'} recorded`,
    },
    ...(deposits
      ? [
          {
            tab: 'deposits' as const,
            label: 'Deposits',
            tone: (!sheet
              ? 'info'
              : sheet.depositExceedsPayable.length > 0
                ? 'problem'
                : 'done') as Tone,
            text: !sheet
              ? '…'
              : sheet.depositExceedsPayable.length > 0
                ? `Larger than pay for ${names(sheet.depositExceedsPayable)}`
                : 'Nothing unusual',
          },
        ]
      : []),
    {
      tab: 'sheet',
      label: 'Hours',
      tone: !sheet ? 'info' : sheet.missingSummary.length > 0 ? 'todo' : 'done',
      text: !sheet
        ? '…'
        : sheet.missingSummary.length > 0
          ? `Not totalled yet for ${sheet.missingSummary.length} — the nightly run adds them`
          : 'Totalled for everyone',
    },
    {
      tab: 'close',
      label: 'Month',
      tone: closed ? 'done' : 'todo',
      text: closed
        ? `Closed ${formatDate(closed.at.slice(0, 10))} by ${closed.by}`
        : 'Open — close it once the sheet is reviewed',
    },
  ];

  return (
    <section
      aria-label={`${formatMonth(month)} checklist`}
      className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5"
    >
      {steps.map((step) => (
        <button
          key={step.label}
          type="button"
          onClick={() => onOpen(step.tab)}
          className="rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition hover:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <Mark tone={step.tone} />
            {step.label}
          </span>
          <span className="mt-1 block text-[11.5px] leading-snug text-ink-3">{step.text}</span>
        </button>
      ))}
    </section>
  );
}

function Mark({ tone }: { tone: Tone }) {
  const [symbol, style, label] =
    tone === 'done'
      ? ['✓', 'text-ok', 'done']
      : tone === 'problem'
        ? ['!', 'text-brand', 'needs attention']
        : tone === 'todo'
          ? ['○', 'text-idle', 'to do']
          : ['•', 'text-ink-3', ''];
  return (
    <span aria-label={label || undefined} className={`w-3 text-center ${style}`}>
      {symbol}
    </span>
  );
}
