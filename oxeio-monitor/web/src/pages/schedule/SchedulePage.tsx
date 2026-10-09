import { useState } from 'react';

import {
  scheduledPeople,
  scheduleMonth,
  type ScheduleDayView,
} from '../../api/schedule';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { MonthPicker } from '../../components/DatePicker';
import { Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import { SelectField } from '../../components/ui';
import { useT } from '../../i18n';
import {
  formatDateMedium,
  formatMonth,
  todayInWorkZone,
} from '../../lib/format';
import { BREACH_LABEL, clockOf, signedDuration } from './schedule.format';

/**
 * Schedule compliance (`/schedule`) for people on a policy that checks a
 * fixed schedule: arrival, leaving, the break and the day's balance.
 * Breaches are marked; the balance is information only.
 */
export function SchedulePage() {
  const t = useT();
  const people = useApi(scheduledPeople, []);

  if (people.loading && !people.data) return <Loading />;
  if (people.error && !people.data) {
    return (
      <Page title={t('Schedule')}>
        <ErrorBox error={people.error} retry={people.reload} />
      </Page>
    );
  }
  if (!people.data || people.data.length === 0) {
    return (
      <Page title={t('Schedule')}>
        <Empty
          title={t('Nobody is on a policy that checks a schedule')}
          hint={t('Switch it on in Settings → Policies & holidays.')}
        />
      </Page>
    );
  }
  return <ScheduleBoard people={people.data} />;
}

function ScheduleBoard({
  people,
}: {
  people: { id: number; fullName: string }[];
}) {
  const t = useT();
  const [employeeId, setEmployeeId] = useState(people[0].id);
  const [month, setMonth] = useState(() => todayInWorkZone().slice(0, 7));
  const view = useApi(
    (signal) => scheduleMonth(employeeId, month, signal),
    [employeeId, month],
  );
  const data = view.data;

  const columns: Column<ScheduleDayView>[] = [
    {
      key: 'day',
      header: t('Day'),
      render: (d) => (
        <>
          {formatDateMedium(d.date)}
          {!d.final && (
            <span className="ml-1.5 text-ink-3">{t('in progress')}</span>
          )}
        </>
      ),
    },
    {
      key: 'arrived',
      header: t('Arrived'),
      render: (d) => <span className="num">{clockOf(d.arrivedMin)}</span>,
    },
    {
      key: 'break',
      header: t('Break'),
      render: (d) => (
        <span className="num">
          {d.breakStartMin === null
            ? '—'
            : `${clockOf(d.breakStartMin)} · ${d.breakMin} min`}
        </span>
      ),
    },
    {
      key: 'left',
      header: t('Left'),
      render: (d) => <span className="num">{clockOf(d.leftMin)}</span>,
    },
    {
      key: 'balance',
      header: t('Balance'),
      align: 'right',
      render: (d) => (
        <span className="num">{signedDuration(d.balanceMin)}</span>
      ),
    },
    {
      key: 'notes',
      header: t('Notes'),
      render: (d) => (
        <span
          className={d.breaches.length > 0 ? 'font-medium text-brand-ink' : ''}
        >
          {d.breaches.map((b) => t(BREACH_LABEL[b])).join(' · ')}
        </span>
      ),
    },
  ];

  return (
    <Page
      title={t('Schedule')}
      subtitle={formatMonth(month)}
      actions={
        <>
          <SelectField
            label={t('Person')}
            value={String(employeeId)}
            onChange={(v) => setEmployeeId(Number(v))}
            options={people.map((p) => ({
              value: String(p.id),
              label: p.fullName,
            }))}
          />
          <MonthPicker value={month} onChange={setMonth} />
        </>
      }
    >
      {view.loading && !data ? (
        <Loading />
      ) : view.error ? (
        <ErrorBox error={view.error} retry={view.reload} />
      ) : (
        data && (
          <div className="space-y-3">
            <Card title={t('This month')}>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                <Total label={t('Late')} value={String(data.totals.late)} />
                <Total
                  label={t('Left early')}
                  value={String(data.totals.earlyLeave)}
                />
                <Total
                  label={t('Short break')}
                  value={String(data.totals.breakShort)}
                />
                <Total
                  label={t('No break')}
                  value={String(data.totals.breakMissing)}
                />
                <Total
                  label={t('No activity')}
                  value={String(data.totals.noShow)}
                />
                <Total
                  label={t('Balance')}
                  value={signedDuration(data.totals.balanceMin)}
                />
              </div>
            </Card>
            <Card padded={false}>
              <Table
                columns={columns}
                rows={data.days}
                rowKey={(d) => d.date}
              />
            </Card>
          </div>
        )
      )}
    </Page>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label}: <b className="num">{value}</b>
    </span>
  );
}
