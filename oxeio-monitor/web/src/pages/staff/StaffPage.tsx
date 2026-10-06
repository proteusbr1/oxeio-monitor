import { useNavigate } from 'react-router';

import { getLiveBoard, type LiveCard } from '../../api/dashboard';
import { usePolling } from '../../api/useApi';
import { Page } from '../../components/Page';
import { ErrorBox, Empty, Loading } from '../../components/States';
import { StatusChip } from '../../components/StatusDot';
import { PersonCell, Table, type Column } from '../../components/Table';
import { formatDuration, formatTime } from '../../lib/format';

/** 30 seconds like the board: both screens show the same numbers, in step */
const REFRESH_MS = 30_000;

/**
 * **Staff: everyone in one list.**
 *
 * Careful: **this is not a copy of Settings → Staff, and that difference is
 * the reason this page exists.** There staff are **edited**: pay, policy,
 * portal account, enabling the agent. Here they are only **viewed**: who is
 * doing what now, how much today, whether the agent is talking.
 *
 * Careful: the sidebar used to have a `/staff` tab that was **removed** because
 * the page did not exist and the tab ended in "not found". Mockup A has it, and
 * the owner asked for a **real page** rather than a fake.
 *
 * The data comes from `/live`, with no new endpoint. So the board and this
 * page can never report two different numbers (G88); a new query would
 * reopen exactly that door.
 */
export function StaffPage() {
  const navigate = useNavigate();
  const board = usePolling((signal) => getLiveBoard(signal), REFRESH_MS, []);

  const cards = board.data?.cards ?? [];

  const columns: Column<LiveCard>[] = [
    {
      key: 'person',
      header: 'Staff',
      className: 'min-w-44',
      render: (c) => (
        <PersonCell
          fullName={c.fullName}
          empCode={c.empCode}
          note={c.designation}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => <StatusChip status={c.status} />,
    },
    {
      key: 'today',
      header: 'Today',
      align: 'right',
      render: (c) => (
        <span className="num font-semibold">
          {formatDuration(c.todayWorkedSec)}
        </span>
      ),
    },
    {
      key: 'month',
      header: 'This month',
      align: 'right',
      render: (c) => (
        <span className="num text-ink-2">
          {formatDuration(c.monthWorkedSec)}
          <small className="ml-1 text-[11px] text-ink-3">
            /{Math.round(c.monthTargetSec / 3600)}h
          </small>
        </span>
      ),
    },
    {
      key: 'seen',
      header: 'Agent last spoke',
      align: 'right',
      /*
        This column is the one thing on this page that the board lacks: the
           board shows state by colour, but not the "how long ago" number.

        Careful: `—` means **never responded**, not "just now". An agent that
           is installed but never spoke is a separate case, and an empty cell
           would not tell it apart.
      */
      render: (c) =>
        c.lastHeartbeatAt ? (
          <span className="num text-ink-2">
            {formatTime(c.lastHeartbeatAt)}
          </span>
        ) : (
          <span className="text-ink-3" title="This agent has never checked in">
            —
          </span>
        ),
    },
  ];

  return (
    <Page
      title="Staff"
      subtitle={
        board.data
          ? `${cards.length} active · updated every 30 seconds`
          : 'Everyone on the board'
      }
    >
      {board.loading && !board.data ? (
        <Loading label="Loading staff…" />
      ) : !board.data ? (
        <ErrorBox error={board.error} retry={board.reload} />
      ) : cards.length === 0 ? (
        <Empty
          title="No active staff yet"
          hint="Add people in Settings → Staff, then install the agent on their PC."
        />
      ) : (
        <Table
          columns={columns}
          rows={cards}
          rowKey={(c) => String(c.employeeId)}
          /*
            Clicking a row opens that person's own page; in the mockup the
               list's only job was to get you there.
          */
          onRowClick={(c) => navigate(`/staff/${c.employeeId}`)}
        />
      )}
    </Page>
  );
}
