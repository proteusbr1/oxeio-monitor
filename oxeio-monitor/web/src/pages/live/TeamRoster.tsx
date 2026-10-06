import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { LiveCard } from '../../api/dashboard';
import { usePolling } from '../../api/useApi';
import { TodayMeter, ProgressBar } from '../../components/ProgressRing';
import { SectionHead } from '../../components/Page';
import { StatusChip, StatusLegend } from '../../components/StatusDot';
import { PersonCell, Table, type Column } from '../../components/Table';
import { Caveat } from '../../components/States';
import { formatAgo, formatDuration, formatHours } from '../../lib/format';
import type { GalleryItem } from '../../api/screenshots';
import { getLatestShots, NO_SHOTS } from './latestShots';
import { isWorking } from './onTheClock';
import { DesignCell } from './DesignCell';
import {
  dayDuty,
  designView,
  meterKind,
  restingStartsAt,
  rosterRows,
} from './roster';
import { ShotLightbox } from './ShotLightbox';

/**
 * **Team roster: everyone on one screen.**
 *
 * Important: the owner chose this after seeing three mockups (direction "B ·
 * One-screen roster"). It used to be a grid of cards; for 13 people that was four
 * rows of four columns, and <b>52% of each card</b> went to a screenshot that cannot
 * be read at that size. "Who is working now, is anyone stuck" meant reading 12 cards.
 *
 * Careful: <b>this is not a copy of the Live Board's `TeamTable`, and must not be
 * allowed to become one.</b> The split is kept explicit:
 *
 * | | `TeamTable` (Live Board) | `TeamRoster` (Worklog) |
 * |---|---|---|
 * | Question | "who is where against target" | "who is working **now**" |
 * | Order | by progress | **employee code, never hours** |
 * | Columns | target, progress | **screenshot, last response** |
 *
 * Careful: if the two ever end up with the same columns, one must be deleted; two
 * "identical" tables on two pages will one day disagree (the lesson of G88).
 *
 * Important: two things from the mockup were <b>deliberately left out</b>:
 *  1. <b>The team median line</b>: on every bar it would mathematically show half
 *     the team "below the line", every day, forever. The owner can change the sort
 *     order, but that line would always burn: a leaderboard built into geometry.
 *  2. <b>Headers pretending to sort</b>: `Table` has no sorting, so an arrow would
 *     advertise a capability that does not exist.
 */

/**
 * Screenshot refresh: **4 minutes**, much slower than the board's own rhythm.
 *
 * Careful: do not lower this. As explained at the top of `latestShots.ts`, every
 * `GET /screenshots` call writes an audit row ("who looked at my screenshots"),
 * and screenshots only accumulate **every 5 minutes** anyway; polling more often
 * returns the same image and only fattens the ledger.
 */
const SHOT_REFRESH_MS = 4 * 60_000;

export function TeamRoster({
  cards,
  canView,
  withTarget,
}: {
  cards: readonly LiveCard[];
  /** Careful: so that a staff member's browser does not collect pointless 403s */
  canView: boolean;
  /**
   * How many have a workday today (with or without an hours target); 0 on a day
   * off for everyone, and the header text changes
   */
  withTarget: number;
}) {
  const [openFor, setOpenFor] = useState<number | null>(null);

  const shots = usePolling(
    (signal) => (canView ? getLatestShots(signal) : Promise.resolve(NO_SHOTS)),
    SHOT_REFRESH_MS,
    [canView],
  );

  const byEmployee = shots.data?.byEmployee ?? null;

  const rows = rosterRows(cards);
  const restingAt = restingStartsAt(rows);
  const workingCount = restingAt === -1 ? rows.length : restingAt;
  const restingCount = rows.length - workingCount;

  const openCard = rows.find((c) => c.employeeId === openFor) ?? null;
  const openShot = openFor === null ? null : byEmployee?.get(openFor) ?? null;

  const columns: Column<LiveCard>[] = [
    {
      key: 'person',
      header: `Staff · ${rows.length}`,
      className: 'min-w-[190px]',
      render: (c) => (
        <Link
          to={`/staff/${c.employeeId}`}
          className="block rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <PersonCell fullName={c.fullName} empCode={c.empCode} />
        </Link>
      ),
    },
    {
      key: 'today',
      header: 'Today',
      align: 'right',
      className: 'min-w-[140px]',
      render: (c) => <TodayCell card={c} />,
    },
    /*
      **Design** column: the owner's daily 25 count.

      Careful: the column appears **only when** the team has at least one designer.
         Always showing it would leave an empty cell every day in researchers' rows,
         and an empty cell looks like "no data yet", when they are simply not
         measured on it.
    */
    ...(rows.some((c) => designView(c) !== null)
      ? [
          {
            key: 'designs',
            /**
             * One word, one number counted (ADR-037, see the link below).
             *
             * Careful: it used to say `Designs · opened / done`. After the cell's
             * number changed, the heading was left behind; this was caught by grepping
             * the live bundle, so it was re-checked after the fix
             * ([Build Log](../../../../docs/09-Build-Log.md)).
             */
            header: 'Designs',
            align: 'right' as const,
            className: 'hidden min-w-[92px] md:table-cell',
            render: (c: LiveCard) => <DesignCell card={c} />,
          },
        ]
      : []),
    {
      key: 'month',
      /* Careful: "/ 208h" must not go in the header: the target differs per employee
         and depends on proration (G37), so the number must appear in every row */
      header: 'This month',
      align: 'right',
      className: 'hidden min-w-[150px] sm:table-cell',
      render: (c) => <MonthCell card={c} />,
    },
    {
      key: 'screen',
      header: 'Screen',
      /* Careful: this goes first on small screens; nothing is readable in a 64px image anyway */
      className: 'hidden w-[84px] lg:table-cell',
      render: (c) => (
        <ShotThumb
          card={c}
          shot={byEmployee?.get(c.employeeId) ?? null}
          onOpen={() => setOpenFor(c.employeeId)}
        />
      ),
    },
    {
      key: 'seen',
      header: 'Last seen',
      className: 'hidden whitespace-nowrap md:table-cell',
      render: (c) => (
        <span className="text-[12px] text-ink-3">{heartbeatLabel(c)}</span>
      ),
    },
    {
      /* The column that answers the owner's question is the **last** to drop, so
         "who is working" survives even on a narrow screen */
      key: 'status',
      header: '',
      align: 'right',
      render: (c) => <StatusChip status={c.status} />,
    },
  ];

  return (
    <div className="space-y-3">
      <SectionHead
        title="Who is on the clock"
        hint={
          withTarget === 0
            ? 'A day off for everyone — anything done today still counts toward the month'
            : "Ordered by employee code — never by hours. This is not a ranking."
        }
      />

      {/* The team's state on one line: the answer comes before counting cards */}
      <CountsStrip
        total={rows.length}
        working={workingCount}
        resting={restingCount}
        cards={rows}
      />

      <Table
        columns={columns}
        rows={rows}
        rowKey={(c) => String(c.employeeId)}
        rowMuted={(c) => !isWorking(c.status)}
        groupBefore={(_c, i) =>
          i === restingAt && restingAt > 0 ? (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3">
                Not working · {restingCount}
              </div>
              {/*
                Careful: this sentence is not decoration. Without it the grey rows
                   below would read like a list of accusations, when switching off the
                   PC and going home is normal and there is nothing to fix.
              */}
              <div className="text-[12px] text-ink-3">
                Off the clock is normal — the agent is healthy, nothing to fix.
              </div>
            </div>
          ) : null
        }
      />

      {rows.length === 0 && (
        <p className="py-8 text-center text-sm text-ink-3">
          Nobody has been added to the team yet.
        </p>
      )}

      <StatusLegend />

      {/*
        `/live` sends no `caveat` field, but the condition is true: there, worked
           seconds are a **sum**, not a UNION.
      */}
      <Caveat>
        When one person runs more than one PC at the same time, that stretch is
        counted twice, so hours can read a little high. An overlap longer than
        15 minutes raises its own alert.
      </Caveat>

      {/* Failing to fetch images is not the page breaking, so it is small and separate */}
      {shots.error && !shots.data && (
        <p className="mt-2 text-xs text-ink-3">
          Screenshots couldn&rsquo;t be loaded — the Screen column stays empty.
        </p>
      )}

      {openCard && (
        <ShotLightbox
          card={openCard}
          shot={openShot}
          onClose={() => setOpenFor(null)}
          onRefresh={shots.reload}
        />
      )}
    </div>
  );
}

/**
 * The team's state on one line: **only what is genuinely known**.
 *
 * Careful: nothing like "Agents reporting 13/13" is written here, though the mockup
 * had it. `/live` does not provide that number (`agent_down` was removed from
 * `LiveStatus`; that information now lives in Alerts). It shows what it does
 * provide: who is working, and whose agent is not installed or is switched off.
 * Important: printing an unknown number with confidence was this codebase's most
 * expensive mistake.
 */
function CountsStrip({
  total,
  working,
  resting,
  cards,
}: {
  total: number;
  working: number;
  resting: number;
  cards: readonly LiveCard[];
}) {
  const noAgent = cards.filter(
    (c) => c.agentPresence !== 'installed',
  ).length;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
      <span>
        <span className="num font-medium text-ink-2">{working}</span> working
      </span>
      <span className="text-line">·</span>
      <span>
        <span className="num font-medium text-ink-2">{resting}</span> not
        working
      </span>
      <span className="text-line">·</span>
      <span>
        <span className="num font-medium text-ink-2">{total}</span> on the team
      </span>
      {/* Careful: at zero the line is absent; writing "0 problems" would give a
          non-news item a place among the news every day */}
      {noAgent > 0 && (
        <>
          <span className="text-line">·</span>
          <span className="text-idle-ink">
            <span className="num font-medium">{noAgent}</span> without a working
            agent
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Today's cell: the number, with the meter below it.
 *
 * Careful: the target is the **server's `dailyTargetSec`**, not "8h"; in a
 *    27-workday month it automatically shows "7h 42m", and it differs per employee.
 */
function TodayCell({ card }: { card: LiveCard }) {
  const kind = meterKind(card);
  /**
   * The condition is no longer written here (`dayDuty()` in `roster.ts`).
   *
   * Careful: it used to be `todayIsWorkday && dailyTargetSec > 0`, and
   * `todayIsWorkday` **does not know personal leave**. So the cell of someone on
   * leave showed "0h / 8h" and an empty meter, looking exactly like someone
   * slacking, though the numbers had excused them long ago.
   */
  const duty = dayDuty(card);
  const hasTarget = duty === 'target';

  return (
    <div className="inline-block w-full max-w-[130px] text-right">
      <div className="flex items-baseline justify-end gap-1.5">
        <span
          className={`num text-[14px] font-semibold ${
            kind === 'counted' ? '' : 'text-ink-3'
          }`}
        >
          {/* Careful: zero and unknown differ in the number too, not only in the bar */}
          {kind === 'unknown' ? '—' : formatDuration(card.todayWorkedSec)}
        </span>
        <span className="num text-[11px] text-ink-3">
          {/*
            Careful: "day off" means the **whole office is closed**. For one person
               on leave it is false, though not for or against them, just a wrong
               reason. So it says something different.
          */}
          {hasTarget
            ? `/ ${targetText(card.dailyTargetSec)}`
            : duty === 'leave'
              ? 'on leave'
              : duty === 'none'
                ? 'no target'
                : 'day off'}
        </span>
      </div>

      {hasTarget && (
        <TodayMeter
          kind={kind}
          value={card.todayWorkedSec}
          max={card.dailyTargetSec}
          className="mt-1.5"
        />
      )}
    </div>
  );
}

/**
 * Careful: the month bar deliberately has **no** pace marker; a mid-month marker
 * would turn every row into an accusation. The month is context here, not a verdict.
 */
function MonthCell({ card }: { card: LiveCard }) {
  /**
   * Careful: the same honesty rule applies to the month cell. Writing `0m / 208h`
   * for an employee whose agent was never installed would read "did nothing this
   * month", though they were not measured. Important: the condition also covers
   * **the number itself**: even if the agent was removed today, the month's earlier
   * hours were genuinely measured, so they are not hidden.
   */
  const unknown = meterKind(card) === 'unknown' && card.monthWorkedSec === 0;

  // No target: the hours alone, with no "/ 0h" and no bar against zero
  if (card.noTarget) {
    return (
      <div className="inline-block w-full max-w-[140px] text-right">
        <div className="num text-[12.5px] text-ink-2">
          {unknown ? <span className="text-ink-3">—</span> : formatDuration(card.monthWorkedSec)}
        </div>
      </div>
    );
  }

  return (
    <div className="inline-block w-full max-w-[140px] text-right">
      <div className="num text-[12.5px] text-ink-2">
        {unknown ? <span className="text-ink-3">—</span> : formatDuration(card.monthWorkedSec)}
        <span className="text-ink-3"> / {formatHours(card.monthTargetSec, 0)}h</span>
      </div>
      {unknown ? (
        <TodayMeter
          kind="unknown"
          value={0}
          max={card.monthTargetSec}
          ariaLabel="This month"
          className="mt-1.5"
        />
      ) : (
        <ProgressBar
          value={card.monthWorkedSec}
          max={card.monthTargetSec}
          ariaLabel="This month"
          className="mt-1.5 opacity-70"
        />
      )}
    </div>
  );
}

/**
 * 64x40 thumbnail: for **recognising**, not for reading.
 *
 * Click for the full image (`ShotLightbox`). Careful: with no image it is not an
 * empty hole but a small dashed box; "none" and "not loaded" must not look alike.
 */
function ShotThumb({
  card,
  shot,
  onOpen,
}: {
  card: LiveCard;
  shot: GalleryItem | null;
  onOpen: () => void;
}) {
  if (!shot) {
    return (
      <div
        className="h-10 w-16 rounded border border-dashed border-line"
        title="No screenshot yet today"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Latest screenshot of ${card.fullName}`}
      className="block h-10 w-16 overflow-hidden rounded border border-line transition hover:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <img
        src={shot.thumbUrl}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    </button>
  );
}

/** `8h` for whole hours, otherwise `7h 42m`; straight from the server's number */
function targetText(targetSec: number): string {
  return targetSec % 3600 === 0
    ? `${formatHours(targetSec, 0)}h`
    : formatDuration(targetSec);
}

/**
 * Careful: there are **three different reasons** for no heartbeat, and three
 * different things for the owner to do. All three used to read "Never checked in", so
 * the same row held a 16:50 screenshot next to "never responded", which
 * contradicted itself (G88).
 */
function heartbeatLabel(card: LiveCard): string {
  if (card.lastHeartbeatAt !== null) return formatAgo(card.lastHeartbeatAt);

  switch (card.agentPresence) {
    case 'switched_off':
      return 'Agent switched off';
    case 'never_installed':
      return 'No agent yet';
    default:
      return 'Never checked in';
  }
}

