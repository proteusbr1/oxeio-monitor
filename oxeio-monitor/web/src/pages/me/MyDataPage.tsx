import { Link } from 'react-router-dom';

import { getMyDays, getMyDeposit, getMySummary, type MyDay } from '../../api/me';
import { useApi } from '../../api/useApi';
import { seesEveryone } from '../../api/auth';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
import { MyTasks } from '../tasks/MyTasks';
import { Card, Stat, StatRow } from '../../components/Card';
import { Duration } from '../../components/Duration';
import { Page } from '../../components/Page';
import { ProgressBar, ProgressRing } from '../../components/ProgressRing';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table } from '../../components/Table';
import {
  formatDate,
  formatDateShort,
  formatSignedDuration,
  shiftWorkDate,
  todayInWorkZone,
  weekdayOf,
} from '../../lib/format';
import { Adjustments } from '../staff/Adjustments';

/**
 * The employee's own page.
 *
 * Careful: the tray menu has had a **"My data"** item since day one, and clicking
 * it opened the browser to a 404; the page had never been built. So the
 * transparency promise was in front of staff every day, and broken every day.
 *
 * Important: <b>the page has one job: "what does the system know about me", in one
 * place.</b> So it has four things and nothing more:
 *   1. Today's and the month's hours (the exact same numbers as the tray)
 *   2. A day-by-day list, including leave and empty days
 *   3. Hour adjustments, with reasons
 *   4. Their own screenshots and the policy's terms
 *
 * Careful: **no buttons**: no "claim time", no "give an explanation". Adding one
 * would be the first step of an approval workflow, which this system deliberately
 * does not have (ADR-011d). The tray window has no buttons for the same reason.
 */
export function MyDataPage() {
  const { user } = useAuth();
  const { features } = useFeatures();
  const today = todayInWorkZone();

  /**
   * Careful: an owner's and a manager's `users.employee_id` is normally null; they
   * are not tied to an employee row. The server returns 403 for them, but that
   * would show on screen as *"You don't have access"*, which is misleading to an
   * owner (who has access to everything). The real point is different: **they have
   * no hours of their own**. So the request is never sent.
   */
  const linked = user?.employeeId != null;

  const summary = useApi(
    (signal) => (linked ? getMySummary(signal) : Promise.resolve(null)),
    [linked],
  );

  /**
   * "See yours" on What Is Recorded: only when the Screenshots route exists
   * for this login (`canSeeScreenshots`, from the server) — and, for staff,
   * when Settings → Privacy lets them see their own.
   */
  const seesOwnShots =
    user?.canSeeScreenshots === true &&
    (seesEveryone(user.role) || summary.data?.canSeeOwnScreenshots === true);

  /**
   * Careful: **rolling 30 days, not "the current month".** Showing the current
   * month on the 1st would leave one row in the list, and that is exactly when
   * people want to cross-check the last days of last month. The numbers above are
   * for the month though; that is the contract's unit (O8).
   */
  const from = shiftWorkDate(today, -29);
  const days = useApi(
    (signal) => (linked ? getMyDays(from, today, signal) : Promise.resolve([])),
    [linked, from, today],
  );

  /**
   * **Their own deposit.** This is exactly what the owner wanted: *"every staff
   * member can also see on their dashboard how much money of theirs has built up"*.
   *
   * Careful: a separate call, not joined to `summary`, so that the rest of the page
   * works fine even when there is no deposit (rule off, or they are new). Mixing
   * them into one call would let one's failure blank out the other too.
   */
  const deposit = useApi(
    (signal) =>
      linked && features.deposits ? getMyDeposit(signal) : Promise.resolve(null),
    [linked, features.deposits],
  );

  const p = summary.data?.progress;

  return (
    <Page
      title="My data"
      subtitle={
        summary.data
          ? `${summary.data.employee.fullName} · ${summary.data.employee.empCode}`
          : (user?.fullName ?? '')
      }
    >
      {!linked && (
        <Empty
          title="This account has no hours of its own"
          hint="Owner and manager accounts are not linked to a staff record, so there is nothing personal to show here. Staff see their own hours on this page."
        />
      )}

      {linked && summary.loading && <Loading />}
      {linked && summary.error && (
        <ErrorBox error={summary.error} retry={summary.reload} />
      )}

      {p && summary.data && (
        <div className="space-y-4">
          <StatRow>
            <Stat
              label="Today"
              value={<Duration seconds={p.todayActiveSec} />}
            />
            <Stat
              label="This month"
              value={<Duration seconds={p.monthActiveSec} />}
              unit={p.noTarget ? undefined : `/ ${p.monthlyTargetHours}h`}
            />
            <Stat
              label="Last 7 days"
              value={<Duration seconds={p.week7ActiveSec} />}
            />
            {/*
              Important: **only one** possible red tile on the whole page: being behind.
              Careful: not red when ahead; making every tile red would erase red's meaning.
            */}
            {/*
              "Not yet observed" and "ahead" are not the same.
              Careful: this tile used to show "Ahead 0s" on a new employee's first day.
                 The number was not a lie, the sentence was: not one of their
                 workdays had been observed to the end yet.
            */}
            {p.noTarget ? (
              // Careful: no target means no pace; say so, not "Ahead 0s"
              <Stat label="Target" value="No target" tone="muted" />
            ) : p.observed ? (
              <Stat
                label={p.paceSec < 0 ? 'Behind' : 'Ahead'}
                value={formatSignedDuration(p.paceSec)}
                tone={p.paceSec < 0 ? 'attention' : 'counted'}
              />
            ) : (
              <Stat
                label="Pace"
                value="Not observed yet"
                tone="muted"
                sub="no finished workday counted for you yet"
              />
            )}
          </StatRow>

          {/*
            **Their own tasks**: near the top, because for someone who receives
               tasks the day's work starts here.
            Careful: for someone with no tasks the card **is not rendered**; an
               empty box on the page of someone who never receives tasks is pointless.
          */}
          {features.tasks && <MyTasks progress={summary.data.tasks} />}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="Where You Are"
              hint="The same numbers your tray icon shows"
            >
              {p.noTarget ? (
                /*
                  Careful: no hours target. A ring or bar against 0 would be empty
                     or full for no reason, and a 0 daily target is not a day off,
                     so the hours are shown plainly.
                */
                <dl className="space-y-1.5 text-[13px]">
                  <PlainLine label="Today" seconds={p.todayActiveSec} />
                  <PlainLine label="Last 7 days" seconds={p.week7ActiveSec} />
                  <PlainLine label="This month" seconds={p.monthActiveSec} />
                </dl>
              ) : (
                <div className="flex flex-wrap items-center gap-6">
                  <div className="flex items-center gap-3">
                    <ProgressRing
                      value={p.monthActiveSec}
                      max={p.monthlyTargetHours * 3600}
                      size={64}
                      ariaLabel="This month"
                    />
                    <div className="text-[13px]">
                      <div className="font-medium">This month</div>
                      <div className="text-ink-3">
                        <Duration seconds={p.monthActiveSec} /> of{' '}
                        {p.monthlyTargetHours}h
                      </div>
                    </div>
                  </div>

                  <div className="min-w-[180px] flex-1 space-y-3">
                    {/*
                      Careful: on a day off the daily target is 0; show a sentence, not an
                         empty bar. An empty bar says "8 hours still to go today" and
                         nags, when nothing is expected today. The tray window follows
                         the same rule.
                    */}
                    {p.dailyTargetSec > 0 ? (
                      <Line
                        label="Today"
                        value={p.todayActiveSec}
                        max={p.dailyTargetSec}
                      />
                    ) : (
                      <p className="text-[13px] text-ink-2">
                        Today is a day off — nothing is expected. Anything you do
                        work still counts.
                      </p>
                    )}

                    <Line
                      label="Last 7 days"
                      value={p.week7ActiveSec}
                      max={p.week7TargetSec}
                    />
                  </div>
                </div>
              )}
            </Card>

            {/*
              **Transparency box.** The numbers that staff were told in writing in
              the policy are here, so they need not hunt for them.
              Careful: the screenshot retention comes from the server, not written by
                 hand; if the policy changed, the page would show an old promise.
            */}
            {/*
              **Deposit total.** Careful: the card appears only when something has
                 really accumulated (or been settled); a card showing zero would only
                 raise questions.
              Careful: no salary figure here, and that does not break the rule: the
                 amount is their own money, not a pay calculation. Nobody's salary can
                 be worked out from it.
            */}
            {deposit.data &&
              (deposit.data.totalPaisa > 0 || deposit.data.settlement) && (
                <Card
                  title="Security Deposit"
                  hint={
                    deposit.data.settlement
                      ? 'Settled — this is the record'
                      : `Held from your salary · ${deposit.data.months.length} ${
                          deposit.data.months.length === 1 ? 'month' : 'months'
                        }`
                  }
                >
                  <div className="num text-[26px] font-semibold">
                    {deposit.data.settlement
                      ? deposit.data.settlement.amount
                      : deposit.data.total}
                  </div>

                  {deposit.data.settlement ? (
                    <p className="mt-1 text-[13px] text-ink-2">
                      {deposit.data.settlement.outcome === 'refunded'
                        ? 'Refunded to you'
                        : 'Not refunded — the notice period was short'}
                      {deposit.data.settlement.note &&
                        ` · ${deposit.data.settlement.note}`}
                    </p>
                  ) : (
                    <p className="mt-1 text-[13px] text-ink-2">
                      This is your money, held back each month. You get all of
                      it when you leave, as long as you give at least{' '}
                      {deposit.data.noticeDays} days&apos; notice.
                    </p>
                  )}

                  {/*
                    The month-by-month list is also here: the answer to "which month was
                       it deducted" should be on their own page, or they would have to go
                       to the owner to check.
                  */}
                  {deposit.data.months.length > 0 && (
                    <ul className="mt-3 divide-y divide-line border-t border-line text-[13px]">
                      {deposit.data.months.map((m) => (
                        <li
                          key={m.yearMonth}
                          className="flex items-baseline justify-between py-1.5"
                        >
                          <span className="num text-ink-2">{m.yearMonth}</span>
                          <span className="num">{m.amount}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}

            <Card title="What Is Recorded" hint="And for how long">
              <dl className="space-y-2.5 text-[13px]">
                {/*
                  Every line here comes from the server (`/me`): whether pictures
                  are taken depends on the Screenshots module *and* their own work
                  policy, and the days on Settings → Privacy. Written by hand it
                  would turn into a promise nobody keeps.
                */}
                <Row term="Screenshots">
                  {summary.data.screenshotsTaken
                    ? `Kept ${summary.data.screenshotRetentionDays} days, then deleted automatically — `
                    : 'Not taken — no pictures of your screen are recorded.'}
                  {/* the link only where the route exists (`canSeeScreenshots`) */}
                  {seesOwnShots ? (
                    summary.data.screenshotsTaken ? (
                      <Link to="/screenshots" className="underline">
                        see yours
                      </Link>
                    ) : (
                      <>
                        {' '}
                        Any taken earlier are deleted after{' '}
                        {summary.data.screenshotRetentionDays} days —{' '}
                        <Link to="/screenshots" className="underline">
                          see them
                        </Link>
                      </>
                    )
                  ) : summary.data.screenshotsTaken ? (
                    'seen by the owner and managers only'
                  ) : null}
                </Row>
                <Row term="Apps & websites">
                  {summary.data.appsTracked
                    ? 'Which app is in front and its window title; for websites, the site name only — never the full address.'
                    : 'Not recorded — only whether the keyboard and mouse are in use.'}
                </Row>
                <Row term="Working hours">
                  Active time only. Idle and locked time is recorded but never
                  counted as work.
                </Row>
                <Row term="Policy signed">
                  {summary.data.policySignedAt
                    ? formatDate(summary.data.policySignedAt)
                    : 'Not recorded yet'}
                </Row>
                {summary.data.employee.joinedOn && (
                  <Row term="Joined">
                    {formatDate(summary.data.employee.joinedOn)}
                  </Row>
                )}
              </dl>
            </Card>
          </div>
        </div>
      )}

      {linked && (
        <div className="mt-4 space-y-4">
          <Card
            title="Day by Day"
            hint="Last 30 days · days off and empty days are shown too"
            padded={false}
          >
            {days.loading && <Loading />}
            {days.error && <ErrorBox error={days.error} retry={days.reload} />}
            {days.data?.length === 0 && <Empty title="Nothing recorded yet" />}
            {days.data && days.data.length > 0 && (
              <DayTable rows={days.data} monthCreditedSec={p?.monthCreditedSec} />
            )}
          </Card>

          {/*
          Adjustments to their own hours, with reasons. The component is **shared**
          with the owner's page: the owner gets the add button there, staff only see
          the list (`isOwner` is checked inside). Writing two separate components
          would one day show different reasons on the two pages.
        */}
          {user?.employeeId != null && (
            <Adjustments employeeId={user.employeeId} nonce={0} />
          )}
        </div>
      )}
    </Page>
  );
}

function PlainLine({ label, seconds }: { label: string; seconds: number }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-ink-2">{label}</dt>
      <dd className="num font-medium">
        <Duration seconds={seconds} />
      </dd>
    </div>
  );
}

function Line({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
        <span className="text-ink-2">{label}</span>
        <span className="text-ink-3">
          <Duration seconds={value} /> / <Duration seconds={max} />
        </span>
      </div>
      <ProgressBar value={value} max={max} ariaLabel={label} />
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="min-w-[120px] text-ink-3">{term}</dt>
      <dd className="min-w-0 flex-1 text-ink-2">{children}</dd>
    </div>
  );
}

/**
 * Careful: **the total below is not computed here.**
 *
 * It used to be (`rows.filter(...).reduce(...)`), and it disagreed with the
 * *"This month"* tile above for three separate reasons: the list is a rolling 30
 * days (on the 31st the 1st would not appear), adjustments only entered the lower
 * one, and with work on two PCs at once the lower one counted the time twice.
 *
 * Important: now the number is the server's, exactly what it uses to compute pace.
 *
 * Careful: so this is **not the sum of the rows above**, it is the month's sum. On
 * the 31st the list starts from the 2nd while the number also includes the 1st;
 * that is intended, and the label says *"This month"*, not "Total".
 */
function DayTable({ rows, monthCreditedSec }: {
  rows: MyDay[];
  /**
   * Careful: **`undefined` means "unknown", not 0.** The summary call above is
   *    separate; this list can arrive even if that failed. Writing 0 then would
   *    make the screen say "you did nothing this month", when the truth is "the
   *    number could not be fetched".
   */
  monthCreditedSec: number | undefined;
}) {
  return (
    <Table
      rows={rows}
      rowKey={(r) => r.workDate}
      // Careful: days off are dimmed: not "did not work" but "was not expected to"
      rowMuted={(r) => r.isOffDay && r.workedSec === 0}
      columns={[
        {
          key: 'date',
          header: 'Date',
          render: (r) => (
            <span className="num">
              {formatDateShort(r.workDate)}{' '}
              <span className="text-ink-3">{weekdayOf(r.workDate)}</span>
            </span>
          ),
        },
        {
          key: 'worked',
          header: 'Worked',
          align: 'right',
          render: (r) => (
            <Duration
              seconds={r.workedSec}
              tone={r.workedSec === 0 ? 'muted' : 'counted'}
            />
          ),
        },
        {
          key: 'adjust',
          header: 'Correction',
          align: 'right',
          render: (r) =>
            // Careful: a dash at zero; writing `+0:00` would make every row look
            //    as if something had changed
            r.adjustmentSec === 0 ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="num">
                {formatSignedDuration(r.adjustmentSec)}
              </span>
            ),
        },
        {
          key: 'credited',
          header: 'Counted',
          align: 'right',
          render: (r) => <Duration seconds={r.creditedSec} />,
        },
        {
          key: 'note',
          header: '',
          render: (r) =>
            r.isOffDay ? (
              <span className="text-[11.5px] text-ink-3">Day off</span>
            ) : null,
        },
      ]}
      footer={
        <tr>
          <td className="px-3 py-2 text-[12.5px] text-ink-3">
            This month so far
            {/* Careful: which column the total is for is written out; otherwise readers
                would try to reconcile it as the sum of "Worked" (G162) */}
            <span className="text-ink-3/70"> · counted</span>
          </td>
          <td colSpan={3} className="px-3 py-2 text-right">
            {monthCreditedSec === undefined ? (
              <span
                className="text-ink-3"
                title="Could not load this month's total"
              >
                —
              </span>
            ) : (
              <Duration seconds={monthCreditedSec} />
            )}
          </td>
          <td />
        </tr>
      }
    />
  );
}
