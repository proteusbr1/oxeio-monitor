import { Link } from 'react-router-dom';

import type {
  PeriodDetail,
  PeriodSummary,
  StatementLine,
} from '../../api/hoursStatement';
import type { ApiResult } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Table, type Column } from '../../components/Table';
import { useT } from '../../i18n';
import { todayInWorkZone } from '../../lib/format';
import { deliveryLine, hm, periodLabel } from '../hours/hours.format';
import { DataPanel } from './DataPanel';
import { cutoffHint } from './hoursToday';

export interface OpenStatement {
  detail: PeriodDetail | null;
  lastFrozen: PeriodSummary | null;
}

/**
 * The open pay period so far, for the owner: hours, carry and what would be
 * posted if it closed now, plus how the last statement's email went. Live
 * figures, not final — the Hours statement page holds the real thing.
 */
export function HoursStatementCard({
  result,
}: {
  result: Pick<ApiResult<OpenStatement | null>, 'data' | 'error' | 'reload'>;
}) {
  const t = useT();
  const detail = result.data?.detail;
  const lastFrozen = result.data?.lastFrozen ?? null;
  const delivery = lastFrozen ? deliveryLine(lastFrozen) : null;
  const lines = detail?.lines ?? [];
  const carries = lines.some((l) => l.carryInSec !== 0);

  const columns: Column<StatementLine>[] = [
    {
      key: 'person',
      header: t('Person'),
      render: (l) => <span className="font-medium">{l.fullName}</span>,
    },
    {
      key: 'measured',
      header: t('Hours so far'),
      align: 'right',
      render: (l) => (
        <span className="num">{hm(Math.floor(l.measuredSec / 60))}</span>
      ),
    },
    ...(carries
      ? [
          {
            key: 'carry',
            header: t('Carried over'),
            align: 'right' as const,
            render: (l: StatementLine) =>
              l.carryInSec === 0 ? (
                <span className="num text-ink-3">—</span>
              ) : (
                <span className="num">{hm(Math.trunc(l.carryInSec / 60))}</span>
              ),
          },
        ]
      : []),
    {
      key: 'toPost',
      header: t('To post so far'),
      align: 'right',
      render: (l) => (
        <span
          className={`num font-semibold ${l.toPostMin < 0 ? 'text-brand-ink' : ''}`}
        >
          {hm(l.toPostMin)}
        </span>
      ),
    },
  ];

  return (
    <Card
      title={t('Hours Statement')}
      hint={detail ? cutoffHint(detail.period, todayInWorkZone()) : undefined}
      actions={
        <Link className="tap text-xs underline underline-offset-4" to="/hours">
          {t('Open ↗')}
        </Link>
      }
      padded={false}
    >
      <DataPanel result={result}>
        <Table
          columns={columns}
          rows={lines}
          rowKey={(l) => String(l.employeeId)}
        />
        <div className="space-y-1 px-4 py-3 text-[11.5px]">
          <p className="text-ink-3">{t('So far, not final')}</p>
          {lastFrozen && delivery && (
            <p
              className={
                delivery.problem ? 'font-medium text-brand-ink' : 'text-ink-3'
              }
            >
              {t('Last statement, {{period}}: {{status}}', {
                period: periodLabel(lastFrozen.start, lastFrozen.end),
                status: delivery.text,
              })}
            </p>
          )}
        </div>
      </DataPanel>
    </Card>
  );
}
