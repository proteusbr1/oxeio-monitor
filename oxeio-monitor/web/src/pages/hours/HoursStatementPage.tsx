import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  getPeriod,
  listPeriods,
  periodFileUrl,
  personDays,
  resendPeriod,
  unmarkPosted,
  type PeriodSummary,
  type StatementDay,
  type StatementLine,
} from '../../api/hoursStatement';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card } from '../../components/Card';
import { Button, Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import {
  Chip,
  MiniButton,
  Notice,
  RowActions,
  SelectField,
  ServerError,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';
import { useXlsxDownload } from '../../lib/download';
import {
  formatDateMedium,
  formatDateTime,
  formatHoursAsDuration,
} from '../../lib/format';
import {
  canResend,
  deliveryLine,
  hm,
  LINE_STATUS_LABEL,
  lineStatus,
  periodLabel,
  pickPeriod,
  type LineStatus,
} from './hours.format';
import { PostedDialog } from './PostedDialog';

/**
 * The hours statement (`/hours`): for each pay period, the hours to post
 * for every person paid by the hour — finance's only screen, the owner's
 * too. Hours only, never money.
 *
 * A frozen period shows the stored lines, each marked as posted (or not) by
 * finance; the open one shows live, partial figures. The email's link opens
 * `?period=<id>`.
 */
export function HoursStatementPage() {
  const t = useT();
  const periods = useApi(listPeriods, []);
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get('period')) || null;

  if (periods.loading && !periods.data) return <Loading />;
  if (periods.error && !periods.data) {
    return (
      <Page title={t('Hours statement')}>
        <ErrorBox error={periods.error} retry={periods.reload} />
      </Page>
    );
  }
  const selected = pickPeriod(periods.data ?? [], requested);
  if (!selected) {
    return (
      <Page title={t('Hours statement')}>
        <Empty
          title={t('No pay period yet')}
          hint={t(
            'The first period starts on its own within the hour. The cutoff day is set in Settings → Hours statement.',
          )}
        />
      </Page>
    );
  }
  return (
    <PeriodView
      // a new period starts with nothing open, no dialog and no old download error
      key={selected.id}
      periods={periods.data ?? []}
      summary={selected}
      onPick={(id) => setParams({ period: String(id) }, { replace: true })}
      onListChanged={periods.reload}
    />
  );
}

function PeriodView({
  periods,
  summary,
  onPick,
  onListChanged,
}: {
  periods: readonly PeriodSummary[];
  summary: PeriodSummary;
  onPick: (id: number) => void;
  onListChanged: () => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const detail = useApi(
    (signal) => getPeriod(summary.id, signal),
    [summary.id],
  );
  const download = useXlsxDownload();
  const resend = useMutation();
  const undo = useMutation();
  const [posting, setPosting] = useState<
    (StatementLine & { id: number }) | null
  >(null);
  const [personId, setPersonId] = useState<number | null>(null);

  const data = detail.data;
  // the detail's copy is fresher after a resend; the list's shows at once
  const period = data?.period ?? summary;
  const locked = data?.locked ?? false;
  const delivery = deliveryLine(period);
  const person = data?.lines.find((l) => l.employeeId === personId) ?? null;

  const reloadAll = () => {
    detail.reload();
    onListChanged();
  };

  const columns: Column<StatementLine>[] = [
    {
      key: 'person',
      header: t('Person'),
      render: (l) => (
        <PersonCell
          fullName={l.fullName}
          empCode={l.empCode}
          // paid by the hour for only part of the period
          note={
            l.fromDate !== period.start || l.toDate !== period.end
              ? periodLabel(l.fromDate, l.toDate)
              : undefined
          }
        />
      ),
    },
    {
      key: 'measured',
      header: t('Hours in the period'),
      align: 'right',
      render: (l) => (
        <span className="num">{hm(Math.floor(l.measuredSec / 60))}</span>
      ),
    },
    {
      key: 'carry',
      header: t('Carried over'),
      align: 'right',
      render: (l) =>
        l.carryInSec === 0 ? (
          <span className="num text-ink-3">—</span>
        ) : (
          <span className="num">{hm(Math.trunc(l.carryInSec / 60))}</span>
        ),
    },
    {
      key: 'toPost',
      header: t('To post'),
      align: 'right',
      render: (l) => (
        <span
          className={`num font-semibold ${l.toPostMin < 0 ? 'text-brand-ink' : ''}`}
        >
          {hm(l.toPostMin)}
        </span>
      ),
    },
    {
      key: 'leave',
      header: t('Leave / holidays'),
      align: 'right',
      render: (l) => (
        <span className="num">
          {l.leaveDays} / {l.holidayDays}
        </span>
      ),
    },
    {
      key: 'noData',
      header: t('Workdays with no time'),
      align: 'right',
      render: (l) => (
        <span
          className={`num ${l.noDataDays > 0 ? 'font-medium text-idle-ink' : 'text-ink-3'}`}
        >
          {l.noDataDays}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('Status'),
      render: (l) => <StatusChip status={lineStatus(l)} />,
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (l) => (
        // the row's click opens the days; a button here must not do that too
        <div onClick={(e) => e.stopPropagation()}>
          <LineAction
            line={l}
            locked={locked}
            busy={undo.busy}
            onMark={(line) => {
              undo.reset();
              setPosting(line);
            }}
            onUndo={(id) =>
              undo.run(async () => {
                await unmarkPosted(id);
                detail.reload();
              })
            }
          />
        </div>
      ),
    },
  ];

  return (
    <Page
      title={t('Hours statement')}
      subtitle={periodLabel(period.start, period.end)}
      actions={
        <>
          <SelectField
            label={t('Pay period')}
            value={String(summary.id)}
            onChange={(v) => onPick(Number(v))}
            options={periods.map((p) => ({
              value: String(p.id),
              label: p.open
                ? `${periodLabel(p.start, p.end)} · ${t('in progress')}`
                : periodLabel(p.start, p.end),
            }))}
          />
          {isOwner && canResend(period) && (
            <Button
              disabled={resend.busy}
              onClick={() =>
                resend.run(async () => {
                  await resendPeriod(period.id);
                  reloadAll();
                })
              }
              title={t('Email the stored statement again')}
            >
              {resend.busy ? t('Sending…') : t('Resend')}
            </Button>
          )}
          <Button
            tone="primary"
            disabled={download.busy}
            onClick={() =>
              download.start(
                periodFileUrl(period.id),
                `oxeio-hours-${period.start}_${period.end}.xlsx`,
              )
            }
          >
            {download.busy ? t('Preparing…') : t('Download spreadsheet')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {period.open ? (
          <Notice>{t('In progress — partial figures, not final')}</Notice>
        ) : (
          delivery &&
          (delivery.problem ? (
            <Notice tone="attention">{delivery.text}</Notice>
          ) : (
            <p className="text-xs text-ink-2">{delivery.text}</p>
          ))
        )}
        {locked && (
          <Notice>
            {t(
              'A later statement already used this period — the posted marks can no longer change.',
            )}
          </Notice>
        )}
        {download.error && <Notice tone="attention">{download.error}</Notice>}
        <ServerError error={resend.error} />
        <ServerError error={undo.error} />

        {detail.loading && !data ? (
          <Loading />
        ) : detail.error && !data ? (
          <ErrorBox error={detail.error} retry={detail.reload} />
        ) : data && data.lines.length === 0 ? (
          <Empty
            title={t('Nobody was paid by the hour in this period')}
            hint={t(
              'The statement lists the people whose pay basis is hourly (Staff).',
            )}
          />
        ) : (
          data && (
            <Card
              padded={false}
              hint={t('Click a row to see their days.')}
              title={t('{{count}} people', { count: data.lines.length })}
            >
              <Table
                columns={columns}
                rows={data.lines}
                rowKey={(l) => String(l.employeeId)}
                onRowClick={(l) =>
                  setPersonId(personId === l.employeeId ? null : l.employeeId)
                }
              />
            </Card>
          )
        )}

        {person && (
          <PersonDays
            periodId={period.id}
            line={person}
            onClose={() => setPersonId(null)}
          />
        )}
      </div>

      {posting && (
        <PostedDialog
          line={posting}
          onClose={() => setPosting(null)}
          onDone={() => {
            setPosting(null);
            detail.reload();
          }}
        />
      )}
    </Page>
  );
}

function StatusChip({ status }: { status: LineStatus }) {
  const t = useT();
  const tone =
    status === 'to_post' ? 'pending' : status === 'live' ? 'muted' : 'counted';
  return <Chip tone={tone}>{t(LINE_STATUS_LABEL[status])}</Chip>;
}

/** Mark, or who marked it and when (with the value, when it differed) */
function LineAction({
  line,
  locked,
  busy,
  onMark,
  onUndo,
}: {
  line: StatementLine;
  locked: boolean;
  busy: boolean;
  onMark: (line: StatementLine & { id: number }) => void;
  onUndo: (lineId: number) => void;
}) {
  const t = useT();
  const id = line.id;
  if (id === null) return <span className="text-ink-3">—</span>;

  if (line.postedAt === null) {
    if (locked)
      return (
        <span className="text-[11.5px] text-ink-3">{t('Not marked')}</span>
      );
    return (
      <RowActions>
        <MiniButton tone="good" onClick={() => onMark({ ...line, id })}>
          {t('Mark as posted')}
        </MiniButton>
      </RowActions>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span
        className="text-right text-[11.5px] text-ink-2"
        title={line.note ?? undefined}
      >
        {t('Posted by {{name}} on {{date}}', {
          name: line.postedBy ?? t('someone'),
          date: formatDateTime(line.postedAt),
        })}
        {line.postedMin !== null && (
          <span className="num block font-medium text-ink">
            {t('Posted: {{value}}', { value: hm(line.postedMin) })}
          </span>
        )}
        {line.note && <span className="block text-ink-3">{line.note}</span>}
      </span>
      {!locked && (
        <MiniButton disabled={busy} onClick={() => onUndo(id)}>
          {t('Undo')}
        </MiniButton>
      )}
    </div>
  );
}

/** One person's days inside the period: what the hours are made of */
function PersonDays({
  periodId,
  line,
  onClose,
}: {
  periodId: number;
  line: StatementLine;
  onClose: () => void;
}) {
  const t = useT();
  const days = useApi(
    (signal) => personDays(periodId, line.employeeId, signal),
    [periodId, line.employeeId],
  );

  const columns: Column<StatementDay>[] = [
    {
      key: 'date',
      header: t('Day'),
      render: (d) => formatDateMedium(d.date),
    },
    {
      key: 'arrived',
      header: t('First use'),
      render: (d) => <span className="num">{d.arrived ?? '—'}</span>,
    },
    {
      key: 'left',
      header: t('Last use'),
      render: (d) => <span className="num">{d.left ?? '—'}</span>,
    },
    {
      key: 'presence',
      header: t('Presence'),
      align: 'right',
      render: (d) => (
        <span className="num">{formatHoursAsDuration(d.presenceHours)}</span>
      ),
    },
    {
      key: 'active',
      header: t('Active'),
      align: 'right',
      render: (d) => (
        <span className="num">{formatHoursAsDuration(d.activeHours)}</span>
      ),
    },
    {
      key: 'adjustment',
      header: t('Adjustment'),
      align: 'right',
      render: (d) =>
        d.adjustmentHours === 0 ? (
          <span className="num text-ink-3">—</span>
        ) : (
          <span className="num">
            {d.adjustmentHours < 0 ? '−' : '+'}
            {formatHoursAsDuration(Math.abs(d.adjustmentHours))}
          </span>
        ),
    },
    {
      key: 'credited',
      header: t('Counted'),
      align: 'right',
      render: (d) => (
        <span className="num font-medium">
          {formatHoursAsDuration(d.creditedHours)}
        </span>
      ),
    },
  ];

  return (
    <Card
      title={line.fullName}
      hint={periodLabel(line.fromDate, line.toDate)}
      actions={<MiniButton onClick={onClose}>{t('Close')}</MiniButton>}
      padded={false}
    >
      {days.loading && !days.data ? (
        <Loading />
      ) : days.error && !days.data ? (
        <ErrorBox error={days.error} retry={days.reload} />
      ) : days.data && days.data.length === 0 ? (
        <p className="p-4 text-[13px] text-ink-3">
          {t('No recorded days in this period.')}
        </p>
      ) : (
        <Table
          columns={columns}
          rows={days.data ?? []}
          rowKey={(d) => d.date}
        />
      )}
    </Card>
  );
}
