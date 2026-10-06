import { useEffect, useState, type ReactNode } from 'react';
import { Trans } from 'react-i18next';

import {
  deleteTask,
  deleteTasks,
  listTaskAdders,
  undoComplete,
  listTaskAssignees,
  listTasks,
  markPublished,
  markChecked,
  markFixed,
  markReviewed,
  markDelivered,
  taskStats,
  type DropReason,
  type TaskRow,
  type TaskStatus,
  updateTask,
} from '../../api/tasks';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import { useT } from '../../i18n';
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
  statusOptions,
  type FilterKey,
  type Stage,
} from './filters';
import { DropReasonPicker, DropReasonTag } from './DropReason';

/**
 * **All tasks**: the sidebar entry is **"Task pool"**.
 *
 * Important: **the word "pool" also means a status on this page** (`Waiting`
 * = not yet handed to anyone). So although the page is named "Task pool", it
 * shows **every status**, not only the waiting ones. The subtitle ("Every
 * task, and where it stands") is there for exactly that reason.
 *
 * Careful: the adding page is separate. They are two different jobs, and on
 * one page every paste of 500 lines would also load the whole list.
 */
export function TaskPoolPage() {
  const t = useT();
  return (
    <Page title={t('Task pool')} subtitle={t('Every task, and where it stands')}>
      <TaskList />
    </Page>
  );
}


/** Today's date in the work zone, `YYYY-MM-DD` */
function workToday(): string {
  // Careful: `toISOString()` gives UTC; in the work zone between midnight and the offset hour it would show yesterday
  return todayInWorkZone();
}

/**
 * **The full list — one table, two pages.**
 *
 * Important: **this could not be built without pagination.** The table can
 * hold tens of thousands of rows; fetching them all would make a response of
 * several MB and the browser would freeze drawing the table.
 *
 * The search box takes **a reference or a task number**: a coordinator can
 * paste a reference to check whether it was already done, and by whom.
 *
 * Careful: when `lockedStage` is given the page **stays locked to that queue**:
 * the chip row and the status dropdown are not shown, because with them someone
 * could leave the Review page and look at something else, and the page's name
 * would no longer match its subject.
 *
 * Search and the other filters (assignee · added by · date) **stay**: they are
 * for searching inside the queue, not for leaving it.
 *
 * Careful: the markup is **shared, not copied**. Lesson from the Worklog page:
 * with copies in two places, one day one changes and the other does not.
 */
export function TaskList({ lockedStage }: { lockedStage?: Stage } = {}) {
  const t = useT();
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
   * **Selected rows**, so many tasks that are no longer needed can be
   * deleted at once.
   *
   * Careful: a `Set`, not `TaskRow[]`: all we need is "is it selected", and
   * the rest of the row's data is in the list anyway. Keeping rows would leave
   * stale copies in hand after a refresh.
   */
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  /** Careful: how many finished rows were skipped; said once after deleting, then silent */
  const [kept, setKept] = useState(0);

  const assignees = useApi(listTaskAssignees, []);
  /**
   * **Who added how many.**
   *
   * Careful: the number is written inside the dropdown, so the owner gets the
   * answer **without clicking anything**; filtering is the next step, not required.
   */
  const adders = useApi(listTaskAdders, []);
  /** The number beside the chip: you need to know there is work **before** clicking */
  const stats = useApi(taskStats, []);

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
      listTasks(
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
              : { status: filter as TaskStatus }),
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
   * The checkbox column is only for people who may delete; on a coordinator's
   * screen they could select rows but nothing could be done with them.
   */
  const pickColumn: Column<TaskRow>[] = mayDelete
    ? [
        {
          key: 'pick',
          className: 'w-8',
          header: (
            <input
              type="checkbox"
              className="tap"
              aria-label={t('Select every row on this page')}
              checked={allPicked}
              onChange={toggleAll}
            />
          ),
          render: (r) => (
            <input
              type="checkbox"
              className="tap"
              aria-label={t('Select {{reference}}', { reference: r.reference })}
              checked={picked.has(r.id)}
              onChange={() => toggleOne(r.id)}
            />
          ),
        },
      ]
    : [];

  /**
   * **Whether start detection is working** (Settings → Tasks): the "On
   * screen" column and the "never on screen" filter exist only then.
   *
   * Careful: without detection nothing is ever measured, so the column would
   * be a row of dashes and the filter would list every finished task — a
   * quiet accusation of everyone.
   */
  const detection = data.data?.startDetection ?? false;

  /** Careful: changing a filter or the search goes back to page 1; otherwise
   *  you would sit on page 5 seeing "nothing here" although results exist */
  const change = (next: () => void) => {
    setPage(1);
    next();
  };

  return (
    <Card
      title={t('Every Task')}
      /*
        Careful: "Newest activity first" used to be a separate label in the
           filter row; it took a whole control's space and did nothing.
        It is true and useful, so it was not deleted; it moved next to the count.
      */
      hint={
        data.data
          ? t('{{n}} in total · newest activity first', { n: data.data.total })
          : t('Loading…')
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
            title={t(f.hint)}
            className={`rounded-full border px-3 py-1 text-[12.5px] transition ${
              filter === f.key
                ? 'border-brand bg-brand-bg font-semibold text-brand-ink'
                : 'border-line text-ink-2 hover:border-brand'
            }`}
          >
            {t(f.label)}
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
                    : f.stage === 'to_deliver'
                      ? stats.data.toDeliver
                      : f.stage === 'to_review'
                        ? stats.data.toReview
                        : stats.data.toPublish}
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
            {statusOptions(detection).map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.label, { context: 'list' })}
              </option>
            ))}
          </select>
        )}

        {/*
          **The other filters are collapsed.**

          Careful: all four fields (assignee · added by · two dates) **sit empty**
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
          {t('Filters')}
          {activeFilters > 0 && <span className="num ml-1.5">{activeFilters}</span>}
          <span className="ml-1 text-ink-3">{showFilters ? '▴' : '▾'}</span>
        </button>

        {/*
          **Reference or task number.** Every row shows its task number
             underneath, so either identity finds it.
        */}
        <input
          value={q}
          onChange={(e) => change(() => setQ(e.target.value))}
          aria-label={t('Search by reference or task number')}
          placeholder={t('Reference or task no…')}
          className="num ml-auto w-full max-w-[260px] rounded-md border border-line bg-paper px-2.5 py-1 text-[12.5px] text-ink"
        />
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <select
            value={staffId}
            onChange={(e) => change(() => setStaffId(e.target.value))}
            className="rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink"
          >
            <option value="">{t('Any assignee')}</option>
            {(assignees.data ?? []).map((d) => (
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
            <option value="">{t('Added by anyone')}</option>
            {(adders.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName} · {formatCount(a.count)}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
            {t('From')}
            <input
              type="date"
              value={from}
              onChange={(e) => change(() => setFrom(e.target.value))}
              className="num rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink"
            />
          </label>

          <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
            {t('to')}
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
              {t('Clear filters')}
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
           no trace is innocent: someone works in an unsaved, untitled window
           all day, so their work leaves no trace although it was done. The
           number is not wrong; its **meaning** is easy to misread.
      */}
      {filter === 'no_file' && (
        <div className="px-4 pb-1">
          <Notice>
            <Trans
              i18nKey="These were marked <b>done</b>, but no window whose title starts with the task number was ever in front in the apps set for start detection. <b>That is a question, not a verdict</b> — work saved under another name, or never saved at all, leaves no trace either."
              components={{ b: <b /> }}
            />
            {data.data?.traceSince ? (
              <>
                {' '}
                <Trans
                  i18nKey="Window titles are kept from <n>{{date}}</n> onward, so nothing older is listed."
                  values={{ date: formatDate(data.data.traceSince) }}
                  components={{ n: <span className="num" /> }}
                />
              </>
            ) : null}
          </Notice>
        </div>
      )}

      {data.loading && !data.data && <Loading />}
      {data.error && <ErrorBox error={data.error} retry={data.reload} />}

      {data.data && data.data.rows.length === 0 && (
        <div className="px-4 py-6 text-[13px] text-ink-3">
          {t('Nothing matches that.')}
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
                <Trans
                  i18nKey="<n>{{n}}</n> selected"
                  values={{ n: picked.size }}
                  components={{ n: <span className="num font-semibold" /> }}
                />
              </span>
              <span className="flex gap-2">
                <MiniButton
                  disabled={edit.busy}
                  onClick={() => setPicked(new Set())}
                >
                  {t('Clear')}
                </MiniButton>
                <MiniButton
                  tone="danger"
                  disabled={edit.busy}
                  onClick={() => setConfirmingBulk(true)}
                >
                  {t('Delete')}
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
                <Trans
                  i18nKey="<n>{{count}}</n> finished tasks were left alone — deleting those would take away work that was really done. Undo them first if they must go."
                  count={kept}
                  components={{ n: <span className="num font-semibold" /> }}
                />
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
              title={t('Delete {{count}} tasks?', { count: picked.size })}
              onClose={() => setConfirmingBulk(false)}
              footer={
                <DropReasonPicker
                  busy={edit.busy}
                  onPick={(reason) =>
                    edit.run(async () => {
                      const res = await deleteTasks([...picked], reason);
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
                  {t('Use this for tasks that should not be done at all.')}
                </p>
                {/*
                  Careful: the consequence is stated **both ways**: it will never go to
                     anyone again, and that reference can never return to the pool. The
                     second is the whole reason a delete keeps the row, so it must not be hidden.
                */}
                <Notice tone="attention">
                  {t(
                    'They stay in the list as Deleted, never go to anyone again, and the same reference can never be added back to the pool. Finished tasks in the selection are left alone.',
                  )}
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
                **Few columns, merged on purpose** (the table looked crowded).

                Careful: no information was removed; columns were **merged**, and
                   not arbitrarily:
                     · task no. under reference (both are *identity*)
                     · date under Stage         (same idea: which step, when)
                     · added by with who's doing it (one *sentence*, not two cells)
              */
              {
                key: 'task',
                header: t('Task'),
                render: (r) => (
                  <span className="block">
                    {/* a task may be only a reference; then there is nothing to open */}
                    {r.link ? (
                      <a
                        href={r.link}
                        target="_blank"
                        // Careful: prevents tabnabbing; the new tab must not be able to navigate this page
                        rel="noreferrer noopener"
                        className="num break-all text-data hover:underline"
                      >
                        {r.reference}
                      </a>
                    ) : (
                      <span className="num break-all text-ink">{r.reference}</span>
                    )}
                    {/*
                      Careful: **if there is no task number the line is not rendered at
                         all**; blank space is calmer than a "—", and a row sitting in
                         the pool never has a number anyway.
                    */}
                    {r.taskNumber !== null && (
                      <span className="num block text-[11.5px] text-ink-3">
                        {t('Task {{number}}', { number: r.taskNumber })}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'stage',
                header: t('Stage'),
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
                          {r.reviewedBy
                            ? t('Reviewed · {{name}}', { name: r.reviewedBy.fullName })
                            : t('Reviewed')}
                        </Chip>
                      )}
                    </span>
                    <WhenCell row={r} />
                  </span>
                ),
              },
              /**
               * **The measure beside the claim**, so a "done" mark can be
               * backed up.
               *
               * Careful: **why this column exists.** The "done" mark is the
               * employee's own click and nobody verifies it. Without this, a
               * questioned "done" could only be answered by a query written by
               * hand in the database.
               *
               * Nothing new had to be stored: the agent already keeps window
               * titles, and start detection looks for the task number in them.
               * Only while detection is on — otherwise the column would be dashes.
               */
              ...(detection
                ? [
                    {
                      key: 'onscreen',
                      header: t('On screen'),
                      className: 'hidden sm:table-cell',
                      render: (r: TaskRow) => <OnScreenCell sec={r.onScreenSec} />,
                    },
                  ]
                : []),
              {
                key: 'people',
                header: t('People'),
                /*
                  **"Added by → doing it"**: the whole story of a row.

                  Careful: two different id worlds sit in one cell (`users` →
                     `employees`), and the arrow shows that: on the left whoever
                     **brought** the work, on the right whoever is **doing** it.

                  Careful: the adder's name is **grey**, the doer's name dark: in
                     daily work the assignee's name is needed more, so the weight goes there.
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
                        await updateTask(r.id, status);
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
                    onDelivered={() =>
                      edit.run(async () => {
                        await markDelivered(r.id);
                        data.reload();
                        stats.reload();
                      })
                    }
                    onPublished={() =>
                      edit.run(async () => {
                        await markPublished(r.id);
                        data.reload();
                        stats.reload();
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
                    mayCheck={user?.canCheckTasks === true}
                    onDelete={(reason) =>
                      edit.run(async () => {
                        // Careful: the single-row path returns `keptDone` too; pressing
                        //    Delete on a finished row does nothing, and that must be said
                        const res = await deleteTask(r.id, reason);
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
              {t('Page {{page}} of {{pages}}', { page: data.data.page, pages: data.data.pages })}
            </span>
            <span className="flex gap-2">
              <MiniButton
                disabled={data.data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t('Previous')}
              </MiniButton>
              <MiniButton
                disabled={data.data.page >= data.data.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('Next')}
              </MiniButton>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Careful: for "done", **how** it was finished is also shown: whether someone
 * pressed Complete or it came from an imported list. The number is the same
 * but the trust is not.
 */
function StatusChip({ row }: { row: TaskRow }) {
  const t = useT();
  if (row.status === 'done') {
    /*
      Careful: imported rows are labelled separately: their number is true,
         but oXeio did not **see** it happen, only took it in as history.
    */
    return (
      <Chip tone="counted">
        {row.completedVia === 'import' ? t('Done (imported)') : t('Done')}
      </Chip>
    );
  }
  // Show "work in progress" separately: the owner sees which rows were really
  //    touched and which are lying idle (only start detection can tell)
  if (row.status === 'assigned') {
    return row.startedAt ? (
      <Chip tone="pending">{t('Started')}</Chip>
    ) : (
      <Chip tone="muted">{t('In hand')}</Chip>
    );
  }
  if (row.status === 'skipped') return <Chip tone="attention">{t('Skipped')}</Chip>;
  /**
   * Careful: grey, not red. A deleted row is not a **problem**, it is a settled
   * matter. With red, the list would fill with red chips and the real red
   * (`Skipped`) would go unnoticed (the same rule as in `Notice`).
   */
  if (row.status === 'deleted') return <Chip tone="muted">{t('Deleted')}</Chip>;

  return <Chip>{t('Waiting')}</Chip>;
}

/**
 * **On screen: three states, three kinds of text.**
 *
 * | value | on screen | meaning |
 * |---|---|---|
 * | `null` | `—` | nothing to say: either the titles from back then were not stored, or the row is not yet marked done |
 * | `0` | `never` | **marked done**, yet never on screen |
 * | `> 0` | `18m` / `45s` | this long in front |
 *
 * Careful: **`formatDuration()` alone is not enough here, and the reason is
 * subtle:** it writes 20 seconds as `0m`, and `0m` looks exactly like "never
 * on screen". Yet that difference is the most useful news in this column: 20
 * seconds means it was opened, zero means it was not. So below one minute it
 * is written in seconds.
 *
 * Careful: the colour for `0` is **not a warning**, it is grey. Red would turn
 * the list into an accusation, yet work saved under another name lands in
 * exactly this cell too.
 */
function OnScreenCell({ sec }: { sec: number | null }) {
  const t = useT();
  if (sec === null) {
    return (
      <span
        className="num text-[12px] text-ink-3"
        title={t('Nothing to say yet — either this is not marked done, or no window titles were kept from back then')}
      >
        —
      </span>
    );
  }

  if (sec === 0) {
    return (
      <span
        className="text-[11.5px] text-ink-3 italic"
        title={t(
          'Marked done, but no window whose title starts with this task number was ever in front in the apps set for start detection. Work saved under another name leaves no trace either.',
        )}
      >
        {t('never')}
      </span>
    );
  }

  return (
    <span
      className="num text-[12px] whitespace-nowrap text-ink-2"
      title={t('How long a window whose title starts with this task number was in front, in the apps set for start detection')}
    >
      {sec < 60 ? `${sec}s` : formatDuration(sec)}
    </span>
  );
}

/**
 * The small date under Stage.
 *
 * Careful: **which date is being shown is also said**: done, started, given
 * or added. With just a date, the reader would take it as "when it happened".
 * The chip above gives the state, but on an `In hand` row the date may be the
 * start or the hand-out, and the chip does not tell those apart.
 */
function WhenCell({ row }: { row: TaskRow }) {
  const t = useT();
  const when = row.completedAt ?? row.startedAt ?? row.assignedAt ?? row.addedAt;

  const at = formatDateTime(when);
  const text = row.completedAt
    ? t('{{when}} · done', { when: at })
    : row.startedAt
      ? t('{{when}} · started', { when: at })
      : row.assignedAt
        ? t('{{when}} · given', { when: at })
        : t('{{when}} · added', { when: at });

  return (
    <span className="num mt-0.5 block text-[11.5px] whitespace-nowrap text-ink-3">
      {text}
    </span>
  );
}

/**
 * **Added by → doing it.**
 *
 * Careful: this used to be two columns ("Added by" and the assignee), both
 * human names, which looked crowded side by side. One cell with an arrow
 * makes it a **sentence**: where the work came from and who it went to.
 */
function PeopleCell({ row }: { row: TaskRow }) {
  const t = useT();
  return (
    <span className="block">
      <span className="whitespace-nowrap">
        {/* Careful: the adder's name is grey; in daily work the assignee's name matters more */}
        <span className="text-ink-3">{row.addedBy.fullName}</span>
        <span className="px-1 text-ink-3">→</span>
        {row.assignedTo ? (
          <span className="text-ink">{row.assignedTo.fullName}</span>
        ) : row.sourceNote ? (
          /*
            Careful: imported rows may have **no** `assignedTo`; the name is
               raw text from the old list, because those people may not be in
               the system.
          */
          <span className="num text-[12px] text-ink-3">{row.sourceNote}</span>
        ) : (
          <span className="text-ink-3">{t('nobody yet')}</span>
        )}
      </span>

      {/*
        **Who said "done".** Showing only the assignee's name would be plainly
        wrong when the owner pressed Complete for them.

        Careful: the name appears only when someone really pressed. On old rows
        the cell stays empty; nothing is filled in by guessing.
      */}
      {row.completedBy && (
        <span className="block text-[11.5px] text-ink-3">
          {t('✓ marked by {{name}}', { name: row.completedBy.fullName })}
        </span>
      )}
    </span>
  );
}

/**
 * **Editing**: owner · manager · coordinator.
 *
 * Careful: **there is no way to change the reference**: it is the row's
 * identity. Changing it would shake the whole basis of the duplicate guard,
 * and the history's "this was done" would become false.
 *
 * Careful: **Delete does not remove the row.** The status becomes `deleted`
 * and the row stays in the list. It still asks first: there is a way back
 * (Undelete), but if the wrong row is deleted nobody will notice, because the
 * chip is grey and grey things go unseen.
 */
function RowActions({
  row,
  busy,
  onChange,
  onDelivered,
  onChecked,
  onFixed,
  onPublished,
  onUndo,
  onReviewed,
  onDelete,
  mayDelete,
  mayCheck,
}: {
  row: TaskRow;
  busy: boolean;
  onChange: (status: TaskStatus) => void;
  onDelivered: () => void;
  /** `true` = checked and fine · `false` = needs a fix */
  onChecked: (ok: boolean) => void;
  onFixed: () => void;
  onPublished: () => void;
  /** Take back "done", on any day */
  onUndo: () => void;
  /** "I have looked": only on skipped and deleted rows */
  onReviewed: () => void;
  onDelete: (reason: DropReason) => void;
  /** Careful: when `false` the Delete button is not rendered; coordinators do not get it */
  mayDelete: boolean;
  /**
   * When `false` the check buttons are not rendered (`canCheckTasks`).
   *
   * Careful: this is checked **in addition to** the row's state, not instead:
   * even with the right, the order must be followed: once checked, "Checked"
   * no longer appears.
   */
  mayCheck: boolean;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  /**
   * **Whether the other buttons are open.**
   *
   * Careful: a row sits in **one** step only, yet all the chain's buttons
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
   * **No "Really delete"; the reasons take its place.** One press gives the
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
   * **Skipped or deleted rows get one button only: the restoring one**
   * (plus Reviewed while nobody has looked).
   *
   * Careful: offering Complete · Skip · Delete here would offer to drop what
   * was already dropped, or to call "done" a task nobody did. The server
   * guards every path separately, but the screen would lie.
   *
   * Careful: **this condition sits before `open`/`next`, and its position is
   * the whole point**: lower down, the collapsed row would still show
   * `Complete` beside a deleted task.
   *
   * Restoring means **back to the pool** (`pool`), and the server then clears
   * the reason too; otherwise whoever gets it next would see a settled warning.
   */
  if (row.status === 'deleted' || row.status === 'skipped') {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        {/*
          **"Reviewed": the only way to empty the queue.**
          Careful: the button shows **only while nobody has reviewed**, and only
             on rows that have a reason (old rows without one have nothing to review).
             Once reviewed the button vanishes and the chip says who did it.
          Careful: `mayDelete` = owner/manager, the same as the server's `@Roles`.
        */}
        {mayDelete && row.dropReason !== null && row.reviewedAt === null && (
          <MiniButton tone="good" disabled={busy} onClick={onReviewed}>
            {t('Reviewed')}
          </MiniButton>
        )}
        <MiniButton disabled={busy} onClick={() => onChange('pool')}>
          {row.status === 'deleted' ? t('Undelete') : t('Un-skip')}
        </MiniButton>
      </span>
    );
  }

  /**
   * **This row's next step**, following the chain in order, top to bottom.
   *
   * Careful: the order is the real decision here: a finished row can have both
   * "check" and "deliver" next, but the check comes first. Reversed, unchecked
   * work would be delivered and the queue would never empty.
   *
   * Careful: the check step has **two** buttons because it is one decision
   * with two answers (fine, or needs a fix).
   */
  const broken = row.errorFoundAt !== null && row.fixedAt === null;

  const next: ReactNode =
    mayCheck && broken ? (
      <MiniButton tone="good" disabled={busy} onClick={onFixed}>
        {t('Fixed')}
      </MiniButton>
    ) : mayCheck && row.completedAt !== null && row.checkedAt === null ? (
      <CheckButtons busy={busy} onChecked={onChecked} />
    ) : row.completedAt !== null && row.deliveredAt === null && !broken ? (
      <MiniButton disabled={busy} onClick={onDelivered}>
        {t('Delivered')}
      </MiniButton>
    ) : row.deliveredAt !== null && row.publishedAt === null ? (
      <MiniButton tone="good" disabled={busy} onClick={onPublished}>
        {t('Published')}
      </MiniButton>
    ) : row.status !== 'done' ? (
      /*
        Careful: the name is **"Complete"**, not "Done": the assignee's page
           has this very button under that name, and two different words would
           read as two different actions.
        The rule: **a verb on the button** (Complete · Skip), **the state on
           the mark** (Done · Skipped).
      */
      <MiniButton tone="good" disabled={busy} onClick={() => onChange('done')}>
        {t('Complete')}
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
   * Careful: the buttons **appear in order**: no "Delivered" until finished,
   * no "Published" until delivered. Showing them all together would let anyone
   * press in any order, and the pipeline numbers would lose meaning. The
   * server guards the same way: the screen is not the only guard.
   */
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      {/* Taking it out of someone's hands: ownership is released too */}
      {row.status !== 'pool' && (
        <MiniButton disabled={busy} onClick={() => onChange('pool')}>
          {t('To pool')}
        </MiniButton>
      )}
      {row.status !== 'done' && (
        <MiniButton tone="good" disabled={busy} onClick={() => onChange('done')}>
          {t('Complete')}
        </MiniButton>
      )}
      {mayCheck && row.completedAt !== null && row.checkedAt === null && (
        <CheckButtons busy={busy} onChecked={onChecked} />
      )}
      {mayCheck && broken && (
        <MiniButton tone="good" disabled={busy} onClick={onFixed}>
          {t('Fixed')}
        </MiniButton>
      )}
      {/*
        Careful: **a task with a problem found and not yet fixed gets no
        "Delivered" button at all**: known-broken work is not delivered. But a
        row that has **not been checked yet** is not blocked; blocking it would
        hold everything back on the day nobody checks.
      */}
      {row.completedAt !== null && row.deliveredAt === null && !broken && (
        <MiniButton disabled={busy} onClick={onDelivered}>
          {t('Delivered')}
        </MiniButton>
      )}
      {row.deliveredAt !== null && row.publishedAt === null && (
        <MiniButton tone="good" disabled={busy} onClick={onPublished}>
          {t('Published')}
        </MiniButton>
      )}
      {/*
        **"Complete pressed by mistake".**

        Careful: this **cannot** be done with the neighbouring "To pool": that
           also gives up ownership, so the work would leave the assignee's
           hands. This only lifts the "done" mark; the row stays with them.

        Careful: the button does not appear on a row that has moved down the
           chain: once checked or delivered it is no longer "pressed by
           mistake", and undoing would make the queue numbers wrong together.
      */}
      {row.status === 'done' &&
        row.checkedAt === null &&
        row.deliveredAt === null &&
        row.publishedAt === null && (
          <MiniButton disabled={busy} onClick={onUndo}>
            {t('Undo complete')}
          </MiniButton>
        )}
      {/*
        Careful: no `status !== 'skipped'` condition: after the early return
           above, a `skipped` row never reaches here.
      */}
      <MiniButton tone="danger" disabled={busy} onClick={() => onChange('skipped')}>
        {t('Skip')}
      </MiniButton>
      {/*
        Careful: coordinators do not get Delete: one wrong delete among
           thousands of rows would never be found.
      */}
      {mayDelete && (
        <MiniButton tone="danger" disabled={busy} onClick={() => setConfirming(true)}>
          {t('Delete')}
        </MiniButton>
      )}
      <MiniButton disabled={busy} onClick={() => setOpen(false)}>
        {'×'}
      </MiniButton>
    </span>
  );
}

/**
 * The check step's two answers, written once: the collapsed row and the open
 * row show the same pair, and two copies would one day drift apart.
 */
function CheckButtons({
  busy,
  onChecked,
}: {
  busy: boolean;
  onChecked: (ok: boolean) => void;
}) {
  const t = useT();
  return (
    <>
      <MiniButton tone="good" disabled={busy} onClick={() => onChecked(true)}>
        {t('Checked')}
      </MiniButton>
      <MiniButton tone="danger" disabled={busy} onClick={() => onChecked(false)}>
        {t('Needs fix')}
      </MiniButton>
    </>
  );
}
