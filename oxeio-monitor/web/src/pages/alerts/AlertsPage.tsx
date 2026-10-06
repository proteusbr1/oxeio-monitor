import { useState } from 'react';

import {
  acknowledgeAlert,
  acknowledgeAllAlerts,
  ALERT_SEVERITY_LABEL,
  ALERT_TYPE_LABEL,
  listAlerts,
  type AlertRow,
  type AlertType,
} from '../../api/alerts';
import { getOpsHealth, runBackupNow, runRetentionNow } from '../../api/ops';
import { usePolling, useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
import { ApiError } from '../../api/client';
import { Card, Stat, StatRow } from '../../components/Card';
import { Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table } from '../../components/Table';
import { formatAgo, formatDateTime } from '../../lib/format';
import { Chip, MiniButton, Notice, ServerError, useMutation } from '../../components/ui';

/**
 * G01-G07, K04: alerts and server health.
 *
 * Careful: `api/alerts.ts` was written long ago (types, labels, filters,
 * `openCount`, everything), but no page used it. So the server raised alerts
 * according to the rules and even sent emails, yet the owner could not see a
 * single one on the dashboard. If an email was missed, the incident was lost
 * for good.
 *
 * The health sits on the same page, not elsewhere: if the answer to "is anything
 * broken?" were split across two places, people would open neither.
 */
export function AlertsPage() {
  const { user } = useAuth();
  const [showAll, setShowAll] = useState(false);

  /**
   * Careful: polling, not a one-shot `useApi`; this page is left open (on a second
   * monitor during an incident). `usePolling` stops by itself in a hidden tab, so
   * even if left open all night it does not storm the server.
   */
  const alerts = usePolling(
    (signal) => listAlerts({ status: showAll ? 'all' : 'open' }, signal),
    30_000,
    [showAll],
  );

  const health = useApi((signal) => getOpsHealth(signal), []);
  const ackAll = useMutation();

  if (user?.role !== 'owner') {
    return (
      <Page title="Alerts">
        <ErrorBox error={new ApiError(403, "You don't have access")} />
      </Page>
    );
  }

  const rows = alerts.data?.rows ?? [];

  return (
    <Page
      title="Alerts"
      subtitle={
        alerts.data
          ? `${alerts.data.openCount} still open`
          : 'What the server noticed on its own'
      }
      actions={
        <MiniButton onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only open' : 'Show all'}
        </MiniButton>
      }
    >
      <div className="space-y-4">
        <HealthCard
          data={health.data}
          loading={health.loading}
          error={health.error}
          reload={health.reload}
        />

        <Card
          title={showAll ? 'All Alerts' : 'Open Alerts'}
          hint="Nothing is ever deleted — acknowledging just marks it seen"
          padded={false}
          actions={
            /*
             * "Seen all": mark every open alert as seen with one click.
             * When G01 ("agent silent") fires repeatedly across 12 PCs, 118 warnings pile up,
             * and pressing them one by one is torture.
             *
             * Careful: shown only when something is open (`openCount > 0`). When all are
             * seen the button is not rendered; a disabled button in the "nothing here" state
             * would confuse.
             *
             * Careful: a confirm prompt: this touches many rows at once, so a wrong click
             * must not mark the whole list seen silently.
             */
            (alerts.data?.openCount ?? 0) > 0 ? (
              <MiniButton
                disabled={ackAll.busy}
                onClick={() =>
                  ackAll.run(async () => {
                    const n = alerts.data?.openCount ?? 0;
                    if (!window.confirm(`Mark all ${n} open alerts as seen?`)) {
                      return;
                    }
                    await acknowledgeAllAlerts();
                    alerts.reload();
                  })
                }
              >
                {ackAll.busy ? 'Marking…' : 'Seen all'}
              </MiniButton>
            ) : undefined
          }
        >
          {alerts.loading && !alerts.data && <Loading />}
          {alerts.error && (
            <ErrorBox error={alerts.error} retry={alerts.reload} />
          )}
          {alerts.data && rows.length === 0 && (
            <Empty
              title={showAll ? 'No alerts at all' : 'Nothing open'}
              hint={
                showAll
                  ? 'The server has not raised a single alert yet.'
                  : 'Everything raised so far has been acknowledged.'
              }
            />
          )}
          {rows.length > 0 && (
            <AlertTable rows={rows} onChanged={alerts.reload} />
          )}
        </Card>
      </div>
    </Page>
  );
}

function AlertTable({
  rows,
  onChanged,
}: {
  rows: AlertRow[];
  onChanged: () => void;
}) {
  const { busy, error, run } = useMutation();

  return (
    <>
      <ServerError error={error} />
      <Table
        rows={rows}
        rowKey={(r) => r.id}
        // Careful: rows that were acknowledged, or closed by the server itself, are
        // dimmed but stay: the history is later the evidence for hour corrections
        // (ADR-011e)
        rowMuted={(r) => r.acknowledgedAt !== null || r.resolvedAt !== null}
        columns={[
          {
            key: 'severity',
            header: '',
            render: (r) => (
              <Chip
                tone={
                  r.severity === 'critical'
                    ? 'attention'
                    : r.severity === 'warning'
                      ? 'pending'
                      : 'muted'
                }
              >
                {ALERT_SEVERITY_LABEL[r.severity] ?? r.severity}
              </Chip>
            ),
          },
          {
            key: 'what',
            header: 'What',
            render: (r) => (
              <div className="min-w-0">
                <div className="font-medium">
                  {ALERT_TYPE_LABEL[r.type as AlertType] ?? r.type}
                </div>
                {/* The title carries the name/hostname: that is the useful information */}
                <div className="text-[12.5px] text-ink-2">{r.title}</div>
                {r.detail && (
                  <div className="mt-0.5 max-w-prose text-[12px] text-ink-3">
                    {r.detail}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'when',
            header: 'When',
            render: (r) => (
              <span
                className="num text-[12.5px] text-ink-3"
                title={formatDateTime(r.createdAt)}
              >
                {formatAgo(r.createdAt)}
              </span>
            ),
          },
          {
            key: 'sent',
            header: 'Sent',
            render: (r) =>
              r.channelsSent.length > 0 ? (
                <span className="text-[12px] text-ink-3">
                  {r.channelsSent.join(', ')}
                </span>
              ) : (
                // Careful: "went nowhere" and "email sent" are different, and the difference
                // matters: when SMTP is down, this column is the only clue
                <span className="text-[12px] text-ink-3">—</span>
              ),
          },
          {
            key: 'ack',
            header: '',
            align: 'right',
            render: (r) =>
              r.acknowledgedAt ? (
                <span className="text-[12px] text-ink-3">
                  Seen{r.acknowledgedBy ? ` by ${r.acknowledgedBy}` : ''}
                </span>
              ) : r.resolvedAt ? (
                /*
                 * Closed by the server itself (the agent came back): no button, because there is
                 * nothing to "see". The row stays in history (under Show all) but does not count
                 * as open.
                 */
                <span
                  className="text-[12px] text-ink-3"
                  title={`Resolved on its own — ${formatDateTime(r.resolvedAt)}`}
                >
                  Resolved
                </span>
              ) : (
                <MiniButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await acknowledgeAlert(r.id);
                      onChanged();
                    })
                  }
                >
                  Seen
                </MiniButton>
              ),
          },
        ]}
      />
    </>
  );
}

/**
 * Health goes on top, small: an alert is an event, health is a state. Mixing them
 * in one list would make "what is broken right now" hard to answer.
 */
function HealthCard({
  data,
  loading,
  error,
  reload,
}: {
  data: import('../../api/ops').OpsHealth | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}) {
  const jobs = useMutation();
  const [ran, setRan] = useState<string | null>(null);
  // no screenshot module, no screenshot cleanup button (the nightly job still
  // clears the pictures taken before it was switched off)
  const { features } = useFeatures();

  return (
    <Card
      title="Server Health"
      hint={data ? `Checked ${formatAgo(data.checkedAt)}` : undefined}
      actions={
        <div className="flex gap-2">
          {/*
            Both buttons are for "seeing with your own eyes": a backup that has never
            been tested is not a backup, it is a guess. The same reasoning applies to
            retention: staff are told on My data how many days screenshots are kept
            (the number set in Settings → Privacy).
          */}
          <MiniButton
            disabled={jobs.busy}
            onClick={() =>
              jobs.run(async () => {
                const r = await runBackupNow();
                setRan(
                  r.ok
                    ? `Backup done${r.fileName ? ` — ${r.fileName}` : ''}`
                    : `Backup failed — ${r.error ?? r.skipped ?? 'unknown'}`,
                );
                reload();
              })
            }
          >
            Back up now
          </MiniButton>
          {features.screenshots && (
            <MiniButton
              disabled={jobs.busy}
              title="Deletes the screenshots older than the retention period set in Settings → Privacy — the same as the nightly cleanup"
              onClick={() =>
                jobs.run(async () => {
                  const r = await runRetentionNow();
                  setRan(
                    r.skipped
                      ? 'A cleanup was already running'
                      : `Cleanup done — ${r.rowsDeleted} old screenshots removed`,
                  );
                  reload();
                })
              }
            >
              Delete old screenshots
            </MiniButton>
          )}
        </div>
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} retry={reload} />}
      <ServerError error={jobs.error} />
      {ran && <Notice>{ran}</Notice>}

      {data && (
        <div className="space-y-3">
          {data.problems.length > 0 && (
            <Notice tone="attention">
              {data.problems.join(' · ')}
            </Notice>
          )}

          <StatRow>
            <Stat
              label="Status"
              value={data.status === 'ok' ? 'Healthy' : data.status === 'degraded' ? 'Degraded' : 'Down'}
              tone={data.status === 'ok' ? 'counted' : 'attention'}
            />
            <Stat
              label="Disk used"
              value={data.disk.usedPct === null ? '—' : `${Math.round(data.disk.usedPct)}%`}
              unit={data.disk.free ? `${data.disk.free} free` : undefined}
              tone={
                data.disk.usedPct !== null && data.disk.usedPct >= 85
                  ? 'attention'
                  : 'counted'
              }
            />
            <Stat
              label="Last backup"
              value={
                // BACKUP_MODE=external — not this server's to report
                data.backup.mode === 'external'
                  ? 'External'
                  : data.backup.lastSuccessAt
                    ? formatAgo(data.backup.lastSuccessAt)
                    : 'Never'
              }
              tone={data.backup.problem ? 'attention' : 'counted'}
            />
            <Stat
              label="Agents quiet"
              value={data.devices.silent}
              unit={`of ${data.devices.active}`}
              // Careful: not red: everyone being silent at night is normal, and it does not
              // make the status bad either (a server rule)
              tone={data.devices.silent > 0 ? 'muted' : 'counted'}
            />
          </StatRow>
        </div>
      )}
    </Card>
  );
}
