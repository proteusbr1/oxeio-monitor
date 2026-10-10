import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getTopUsage } from '../../api/activity';
import { listAlerts } from '../../api/alerts';
import { getLiveBoard, getTeamPulse, getTeamTrend, type TrendDay } from '../../api/dashboard';
import { openStatement } from '../../api/hoursStatement';
import { scheduleToday } from '../../api/schedule';
import { usePolling } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
import { Card } from '../../components/Card';
import { Button, Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Tabs } from '../../components/Tabs';
import { workHourNow, formatDate, formatDateShort, formatDuration, formatTime, weekdayOf, workTimeZone, workTimeZoneLabel } from '../../lib/format';
import { DataPanel } from './DataPanel';
import { DayPulse } from './DayPulse';
import { HoursStatementCard } from './HoursStatementCard';
import { ScheduleTodayCard } from './ScheduleTodayCard';
import { breachCount } from './scheduleToday';
import { TopApps } from './TopApps';
import { StatusStrip } from './TeamBars';
import { TeamTable } from './TeamTable';
import { FewestHours, MonthCard, TopPerformers, WeekBars } from './WeekAndMonth';
import { isWorking } from './onTheClock';
import { dayDuty } from './roster';
import { useT } from '../../i18n';

// Live state every 15 seconds; heavy charts/reports every two minutes.
// Images are not fetched here.
const BOARD_REFRESH_MS = 15_000;
const CHART_REFRESH_MS = 120_000;
const LEADER_WINDOWS = [{ id: '30d', label: '30 days' }, { id: 'all', label: 'All time' }] as const;

export function LiveBoardPage() {
  const t = useT();
  const { user } = useAuth();
  const { features } = useFeatures();
  const canViewBoard = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';
  // The role condition stays the same; without permission, no call to any
  // protected endpoint.
  const board = usePolling((signal) => canViewBoard ? getLiveBoard(signal) : Promise.resolve(null), BOARD_REFRESH_MS, [canViewBoard]);
  const pulse = usePolling((signal) => canViewBoard ? getTeamPulse(signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard]);
  const trend = usePolling((signal) => canViewBoard ? getTeamTrend(signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard]);
  const workDate = board.data?.workDate;
  // Apps & websites switched off: the endpoint answers 404, so it is not asked at all
  const tracksApps = features.appTracking;
  const apps = usePolling((signal) => canViewBoard && tracksApps && workDate ? getTopUsage({ from: workDate, to: workDate, limit: 6 }, signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard, tracksApps, workDate]);
  const alerts = usePolling((signal) => isOwner ? listAlerts({ limit: 3 }, signal) : Promise.resolve(null), CHART_REFRESH_MS, [isOwner]);
  // Fixed schedules and the hours statement: shown only when in use. The
  // statement is the owner's (a manager would get 403), behind its module.
  const schedule = usePolling((signal) => canViewBoard ? scheduleToday(signal) : Promise.resolve(null), CHART_REFRESH_MS, [canViewBoard]);
  const readsHours = isOwner && features.hoursStatement;
  const hours = usePolling((signal) => readsHours ? openStatement(signal) : Promise.resolve(null), CHART_REFRESH_MS, [readsHours]);
  const scheduled = schedule.data?.people ?? [];
  const scheduledToday = scheduled.filter((p) => p.checkedToday).length;
  const offSchedule = breachCount(scheduled);
  const showsHours = readsHours && (hours.data?.detail?.lines.length ?? 0) > 0;
  const [leaderWindow, setLeaderWindow] = useState<'30d' | 'all'>('30d');
  const cards = board.data?.cards ?? [];
  const active = cards.filter((card) => isWorking(card.status)).length;
  const idle = cards.filter((card) => card.status === 'idle').length;
  const offline = cards.filter((card) => card.status === 'offline').length;
  const todaySec = cards.reduce((sum, card) => sum + card.todayWorkedSec, 0);
  const worked = cards.filter((card) => card.todayWorkedSec > 0).length;
  const finished = cards.reduce((sum, card) => sum + card.tasksDone, 0);
  // the Tasks module switched off in Settings → Modules: no task panels;
  // and only when someone receives tasks — otherwise the panels would be zeros
  const hasAssignees = features.tasks && cards.some((card) => card.receivesTasks);
  const month = trend.data?.month;
  // Careful: with nobody on a target (all no-target or no policy) there is no pace to show
  const observed = month?.trackedFrom != null && month.targetSec > 0;
  const withTarget = cards.filter((card) => dayDuty(card) === 'target').length;
  // No-target staff are not "off": they work today, there is just nothing to measure
  const noTargetCount = cards.filter((card) => dayDuty(card) === 'none').length;
  const offCount = cards.length - withTarget - noTargetCount;
  const targets = cards.filter((card) => card.dailyTargetSec > 0);
  const dailyTarget = targets.length && targets.every((card) => card.dailyTargetSec === targets[0].dailyTargetSec) ? targets[0].dailyTargetSec : null;
  const yesterday = trend.data?.days.at(-2);
  const delta = yesterday?.tracked ? yesterday.expectedStaff === 0 ? t('Yesterday was a day off') : Math.abs(todaySec - yesterday.workedSec) < 300 ? t('About the same as yesterday') : `${todaySec > yesterday.workedSec ? '▲' : '▼'} ${t('{{duration}} vs yesterday', { duration: formatDuration(Math.abs(todaySec - yesterday.workedSec)) })}` : null;
  const refresh = () => { board.reload(); pulse.reload(); trend.reload(); if (tracksApps) apps.reload(); if (isOwner) alerts.reload(); schedule.reload(); if (readsHours) hours.reload(); };

  let content: ReactNode;
  if (!canViewBoard) content = <Empty title={t("You don't have access")} hint={t('This board is available to owners and managers.')} />;
  else if (!board.data && board.loading) content = <Loading label={t('Loading the board…')} />;
  else if (!board.data) content = <ErrorBox error={board.error} retry={board.reload} />;
  else if (!cards.length) content = <Empty title={t('Nobody on the board yet')} hint={t('Add staff and install the agent. Their first heartbeat brings them onto the board.')} />;
  else content = <>
    {board.error && <p role="status" className="rounded-lg border border-brand/30 bg-brand-bg px-4 py-3 text-sm text-brand-ink">{t("Couldn't refresh — showing the last successful snapshot from {{time}}.", { time: formatTime(board.updatedAt?.toISOString() ?? null) })}</p>}
    <div className="studio-stats">
      <StudioStat label={t('Working now')} value={active} unit={`/ ${cards.length}`} note={<>{t('{{idle}} idle · {{offline}} offline', { idle, offline })}<br />{t('{{count}} off today', { count: offCount })}{noTargetCount > 0 && ` · ${t('{{count}} no target', { count: noTargetCount })}`}</>} />
      <StudioStat label={t('Hours today')} value={formatDuration(todaySec)} note={<>{t('{{count}} staff with recorded time', { count: worked })}{delta && <><br />{delta}{trend.error && ` · ${t('last update')}`}</>}</>} />
      <StudioStat label={t('Average today')} value={worked ? formatDuration(todaySec / worked) : '—'} note={<>{t('Across {{count}} staff with time', { count: worked })}<br />{dailyTarget ? t('{{duration}} daily target', { duration: formatDuration(dailyTarget) }) : targets.length ? t('Individual targets shown below') : t('No daily target today')}</>} />
      {hasAssignees && <StudioStat label={t('Tasks done')} value={finished} note={t('Marked complete today')} />}
      <StudioStat label={!observed ? t('Monthly pace') : month!.paceSec < 0 ? t('Behind monthly pace') : t('Ahead of monthly pace')} value={observed ? formatDuration(Math.abs(month!.paceSec)) : '—'} tone={observed ? month!.paceSec < 0 ? 'warning' : 'ok' : undefined} note={trend.error ? t('Refresh failed · last update shown') : observed ? <>{t('Counted from {{date}}', { date: formatDate(month!.trackedFrom!) })}{month!.notObservedStaff > 0 && ` · ${t('{{count}} not counted yet', { count: month!.notObservedStaff })}`}</> : month && month.targetSec <= 0 ? t('Nobody has an hours target') : t('No finished day counted yet')} />
      {scheduled.length > 0 && <StudioStat label={t('Schedule today')} value={offSchedule} unit={`/ ${scheduledToday}`} tone={offSchedule > 0 ? 'warning' : undefined} note={scheduledToday === 0 ? t('Nobody scheduled today') : offSchedule > 0 ? t('people outside their schedule') : t('everyone on schedule')} />}
      {isOwner && <StudioStat label={t('Open alerts')} value={alerts.data?.openCount ?? '—'} tone={alerts.data?.openCount ? 'warning' : undefined} note={<Link to="/alerts" className="underline underline-offset-4">{alerts.error ? t('Refresh failed · view alerts ↗') : alerts.data?.rows[0]?.title ?? t('View alerts ↗')}</Link>} />}
    </div>
    <div className="studio-overview">
      <Card title={t('Shape of the Day')} hint={t('Team hours by hour · {{zone}} time', { zone: workTimeZoneLabel() })} padded={false}><DataPanel result={pulse}>{pulse.data && <DayPulse hours={pulse.data.hours} currentHour={workHourNow()} />}</DataPanel></Card>
      <Card title={t('Team Right Now')} hint={t('Agent status at the last refresh')} padded={false}>
        <StatusStrip cards={cards} />
        <p className="studio-connection-note">{t('Offline describes the agent connection, not whether someone worked.')}</p>
      </Card>
      <Card title={t('Hours · Last 7 Days')} hint={t('Solid line = usual target · dashed bars = not tracked')} padded={false}><DataPanel result={trend}>{trend.data && <WeekBars days={trend.data.days} />}</DataPanel></Card>
    </div>
    {/* a lone card takes the full width: studio-pair would leave an empty half */}
    {(scheduled.length > 0 || showsHours) && <div className={scheduled.length > 0 && showsHours ? 'studio-pair' : undefined}>
      {scheduled.length > 0 && <ScheduleTodayCard result={schedule} />}
      {showsHours && <HoursStatementCard result={hours} />}
    </div>}
    <div className="studio-detail-grid">
      <Card title={t('Team Snapshot')} hint={withTarget ? t('Today’s hours, targets and task progress · furthest along first') : noTargetCount ? t('Today’s hours · no hours target set') : t('Day off · recorded hours still count')} actions={<Link className="tap text-xs underline underline-offset-4" to="/worklog">{t('View Worklog ↗')}</Link>} padded={false}>
        <TeamTable cards={cards} />
      </Card>
      <div className="studio-detail-side">
        {hasAssignees && <Card title={t('Tasks Done · Last 7 Days')} hint={t('Whole team · today is still in progress')} padded={false}><DataPanel result={trend}>{trend.data && <StudioWeek days={trend.data.days} metric="tasks" />}</DataPanel></Card>}
        {tracksApps && <Card title={t('Where Today Went')} hint={t('Whole team · counted app time only')} padded={false}><DataPanel result={apps}>{apps.data && <TopApps usage={apps.data.apps} />}</DataPanel></Card>}
        <Card title={t('Fewest Hours')} hint={trend.data ? t('Least counted in the last {{count}} days', { count: trend.data.laggardDays }) : t('Least counted recently')} padded={false}><DataPanel result={trend}>{trend.data && <FewestHours people={trend.data.laggards} days={trend.data.laggardDays} />}</DataPanel></Card>
      </div>
    </div>
    <div className="studio-pair">
      <Card title={t('Top Performers')} hint={leaderWindow === '30d' ? t('Most hours counted in the last 30 days') : t('Most hours counted, all time')} padded={false} actions={<Tabs items={LEADER_WINDOWS.map((w) => ({ ...w, label: t(w.label) }))} active={leaderWindow} onChange={setLeaderWindow} label={t('Top performers window')} />}><DataPanel result={trend}>{trend.data && <TopPerformers leaders={leaderWindow === '30d' ? trend.data.leaders30 : trend.data.leaders} />}</DataPanel></Card>
      <Card title={t('This Month')} hint={t('Counted against the team target')} padded={false}><DataPanel result={trend}>{month && <MonthCard month={month} />}</DataPanel></Card>
    </div>

  </>;

  return <Page><div className="studio-board">
    <div className="studio-board-head">
      <div><h1>{t('Your team, at a glance.')}</h1><p>{workDate ? `${formatDate(workDate)} · ${workTimeZone()}` : t('Live Board · {{zone}}', { zone: workTimeZone() })}</p></div>
      {canViewBoard && <div className="studio-actions"><span className="studio-updated"><strong className={board.error ? 'text-idle-ink' : 'text-ok'}>{board.error ? t('STALE') : board.paused ? t('PAUSED') : board.data ? t('LIVE') : t('CONNECTING')}</strong>{board.updatedAt && ` · ${t('Updated {{time}}', { time: formatTime(board.updatedAt.toISOString()) })}`}</span><Link className="tap text-xs underline underline-offset-4" to="/reports">{t('Reports ↗')}</Link><Button onClick={refresh} disabled={board.loading}>{board.loading ? t('Refreshing…') : t('Refresh')}</Button><Link className="tap rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] text-ink" to="/worklog">{t('Open Worklog ↗')}</Link></div>}
    </div>
    {content}
    <footer className="studio-footer"><span>{board.error ? t('Refresh failed') : board.paused ? t('Updates paused') : board.loading ? t('Refreshing snapshot…') : t('Refreshes every 15 seconds')}{board.updatedAt && ` · ${t('Last updated {{time}}', { time: formatTime(board.updatedAt.toISOString()) })}`}</span>{canViewBoard && <Link to="/reports" className="underline underline-offset-4">{t('Open reports ↗')}</Link>}</footer>
  </div></Page>;
}

function StudioStat({ label, value, unit, note, tone }: { label: string; value: ReactNode; unit?: string; note: ReactNode; tone?: 'warning' | 'ok' }) {
  return <div className="studio-stat"><p className="studio-stat-label">{label}</p><div className={`studio-stat-value${tone === 'warning' ? ' text-idle-ink' : tone === 'ok' ? ' text-ok' : ''}`}>{value}{unit && <small>{unit}</small>}</div><p className="studio-stat-note">{note}</p></div>;
}

function StudioWeek({ days, metric }: { days: TrendDay[]; metric: 'tasks' | 'hours' }) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const valueOf = (day: TrendDay) => metric === 'tasks' ? day.tasksDone : day.workedSec;
  const labelOf = (day: TrendDay) => metric === 'tasks' ? `${day.tasksDone}` : formatDuration(day.workedSec);
  const peak = Math.max(...days.filter((day) => day.tracked).map(valueOf), 1);
  const shown = days.find((day) => day.date === selected);
  if (!days.length) return <p className="p-5 text-sm text-ink-2">{t('No daily history yet.')}</p>;
  const tracked = days.filter((day) => day.tracked);
  return <div className="studio-chart">
    <div className="studio-chart-columns" aria-label={metric === 'tasks' ? t('Finished tasks by day') : t('Active hours by day')}>
      {days.map((day) => <button type="button" key={day.date} className="studio-chart-day" onMouseEnter={() => setSelected(day.date)} onFocus={() => setSelected(day.date)} onClick={() => setSelected(day.date)} aria-label={`${formatDate(day.date)}: ${day.tracked ? `${metric === 'tasks' ? t('{{value}} tasks done', { value: labelOf(day) }) : t('{{value}} active time', { value: labelOf(day) })}${day.expectedStaff === 0 ? `, ${t('day off')}` : ''}` : t('not tracked yet')}`}>
        <span className="studio-chart-value">{day.tracked ? labelOf(day) : '—'}</span>
        <span className={`studio-chart-bar${day.tracked ? '' : ' is-untracked'}`} style={{ height: day.tracked ? `${Math.max(2, valueOf(day) / peak * 135)}px` : '35px' }} />
      </button>)}
    </div>
    <div className="studio-chart-dates" aria-hidden>{days.map((day) => <span key={day.date}>{weekdayOf(day.date).slice(0, 3)}<br />{Number(day.date.slice(-2))}</span>)}</div>
    <p className="studio-chart-total"><strong>{tracked.length ? tracked.reduce((sum, day) => sum + day.tasksDone, 0) : '—'}</strong> {t('tasks done · {{tracked}} of {{total}} days tracked', { tracked: tracked.length, total: days.length })}</p>
    <p className="studio-chart-note" aria-live="polite">{shown ? `${formatDateShort(shown.date)} · ${shown.tracked ? `${metric === 'tasks' ? t('{{value}} done', { value: labelOf(shown) }) : t('{{value}} active', { value: labelOf(shown) })}${shown.expectedStaff === 0 ? ` · ${t('day off')}` : ''}` : t('not tracked yet')}` : t('Today is still in progress. Dashed bars mean not tracked yet.')}</p>
  </div>;
}