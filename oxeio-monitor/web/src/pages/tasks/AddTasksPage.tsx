import { useState } from 'react';

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
    <Page title="Add tasks" subtitle="The work handed out to your team each day">
      <div className="space-y-3">
        <Card title="The Pipeline" hint="From a new task to a published result">
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
                  <Tile n={s.pool} label="In the pool" tone="text-ink" />
                  <Tile n={s.assigned} label="In hand" tone="text-data" />
                  <Tile n={s.done} label="Done" tone="text-ink" />
                  <Tile n={s.delivered} label="Delivered" tone="text-data" />
                  {/* The last step is the one that finishes the work, so it is green */}
                  <Tile n={s.published} label="Published" tone="text-ok" />
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
                  Dropped along the way:{' '}
                  <span className="num font-medium">{s.skipped}</span> skipped ·{' '}
                  <span className="num font-medium">{s.deleted}</span> deleted
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="Add Tasks" hint={`One per line — up to ${MAX_BULK_LINES} at a time`}>
          <div className="space-y-3 p-4">
            {/*
              The three line formats, spelled out: without them the first paste
                 is a guess, and a wrong guess comes back as a table of rejected lines.
            */}
            <Notice>
              Each line becomes one task. Write a <b>reference</b> on its own
              (<span className="num">INV-2041</span>), a reference and a link
              separated by a bar (
              <span className="num">INV-2041 | https://example.com/inv/2041</span>
              ), or just a link — then the link is the reference too.{' '}
              <b>A reference already in the pool is skipped on its own</b>, so you
              never have to check first.
            </Notice>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={8}
              aria-label="Tasks, one per line"
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
                <span className="num font-medium text-ink-2">{preview.ready}</span>{' '}
                {preview.ready === 1 ? 'task' : 'tasks'} ready
                {preview.rejected.length > 0 && (
                  <>
                    {' · '}
                    <span className="num font-medium text-idle-ink">
                      {preview.rejected.length}
                    </span>{' '}
                    {preview.rejected.length === 1 ? 'line needs' : 'lines need'} a
                    look (listed after adding)
                  </>
                )}
              </div>
            )}

            {preview.overLimit && (
              <Notice tone="attention">
                That is <span className="num">{preview.lines}</span> lines — at most{' '}
                <span className="num">{MAX_BULK_LINES}</span> go in at a time. Split
                the list and add it in parts.
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
                {submit.busy ? 'Adding…' : 'Add to pool'}
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
                  {spread.busy ? 'Handing out…' : 'Hand out now'}
                </Button>
              )}

              <span className="text-[12px] text-ink-3">
                Tasks are handed out on their own at 8:00 every morning
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
        <span className="num font-semibold">{result.added}</span> added ·{' '}
        {/* Careful: "already existed" is not an error, but the count is not hidden either */}
        <span className="num font-semibold">{result.alreadyKnown}</span> already
        known · <span className="num font-semibold">{result.rejectedTotal}</span>{' '}
        could not be used — pool is now{' '}
        <span className="num font-semibold">{result.poolSize}</span>
      </div>

      {/*
        Careful: the server sends at most 200 rejected lines, but **the count
           stays true**, and how many are not shown is also written; nothing is
           cut silently.
      */}
      {result.rejectedTotal > result.rejected.length && (
        <div className="text-[12px] text-ink-3">
          Showing the first <span className="num">{result.rejected.length}</span> of{' '}
          <span className="num">{result.rejectedTotal}</span> — enough to see what
          went wrong.
        </div>
      )}

      {result.rejected.length > 0 && <RejectedTable rows={result.rejected} />}
    </div>
  );
}

function RejectedTable({ rows }: { rows: RejectedLine[] }) {
  return (
    <Table
      rows={rows}
      rowKey={(r) => String(r.line)}
      columns={[
        {
          key: 'line',
          header: 'Line',
          align: 'right',
          className: 'w-16',
          render: (r) => <span className="num text-ink-3">{r.line}</span>,
        },
        {
          key: 'text',
          header: 'What was pasted',
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
              {REJECT_TEXT[r.reason]}
            </Chip>
          ),
        },
      ]}
    />
  );
}
