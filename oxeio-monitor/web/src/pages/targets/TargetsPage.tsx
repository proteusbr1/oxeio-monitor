import { useState } from 'react';

import {
  addTargets,
  distributeTargets,
  REJECT_TEXT,
  targetStats,
  type BulkResult,
} from '../../api/targets';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button, Page } from '../../components/Page';
import { ErrorBox, Loading } from '../../components/States';
import { useAuth } from '../../auth/AuthContext';
import { Chip, Notice, ServerError, useMutation } from '../../components/ui';
import { Table } from '../../components/Table';

/**
 * **Submitting design targets**: "Add Design Targets" in the sidebar.
 *
 * Careful: the list is on a **separate page** (owner's decision): submitting
 * and browsing are two different jobs, and on one page every paste of 500 lines
 * would also load the list.
 *
 * Researchers submit about 500 Amazon URLs a day; at 8 am they are randomly
 * distributed among the designers.
 *
 * Important: **the page is in the sidebar, not in Settings** (owner's
 * decision): researchers will come here **every day**, and Settings is a
 * set-and-forget place. For the same reason Deposits is in the sidebar too (09 § 3).
 */
export function TargetsPage() {
  const { user } = useAuth();
  const stats = useApi(targetStats, []);
  const submit = useMutation();
  const spread = useMutation();

  const [text, setText] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);

  const canDistribute = user?.role === 'owner' || user?.role === 'manager';
  const s = stats.data;

  return (
    <Page
      title="Add design targets"
      subtitle="Amazon links the designers will work from"
    >
      <div className="space-y-3">
        <Card
          title="The Pipeline"
          hint="From collected link to a product that sells"
        >
          <div className="p-4">
            {stats.loading && !s && <Loading />}
            {stats.error && !s && <ErrorBox error={stats.error} retry={stats.reload} />}

            {s && (
              <>
                {/*
                  **The order is the point here.** The four tiles used to sit
                  side by side, so you could not see which way the work moves.
                  Now, read left to right, the leak shows up:
                  30 given → 25 designed → 20 uploaded → 12 live.
                */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Tile n={s.pool} label="In the pool" tone="text-ink" />
                  <Tile n={s.assigned} label="In hand" tone="text-data" />
                  <Tile n={s.done} label="Designed" tone="text-ink" />
                  <Tile n={s.uploaded} label="Uploaded" tone="text-data" />
                  {/* The last step is the only one that brings in money, so it is green */}
                  <Tile n={s.live} label="Live on Amazon" tone="text-ok" />
                </div>

                {/*
                  Careful: "dropped" is not hidden: if the number keeps growing
                     it shows the quality of sourcing is falling, and that needs to be known.
                  It sits outside the pipeline, though, because it is not a step: it is an exit.
                */}
                {/*
                  **Two numbers, and they do not mean the same.**
                     `skipped` = the designer chose not to do it (a human decision),
                     `deleted` = the page does not exist on Amazon (a fact of the world).
                  Careful: shown as one, someone seeing the number grow could not tell
                     whose fault it is: sourcing or the designer. And the second
                     is the only measure of how stale the researcher's list is.
                */}
                <div className="mt-3 text-[12px] text-ink-3">
                  Dropped along the way:{' '}
                  <span className="num font-medium">{s.skipped}</span> skipped ·{' '}
                  <span className="num font-medium">{s.deleted}</span> gone from
                  Amazon
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="Add Links" hint="One per line — paste as many as you like">
          <div className="space-y-3 p-4">
            <Notice>
              Paste them however they come — <span className="num">/dp/</span>,{' '}
              <span className="num">/gp/product/</span>,{' '}
              <span className="num">.co.uk</span>, even a bare ASIN.{' '}
              <b>The same product twice is dropped on its own</b>, so you never
              have to check first.
            </Notice>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder="https://www.amazon.com/dp/B0DJBD22LW"
              className="num w-full rounded-lg border border-line bg-paper p-3 text-[12.5px] text-ink"
            />

            <ServerError error={submit.error ?? spread.error} />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                tone="primary"
                disabled={submit.busy || text.trim().length === 0}
                onClick={() =>
                  submit.run(async () => {
                    const res = await addTargets(text);
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
                   undone (job numbers get assigned), so the button is not for everyone.
              */}
              {canDistribute && (
                <Button
                  disabled={spread.busy}
                  onClick={() =>
                    spread.run(async () => {
                      await distributeTargets();
                      stats.reload();
                    })
                  }
                >
                  {spread.busy ? 'Distributing…' : 'Distribute now'}
                </Button>
              )}

              <span className="text-[12px] text-ink-3">
                Distribution runs on its own at 8:00 every morning
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
 * Careful: if 6 of 500 are dropped, the researcher needs to know **which 6**:
 * line number, what was written, and the reason. Without it those six links
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
        Careful: since the cap was raised, pasting 45,000 lines is possible. Pasting
        the wrong file would reject all of them, and drawing the whole list would
        freeze the browser. So the server sends 200, but **the count stays true**,
        and how many are not shown is also written; nothing is cut silently.
      */}
      {result.rejectedTotal > result.rejected.length && (
        <div className="text-[12px] text-ink-3">
          Showing the first{' '}
          <span className="num">{result.rejected.length}</span> of{' '}
          <span className="num">{result.rejectedTotal}</span> — enough to see
          what went wrong.
        </div>
      )}

      {result.rejected.length > 0 && (
        <Table
          rows={result.rejected}
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
                // Careful: not `truncate`: the link must be fully visible, otherwise
                //    the researcher could not match which one it was
                <span className="num break-all text-[12px] text-ink-2">{r.text}</span>
              ),
            },
            {
              key: 'why',
              header: '',
              render: (r) => (
                <Chip tone={r.reason === 'not_amazon' ? 'attention' : 'pending'}>
                  {REJECT_TEXT[r.reason]}
                </Chip>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
