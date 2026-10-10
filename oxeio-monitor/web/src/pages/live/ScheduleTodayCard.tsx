import { Link } from 'react-router-dom';

import type { ScheduleToday } from '../../api/schedule';
import type { ApiResult } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Chip } from '../../components/ui';
import { useT } from '../../i18n';
import { workTimeZoneLabel } from '../../lib/format';
import { BREACH_LABEL } from '../schedule/schedule.format';
import { DataPanel } from './DataPanel';
import { todayStatus, type TodayStatus } from './scheduleToday';

const TONE_CLASS: Record<TodayStatus['tone'], string> = {
  ok: 'text-ink-2',
  // the Schedule page marks a day with breaches the same way
  attention: 'font-medium text-brand-ink',
  off: 'text-ink-3',
};

/**
 * Everyone on a fixed schedule, today: arrival, break, leaving and what is
 * off schedule so far. The board renders it only when someone is on one.
 */
export function ScheduleTodayCard({
  result,
}: {
  result: Pick<ApiResult<ScheduleToday | null>, 'data' | 'error' | 'reload'>;
}) {
  const t = useT();
  const today = result.data;
  return (
    <Card
      title={t('Schedule Today')}
      hint={t('Fixed-schedule staff · {{zone}} time', {
        zone: workTimeZoneLabel(),
      })}
      actions={
        <Link
          className="tap text-xs underline underline-offset-4"
          to="/schedule"
        >
          {t('View Schedule ↗')}
        </Link>
      }
      padded={false}
    >
      <DataPanel result={result}>
        {today && (
          <ul className="divide-y divide-line">
            {today.people.map((p) => {
              const s = todayStatus(p, today.nowMin);
              return (
                <li
                  key={p.employeeId}
                  className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">
                      {p.fullName}
                    </div>
                    {p.breaches.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.breaches.map((b) => (
                          <Chip key={b} tone="attention">
                            {t(BREACH_LABEL[b])}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>
                  <div
                    className={`num flex flex-col gap-0.5 text-[12.5px] ${TONE_CLASS[s.tone]}`}
                  >
                    <span>{s.arrival}</span>
                    {s.breakText && <span>{s.breakText}</span>}
                    {s.leaving && <span>{s.leaving}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DataPanel>
    </Card>
  );
}
