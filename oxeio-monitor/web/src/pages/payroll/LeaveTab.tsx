import { useState } from 'react';

import { createLeave, deleteLeave, listLeaves, type LeaveView } from '../../api/payroll';
import { listEmployees } from '../../api/staff';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { formatDate } from '../../lib/format';
import {
  ConfirmDialog,
  FormGrid,
  FullWidth,
  MiniButton,
  Modal,
  Notice,
  RowActions,
  SelectField,
  ServerError,
  TextField,
  orUndefined,
  useMutation,
} from '../../components/ui';

/** All three are paid leave; see the `schema.prisma` note on why there is no `unpaid` */
const TYPES = [
  { value: 'casual', label: 'Casual' },
  { value: 'sick', label: 'Sick' },
  { value: 'annual', label: 'Annual' },
] as const;

/**
 * Leave ledger.
 *
 * Careful — the problem this fixes: without a leave ledger the system could not tell
 * absence from leave. Someone on approved leave had those days counted as a full
 * eight-hour shortfall in the month's pace, so the number claimed a failure in
 * their name that never happened.
 *
 * Important: **leave is paid.** The day's eight hours drop out of the target, but
 * the payroll fraction `d ÷ D` is **unchanged**. This split is guarded in three
 * places in the code, and the note below is also shown on screen, or someone
 * entering leave might think pay is being cut.
 */
/** Leave for one month — the month is picked on the Payroll page */
export function LeaveTab({ month }: { month: string }) {

  const { data, error, loading, reload } = useApi(
    (signal) => listLeaves(month, signal),
    [month],
  );
  const staff = useApi(
    (signal) => listEmployees({ status: 'active' }, signal),
    [],
  );
  const mutation = useMutation();

  const [adding, setAdding] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [removing, setRemoving] = useState<LeaveView | null>(null);

  return (
    <>
      <ServerError error={mutation.error} />

      <Card
        title="Leave"
        hint="Days off that were agreed — not absences"
        padded={false}
        actions={
          <RowActions>
            <MiniButton
              disabled={!staff.data || staff.data.rows.length === 0}
              onClick={() => setAdding(true)}
            >
              Add leave
            </MiniButton>
          </RowActions>
        }
      >
        {loading && !data ? (
          <Loading label="Loading leave…" />
        ) : !data ? (
          <ErrorBox error={error} retry={reload} />
        ) : data.rows.length === 0 ? (
          <Empty
            title="No leave recorded for this month"
            hint="Anyone who was away on these dates counts as a full shortfall until it is written here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
              >
                <span className="num min-w-24 text-[13px] font-medium">
                  {formatDate(row.leaveDate)}
                </span>

                <span className="min-w-0 flex-1 text-[13px]">
                  {row.employeeName}
                  <span className="ml-2 text-[12px] text-ink-3">
                    {labelOf(row.type)}
                  </span>
                  {row.note && (
                    <span className="block text-[12px] text-ink-2">
                      {row.note}
                    </span>
                  )}
                  {/*
                    Careful: this line is the most important part of the screen. Leave
                       entered on a Friday or a public holiday reduces the target by
                       nothing, yet the row stays in the ledger. Without the note the
                       owner would assume that day was excused, with no way to check
                       it from the numbers.
                  */}
                  {!row.countsTowardTarget && (
                    <span className="block text-[12px] text-idle-ink">
                      Already a day off — this changes no target
                    </span>
                  )}
                </span>

                <RowActions>
                  <MiniButton tone="danger" onClick={() => setRemoving(row)}>
                    Remove
                  </MiniButton>
                </RowActions>
              </li>
            ))}
          </ul>
        )}

        <Caveat>
          Leave is paid. The hours target for those days is removed, so nobody
          shows a shortfall for being away — but the payroll fraction (days
          employed ÷ days in the month) does not change, so the salary is the
          same. A month that has been closed refuses new leave; reopen it first.
        </Caveat>
      </Card>

      {adding && staff.data && (
        <AddLeave
          skipped={skipped}
          staff={staff.data.rows.map((e) => ({
            value: String(e.id),
            label: `${e.fullName} (${e.empCode})`,
          }))}
          month={month}
          busy={mutation.busy}
          onClose={() => {
            setAdding(false);
            setSkipped([]);
          }}
          /**
           * Careful: `mutation.run` returns nothing, so `skipped` cannot come out of
           *    it. The skipped days are held here, and while there are any the modal
           *    **stays open**. Closing it would leave nowhere to answer "which days
           *    were not added".
           */
          onSubmit={(body) =>
            mutation.run(async () => {
              const result = await createLeave(body);
              setSkipped(result.skipped);
              if (result.skipped.length === 0) setAdding(false);
              reload();
            })
          }
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Remove this leave day?"
          intro={
            <>
              {formatDate(removing.leaveDate)} · {removing.employeeName}
            </>
          }
          warning={
            removing.countsTowardTarget
              ? "That day's target comes back, so the month will show it as a shortfall again unless it was worked."
              : 'That day was already a day off, so no target changes.'
          }
          confirmLabel="Remove"
          busy={mutation.busy}
          error={mutation.error}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            mutation.run(async () => {
              await deleteLeave(removing.id);
              setRemoving(null);
              reload();
            })
          }
        />
      )}
    </>
  );
}

function AddLeave({
  staff,
  month,
  busy,
  skipped,
  onClose,
  onSubmit,
}: {
  staff: { value: string; label: string }[];
  month: string;
  busy: boolean;
  /** Days that were not added because they were already in the ledger */
  skipped: string[];
  onClose: () => void;
  onSubmit: (body: {
    employeeId: number;
    from: string;
    to: string;
    type: string;
    note?: string;
  }) => void;
}) {
  const [employeeId, setEmployeeId] = useState(staff[0]?.value ?? '');
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(`${month}-01`);
  const [type, setType] = useState<string>('casual');
  const [note, setNote] = useState('');

  /**
   * Careful: the server returns 400 if the end date is before the start, but the
   *    button is already disabled before that; better to show it than to send
   *    users into a wall.
   */
  const backwards = from !== '' && to !== '' && to < from;

  return (
    <Modal title="Add leave" onClose={onClose}>
      {/*
        Careful: do not swallow `skipped` silently. Days already in the ledger are not
           added, and closing the modal with "added" would make the owner think the
           whole range went in.
      */}
      {skipped.length > 0 && (
        <Notice tone="attention">
          {skipped.length} day{skipped.length === 1 ? '' : 's'} already had
          leave and {skipped.length === 1 ? 'was' : 'were'} left alone:{' '}
          {skipped.map((d) => formatDate(d)).join(', ')}
        </Notice>
      )}

      <FormGrid>
        <FullWidth>
          <SelectField
            label="Staff"
            value={employeeId}
            onChange={setEmployeeId}
            options={staff}
            required
          />
        </FullWidth>

        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(v) => {
            setFrom(v);
            // A one-day leave is the most common, so the end date follows the start
            if (to === '' || to < v) setTo(v);
          }}
          required
        />

        <TextField label="To" type="date" value={to} onChange={setTo} required />

        <SelectField
          label="Type"
          value={type}
          onChange={setType}
          options={TYPES}
          hint="All three are paid"
        />

        <FullWidth>
          <TextField
            label="Note (optional)"
            value={note}
            onChange={setNote}
            placeholder="Family wedding"
            maxLength={280}
          />
        </FullWidth>
      </FormGrid>

      {backwards && (
        <Notice tone="attention">The end date is before the start date.</Notice>
      )}

      <RowActions>
        <MiniButton onClick={onClose}>Cancel</MiniButton>
        <MiniButton
          disabled={busy || employeeId === '' || from === '' || backwards}
          onClick={() => {
            onSubmit({
              employeeId: Number(employeeId),
              from,
              to,
              type,
              note: orUndefined(note),
            });
          }}
        >
          Add
        </MiniButton>
      </RowActions>
    </Modal>
  );
}

function labelOf(type: string): string {
  return TYPES.find((t) => t.value === type)?.label ?? type;
}
