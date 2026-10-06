import { useNavigate, useSearchParams } from 'react-router';

import { getLiveBoard, type LiveCard } from '../../api/dashboard';
import { usePolling } from '../../api/useApi';
import { Page } from '../../components/Page';
import { ErrorBox, Empty, Loading } from '../../components/States';
import { StatusChip } from '../../components/StatusDot';
import { PersonCell, Table, type Column } from '../../components/Table';
import { Tabs } from '../../components/Tabs';
import { formatDuration, formatTime } from '../../lib/format';
import { useT } from '../../i18n';
import { StaffDirectory } from './StaffDirectory';

/** 30 seconds like the board: both screens show the same numbers, in step */
const REFRESH_MS = 30_000;

/**
 * Staff — one page for the people: **Today** (who is doing what now, hours
 * today and this month, when the agent last spoke — read-only, from `/live`,
 * the same numbers as the board) and **Directory** (adding and editing
 * people, their portal logins, agent setup, deactivating). Each person's own
 * page opens from either tab.
 */
function StaffToday() {
  const t = useT();
  const navigate = useNavigate();
  const board = usePolling((signal) => getLiveBoard(signal), REFRESH_MS, []);

  const cards = board.data?.cards ?? [];

  const columns: Column<LiveCard>[] = [
    {
      key: 'person',
      header: t('Staff'),
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
      header: t('Status'),
      render: (c) => <StatusChip status={c.status} />,
    },
    {
      key: 'today',
      header: t('Today'),
      align: 'right',
      render: (c) => (
        <span className="num font-semibold">
          {formatDuration(c.todayWorkedSec)}
        </span>
      ),
    },
    {
      key: 'month',
      header: t('This month'),
      align: 'right',
      render: (c) => (
        <span className="num text-ink-2">
          {formatDuration(c.monthWorkedSec)}
          {/* No target: the hours alone, not "/0h" */}
          {!c.noTarget && (
            <small className="ml-1 text-[11px] text-ink-3">
              /{Math.round(c.monthTargetSec / 3600)}h
            </small>
          )}
        </span>
      ),
    },
    {
      key: 'seen',
      header: t('Agent last spoke'),
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
          <span className="text-ink-3" title={t('This agent has never checked in')}>
            —
          </span>
        ),
    },
  ];

  return (
    <>
      <p className="mb-3 text-xs text-ink-3">
        {board.data
          ? t('{{count}} active · updated every 30 seconds', { count: cards.length })
          : t('Everyone on the board')}
      </p>
      {board.loading && !board.data ? (
        <Loading label={t('Loading staff…')} />
      ) : !board.data ? (
        <ErrorBox error={board.error} retry={board.reload} />
      ) : cards.length === 0 ? (
        <Empty
          title={t('No active staff yet')}
          hint={t('Add people in the Directory tab, then install the agent on their PC.')}
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
    </>
  );
}

type TabId = 'today' | 'directory';

const TABS: { id: TabId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'directory', label: 'Directory' },
];

export function StaffPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const active: TabId = params.get('tab') === 'directory' ? 'directory' : 'today';

  return (
    <Page
      title={t('Staff')}
      subtitle={
        active === 'today'
          ? t('Who is working now, and how much today')
          : t('Add and edit people, their logins and their PCs — nothing is ever deleted')
      }
    >
      <Tabs
        items={TABS.map((tab) => ({ ...tab, label: t(tab.label) }))}
        active={active}
        onChange={(tab) => setParams(tab === 'today' ? {} : { tab }, { replace: true })}
        label={t('Staff')}
      />
      <div className="mt-4">
        {active === 'today' ? <StaffToday /> : <StaffDirectory />}
      </div>
    </Page>
  );
}
