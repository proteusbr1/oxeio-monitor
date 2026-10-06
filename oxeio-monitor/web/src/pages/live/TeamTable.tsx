import type { LiveCard } from '../../api/dashboard';
import { useFeatures } from '../../features/FeaturesContext';
import { TaskCell } from './TaskCell';
import { dayDuty, taskView } from './roster';
import { ProgressBar } from '../../components/ProgressRing';
import { StatusChip } from '../../components/StatusDot';
import { PersonCell, Table, type Column } from '../../components/Table';
import { formatDuration, pctOf } from '../../lib/format';
import { useT } from '../../i18n';

/**
 * **Team table, with all six columns of mockup A**: Employee, Today, Target,
 * Month, Progress, Status.
 *
 * Careful: **this replaced `TargetBars`, a deliberate reversal.** The table was
 * first left out on purpose: the bars already show name, status, progress and
 * hours, and a table would lose the carefully written phone layout and bar-colour
 * rules. But the owner approved the mockup **with the table** and later said it did
 * not fully match, so that argument did not hold. Still, **the rules survived**:
 * every comment below was carried over from the bar code, because they are rules of
 * **truth**, not of layout.
 *
 * Important: on a phone the table scrolls sideways in its own frame and **the first
 * column stays pinned** (the `Table` component's sticky first column); otherwise,
 * scrolling across six columns would lose which row you are looking at.
 */
export function TeamTable({ cards }: { cards: LiveCard[] }) {
  const t = useT();
  const { features } = useFeatures();
  /**
   * Careful: an employee on leave goes **to the end of the list**; sorting progress
   *    against zero would make the day off look like a failure.
   */
  const rows = [...cards].sort((a, b) => {
    const ta = hasTarget(a);
    const tb = hasTarget(b);
    if (ta !== tb) return ta ? -1 : 1;
    if (ta && tb) {
      const pa = pctOf(a.todayWorkedSec, a.dailyTargetSec);
      const pb = pctOf(b.todayWorkedSec, b.dailyTargetSec);
      if (pa !== pb) return pb - pa;
    }
    return b.todayWorkedSec - a.todayWorkedSec;
  });

  if (rows.length === 0) return null;

  const columns: Column<LiveCard>[] = [
    {
      key: 'person',
      header: t('Staff'),
      className: 'min-w-40',
      render: (c) => <PersonCell fullName={c.fullName} empCode={c.empCode} />,
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
      key: 'target',
      header: t('Target'),
      align: 'right',
      render: (c) =>
        /*
          Careful: `—` on a day off, not `0`. Zero claims a target that was not
             met; the dash says **there was no target today**.
          Careful: the number is not a hardcoded 8 hours; 7h 42m in a 27-workday month.
        */
        hasTarget(c) ? (
          <span className="num text-ink-2">
            {formatDuration(c.dailyTargetSec)}
          </span>
        ) : (
          /*
            Why the dash is explained on hover. Careful: it used to always say
               "Weekly off or holiday", but the reason can also be personal leave,
               and then the text was plainly wrong.
          */
          <span
            className="text-ink-3"
            title={
              dayDuty(c) === 'leave'
                ? t('On approved leave today')
                : dayDuty(c) === 'none'
                  ? t('No hours target in this work policy')
                  : t('Weekly off or holiday')
            }
          >
            {/* Careful: no target is not a day off; say so instead of the dash */}
            {dayDuty(c) === 'none' ? t('No target') : '—'}
          </span>
        ),
    },
    /*
      Careful: there used to be a **Month** column, "hours per person this month".
      It was removed on the owner's instruction.

      It was added because "you had to go to the Monthly page". But this board table
      is about **today**: Today, Target, Tasks, Progress. The month figure answered
      a different question and made the table wider.

      Careful: the information is not lost: it is on the **Monthly** page, and the
      Worklog roster also has a `This month` column. One click away, not deleted.
    */
    /**
     * **Today's finished tasks.**
     *
     * Careful: the cell is **shared** in `TaskCell`; the Worklog roster shows the
     * same thing. Copying it would let one change and not the other.
     *
     * Careful: the column appears **only when** the Tasks module is on and at
     * least one team member has something to show. Always showing it would leave
     * an empty cell every day in the rows of people who never receive tasks, and
     * an empty cell looks like "no data yet", when they are simply not measured on it.
     */
    ...(features.tasks && cards.some((c) => taskView(c) !== null)
      ? [
          {
            key: 'tasks',
            header: t('Tasks'),
            align: 'right' as const,
            className: 'whitespace-nowrap',
            render: (c: LiveCard) => <TaskCell card={c} />,
          },
        ]
      : []),
    {
      key: 'progress',
      header: t('Progress'),
      className: 'w-40 min-w-32',
      render: (c) => <TodayBar card={c} />,
    },
    {
      key: 'status',
      header: t('Status'),
      /*
        The coloured pill from the mockup. It was not written anew: `StatusChip`
           already existed (used at the top of the card). Careful: building our own
           would define the four status colours twice, and one day one would change
           and the other stay; this very file has a name for that, G88.

        Careful: the mockup also had a time inside the pill ("offline 40m"). It is
           not shown: `LiveCard` has only `lastHeartbeatAt`, which is **when the agent
           last spoke**, not "how long inactive". They are not the same, and showing
           the heartbeat time as the inactivity length would claim something the pill
           does not know.
      */
      render: (c) => <StatusChip status={c.status} />,
    },
  ];

  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(c) => String(c.employeeId)}
      /*
        Careful: the on-leave row is dimmed. Being at the end of the list is not
           signal enough, since the order does not say whether they are "furthest
           behind" or "on leave today".
      */
      rowMuted={(c) =>
        !hasTarget(c) && dayDuty(c) !== 'none' && c.todayWorkedSec === 0
      }
    />
  );
}

/**
 * **Bar is green, as in mockup A** (the owner wanted it 100% identical).
 *
 * Careful: the bar used to be **neutral**, for a real reason: in-progress used to be
 * drawn in brand red, so every person working normally had red burning in their row
 * all day, and within two days red meant "nothing".
 *
 * Important: green does not bring that problem back: green means "fine" in this app,
 * and work in progress really is fine. Careful, though, there is a cost worth
 * writing down: **reaching the target and not reaching it now share one colour**.
 * Green used to mean "done"; now the difference is only the bar's **length** and
 * the percentage beside it.
 */
function TodayBar({ card }: { card: LiveCard }) {
  const t = useT();
  const targeted = hasTarget(card);

  // No target: the Target column says so, and there is nothing to draw a bar against
  if (dayDuty(card) === 'none') {
    return <span className="text-[11px] text-ink-3">—</span>;
  }

  /**
   * **Work done on a day off also shows in the bar, and it is green.**
   *
   * Careful: on a day off everyone used to get an **empty grey rail**, while the
   *    numbers said everyone had worked 3 hours, 2 hours. An empty rail looks
   *    exactly like "zero percent": number and picture in the same row contradicted
   *    each other, and people believe the picture.
   *
   * Careful: it is green from the start, because on a day off **there is no
   *    "not done"**; whatever was done is entirely extra.
   */
  const bonus =
    !targeted && card.todayWorkedSec > 0 && card.dailyTargetSec > 0;

  // Careful: nothing done means no bar. On a day off zero is no shortfall, and a
  //    zero-filled rail would claim exactly that.
  if (!targeted && !bonus) {
    return (
      <div
        className="h-1.5 rounded-full bg-line/60"
        title={t('Weekly off or holiday — nothing is expected today')}
      />
    );
  }

  const pct = Math.round(pctOf(card.todayWorkedSec, card.dailyTargetSec));

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <ProgressBar
          value={card.todayWorkedSec}
          max={card.dailyTargetSec}
          // Always green: in mockup A the bars are green even when partly filled
          tone="ok"
          ariaLabel={
            bonus
              ? t('{{name}} — worked on a day off, against a normal day', { name: card.fullName })
              : t("{{name}} — today's target", { name: card.fullName })
          }
        />
      </div>
      {/* `w-9` keeps the percentages aligned on one line at the right */}
      <span className="num w-9 shrink-0 text-right text-[11px] text-ink-3">
        {pct}%
      </span>
    </div>
  );
}

/**
 * Whether this employee really has a target today; on a day off they do not.
 *
 * Careful: the rule is no longer **written** here; it lives in `dayDuty()` in
 *    `roster.ts`. It used to be written three times on three screens, and personal
 *    leave (G130) got added to one but not the other two.
 */
function hasTarget(card: LiveCard): boolean {
  return dayDuty(card) === 'target';
}
