import { useState } from 'react';

import { closeMonth, listMonthClosures, reopenMonth, type MonthClosureView } from '../../api/payroll';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Caveat, ErrorBox, Loading } from '../../components/States';
import { formatDate, formatMonth, workOffsetMs } from '../../lib/format';
import {
  ConfirmDialog,
  MiniButton,
  Modal,
  RowActions,
  ServerError,
  TextField,
  orUndefined,
  useMutation,
} from '../../components/ui';

/**
 * Closing a month. Owner-only (the route too, in `App.tsx`).
 *
 * Careful — why this screen is needed: closing a month is the only thing that
 * **freezes** the `monthly_summary` numbers. Without it, moving one holiday date
 * changes last month's d and D, and payroll reads from there, so the figures would
 * shift even after salaries were paid.
 *
 * Important: the list is **per month, not per closure record**. The server returns
 * only closed months, but the screen shows the last 12 months, each with its status.
 * The owner's question is not "which did I close" but **"which is still open"**, and
 * absence cannot answer that. Showing an empty list that suggests "all fine" is
 * forbidden in this project.
 */
export function MonthsTab() {
  const { data, error, loading, reload } = useApi(listMonthClosures, []);
  const mutation = useMutation();

  const [closing, setClosing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [reopening, setReopening] = useState<MonthClosureView | null>(null);

  if (loading && !data) return <Loading label="Loading months…" />;
  if (!data) return <ErrorBox error={error} retry={reload} />;

  const closed = new Map(data.rows.map((r) => [r.yearMonth, r]));
  const months = lastMonths(12);

  return (
    <>
      <ServerError error={mutation.error} />

      <Card
        title="Closing the Month"
        hint="Once closed, that month's hours and targets stop moving"
        padded={false}
      >
        <ul className="divide-y divide-line">
          {months.map((ym) => {
            const row = closed.get(ym);
            /**
             * Careful: the current month is shown separately. The server will not close
             *    it (the month is still running), so the button should not exist
             *    either; showing it and returning a 400 would send the user into a wall.
             */
            const isCurrent = ym === currentMonth();

            return (
              <li
                key={ym}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <span className="num min-w-24 text-[13px] font-medium">
                  {monthLabel(ym)}
                </span>

                <span className="min-w-0 flex-1 text-[12px] text-ink-3">
                  {row ? (
                    <>
                      <span className="text-ok-ink">Closed</span>{' '}
                      {formatDate(row.closedAt.slice(0, 10))} · {row.closedBy}
                      {row.note && (
                        <span className="block text-ink-2">{row.note}</span>
                      )}
                    </>
                  ) : isCurrent ? (
                    'Still running — can be closed once the month is over'
                  ) : (
                    'Open — figures can still move'
                  )}
                </span>

                <RowActions>
                  {row ? (
                    <MiniButton tone="danger" onClick={() => setReopening(row)}>
                      Reopen
                    </MiniButton>
                  ) : (
                    !isCurrent && (
                      <MiniButton
                        onClick={() => {
                          setNote('');
                          setClosing(ym);
                        }}
                      >
                        Close
                      </MiniButton>
                    )
                  )}
                </RowActions>
              </li>
            );
          })}
        </ul>

        {/*
          Careful: this explanation must stay, or the word "close" suggests that data
             is deleted or the screen is closing.
        */}
        <Caveat>
          Closing a month freezes its totals: the daily rollup stops
          recalculating it, and time corrections for those dates are refused.
          Screenshots, reports and everything else stay exactly as they are.
          Payroll reads the frozen numbers, so a holiday edited later can no
          longer change a month you have already paid.
        </Caveat>
      </Card>

      {closing && (
        <Modal title={`Close ${monthLabel(closing)}`} onClose={() => setClosing(null)}>
          <p className="text-[13px] text-ink-2">
            After this, {monthLabel(closing)} stops recalculating and time
            corrections for those dates are refused. You can reopen it later —
            both actions are recorded in the audit log.
          </p>

          <div className="mt-3">
            <TextField
              label="Note (optional)"
              value={note}
              onChange={setNote}
              placeholder="Paid on 3 September"
            />
          </div>

          <RowActions>
            <MiniButton onClick={() => setClosing(null)}>Cancel</MiniButton>
            <MiniButton
              disabled={mutation.busy}
              onClick={() =>
                mutation.run(async () => {
                  await closeMonth(closing, orUndefined(note));
                  setClosing(null);
                  reload();
                })
              }
            >
              Close the month
            </MiniButton>
          </RowActions>
        </Modal>
      )}

      {/*
        Careful: confirmation for reopening, because this is the only path that can
           move the **basis of already-paid salaries** again. Reopening is heavier than
           closing, so the button is `danger` too.
      */}
      {reopening && (
        <ConfirmDialog
          title={`Reopen ${monthLabel(reopening.yearMonth)}?`}
          intro={
            <>
              Closed on {formatDate(reopening.closedAt.slice(0, 10))} by{' '}
              {reopening.closedBy}. Both the closing and this reopening stay in
              the audit log.
            </>
          }
          warning="Its figures can move again — a holiday edit or a time correction will recalculate them. If this month has already been paid, the numbers behind that payment can change."
          confirmLabel="Reopen"
          busy={mutation.busy}
          error={mutation.error}
          onClose={() => setReopening(null)}
          onConfirm={() =>
            mutation.run(async () => {
              await reopenMonth(reopening.yearMonth);
              setReopening(null);
              reload();
            })
          }
        />
      )}
    </>
  );
}

/** The current month in the work zone, as `YYYY-MM` */
function currentMonth(): string {
  return workNow().slice(0, 7);
}

/**
 * The last `n` months, newest first, including the current month.
 *
 * Careful: uses the work-zone date, not the browser's. Otherwise someone in another
 *    timezone opening the screen near midnight would see the list a month off.
 */
function lastMonths(n: number): string[] {
  const [y, m] = workNow().slice(0, 7).split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Careful: the work zone has a fixed offset; this keeps the same day as the server */
function workNow(): string {
  return new Date(Date.now() + workOffsetMs()).toISOString();
}

/** `2026-08` → `August 2026` — through lib/format, so DISPLAY_LOCALE applies */
function monthLabel(yearMonth: string): string {
  return formatMonth(yearMonth);
}
