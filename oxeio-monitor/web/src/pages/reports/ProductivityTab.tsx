import { getProductivityReport, type ProductivityEmployeeRow, type ProductivityItem } from '../../api/reports';
import { useApi } from '../../api/useApi';
import { Card, Stat, StatRow } from '../../components/Card';
import { Hours } from '../../components/Duration';
import { ProgressBar } from '../../components/ProgressRing';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import { formatPct } from '../../lib/format';
import { useT } from '../../i18n';
import { CATEGORY_LABEL, MetaNote, Pill } from './shared';

/**
 * App/site-based productivity report.
 *
 * Careful: name clash. `DailyProductivityReport` in `activity.ts` is a different
 *    thing: it is a per-day score, while this one is time spent per app/site.
 *
 * Important: what is shown is the browser **domain** (`github.com`), not the full URL.
 *    The server never stores full URLs (ADR-013), and window titles never arrive either.
 *    Remember that rule before adding any new "detail" column to this screen.
 */
export function ProductivityTab({
  from,
  to,
  employeeId,
  limit,
}: {
  from: string;
  to: string;
  employeeId: number | null;
  /** How many top apps/sites to return; the server caps it at 200 */
  limit: number;
}) {
  const t = useT();
  const { data, error, loading, reload } = useApi(
    (signal) =>
      getProductivityReport(
        { from, to, employeeId: employeeId ?? undefined, limit },
        signal,
      ),
    [from, to, employeeId, limit],
  );

  if (loading && !data) return <Loading label={t('Loading app and site usage…')} />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data || (data.top.length === 0 && data.byEmployee.length === 0)) {
    return (
      <Empty
        title={t('No app or site usage in this range')}
        hint={t(
          'While the agent runs, working time is collected on its own. In a new office it is normal for this page to stay empty for the first few days.',
        )}
      />
    );
  }

  const topColumns: Column<ProductivityItem>[] = [
    {
      key: 'name',
      header: t('App / site'),
      render: (item) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">
            {item.displayName ?? item.key}
          </div>
          {/* Show the real key too when a rule gives a custom name, or rows could not be matched */}
          {item.displayName && item.displayName !== item.key && (
            <div className="num truncate text-[11px] text-ink-3">{item.key}</div>
          )}
        </div>
      ),
    },
    {
      key: 'kind',
      header: t('Type'),
      render: (item) => (
        <Pill muted>{item.kind === 'site' ? t('Site') : t('App')}</Pill>
      ),
    },
    {
      key: 'category',
      header: t('Category'),
      render: (item) => (
        <Pill muted={item.category === 'uncategorized'}>
          {t(CATEGORY_LABEL[item.category])}
        </Pill>
      ),
    },
    {
      key: 'hours',
      header: t('Time'),
      align: 'right',
      render: (item) => <Hours hours={item.hours} />,
    },
    {
      key: 'share',
      header: t('Share'),
      align: 'right',
      className: 'w-32',
      render: (item) => (
        <div className="flex items-center justify-end gap-2">
          <ProgressBar
            value={item.sharePct}
            max={100}
            className="w-16"
            ariaLabel={t('Share')}
          />
          <span className="num w-11 text-right text-ink-2">
            {formatPct(item.sharePct)}
          </span>
        </div>
      ),
    },
  ];

  const employeeColumns: Column<ProductivityEmployeeRow>[] = [
    {
      key: 'person',
      header: t('Staff'),
      render: (row) => (
        <PersonCell fullName={row.fullName} empCode={row.empCode} />
      ),
    },
    {
      key: 'productive',
      header: t('Productive'),
      align: 'right',
      render: (row) => (
        <Hours hours={row.productiveHours} className="font-semibold" />
      ),
    },
    {
      key: 'neutral',
      header: t('Neutral'),
      align: 'right',
      render: (row) => <Hours hours={row.neutralHours} />,
    },
    {
      key: 'unproductive',
      header: t('Unproductive'),
      align: 'right',
      render: (row) => <Hours hours={row.unproductiveHours} />,
    },
    {
      // Careful: grey — these have not matched any rule yet; nothing bad about them
      key: 'uncategorized',
      header: t('Uncategorized'),
      align: 'right',
      render: (row) => <Hours hours={row.uncategorizedHours} tone="muted" />,
    },
    {
      key: 'tracked',
      header: t('Total tracked'),
      align: 'right',
      render: (row) => <Hours hours={row.trackedHours} tone="muted" />,
    },
    {
      key: 'share',
      header: t('Productive share'),
      align: 'right',
      className: 'w-32',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <ProgressBar
            value={row.productiveSharePct}
            max={100}
            className="w-16"
            ariaLabel={t('Productive share')}
          />
          <span className="num w-11 text-right">
            {formatPct(row.productiveSharePct)}
          </span>
        </div>
      ),
    },
  ];

  return (
    <>
      <StatRow>
        <Stat label={t('Total tracked')} value={<Hours hours={data.totalTrackedHours} />} />
        <Stat
          label={t('Uncategorized')}
          value={<Hours hours={data.uncategorizedHours} />}
          tone="muted"
        />
        <Stat
          label={t('Uncategorized share')}
          value={formatPct(
            data.totalTrackedHours > 0
              ? (data.uncategorizedHours / data.totalTrackedHours) * 100
              : null,
          )}
          tone="muted"
        />
      </StatRow>

      <div className="mt-4 space-y-4">
        <Card
          title={t('Top Apps and Sites')}
          hint={t('Sites show the domain only — the full address is never stored')}
          padded={false}
        >
          {data.top.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-3">
              {t('No apps or sites were recorded in this range.')}
            </p>
          ) : (
            <Table
              columns={topColumns}
              rows={data.top}
              // Careful: an app and a site can share a name, so kind is part of the key
              rowKey={(item) => `${item.kind}-${item.key}`}
            />
          )}
        </Card>

        <Card title={t('By Staff')} padded={false}>
          {data.byEmployee.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-3">
              {t('No usage was recorded for anyone in this range.')}
            </p>
          ) : (
            <Table
              columns={employeeColumns}
              rows={data.byEmployee}
              rowKey={(row) => String(row.employeeId)}
            />
          )}
        </Card>
      </div>

      {/*
        Careful: do not remove this sentence. The denominator of "productive share" also
           includes unclassified time, so the number rises on its own as new category
           rules are added. Without the note, people would think the person's work had
           changed when only the rule list grew. It also will not match the
           `daily_summary` percentage exactly, which is not an error.
      */}
      <Caveat>
        {t(
          "Productive share = productive ÷ total tracked time, and the denominator includes uncategorized time too. The more category rules there are, the higher this number climbs — so do not be surprised if it does not match the dashboard's daily score exactly.",
        )}
      </Caveat>

      <MetaNote meta={data.meta} />
    </>
  );
}
