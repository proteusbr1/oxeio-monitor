import { useState } from 'react';

import { listAuditLog, type AuditLogRow } from '../../api/audit';
import { type Role } from '../../api/staff';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { DateRange } from '../../components/DatePicker';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import {
  formatCount,
  formatDateShort,
  formatDateTime,
  formatTime,
  monthStartOf,
  todayInDhaka,
  workDateOf,
  workOffsetIso,
} from '../../lib/format';
import { Chip, FilterChip, MiniButton, Notice } from '../../components/ui';

/**
 * Audit log viewer (owner-only).
 *
 * Important: the real job of this screen is answering one question: **who looked at
 *    whose screenshots.** A surveillance tool needs some watching of that
 *    surveillance too, or "has anyone viewed my pictures?" would have no answer. So
 *    it is a one-click filter, not hidden in a dropdown.
 *
 * Careful: the log is read-only; the server has no path to write, delete or edit
 *    it. A log that can be changed is no longer evidence.
 */

/** Careful: the `action` values the server really writes, taken from the source, not guessed */
const ACTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All events' },
  { value: 'view_screenshot', label: 'Screenshot viewed' },
  { value: 'payroll_view', label: 'Salary viewed' },
  { value: 'change_setting', label: 'Setting changed' },
  /**
   * **Un-finishing a finished design.**
   *
   * Careful: kept near the top of the list on purpose. It is the only action that
   * **erases its own trace** (`completed_at` and `completed_by_id` both become
   * `null`), so the log is the only place to see it.
   */
  { value: 'design_undone', label: 'Design un-completed' },
  { value: 'revoke_device', label: 'Device revoked' },
  { value: 'create_enrollment_code', label: 'Enrolment code' },
  { value: 'export_report', label: 'Report exported' },
  { value: 'create_portal_account', label: 'Portal account' },
  { value: 'reset_password', label: 'Password reset' },
  { value: 'change_password', label: 'Password changed' },
  { value: 'login', label: 'Sign-in' },
  { value: 'login_failed', label: 'Failed sign-in' },
];

const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  ACTIONS.filter((a) => a.value !== '').map((a) => [a.value, a.label]),
);

/**
 * Careful: `Record<Role, ...>`, **not** `Record<string, ...>`.
 *
 * When `researcher` was added to `UserRole`, the map in `Layout.tsx` was fixed but
 * **this one was missed**, because with `string` the compiler said nothing. Result:
 * the raw word `researcher` appeared in the researcher's rows of the audit log.
 * Now, if the enum grows, this line errors.
 */
const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  researcher: 'Researcher',
  employee: 'Staff',
};

const PAGE_SIZE = 50;

/**
 * Careful: `from`/`to` here are **instants**, not plain dates (`@IsISO8601()`). The
 *    Dhaka offset is added explicitly: `?from=2026-08-10` would be read by the
 *    server as UTC midnight, so events before 6am Dhaka time would fall on the
 *    previous day, and who looked at what in the early morning could not be found.
 */
function dayStart(date: string): string {
  return `${date}T00:00:00.000${workOffsetIso()}`;
}

/** Careful: the server's `lte` is inclusive, so this runs to the last millisecond of the day. */
function dayEnd(date: string): string {
  return `${date}T23:59:59.999${workOffsetIso()}`;
}

export function AuditTab() {
  const today = todayInDhaka();
  const [range, setRange] = useState({ from: monthStartOf(today), to: today });
  const [action, setAction] = useState('');
  const [user, setUser] = useState<{ id: number; name: string } | null>(null);
  const [page, setPage] = useState(1);

  const log = useApi(
    (signal) =>
      listAuditLog(
        {
          from: dayStart(range.from),
          to: dayEnd(range.to),
          ...(action === '' ? {} : { action }),
          ...(user === null ? {} : { userId: user.id }),
          page,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    [range.from, range.to, action, user?.id, page],
  );

  /** Careful: changing a filter must also return to page 1, or staying on page 3 and
   *     finding nothing under the new filter would look like "nothing happened" */
  const changeAction = (next: string): void => {
    setAction(next);
    setPage(1);
  };

  const rows = log.data?.rows ?? [];
  const total = log.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns: Column<AuditLogRow>[] = [
    {
      key: 'time',
      header: 'When',
      render: (row) => (
        // Careful: the time is Dhaka time; `formatTime()` adds the offset explicitly.
        //    With `toLocaleTimeString()`, someone on a VPN would see the wrong time and
        //    the answer to "who looked when" would be wrong.
        <span
          className="num whitespace-nowrap"
          title={formatDateTime(row.occurredAt)}
        >
          {formatDateShort(workDateOf(row.occurredAt))}{' '}
          {formatTime(row.occurredAt)}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'Who',
      render: (row) => {
        const actor = row.user;
        // Careful: the row stays even if the user was deleted; the log is evidence, so
        //    it is never blanked
        if (!actor) {
          return <span className="text-ink-3">Deleted account</span>;
        }

        return (
          <button
            type="button"
            onClick={() => {
              setUser({ id: actor.id, name: actor.fullName });
              setPage(1);
            }}
            title="Show only this user's events"
            className="min-w-0 text-left transition hover:text-brand-ink"
          >
            <span className="block truncate font-medium">{actor.fullName}</span>
            <span className="block truncate text-[11px] text-ink-3">
              {ROLE_LABEL[actor.role] ?? actor.role} · {actor.email}
            </span>
          </button>
        );
      },
    },
    {
      key: 'action',
      header: 'What',
      // Important: red **only** for failed logins. If viewing screenshots or pay were
      //    red too, the whole table would be red under that filter and the real
      //    problem (someone repeatedly entering a wrong password) would go unseen.
      render: (row) => (
        <Chip tone={row.action === 'login_failed' ? 'attention' : 'counted'}>
          {ACTION_LABEL[row.action] ?? row.action}
        </Chip>
      ),
    },
    {
      key: 'target',
      header: 'On whom / what',
      render: (row) =>
        row.targetType === null ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className="num text-[12px]">
            {row.targetType}
            {row.targetId ? ` #${row.targetId}` : ''}
          </span>
        ),
    },
    {
      key: 'ip',
      header: 'IP',
      render: (row) => (
        <span className="num text-[12px] text-ink-3">
          {row.ipAddress ?? '—'}
        </span>
      ),
    },
    {
      key: 'meta',
      header: 'Details',
      render: (row) => <Meta meta={row.meta} />,
    },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        This log is read-only — there is no way to edit or delete it. Viewing a
        screenshot and viewing a salary are both written here, which means{' '}
        <strong>whoever is watching is watched too</strong>.
      </Notice>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <DateRange
            from={range.from}
            to={range.to}
            onChange={(next) => {
              setRange(next);
              setPage(1);
            }}
          />
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-ink-3">Event</span>
            <select
              value={action}
              onChange={(e) => changeAction(e.target.value)}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
            >
              {ACTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* The most important question on this page is one click away */}
        <MiniButton
          onClick={() => changeAction('view_screenshot')}
          title="Only the screenshot-viewing events"
        >
          Who viewed whose screenshots
        </MiniButton>
      </div>

      {user && (
        <div className="flex flex-wrap gap-2">
          <FilterChip
            onClear={() => {
              setUser(null);
              setPage(1);
            }}
          >
            User: {user.name}
          </FilterChip>
        </div>
      )}

      {log.loading && !log.data && <Loading />}
      {log.error && <ErrorBox error={log.error} retry={log.reload} />}

      {!log.loading && !log.error && rows.length === 0 && (
        <Empty
          title="No events match this filter"
          hint="Try widening the date range, or pick 'All events'. On a new system the log holds nothing but sign-ins for the first few days."
        />
      )}

      {rows.length > 0 && (
        <Card
          padded={false}
          title={`${formatCount(total)} Events`}
          hint={`Page ${page} of ${lastPage} · newest first`}
          actions={
            <div className="flex gap-1.5">
              <MiniButton
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || log.loading}
              >
                ← Previous
              </MiniButton>
              <MiniButton
                onClick={() => setPage((p) => p + 1)}
                disabled={!log.data?.hasMore || log.loading}
              >
                Next →
              </MiniButton>
            </div>
          }
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </Card>
      )}
    </div>
  );
}

/**
 * `meta` is JSON of any shape (`Prisma.JsonValue` on the server).
 *
 * Careful: rendering it blindly would hand React an object and throw ("Objects are
 *    not valid as a React child"); the whole page would go white and the cause would
 *    not show on screen. So always `JSON.stringify`.
 *
 * Important: collapsed by default: the `view_screenshot` meta holds whose image, how
 *    many, which date, and with it expanded on every row the table could not be read.
 */
function Meta({ meta }: { meta: unknown }) {
  const [open, setOpen] = useState(false);

  if (meta === null || meta === undefined) {
    return <span className="text-ink-3">—</span>;
  }

  const text = JSON.stringify(meta, null, 2);

  if (!open) {
    return (
      <MiniButton onClick={() => setOpen(true)} title={text}>
        Show
      </MiniButton>
    );
  }

  return (
    <div className="min-w-0">
      <pre className="num max-w-md overflow-x-auto rounded-md border border-line bg-paper px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-1 text-[11px] text-ink-3 transition hover:text-ink"
      >
        Hide
      </button>
    </div>
  );
}
