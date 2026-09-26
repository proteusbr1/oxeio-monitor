import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getTopUsage } from '../api/activity';
import { listAlerts } from '../api/alerts';
import { getLiveBoard, getTeamPulse, getTeamTrend, type TrendDay } from '../api/dashboard';
import { usePolling, type ApiResult } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/Card';
import { Button, Page } from '../components/Page';
import { Empty, ErrorBox, Loading } from '../components/States';
import { Tabs } from '../components/Tabs';
import { dhakaHourNow, formatDate, formatDateShort, formatDuration, formatTime, weekdayOf } from '../lib/format';
import { DayPulse } from './live/DayPulse';
import { TopApps } from './live/TopApps';
import { StatusStrip } from './live/TeamBars';
import { TeamTable } from './live/TeamTable';
import { FewestHours, MonthCard, TopPerformers } from './live/WeekAndMonth';
import { isWorking } from './live/onTheClock';
import { dayDuty } from './live/roster';

// লাইভ অবস্থা ১৫ সেকেন্ডে; ভারী চার্ট/রিপোর্ট দুই মিনিটে। ছবি এখানে আনা হয় না।
const BOARD_REFRESH_MS = 15_000;
const CHART_REFRESH_MS = 120_000;
const LEADER_WINDOWS = [{ id: '30d', label: '30 days' }, { id: 'all', label: 'All time' }] as const;
const CHART_METRICS = [{ id: 'designs', label: 'Designs' }, { id: 'hours', label: 'Hours' }] as const;

export function LiveBoardPage() {
  const { user } = useAuth();
  const canViewBoard = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';
  // ভূমিকার শর্ত একই থাকে; অনুমতি না থাকলে কোনো protected endpoint-এ কল নয়।
  const board = usePolling((signal) => canViewBoard ? getLiveBoard(signal) : Promise.resolve(null), BOARD_REFRESH_MS, [canViewBoard]);
  const pulse = usePolling((signal) => canViewBoard ? getTeamPulse(signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard]);
  const trend = usePolling((signal) => canViewBoard ? getTeamTrend(signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard]);
  const workDate = board.data?.workDate;
  const apps = usePolling((signal) => canViewBoard && workDate ? getTopUsage({ from: workDate, to: workDate, limit: 6 }, signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard, workDate]);
  const alerts = usePolling((signal) => isOwner ? listAlerts({ limit: 3 }, signal) : Promise.resolve(null), CHART_REFRESH_MS, [isOwner]);
  const [leaderWindow, setLeaderWindow] = useState<'30d' | 'all'>('30d');
  const [metric, setMetric] = useState<'designs' | 'hours'>('designs');
  const cards = board.data?.cards ?? [];
  const active = cards.filter((card) => isWorking(card.status)).length;
  const idle = cards.filter((card) => card.status === 'idle').length;
  const offline = cards.filter((card) => card.status === 'offline').length;
  const todaySec = cards.reduce((sum, card) => sum + card.todayWorkedSec, 0);
  const worked = cards.filter((card) => card.todayWorkedSec > 0).length;
  const finished = cards.reduce((sum, card) => sum + card.designsFinished, 0);
  const hasDesigners = cards.some((card) => card.staffType === 'designer');
  const month = trend.data?.month;
  const observed = month?.trackedFrom != null;
  const withTarget = cards.filter((card) => dayDuty(card) === 'target').length;
  const refresh = () => { board.reload(); pulse.reload(); trend.reload(); apps.reload(); if (isOwner) alerts.reload(); };

  let content: ReactNode;
  if (!canViewBoard) content = <Empty title="You don't have access" hint="This board is available to owners and managers." />;
  else if (!board.data && board.loading) content = <Loading label="Loading the board…" />;
  else if (!board.data) content = <ErrorBox error={board.error} retry={board.reload} />;
  else if (!cards.length) content = <Empty title="Nobody on the board yet" hint="Add staff and install the agent. Their first heartbeat brings them onto the board." />;
  else content = <>
    {board.error && <p role="status" className="rounded-lg border border-brand/30 bg-brand-bg px-4 py-3 text-sm text-brand-ink">Couldn't refresh — showing the last successful snapshot from {formatTime(board.updatedAt?.toISOString() ?? null)}.</p>}
    <div className="studio-stats">
      <StudioStat label="Working now" value={active} unit={`/ ${cards.length}`} note={`${idle} idle · ${offline} offline`} />
      <StudioStat label="Hours today" value={formatDuration(todaySec)} note={`Across ${worked} staff with recorded time`} />
      {hasDesigners ? <StudioStat label="Designs finished" value={finished} note="Marked complete today" /> : <StudioStat label="Average today" value={worked ? formatDuration(todaySec / worked) : '—'} note="Across staff with recorded time" />}
      <StudioStat label={!observed ? 'Monthly pace' : month!.paceSec < 0 ? 'Behind monthly pace' : 'Ahead of monthly pace'} value={observed ? formatDuration(Math.abs(month!.paceSec)) : '—'} note={observed ? <>Counted from {formatDate(month!.trackedFrom!)}{month!.notObservedStaff > 0 && ` · ${month!.notObservedStaff} not counted yet`}</> : 'No finished day counted yet'} />
    </div>
    <div className="studio-overview">
      <Card title="The Last 7 Days" hint={metric === 'designs' ? 'Designs marked complete · whole team' : 'Active hours · whole team'} padded={false} actions={<Tabs items={CHART_METRICS} active={metric} onChange={setMetric} label="Chart metric" />}>
        <DataPanel result={trend}>{trend.data && <StudioWeek days={trend.data.days} metric={metric} />}</DataPanel>
      </Card>
      <Card title="Team Right Now" hint="Agent status at the last refresh" padded={false}>
        <StatusStrip cards={cards} />
        <p className="studio-connection-note">Offline describes the agent connection, not whether someone worked.</p>
        {hasDesigners && <div className="studio-secondary-stat"><span>Average today · {worked} staff</span><strong className="num text-ink">{worked ? formatDuration(todaySec / worked) : '—'}</strong></div>}
        {isOwner && <div className="studio-secondary-stat"><Link to="/alerts" className="underline underline-offset-4">Open alerts ↗</Link><span className="num">{alerts.error ? 'Unavailable' : alerts.data?.total ?? '—'}</span></div>}
      </Card>
    </div>
    <Card title="Team Snapshot" hint={withTarget ? 'Today’s hours and design progress · furthest along first' : 'Day off · recorded hours still count'} actions={<Link className="tap text-xs underline underline-offset-4" to="/worklog">View Worklog ↗</Link>} padded={false}>
      <TeamTable cards={cards} />
    </Card>
    <div className="studio-pair">
      <Card title="Shape of the Day" hint="Team hours by hour · Dhaka time" padded={false}><DataPanel result={pulse}>{pulse.data && <DayPulse hours={pulse.data.hours} currentHour={dhakaHourNow()} />}</DataPanel></Card>
      <Card title="Where Today Went" hint="Whole team · counted app time only" padded={false}><DataPanel result={apps}>{apps.data && <TopApps usage={apps.data.apps} />}</DataPanel></Card>
    </div>
    <div className="studio-pair">
      <Card title="Top Performers" hint={leaderWindow === '30d' ? 'Most hours counted in the last 30 days' : 'Most hours counted, all time'} padded={false} actions={<Tabs items={LEADER_WINDOWS} active={leaderWindow} onChange={setLeaderWindow} label="Top performers window" />}><DataPanel result={trend}>{trend.data && <TopPerformers leaders={leaderWindow === '30d' ? trend.data.leaders30 : trend.data.leaders} />}</DataPanel></Card>
      <Card title="This Month" hint="Counted against the team target" padded={false}><DataPanel result={trend}>{month && <MonthCard month={month} />}</DataPanel></Card>
    </div>
    <Card title="Fewest Hours" hint={trend.data ? `Least counted in the last ${trend.data.laggardDays} days` : 'Least counted recently'} padded={false}><DataPanel result={trend}>{trend.data && <FewestHours people={trend.data.laggards} days={trend.data.laggardDays} />}</DataPanel></Card>
  </>;

  return <Page><div className="studio-board">
    <div className="studio-board-head">
      <div><h1>Your team, at a glance.</h1><p>{workDate ? `${formatDate(workDate)} · Asia/Dhaka` : 'Live Board · Asia/Dhaka'}</p></div>
      {canViewBoard && <div className="studio-actions"><Button onClick={refresh} disabled={board.loading}>{board.loading ? 'Refreshing…' : 'Refresh'}</Button><Link className="tap rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] text-ink" to="/worklog">Open Worklog ↗</Link></div>}
    </div>
    {content}
    <footer className="studio-footer"><span>{board.error ? 'Refresh failed' : board.paused ? 'Updates paused' : board.loading ? 'Refreshing snapshot…' : 'Refreshes every 15 seconds'}{board.updatedAt && ` · Last updated ${formatTime(board.updatedAt.toISOString())}`}</span>{canViewBoard && <Link to="/reports" className="underline underline-offset-4">Open reports ↗</Link>}</footer>
  </div></Page>;
}

function StudioStat({ label, value, unit, note }: { label: string; value: ReactNode; unit?: string; note: ReactNode }) {
  return <div className="studio-stat"><p className="studio-stat-label">{label}</p><div className="studio-stat-value">{value}{unit && <small>{unit}</small>}</div><p className="studio-stat-note">{note}</p></div>;
}

// প্রতিটা স্বাধীন ডেটা-উৎসের ব্যর্থতা দেখায়; পুরোনো সফল উত্তর মুছে দেয় না।
function DataPanel({ result, children }: { result: Pick<ApiResult<unknown>, 'data' | 'error' | 'reload'>; children: ReactNode }) {
  if (!result.data) return <div className="p-5">{result.error ? <ErrorBox error={result.error} retry={result.reload} /> : <Loading label="Loading summary…" />}</div>;
  return <>{result.error && <p role="status" className="px-5 pb-3 text-xs text-idle-ink">Couldn’t refresh this summary. Showing its last successful update. <button type="button" onClick={result.reload} className="tap underline">Retry</button></p>}{children}</>;
}

function StudioWeek({ days, metric }: { days: TrendDay[]; metric: 'designs' | 'hours' }) {
  const [selected, setSelected] = useState<string | null>(null);
  const valueOf = (day: TrendDay) => metric === 'designs' ? day.designsFinished : day.workedSec;
  const labelOf = (day: TrendDay) => metric === 'designs' ? `${day.designsFinished}` : formatDuration(day.workedSec);
  const peak = Math.max(...days.filter((day) => day.tracked).map(valueOf), 1);
  const shown = days.find((day) => day.date === selected);
  if (!days.length) return <p className="p-5 text-sm text-ink-2">No daily history yet.</p>;
  return <div className="studio-chart">
    <div className="studio-chart-columns" aria-label={metric === 'designs' ? 'Completed designs by day' : 'Active hours by day'}>
      {days.map((day) => <button type="button" key={day.date} className="studio-chart-day" onMouseEnter={() => setSelected(day.date)} onFocus={() => setSelected(day.date)} onClick={() => setSelected(day.date)} aria-label={`${formatDate(day.date)}: ${day.tracked ? `${labelOf(day)} ${metric === 'designs' ? 'designs finished' : 'active time'}${day.expectedStaff === 0 ? ', day off' : ''}` : 'not tracked yet'}`}>
        <span className="studio-chart-value">{day.tracked ? labelOf(day) : '—'}</span>
        <span className={`studio-chart-bar${day.tracked ? '' : ' is-untracked'}`} style={{ height: day.tracked ? `${Math.max(2, valueOf(day) / peak * 135)}px` : '35px' }} />
      </button>)}
    </div>
    <div className="studio-chart-dates" aria-hidden>{days.map((day) => <span key={day.date}>{weekdayOf(day.date).slice(0, 3)}<br />{Number(day.date.slice(-2))}</span>)}</div>
    <p className="studio-chart-note" aria-live="polite">{shown ? `${formatDateShort(shown.date)} · ${shown.tracked ? `${labelOf(shown)} ${metric === 'designs' ? 'finished' : 'active'}${shown.expectedStaff === 0 ? ' · day off' : ''}` : 'not tracked yet'}` : 'Today is still in progress. Dashed bars mean not tracked yet.'}</p>
  </div>;
}