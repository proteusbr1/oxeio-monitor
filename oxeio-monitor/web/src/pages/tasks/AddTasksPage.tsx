import { useState } from 'react';
import { Trans } from 'react-i18next';

import {
  addTasks,
  distributeTasks,
  REJECT_TEXT,
  taskStats,
  type BulkResult,
  type RejectedLine,
} from '../../api/tasks';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button, Page } from '../../components/Page';
import { ErrorBox, Loading } from '../../components/States';
import { useAuth } from '../../auth/AuthContext';
import { Chip, Notice, ServerError, useMutation } from '../../components/ui';
import { Table } from '../../components/Table';
import { useT } from '../../i18n';
import { MAX_BULK_LINES, previewBulk } from './bulk';

/**
 * **Adding tasks**: "Add tasks" in the sidebar.
 *
 * Careful: the list is on a **separate page** (Task pool): adding and browsing
 * are two different jobs, and on one page every paste of 500 lines would also
 * load the list.
 *
 * Coordinators add tasks here; each morning they are handed out among the
 * people who receive tasks.
 *
 * Important: **the page is in the sidebar, not in Settings**: coordinators come
 * here **every day**, and Settings is a set-and-forget place.
 */
export function AddTasksPage() {
  const t = useT();
  const { user } = useAuth();
  const stats = useApi(taskStats, []);
  const submit = useMutation();
  const spread = useMutation();

  const [text, setText] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);

  const canDistribute = user?.role === 'owner' || user?.role === 'manager';
  const s = stats.data;
  /**
   * Read as it is typed: how many tasks the paste makes, before sending.
   * Careful: a preview only — the server answers for real (`BulkOutcome`).
   */
  const preview = previewBulk(text);

  return (
    <Page title={t('Add tasks')} subtitle={t('The work handed out to your team each day')}>
      <div className="space-y-3">
        <Card title={t('The Pipeline')} hint={t('From a new task to a published result')}>
          <div className="p-4">
            {stats.loading && !s && <Loading />}
            {stats.error && !s && <ErrorBox error={stats.error} retry={stats.reload} />}

            {s && (
              <>
                {/*
                  **The order is the point here.** Read left to right, the leak
                  shows up: 30 given → 25 done → 20 delivered → 12 published.
                */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Tile n={s.pool} label={t('In the pool')} tone="text-ink" />
                  <Tile n={s.assigned} label={t('In hand')} tone="text-data" />
                  <Tile n={s.done} label={t('Done', { context: 'list' })} tone="text-ink" />
                  <Tile n={s.delivered} label={t('Delivered', { context: 'list' })} tone="text-data" />
                  {/* The last step is the one that finishes the work, so it is green */}
                  <Tile n={s.published} label={t('Published', { context: 'list' })} tone="text-ok" />
                </div>

                {/*
                  **Two numbers, and they do not mean the same.**
                     `skipped` = the person chose not to do it (a human decision),
                     `deleted` = taken out of the work for good.
                  Careful: shown as one, someone seeing the number grow could not
                     tell whether the tasks or the people are the problem.
                  It sits outside the pipeline, because it is not a step: it is an exit.
                */}
                <div className="mt-3 text-[12px] text-ink-3">
                  <Trans
                    i18nKey="Dropped along the way: <n>{{skipped}}</n> skipped · <n>{{deleted}}</n> deleted"
                    values={{ skipped: s.skipped, deleted: s.deleted }}
                    components={{ n: <span className="num font-medium" /> }}
                  />
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title={t('Add Tasks')} hint={t('One per line — up to {{max}} at a time', { max: MAX_BULK_LINES })}>
          <div className="space-y-3 p-4">
            {/*
              The three line formats, spelled out: without them the first paste
                 is a guess, and a wrong guess comes back as a table of rejected lines.
            */}
            <Notice>
              <Trans
                i18nKey="Each line becomes one task. Write a <b>reference</b> on its own (<n>INV-2041</n>), a reference and a link separated by a bar (<n>INV-2041 | https://example.com/inv/2041</n>), or just a link — then the link is the reference too. <b>A reference already in the pool is skipped on its own</b>, so you never have to check first."
                components={{ b: <b />, n: <span className="num" /> }}
              />
            </Notice>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={8}
              aria-label={t('Tasks, one per line')}
              placeholder={'INV-2041\nINV-2042 | https://example.com/inv/2042\nhttps://example.com/tickets/88'}
              className="num w-full rounded-lg border border-line bg-paper p-3 text-[12.5px] text-ink"
            />

            {/*
              Careful: the count says what will happen **before** pressing: a
                 paste of 600 lines is refused whole by the server, and it is
                 better to learn that here than after the wait.
            */}
            {preview.lines > 0 && (
              <div className="text-[12px] text-ink-3" role="status">
                <Trans
                  i18nKey="<n>{{count}}</n> tasks ready"
                  count={preview.ready}
                  components={{ n: <span className="num font-medium text-ink-2" /> }}
                />
                {preview.rejected.length > 0 && (
                  <>
                    {' · '}
                    <Trans
                      i18nKey="<n>{{count}}</n> lines need a look (listed after adding)"
                      count={preview.rejected.length}
                      components={{ n: <span className="num font-medium text-idle-ink" /> }}
                    />
                  </>
                )}
              </div>
            )}

            {preview.overLimit && (
              <Notice tone="attention">
                <Trans
                  i18nKey="That is <n>{{lines}}</n> lines — at most <n>{{max}}</n> go in at a time. Split the list and add it in parts."
                  values={{ lines: preview.lines, max: MAX_BULK_LINES }}
                  components={{ n: <span className="num" /> }}
                />
              </Notice>
            )}

            <ServerError error={submit.error ?? spread.error} />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                tone="primary"
                disabled={submit.busy || preview.lines === 0 || preview.overLimit}
                onClick={() =>
                  submit.run(async () => {
                    const res = await addTasks(text);
                    setResult(res);
                    // Careful: the box is cleared **only on success**; otherwise a
                    //    network failure would lose the 500 lines
                    setText('');
                    stats.reload();
                  })
                }
              >
                {submit.busy ? t('Adding…') : t('Add to pool')}
              </Button>

              {/*
                Careful: owner/manager only: once distribution has happened it cannot be
                   undone (task numbers get assigned), so the button is not for everyone.
              */}
              {canDistribute && (
                <Button
                  disabled={spread.busy}
                  onClick={() =>
                    spread.run(async () => {
                      await distributeTasks();
                      stats.reload();
                    })
                  }
                >
                  {spread.busy ? t('Handing out…') : t('Hand out now')}
                </Button>
              )}

              <span className="text-[12px] text-ink-3">
                {t('Tasks are handed out on their own at 8:00 every morning')}
              </span>
            </div>

            {result && <BulkOutcome result={result} />}
          </div>
        </Card>
      </div>
    </Page>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-3 py-2.5">
      <div className={`num text-[22px] font-semibold ${tone}`}>{n}</div>
      <div className="text-[11px] tracking-wide text-ink-3 uppercase">{label}</div>
    </div>
  );
}

/**
 * **The full account of what could not be taken.**
 *
 * Careful: if 6 of 500 are dropped, the person needs to know **which 6**:
 * line number, what was written, and the reason. Without it those six tasks
 * would be lost for good and nobody would realise anything was lost.
 */
function BulkOutcome({ result }: { result: BulkResult }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-ok/40 bg-ok-bg px-3 py-2.5 text-[13.5px] text-ok-ink">
        {/* Careful: "already existed" is not an error, but the count is not hidden either */}
        <Trans
          i18nKey="<n>{{added}}</n> added · <n>{{known}}</n> already known · <n>{{rejected}}</n> could not be used — pool is now <n>{{pool}}</n>"
          values={{
            added: result.added,
            known: result.alreadyKnown,
            rejected: result.rejectedTotal,
            pool: result.poolSize,
          }}
          components={{ n: <span className="num font-semibold" /> }}
        />
      </div>

      {/*
        Careful: the server sends at most 200 rejected lines, but **the count
           stays true**, and how many are not shown is also written; nothing is
           cut silently.
      */}
      {result.rejectedTotal > result.rejected.length && (
        <div className="text-[12px] text-ink-3">
          <Trans
            i18nKey="Showing the first <n>{{shown}}</n> of <n>{{total}}</n> — enough to see what went wrong."
            values={{ shown: result.rejected.length, total: result.rejectedTotal }}
            components={{ n: <span className="num" /> }}
          />
        </div>
      )}

      {result.rejected.length > 0 && <RejectedTable rows={result.rejected} />}
    </div>
  );
}

function RejectedTable({ rows }: { rows: RejectedLine[] }) {
  const t = useT();
  return (
    <Table
      rows={rows}
      rowKey={(r) => String(r.line)}
      columns={[
        {
          key: 'line',
          header: t('Line'),
          align: 'right',
          className: 'w-16',
          render: (r) => <span className="num text-ink-3">{r.line}</span>,
        },
        {
          key: 'text',
          header: t('What was pasted'),
          render: (r) => (
            // Careful: not `truncate`: the line must be fully visible, otherwise
            //    the person could not match which one it was
            <span className="num text-[12px] break-all text-ink-2">{r.text}</span>
          ),
        },
        {
          key: 'why',
          header: '',
          render: (r) => (
            // a fix is needed on the line itself → attention; a repeat → just pending
            <Chip tone={r.reason === 'bad_link' || r.reason === 'too_long' ? 'attention' : 'pending'}>
              {t(REJECT_TEXT[r.reason])}
            </Chip>
          ),
        },
      ]}
    />
  );
}
