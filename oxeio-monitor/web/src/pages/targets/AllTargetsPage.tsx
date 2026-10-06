import { useEffect, useState, type ReactNode } from 'react';

import {
  deleteTarget,
  deleteTargets,
  listTargetAdders,
  undoComplete,
  listTargetDesigners,
  listTargets,
  markLive,
  markChecked,
  markFixed,
  markReviewed,
  markUploaded,
  targetStats,
  type DropReason,
  type TargetRow,
  type TargetStatus,
  updateTarget,
} from '../../api/targets';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import { formatCount, formatDate, formatDateTime, formatDuration, todayInWorkZone } from '../../lib/format';
import {
  Chip,
  MiniButton,
  Modal,
  Notice,
  ServerError,
  useMutation,
} from '../../components/ui';
import {
  dropdownValueOf,
  FILTERS,
  stageOf,
  STATUS_OPTIONS,
  type FilterKey,
  type Stage,
} from './filters';
import { DropReasonPicker, DropReasonTag } from './DropReason';

/**
 * **All design targets**: the sidebar entry is **"Design Pool"** (a name the
 * owner chose).
 *
 * Careful: the file is still called `AllTargetsPage` on purpose. Renaming the
 * route (`targets/all`), the imports and App.tsx together would be needless
 * churn, and users never see the file name. Screen name and file name differ,
 * which can confuse, so it is noted here.
 *
 * Important: **the word "Pool" appears again on this page**, in the status chip
 * (`Pool` = not yet handed to anyone). So although the page is named "Design
 * Pool", it shows **every status**, not only the pool. The subtitle ("Every
 * link, and where it stands") is there for exactly that reason.
 *
 * Careful: the submission page is separate. They are two different jobs, and
 * on one page every paste of 500 lines would also load the 39,000-row list.
 */
export function AllTargetsPage() {
  return (
    <Page title="Design Pool" subtitle="Every link, and where it stands">
      <TargetList />
    </Page>
  );
}


/**
 * **The full list.**
 *
 * Important: **this could not be built without pagination.** The table has
 * more than 39,000 rows; fetching them all would make a response of several MB
 * and the browser would freeze drawing the table.
 *
 * The search box accepts **a URL or an ASIN**: a researcher can paste a link
 * to check whether it was already done, and by whom.
 */
/** Today's date in Dhaka, `YYYY-MM-DD` */
function workToday(): string {
  // Careful: `toISOString()` gives UTC; in Dhaka before 6 am it would show yesterday
  return todayInWorkZone();
}

/**
 * **One table, two pages.**
 *
 * Careful: when `lockedStage` is given the page **stays locked to that queue**:
 * the chip row and the status dropdown are not shown, because with them someone
 * could leave the Review page and look at something else, and the page's name
 * would no longer match its subject.
 *
 * Search and the other filters (designer · added by · date) **stay**: they are
 * for searching inside the queue, not for leaving it.
 *
 * Careful: the markup is **shared, not copied**. Lesson from the Worklog page:
 * with copies in two places, one day one changes and the other does not.
 */
export function TargetList({ lockedStage }: { lockedStage?: Stage } = {}) {
  const [filter, setFilter] = useState<FilterKey>(lockedStage ?? 'all');
  /** Careful: the locked page does not show the controls for switching queues */
  const showQueues = lockedStage === undefined;
  const [q, setQ] = useState('');
  const [staffId, setStaffId] = useState('');
  /** Added by: `users.id`, which is different from `staffId` (`employees.id`) */
  const [addedById, setAddedById] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  /** Whether the other filters are open; closed by default */
  const [showFilters, setShowFilters] = useState(false);
  const edit = useMutation();

  /**
   * **Selected rows.** Requested by the owner so that "not found" ASINs can be
   * selected when deleting.
   *
   * Careful: a `Set`, not `TargetRow[]`: all we need is "is it selected", and
   * the rest of the row's data is in the list anyway. Keeping rows would leave
   * stale copies in hand after a refresh.
   */
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  /** Careful: how many finished rows were skipped; said once after deleting, then silent */
  const [kept, setKept] = useState(0);

  const designers = useApi(listTargetDesigners, []);
  /**
   * **Who added how many.**
   *
   * Careful: the number is written inside the dropdown, so the owner gets the
   * answer **without clicking anything**; filtering is the next step, not required.
   */
  const adders = useApi(listTargetAdders, []);
  /** The number beside the chip: you need to know there is work **before** clicking */
  const stats = useApi(targetStats, []);

  /**
   * The condition has a **name**; `role !== 'employee'` is not written inline.
   *
   * Careful: in this project, unnamed permission conditions have repeatedly
   * caused bugs (G134: a manager saw Settings in the nav and, when clicking it,
   * got "There's nothing at this address"). With a name, all places change together.
   */
  const { user } = useAuth();
  const mayDelete = user?.role === 'owner' || user?.role === 'manager';

  const data = useApi(
    (signal) =>
      listTargets(
        {
          /**
           * Careful: the queues are not a `status`, so they are sent separately.
           *    When `stage` is set, `status` is **not** sent; otherwise the two
           *    filters would combine and the queue would look empty.
           */
          ...(stageOf(filter)
            ? { stage: stageOf(filter) }
            : filter === 'all'
              ? {}
              : { status: filter as TargetStatus }),
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(staffId ? { staffId: Number(staffId) } : {}),
          ...(addedById ? { addedById: Number(addedById) } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          page,
        },
        signal,
      ),
    [filter, q, staffId, addedById, from, to, page],
  );

  /**
   * Important: **changing the filter or the page clears the selection, and
   * this is a safety condition.** Otherwise, selecting 50 on page 2, then
   * changing the filter and pressing Delete would remove rows **that are not
   * in front of your eyes**, and nobody would know what went.
   */
  useEffect(() => {
    setPicked(new Set());
    setKept(0);
  }, [filter, q, staffId, addedById, from, to, page]);

  /**
   * **The count on the collapsed filters' button.**
   *
   * Careful: a hidden filter is a trap in itself: someone coming back
   * tomorrow sees an empty list and thinks data was lost, when yesterday's
   * date was still set. This number closes the trap; when the button shows a
   * number it also turns red.
   */
  const activeFilters =
    (staffId ? 1 : 0) + (addedById ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);

  /**
   * What the dropdown shows: `all` when a queue chip is selected.
   *
   * Careful: the chip and the dropdown work off **the same variable** (`filter`),
   * so picking one releases the other by itself. With two separate variables
   * both would apply one day and the list would look empty.
   *
   * Careful: `done_today` is not a real status, so it is worked out by
   * matching, not remembered. If remembered, the dropdown would still say
   * "today" after the owner changes the dates by hand.
   */
  const today = workToday();
  const statusValue = dropdownValueOf(filter, from, to, today);

  const rows = data.data?.rows ?? [];
  /** Careful: `every()` is true on an empty page, so the count is checked too */
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));

  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)));

  const toggleOne = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      // Careful: add only if `delete()` returned false; not a two-line if/else
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /**
   * The checkbox column is only for people who may delete; on a researcher's
   * screen they could select rows but nothing could be done with them.
   */
  const pickColumn: Column<TargetRow>[] = mayDelete
    ? [
        {
          key: 'pick',
          className: 'w-8',
          header: (
            <input
              type="checkbox"
              className="tap"
              aria-label="Select every row on this page"
              checked={allPicked}
              onChange={toggleAll}
            />
          ),
          render: (r) => (
            <input
              type="checkbox"
              className="tap"
              aria-label={'Select ' + r.asin}
              checked={picked.has(r.id)}
              onChange={() => toggleOne(r.id)}
            />
          ),
        },
      ]
    : [];

  /** Careful: changing a filter or the search goes back to page 1; otherwise
   *  you would sit on page 5 seeing "nothing here" although results exist */
  /**
   * Is the text a link? A `/` or `:` is enough.
   *
   * Careful: this is deliberately not exact URL parsing. The job is only to
   *    **show a hint**, not to block anything. An ASIN or Job number contains neither character.
   */
  const looksLikeUrl = /[/:]/.test(q);

  const change = (next: () => void) => {
    setPage(1);
    next();
  };

  return (
    <Card
      title="Every Target"
      /*
        Careful: "Newest activity first" used to be a separate label in the
           filter row; it took a whole control's space and did nothing.
        It is true and useful, so it was not deleted; it moved next to the count.
      */
      hint={
        data.data
          ? `${data.data.total} in total · newest activity first`
          : 'Loading…'
      }
      padded={false}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        {showQueues &&
          FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => change(() => setFilter(f.key))}
            title={
              f.stage === 'to_check'
                ? 'Finished designs whose spelling has not been checked yet'
                : f.stage === 'to_fix'
                  ? 'A spelling error was found — waiting to be fixed'
                  : f.stage === 'to_upload'
                    ? 'Checked or not yet checked, and not sent to Amazon. Designs with an unfixed error are held back.'
                    : f.stage === 'to_review'
                      ? 'Skipped or deleted, with a reason — nobody has looked at these yet'
                      : f.stage === 'to_live'
                      ? 'Sent to Amazon, not live yet'
                      : undefined
            }
            className={`rounded-full border px-3 py-1 text-[12.5px] transition ${
              filter === f.key
                ? 'border-brand bg-brand-bg font-semibold text-brand-ink'
                : 'border-line text-ink-2 hover:border-brand'
            }`}
          >
            {f.label}
            {/*
              The count is on the chip itself: you need to know whether there is
                 work today **before** clicking. Careful: it is shown even at 0,
                 because "0" means "I'm done", the only reward here.
            */}
            {stats.data ? (
              <span className="num ml-1.5 text-ink-3">
                {f.stage === 'to_check'
                  ? stats.data.toCheck
                  : f.stage === 'to_fix'
                    ? stats.data.toFix
                    : f.stage === 'to_upload'
                      ? stats.data.toUpload
                      : f.stage === 'to_review'
                        ? stats.data.toReview
                        : stats.data.toLive}
              </span>
            ) : null}
          </button>
          ))}

        {/*
          **One dropdown instead of five status chips.**

          Careful: choosing `done_today` also sets both dates, so the value
             comes back as `done`; `statusValue` below matches it and shows
             `done_today` again. What the dropdown says is exactly what the
             filter does; if they differed nobody would trust it.
        */}
        {showQueues && (
          <select
            value={statusValue}
          onChange={(e) =>
            change(() => {
              const v = e.target.value;
              if (v === 'done_today') {
                setFilter('done');
                setFrom(workToday());
                setTo(workToday());
                return;
              }
              setFilter(v as FilterKey);
              // Careful: leaving "today" must also clear both dates, otherwise
              //    someone picking "Done" would see an empty list and think data was lost
              if (statusValue === 'done_today') {
                setFrom('');
                setTo('');
              }
            })
          }
          className={`rounded-md border px-2 py-1 text-[12.5px] transition ${
            statusValue === 'all'
              ? 'border-line bg-paper text-ink'
              : 'border-brand bg-brand-bg font-semibold text-brand-ink'
          }`}
        >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}

        {/*
          **The other filters are collapsed.**

          Careful: all four fields (designer · added by · two dates) **sit empty**
             most of the time, yet take a whole row of the screen every day.

          Careful: but a hidden filter is a trap in itself: someone coming back
             tomorrow sees an empty list and thinks data was lost. So the button
             carries a **count**, and with a count it stays red.
             Hidden, but not silent.
        */}
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className={`rounded-md border px-2.5 py-1 text-[12.5px] transition ${
            activeFilters > 0
              ? 'border-brand bg-brand-bg font-semibold text-brand-ink'
              : 'border-line text-ink-2 hover:border-brand'
          }`}
        >
          Filters
          {activeFilters > 0 && <span className="num ml-1.5">{activeFilters}</span>}
          <span className="ml-1 text-ink-3">{showFilters ? '▴' : '▾'}</span>
        </button>

        {/*
          **ASIN or Job number.**
             Every row shows its Job number underneath, yet until now you could not
             search by it; the only identity was the ASIN.

          Careful: **links no longer work.** Pasted URLs used to be reduced to
             an ASIN; the owner asked for that to be removed.
        */}
        <input
          value={q}
          onChange={(e) => change(() => setQ(e.target.value))}
          placeholder="ASIN or job no…"
          className="num ml-auto w-full max-w-[260px] rounded-md border border-line bg-paper px-2.5 py-1 text-[12.5px] text-ink"
        />
      </div>

      {/*
        Careful: when a link is pasted, the user **is told**. Otherwise the result
           would be a silent empty list, and the user would think the design is not
           in the pool when it is. A silent wrong answer is the failure this app dislikes most.
      */}
      {looksLikeUrl && (
        <div className="px-4 pb-2 text-[12px] text-idle-ink">
          Links are not searched any more — paste the <b>ASIN</b> or the{' '}
          <b>job number</b> instead.
        </div>
      )}

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <select
            value={staffId}
            onChange={(e) => change(() => setStaffId(e.target.value))}
            className="rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink"
          >
            <option value="">Any designer</option>
            {(designers.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.empCode} · {d.fullName}
              </option>
            ))}
          </select>

          {/*
            Careful: looks the same as the dropdown beside it, but is the **id of a
               different table**: that one is `employees`, this one `users`. The
               labels are kept different so they don't look like twins.
            The number beside each name lets the owner see who added how many
               **before** filtering.
          */}
          <select
            value={addedById}
            onChange={(e) => change(() => setAddedById(e.target.value))}
            className="rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink"
          >
            <option value="">Added by anyone</option>
            {(adders.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName} · {formatCount(a.count)}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => change(() => setFrom(e.target.value))}
              className="num rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink"
            />
          </label>

          <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
            to
            <input
              type="date"
              value={to}
              onChange={(e) => change(() => setTo(e.target.value))}
              className="num rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink"
            />
          </label>

          {activeFilters > 0 && (
            <button
              type="button"
              onClick={() =>
                change(() => {
                  setStaffId('');
                  setAddedById('');
                  setFrom('');
                  setTo('');
                })
              }
              className="text-[12px] text-data hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      <div className="px-4">
        <ServerError error={edit.error} />
      </div>

      {/*
        **What the list says, and what it does not.**

        Important: this text is not optional. Read without explanation, a "no
           evidence" list is an **indictment**, yet the most common reason for
           no trace is innocent: in the field, someone works all day in
           `Untitled-20*` and never saves, so 80% of their work leaves no trace
           although the work was done. The number is not wrong; its **meaning**
           is easy to misread.
      */}
      {filter === 'no_file' && (
        <div className="px-4 pb-1">
          <Notice>
            These were marked <b>done</b>, but no file whose name starts with
            that job number was ever open in Illustrator or Photoshop.{' '}
            <b>That is a question, not a verdict</b> — a file saved without the
            job number in its name, or never saved at all, leaves no trace
            either.
            {data.data?.traceSince ? (
              <>
                {' '}
                Window titles are kept from{' '}
                <span className="num">
                  {formatDate(data.data.traceSince)}
                </span>{' '}
                onward, so nothing older is listed.
              </>
            ) : null}
          </Notice>
        </div>
      )}

      {data.loading && !data.data && <Loading />}
      {data.error && <ErrorBox error={data.error} retry={data.reload} />}

      {data.data && data.data.rows.length === 0 && (
        <div className="px-4 py-6 text-[13px] text-ink-3">
          Nothing matches that.
        </div>
      )}

      {data.data && data.data.rows.length > 0 && (
        <>
          {/*
            **How many are selected, and what can be done with them.** The bar
               appears only when at least one is selected. Careful: if always
               shown, it would leave an empty strip at the top of the page, and
               the whole point of the August trimming was fewer things on this page.
          */}
          {mayDelete && picked.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper px-4 py-2.5">
              <span className="text-[12.5px] text-ink-2">
                <span className="num font-semibold">{picked.size}</span> selected
              </span>
              <span className="flex gap-2">
                <MiniButton
                  disabled={edit.busy}
                  onClick={() => setPicked(new Set())}
                >
                  Clear
                </MiniButton>
                <MiniButton
                  tone="danger"
                  disabled={edit.busy}
                  onClick={() => setConfirmingBulk(true)}
                >
                  Delete
                </MiniButton>
              </span>
            </div>
          )}

          {/*
            Careful: **the rows that were not deleted are reported too.** After
               selecting 50 and deleting 48, without saying what happened to the
               other two people would assume all went, and finished work would
               silently stay in the list.
          */}
          {kept > 0 && (
            <div className="px-4 pt-3">
              <Notice tone="attention">
                <span className="num font-semibold">{kept}</span> finished{' '}
                {kept === 1 ? 'design was' : 'designs were'} left alone — deleting
                those would take away work that was really done. Undo them first
                if they must go.
              </Notice>
            </div>
          )}

          {/*
            Careful: **an open `Modal`, not `ConfirmDialog`, and the reason is
               structural.** That dialog has its own "Delete" button, so the
               reason picker could not be tied to it: either rows could be deleted
               with no reason, or a default would have to be preset, and a default
               means nobody ever picks thoughtfully. Here **all three reasons are
               the buttons below**, so there is no way to delete without choosing one.
          */}
          {confirmingBulk && (
            <Modal
              title={
                picked.size === 1
                  ? 'Delete 1 target?'
                  : 'Delete ' + picked.size + ' targets?'
              }
              onClose={() => setConfirmingBulk(false)}
              footer={
                <DropReasonPicker
                  busy={edit.busy}
                  onPick={(reason) =>
                    edit.run(async () => {
                      const res = await deleteTargets([...picked], reason);
                      setKept(res.keptDone);
                      setPicked(new Set());
                      setConfirmingBulk(false);
                      data.reload();
                      stats.reload();
                    })
                  }
                  onCancel={() => setConfirmingBulk(false)}
                />
              }
            >
              <div className="space-y-3">
                <p className="text-[13px] text-ink-2">
                  Use this for links whose Amazon page is gone.
                </p>
                {/*
                  Careful: the consequence is stated **both ways**: it will never go to
                     anyone again, and that ASIN can never return to the pool. The second
                     is the whole reason for this change, so it must not be hidden.
                */}
                <Notice tone="attention">
                  They stay in the list as Deleted, never go to anyone again, and
                  the same ASIN can never be added back to the pool. Finished
                  designs in the selection are left alone.
                </Notice>
                <ServerError error={edit.error} />
              </div>
            </Modal>
          )}

          <Table
            rows={data.data.rows}
            rowKey={(r) => String(r.id)}
            columns={[
              ...pickColumn,
              /*
                **Seven columns down to four** (owner's decision: the table
                   looked crowded).

                Careful: no information was removed; columns were **merged**, and
                   not arbitrarily:
                     · Job no. under ASIN       (both are *identity*)
                     · date under Stage         (same idea: which step, when)
                     · added by with who's doing it (one *sentence*, not two cells)
              */
              {
                key: 'design',
                header: 'Design',
                render: (r) => (
                  <span className="block">
                    <a
                      href={r.url}
                      target="_blank"
                      // Careful: prevents tabnabbing; the new tab must not be able to navigate this page
                      rel="noreferrer noopener"
                      className="num text-data hover:underline"
                    >
                      {r.asin}
                    </a>
                    {/*
                      Careful: **if there is no job number the line is not rendered at
                         all**; blank space is calmer than a "—", and a row sitting in
                         the pool never has a number anyway.
                    */}
                    {r.jobNumber !== null && (
                      <span className="num block text-[11.5px] text-ink-3">
                        Job {r.jobNumber}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'stage',
                header: 'Stage',
                render: (r) => (
                  <span className="block">
                    {/*
                      The reason goes **beside** the chip, not below it: the line
                         below is the date, and two different things on one line
                         could not be told apart.
                    */}
                    <span className="flex flex-wrap items-center gap-1.5">
                      <StatusChip row={r} />
                      <DropReasonTag reason={r.dropReason} />
                      {/*
                        Once reviewed, who reviewed it is shown here: the row leaves
                           the queue, so otherwise that information would be nowhere.
                      */}
                      {r.reviewedAt !== null && (
                        <Chip tone="counted">
                          Reviewed{r.reviewedBy ? ` · ${r.reviewedBy.fullName}` : ''}
                        </Chip>
                      )}
                    </span>
                    <WhenCell row={r} />
                  </span>
                ),
              },
              /**
               * **The measure beside the claim.** Requested by the owner, so a
               * "done" mark can be backed up.
               *
               * Careful: **why this column was needed.** The "done" mark is the
               * employee's own click and nobody verifies it. When one person's 32
               * "done"s were questioned, answering meant writing a query by hand in
               * the database, because the screen showed the claim and nothing
               * beside it.
               *
               * Nothing new had to be stored: the agent already keeps window
               * titles, and file names start with the job number.
               */
              {
                key: 'file',
                header: 'File',
                className: 'hidden sm:table-cell',
                render: (r) => <FileCell sec={r.fileSec} />,
              },
              {
                key: 'people',
                header: 'People',
                /*
                  **"Added by → doing it"**: the whole story of a row.

                  Careful: two different id worlds sit in one cell (`users` →
                     `employees`), and the arrow shows that: on the left whoever
                     **brought** the work, on the right whoever is **doing** it.

                  Careful: the adder's name is **grey**, the doer's name dark: in
                     daily work the designer's name is needed more, so the weight goes there.
                */
                className: 'hidden sm:table-cell',
                render: (r) => <PeopleCell row={r} />,
              },
              {
                key: 'edit',
                header: '',
                render: (r) => (
                  <RowActions
                    row={r}
                    busy={edit.busy}
                    onChange={(status) =>
                      edit.run(async () => {
                        await updateTarget(r.id, status);
                        data.reload();
                      })
                    }
                    onChecked={(ok) =>
                      edit.run(async () => {
                        await markChecked(r.id, ok);
                        data.reload();
                        stats.reload();
                      })
                    }
                    onFixed={() =>
                      edit.run(async () => {
                        await markFixed(r.id);
                        data.reload();
                        stats.reload();
                      })
                    }
                    onUploaded={() =>
                      edit.run(async () => {
                        await markUploaded(r.id);
                        data.reload();
                      })
                    }
                    onLive={() =>
                      edit.run(async () => {
                        await markLive(r.id);
                        data.reload();
                      })
                    }
                    onUndo={() =>
                      edit.run(async () => {
                        await undoComplete(r.id);
                        data.reload();
                      })
                    }
                    onReviewed={() =>
                      edit.run(async () => {
                        await markReviewed(r.id);
                        data.reload();
                        stats.reload();
                      })
                    }
                    mayDelete={mayDelete}
                    mayProofread={user?.canProofread === true}
                    onDelete={(reason) =>
                      edit.run(async () => {
                        // Careful: the single-row path returns `keptDone` too; pressing
                        //    Delete on a finished row does nothing, and that must be said
                        const res = await deleteTarget(r.id, reason);
                        setKept(res.keptDone);
                        data.reload();
                        stats.reload();
                      })
                    }
                  />
                ),
              },
            ]}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">
            <span className="num">
              Page {data.data.page} of {data.data.pages}
            </span>
            <span className="flex gap-2">
              <MiniButton
                disabled={data.data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </MiniButton>
              <MiniButton
                disabled={data.data.page >= data.data.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </MiniButton>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Careful: for "done", **how** it was finished is also shown: whether the
 * system picked it up from a file name, someone said so by hand, or it came
 * from the old list. The number is the same but the trust is not.
 */
function StatusChip({ row }: { row: TargetRow }) {
  if (row.status === 'done') {
    /*
      Careful: rows from the old Excel are labelled separately: their number
         is true, but oXeio did not **measure** it, only took it in as history.
         The level of trust differs.
      Careful: `filename` no longer arrives (it has meant "started" since 23
         August); the case is kept because old rows may still have it.
    */
    return (
      <Chip tone="counted">
        {row.completedVia === 'import' ? 'Done (old list)' : 'Done'}
      </Chip>
    );
  }
  // Show "work in progress" separately: the owner sees which rows were really
  //    touched and which are lying idle
  if (row.status === 'assigned') {
    return row.startedAt ? (
      <Chip tone="pending">Started</Chip>
    ) : (
      <Chip tone="muted">In hand</Chip>
    );
  }
  if (row.status === 'skipped') return <Chip tone="attention">Skipped</Chip>;
  /**
   * Careful: grey, not red. A deleted row is not a **problem**, it is a settled
   * matter. With red, the list would fill with red chips and the real red
   * (`Skipped`) would go unnoticed (the same rule as in `Notice`).
   */
  if (row.status === 'deleted') return <Chip tone="muted">Deleted</Chip>;

  return <Chip>Waiting</Chip>;
}

/**
 * Which date, and the date of **what**.
 *
 * Careful: with just one date, a row lying in the pool would show something
 * too, and the reader would take it to be "when it happened".
 */
/**
 * The small date under Stage (no longer a separate column).
 *
 * Careful: **which date is being shown is also said**: done, started, or
 * assigned. With just a date, the reader would take it as "when it
 * happened". The chip above gives the state, but on an `In hand` row the date
 * may be the start or the assignment, and the chip does not tell those apart.
 *
 * A row lying in the pool has no work date, so `—` used to be shown here.
 * Now it shows **when it arrived**: that is the row's only news, and telling
 * the truth beats leaving the cell empty.
 */
/**
 * **File trace: three states, three kinds of text.**
 *
 * | value | on screen | meaning |
 * |---|---|---|
 * | `null` | `—` | nothing to say: either the titles from back then were not stored, or the row is not yet marked done |
 * | `0` | `no trace` | **marked done**, yet never opened |
 * | `> 0` | `18m` / `45s` | this long on screen |
 *
 * Careful: **`formatDuration()` alone is not enough here, and the reason is
 * subtle:** it writes 20 seconds as `0m`, and `0m` looks exactly like "never
 * opened". Yet that difference is the most useful news in this column: 20
 * seconds means the file was opened, zero means it was not. So below one
 * minute it is written in seconds.
 *
 * Careful: the colour for `0` is **not a warning**, it is grey. Red would turn
 * the list into an accusation, yet an unsaved file lands in exactly this cell too.
 */
function FileCell({ sec }: { sec: number | null }) {
  if (sec === null) {
    return (
      <span
        className="num text-[12px] text-ink-3"
        title="Nothing to say yet — either this is not marked done, or no window titles were kept from back then"
      >
        —
      </span>
    );
  }

  if (sec === 0) {
    return (
      <span
        className="text-[11.5px] text-ink-3 italic"
        title="Marked done, but no file starting with this job number was ever open in Illustrator or Photoshop. A file saved under another name leaves no trace either."
      >
        no trace
      </span>
    );
  }

  return (
    <span
      className="num whitespace-nowrap text-[12px] text-ink-2"
      title="How long a file starting with this job number was on screen in Illustrator or Photoshop"
    >
      {sec < 60 ? `${sec}s` : formatDuration(sec)}
    </span>
  );
}

function WhenCell({ row }: { row: TargetRow }) {
  const when =
    row.completedAt ?? row.startedAt ?? row.assignedAt ?? row.addedAt;

  const what = row.completedAt
    ? 'done'
    : row.startedAt
      ? 'started'
      : row.assignedAt
        ? 'given'
        : 'added';

  return (
    <span className="num mt-0.5 block whitespace-nowrap text-[11.5px] text-ink-3">
      {formatDateTime(when)} · {what}
    </span>
  );
}

/**
 * **Added by → doing it.**
 *
 * Careful: this used to be two columns ("Added by" and "Designer"), both
 * human names, which looked crowded side by side. One cell with an arrow
 * makes it a **sentence**: where the work came from and who it went to.
 */
function PeopleCell({ row }: { row: TargetRow }) {
  return (
    <span className="block">
      <span className="whitespace-nowrap">
        {/* Careful: the adder's name is grey; in daily work the designer's name matters more */}
        <span className="text-ink-3">{row.addedBy.fullName}</span>
        <span className="px-1 text-ink-3">→</span>
        {row.assignedTo ? (
          <span className="text-ink">{row.assignedTo.fullName}</span>
        ) : row.sourceNote ? (
          /*
            Careful: imported old rows have **no** `assignedTo`; the name is
               raw text (`Hafiz-24-05-2026`), because many of those staff
               are no longer in the system.
          */
          <span className="num text-[12px] text-ink-3">{row.sourceNote}</span>
        ) : (
          <span className="text-ink-3">nobody yet</span>
        )}
      </span>

      {/*
        **Who said "done".** Reported by the owner. It used to show only the
        assignee's name, so even when the owner pressed Complete the designer's
        name appeared: plainly wrong information.

        Careful: the name appears only when someone really pressed. On old rows
        the cell stays empty; nothing is filled in by guessing.
      */}
      {row.completedBy && (
        <span className="block text-[11.5px] text-ink-3">
          ✓ marked by {row.completedBy.fullName}
        </span>
      )}
    </span>
  );
}

/**
 * **Editing**: owner · manager · researcher.
 *
 * Careful: **there is no way to change the ASIN**: it is the row's identity.
 * Changing it would shake the whole basis of the duplicate guard, and the
 * history's "this product was done" would become false.
 *
 * Careful: **Delete no longer removes the row.** The status becomes `deleted`
 * and the row stays in the list. It still asks first: there is a way back
 * (change the status to `pool`), but if the wrong row is deleted nobody will
 * notice, because the chip is grey and grey things go unseen.
 */
function RowActions({
  row,
  busy,
  onChange,
  onUploaded,
  onChecked,
  onFixed,
  onLive,
  onUndo,
  onReviewed,
  onDelete,
  mayDelete,
  mayProofread,
}: {
  row: TargetRow;
  busy: boolean;
  onChange: (status: TargetStatus) => void;
  onUploaded: () => void;
  /** `true` = spelling correct · `false` = an error was found */
  onChecked: (ok: boolean) => void;
  onFixed: () => void;
  onLive: () => void;
  /** Take back "done", on any day */
  onUndo: () => void;
  /** "I have looked": only on skipped rows */
  onReviewed: () => void;
  onDelete: (reason: DropReason) => void;
  /** Careful: when `false` the Delete button is not rendered; researchers do not get it */
  mayDelete: boolean;
  /**
   * When `false` the three spelling-check buttons are not rendered.
   *
   * Careful: this is checked **in addition to** the row's status, not instead:
   * even with the right, the order must be followed: once reviewed,
   * "Spelling OK" no longer appears.
   */
  mayProofread: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  /**
   * **Whether the other buttons are open.** The owner said the row looked
   * crowded.
   *
   * Careful: a row sits in **one** step only, yet all the pipeline's buttons
   * used to show together: up to six on a finished row. Now this row's *next
   * step* is in front and the rest are under `⋯`.
   *
   * Careful: **no button was removed**; all are one click away. It opens
   * inside the row rather than as a pop-up menu: a menu means measuring space,
   * catching outside clicks and handling the keyboard, three new traps and
   * none of them needed.
   */
  const [open, setOpen] = useState(false);

  /**
   * **"Really delete" is gone; three reasons took its place.**
   *
   * Careful: the old button asked a question whose answer carried **no
   * information**: nothing was learnt except "yes". Now one press gives the
   * confirmation **and** the reason.
   */
  if (confirming) {
    return (
      <DropReasonPicker
        busy={busy}
        onPick={(reason) => {
          setConfirming(false);
          onDelete(reason);
        }}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  /**
   * **Skipped or deleted rows get one button only: the restoring one.**
   * The owner's instruction: a deleted design should show only "Undelete", and
   * the same for a skipped one.
   *
   * Careful: these rows used to get Complete · Skip · Delete too, i.e. an offer
   * to drop what was already dropped, or to call "done" a design nobody made.
   * None of it did harm (the server guards every path separately), but the
   * screen lied by offering actions that make no sense.
   *
   * Careful: **this condition sits before `open`/`next`, and its position is
   * the whole point.** The first version put it lower, inside the open menu,
   * so the collapsed row still showed `Complete`. The owner caught this with a
   * screenshot: "why a complete button next to a deleted design?"
   *
   * **`skipped` and `deleted` behave the same, only the text differs**: the
   * action is the same (back to the pool), but the button name is the opposite
   * of what is being undone; with "To pool" you could not tell what comes back.
   *
   * Careful: restoring means **back to the pool** (`pool`), and the server
   * then clears the reason too; otherwise the row would be back in the pool
   * still marked "Not Found", and whoever gets it next would see a settled warning.
   */
  if (row.status === 'deleted' || row.status === 'skipped') {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        {/*
          **"Reviewed": the only way to empty the queue.**
          Careful: the button shows **only while nobody has reviewed**, and only
             on rows that have a reason (the old 93 have none, so nothing to review).
             Once reviewed the button vanishes and the chip below says who did it.
          Careful: `mayDelete` = owner/manager, the same as the server's `@Roles`.
        */}
        {mayDelete && row.dropReason !== null && row.reviewedAt === null && (
          <MiniButton tone="good" disabled={busy} onClick={onReviewed}>
            Reviewed
          </MiniButton>
        )}
        <MiniButton disabled={busy} onClick={() => onChange('pool')}>
          {row.status === 'deleted' ? 'Undelete' : 'Un-skip'}
        </MiniButton>
      </span>
    );
  }

  /**
   * **This row's next step**, following the chain in order, top to bottom.
   *
   * Careful: the order is the real decision here: a finished row can have both
   * "spelling check" and "upload" next, but spelling comes first. Reversed, an
   * unchecked design would go to Amazon and the queue would never empty.
   *
   * Careful: the check step has **two** buttons because it is not one task but
   * one decision (correct, or has an error). It could not be reduced to one.
   */
  const broken = row.errorFoundAt !== null && row.fixedAt === null;

  const next: ReactNode =
    mayProofread && broken ? (
      <MiniButton tone="good" disabled={busy} onClick={onFixed}>
        Fixed
      </MiniButton>
    ) : mayProofread && row.completedAt !== null && row.checkedAt === null ? (
      <>
        <MiniButton tone="good" disabled={busy} onClick={() => onChecked(true)}>
          Spelling OK
        </MiniButton>
        <MiniButton tone="danger" disabled={busy} onClick={() => onChecked(false)}>
          Has error
        </MiniButton>
      </>
    ) : row.completedAt !== null && row.uploadedAt === null && !broken ? (
      <MiniButton disabled={busy} onClick={onUploaded}>
        Uploaded
      </MiniButton>
    ) : row.uploadedAt !== null && row.liveAt === null ? (
      <MiniButton tone="good" disabled={busy} onClick={onLive}>
        Live
      </MiniButton>
    ) : row.status !== 'done' ? (
      /*
        Careful: the name is **"Complete"**, not "Done": the designer's page
           has this very button under that name, and two different words would
           make the owner think they were two different actions (owner's question).
        The rule: **a verb on the button** (Complete · Skip), **the state on
           the mark** (Done · Skipped).
      */
      <MiniButton tone="good" disabled={busy} onClick={() => onChange('done')}>
        Complete
      </MiniButton>
    ) : null;

  if (!open) {
    return (
      <span className="flex items-center justify-end gap-1.5 whitespace-nowrap">
        {next}
        <MiniButton disabled={busy} onClick={() => setOpen(true)}>
          {'⋯'}
        </MiniButton>
      </span>
    );
  }

  /**
   * Open state: everything, in order.
   *
   * Careful: the buttons **appear in order**: no "Uploaded" until finished, no
   * "Live" until uploaded. Showing them all together would let anyone press in
   * any order, and the pipeline numbers themselves would lose meaning. The
   * server guards the same way: the screen is not the only guard.
   */
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      {/* Taking it out of someone's hands: ownership is released too */}
      {row.status !== 'pool' && (
        <MiniButton disabled={busy} onClick={() => onChange('pool')}>
          To pool
        </MiniButton>
      )}
      {row.status !== 'done' && (
        <MiniButton tone="good" disabled={busy} onClick={() => onChange('done')}>
          Complete
        </MiniButton>
      )}
      {mayProofread && row.completedAt !== null && row.checkedAt === null && (
        <>
          <MiniButton tone="good" disabled={busy} onClick={() => onChecked(true)}>
            Spelling OK
          </MiniButton>
          <MiniButton tone="danger" disabled={busy} onClick={() => onChecked(false)}>
            Has error
          </MiniButton>
        </>
      )}
      {mayProofread && broken && (
        <MiniButton tone="good" disabled={busy} onClick={onFixed}>
          Fixed
        </MiniButton>
      )}
      {/*
        Careful: **a design with an error found and not yet fixed gets no
        "Uploaded" button at all** (owner's decision): known-broken work does not
        go to Amazon. But a row that has **not been checked yet** is not blocked;
        blocking it would make the queue 0 overnight and nobody would start.
      */}
      {row.completedAt !== null && row.uploadedAt === null && !broken && (
        <MiniButton disabled={busy} onClick={onUploaded}>
          Uploaded
        </MiniButton>
      )}
      {row.uploadedAt !== null && row.liveAt === null && (
        <MiniButton tone="good" disabled={busy} onClick={onLive}>
          Live
        </MiniButton>
      )}
      {/*
        **"Complete pressed by mistake".** Reported by the owner.

        Careful: this **cannot** be done with the neighbouring "To pool": that
           also gives up ownership, so the work would leave the designer's
           hands. This only lifts the "done" mark; the row stays with them.

        Careful: the button does not appear on a row that has moved down the
           chain: once spelling was checked or it went to Amazon it is no longer
           "pressed by mistake", and undoing would make the queue numbers wrong together.
      */}
      {row.status === 'done' &&
        row.checkedAt === null &&
        row.uploadedAt === null &&
        row.liveAt === null && (
          <MiniButton disabled={busy} onClick={onUndo}>
            Undo complete
          </MiniButton>
        )}
      {/*
        Careful: the condition (`status !== 'skipped'`) was removed: after the
           early return above, a `skipped` row never reaches here, so the
           condition was always true. The type checker caught it ("no overlap");
           keeping a dead condition makes the next reader wonder when it is false.
      */}
      <MiniButton tone="danger" disabled={busy} onClick={() => onChange('skipped')}>
        Skip
      </MiniButton>
      {/*
        Careful: researchers do not get Delete: one wrong delete among 46,000
           rows would never be found.
      */}
      {mayDelete && (
        <MiniButton tone="danger" disabled={busy} onClick={() => setConfirming(true)}>
          Delete
        </MiniButton>
      )}
      <MiniButton disabled={busy} onClick={() => setOpen(false)}>
        {'×'}
      </MiniButton>
    </span>
  );
}

