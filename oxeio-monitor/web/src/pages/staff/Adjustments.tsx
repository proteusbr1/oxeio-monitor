import { useState } from 'react';

import {
  createAdjustment,
  listAdjustments,
  revokeAdjustment,
  CAUSE_LABELS,
  type AdjustmentCause,
  type AdjustmentView,
} from '../../api/adjustments';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import {
  formatDate,
  formatSignedDuration,
  todayInWorkZone,
} from '../../lib/format';
import {
  Chip,
  ConfirmDialog,
  Modal,
  MiniButton,
  Notice,
  SelectField,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';

/**
 * Hours adjustment.
 *
 * Important — why this is on the employee page and not in Settings: the question
 * comes up while looking at one particular day, "the agent was off that day, why
 * are their hours low". The answer should be on that same page; nobody would go
 * searching another screen.
 *
 * Careful: **staff read this themselves** (J08). So the reason texts are not
 * technical, and there is no "claim" button here: an adjustment is the owner's
 * decision, not a staff request (ADR-011d: there is no approval system).
 *
 * Careful: the list is **date-independent**. The rest of the page is about one day,
 * but adjustments are few and seeing them all together is useful. Filtering by day
 * would mean scrolling through 30 days to answer "was anything granted last month".
 */
export function Adjustments({
  employeeId,
  nonce,
}: {
  employeeId: number;
  nonce: number;
}) {
  const t = useT();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const { data, loading, error, reload } = useApi(
    (signal) => listAdjustments(employeeId, signal),
    [employeeId, nonce],
  );

  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<AdjustmentView | null>(null);

  const rows = data ?? [];
  const counted = rows.filter((r) => r.active);

  return (
    <Card
      title={t('Hour Corrections')}
      hint={t('Time given back when the system — not the person — lost the hours')}
      actions={
        isOwner ? (
          <Button onClick={() => setAdding(true)}>{t('Add correction')}</Button>
        ) : undefined
      }
    >
      {loading && <Loading />}
      {error && <ErrorBox error={error} retry={reload} />}

      {!loading && !error && rows.length === 0 && (
        <Empty
          title={t('No corrections')}
          hint={t('The recorded hours stand exactly as they were measured.')}
        />
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="space-y-2">
          {/*
            Careful: the total is at the top because "how much was given back in total"
               is the first question; nobody would count rows to find out.
            Careful: only **active** rows are counted; cancelled ones are excluded,
               just as in the server's calculation.
          */}
          {counted.length > 0 && (
            <p className="text-[13px] text-ink-2">
              <span className="num font-semibold">{formatSignedDuration(totalSec(counted))}</span>{' '}
              {t('counted in total, from {{count}} corrections', { count: counted.length })}
            </p>
          )}

          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                canRevoke={isOwner}
                onRevoke={() => setRevoking(row)}
              />
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <AddDialog
          employeeId={employeeId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            reload();
          }}
        />
      )}

      {revoking && (
        <RevokeDialog
          row={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}

function Row({
  row,
  canRevoke,
  onRevoke,
}: {
  row: AdjustmentView;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2.5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Careful: a signed number (+2:00 / -0:30): seeing "2:00" alone, nobody
               could tell whether hours were added or deducted, yet the difference
               is in their pay.
            Careful: when cancelled it is struck through and the colour is neutral;
               there must be no room to mistake it for a number still being counted.
          */}
          <span
            className={`num text-[15px] font-semibold ${
              row.active ? 'text-ink' : 'text-ink-3 line-through'
            }`}
          >
            {formatSignedDuration(row.deltaSec)}
          </span>

          <span className="num text-[13px] text-ink-2">
            {formatDate(row.workDate)}
          </span>

          <Chip>{CAUSE_LABELS[row.cause] ? t(CAUSE_LABELS[row.cause]) : row.cause}</Chip>

          {row.beyondEvidence && (
            <Chip tone="pending">{t('More than measured')}</Chip>
          )}

          {!row.active && <Chip tone="muted">{t('Revoked')}</Chip>}
        </div>

        {/* The reason is always shown; staff read this themselves (J08) */}
        <p className="max-w-prose text-[13px] text-ink-2">{row.reason}</p>

        <p className="text-[11.5px] text-ink-3">
          {t('Recorded by {{name}}', { name: row.createdBy })}
          {!row.active && row.revokedBy ? (
            <> · {t('revoked by {{name}}', { name: row.revokedBy })}{row.revokeReason ? ` — ${row.revokeReason}` : ''}</>
          ) : null}
        </p>
      </div>

      {canRevoke && row.active && (
        <MiniButton tone="danger" onClick={onRevoke}>
          {t('Revoke')}
        </MiniButton>
      )}
    </li>
  );
}

/**
 * Careful: input is **hours and minutes**, not seconds: someone typing 230 meaning
 * "2h 30m" would get about 4 minutes. The API takes seconds; the conversion is here.
 */
function AddDialog({
  employeeId,
  onClose,
  onDone,
}: {
  employeeId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  const [workDate, setWorkDate] = useState(todayInWorkZone());
  const [sign, setSign] = useState<'plus' | 'minus'>('plus');
  const [hours, setHours] = useState('2');
  const [minutes, setMinutes] = useState('0');
  const [cause, setCause] = useState<AdjustmentCause>('agent_down');
  const [reason, setReason] = useState('');

  const seconds =
    (Math.max(0, Number(hours) || 0) * 3600 +
      Math.max(0, Number(minutes) || 0) * 60) *
    (sign === 'minus' ? -1 : 1);

  const tooLong = Math.abs(seconds) > 24 * 3600;
  const ready = seconds !== 0 && reason.trim().length >= 3 && !tooLong;

  return (
    <Modal
      title={t('Add hour correction')}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            tone="primary"
            disabled={busy || !ready}
            onClick={() =>
              run(async () => {
                await createAdjustment(employeeId, {
                  workDate,
                  deltaSec: seconds,
                  cause,
                  reason: reason.trim(),
                });
                onDone();
              })
            }
          >
            {t('Add correction')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Notice tone="info">
          {t('This does not change what was measured — the raw activity stays exactly as recorded. The correction is stored beside it, with your name and reason, and the staff member can see both.')}
        </Notice>

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('Day')}
            type="date"
            value={workDate}
            onChange={setWorkDate}
            max={todayInWorkZone()}
          />

          <SelectField
            label={t('Direction')}
            value={sign}
            onChange={(v) => setSign(v as 'plus' | 'minus')}
            options={[
              { value: 'plus', label: t('Give hours back') },
              { value: 'minus', label: t('Take hours off') },
            ]}
          />

          <TextField
            label={t('Hours')}
            type="number"
            value={hours}
            onChange={setHours}
            min="0"
            max="24"
          />

          <TextField
            label={t('Minutes')}
            type="number"
            value={minutes}
            onChange={setMinutes}
            min="0"
            max="59"
          />
        </div>

        <SelectField
          label={t('What happened')}
          value={cause}
          onChange={(v) => setCause(v as AdjustmentCause)}
          options={Object.entries(CAUSE_LABELS).map(([value, label]) => ({
            value,
            label: t(label),
          }))}
        />

        <TextField
          label={t('Reason')}
          value={reason}
          onChange={setReason}
          hint={t('The staff member reads this — write it for them, not for the log')}
        />

        {tooLong && (
          <Notice tone="attention">
            {t('A single day cannot be corrected by more than 24 hours.')}
          </Notice>
        )}

        <ServerError error={error} />
      </div>
    </Modal>
  );
}

function RevokeDialog({
  row,
  onClose,
  onDone,
}: {
  row: AdjustmentView;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  return (
    <ConfirmDialog
      title={t('Revoke {{amount}} on {{date}}?', {
        amount: formatSignedDuration(row.deltaSec),
        date: formatDate(row.workDate),
      })}
      intro={t('The correction stops counting from now on. It is not deleted — the record, your reason and the original one all stay.')}
      confirmLabel={t('Revoke')}
      withReason
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={(reason) =>
        run(async () => {
          await revokeAdjustment(row.id, reason);
          onDone();
        })
      }
    />
  );
}

function totalSec(rows: AdjustmentView[]): number {
  return rows.reduce((sum, r) => sum + r.deltaSec, 0);
}

/**
 * Careful: `signed()` used to be written here and is now in `lib/format.ts`
 * (`formatSignedDuration`). That file's own doc says "do not write a separate
 * format on your own page", and this was the only place that broke the rule.
 *
 * Important: moving it exposed a real bug: with the old calculation an adjustment of
 * 3598 seconds showed `+0:60` (the minutes round up to 60 and were never carried
 * into hours). `formatDuration()` already handled that trap; the copied code did
 * not.
 */
