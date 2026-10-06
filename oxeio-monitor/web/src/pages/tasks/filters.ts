import type { Stage, TaskStatus } from '../../api/tasks';

export type { Stage };

/**
 * **The filter rules of the Task pool**, split out of the page: which control
 * selects what, and what the dropdown shows.
 *
 * Careful: **why a separate file.** The most fragile part of the page is not
 * the JSX but these pure rules, especially `dropdownValueOf`: if it is wrong,
 * the select jumps back to "All tasks" right after picking and the list
 * becomes unexplained. Inside the page, the only way to test it was to look at
 * it in a browser.
 */

export type FilterKey = TaskStatus | 'all' | Stage;

/**
 * Whether a key is a step or a status: decided in one place, not two.
 *
 * Careful: these are **steps**, not a `status`: `deliveredAt`/`publishedAt`
 * are dates, not states (otherwise the row would leave `done` and every count
 * would silently drop).
 */
export const stageOf = (key: FilterKey): Stage | undefined =>
  key === 'to_check' ||
  key === 'to_fix' ||
  key === 'to_deliver' ||
  key === 'to_publish' ||
  key === 'to_review' ||
  key === 'no_file'
    ? key
    : undefined;

/**
 * **Only the work queues are chips**, in the order the work moves: check →
 * fix → deliver → publish.
 *
 * Careful: the statuses are **alternatives** (you can never select two at
 * once), so they live in a dropdown (`statusOptions`). The queues stay as
 * chips because **they carry counts**, and the count tells you before
 * clicking whether there is work today.
 *
 * Careful: `to_review` is not here; it has its own page (Review), for other
 * people (owner and manager) on another rhythm. The same queue in two places
 * would be two doors.
 */
export const FILTERS: { key: FilterKey; label: string; stage: Stage; hint: string }[] = [
  {
    key: 'to_check',
    label: 'To check',
    stage: 'to_check',
    hint: 'Finished tasks nobody has checked yet',
  },
  {
    key: 'to_fix',
    label: 'To fix',
    stage: 'to_fix',
    hint: 'A check found a problem — waiting to be fixed',
  },
  {
    key: 'to_deliver',
    label: 'To deliver',
    stage: 'to_deliver',
    hint: 'Finished and not delivered yet. Tasks with an unfixed problem are held back.',
  },
  {
    key: 'to_publish',
    label: 'To publish',
    stage: 'to_publish',
    hint: 'Delivered, not published yet',
  },
];

/**
 * The status dropdown.
 *
 * Careful: `done_today` is **not** a real status: it is a shortcut that sets
 * `filter='done'` plus today's two dates together — the shortest way to find
 * work done by a mistaken Complete press.
 *
 * `no_file` — **marked done, yet never on screen** — exists only while start
 * detection is on: without detection every finished task would land in it,
 * and the list would accuse everyone of nothing.
 *
 * Careful: **it is not a chip, and that is the whole decision.** A chip
 * carries a number, and with a number it would become a queue to empty daily,
 * in effect an alert. It is meant as a quiet list: whoever looks for it finds it.
 */
export function statusOptions(
  startDetection: boolean,
): { value: string; label: string }[] {
  return [
    { value: 'all', label: 'All tasks' },
    { value: 'pool', label: 'Waiting' },
    { value: 'assigned', label: 'In hand' },
    { value: 'done', label: 'Done' },
    { value: 'done_today', label: 'Done · today' },
    ...(startDetection
      ? [{ value: 'no_file', label: 'Done · never on screen' }]
      : []),
    { value: 'skipped', label: 'Skipped' },
    /**
     * Taken out of the work for good. Without this, deleted rows could not
     * be seen anywhere, yet they sit in the table.
     */
    { value: 'deleted', label: 'Deleted' },
  ];
}

/**
 * **Which value the dropdown shows.** Pulled out of the page.
 *
 * | selection | dropdown shows | why |
 * |---|---|---|
 * | queue chip (`to_check` …) | `all` | Careful: the selection is **on the chip**; with both controls lit you could not tell which one is working |
 * | `no_file` | `no_file` | it is **inside the dropdown itself**; if it did not show itself the selection would vanish |
 * | `done` + today's two dates | `done_today` | Careful: the select says what the shortcut did |
 * | everything else | itself | |
 *
 * Careful: `done_today` is **not remembered, it is matched**; otherwise the
 * select would still say "today" after the owner changes the dates by hand.
 */
export function dropdownValueOf(
  filter: FilterKey,
  from: string,
  to: string,
  today: string,
): string {
  if (filter === 'no_file') return 'no_file';
  if (stageOf(filter) !== undefined) return 'all';
  if (filter === 'done' && from === today && to === today) return 'done_today';

  return filter;
}
