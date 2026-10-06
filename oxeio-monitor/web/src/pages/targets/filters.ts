import type { TargetStatus } from '../../api/targets';

/**
 * **The filter rules of the Design Pool**, split out of the page: which
 * control selects what, and what the dropdown shows.
 *
 * Careful: **why a separate file.** While adding `no_file` it turned out that
 * the most fragile part is not the JSX but these three pure rules, especially
 * `dropdownValueOf`: if it is wrong, the select jumps back to "All targets"
 * right after picking and the list becomes unexplained. Inside the page, the
 * only way to test it was to look at it in a browser.
 */

export type Stage =
  | 'to_check'
  | 'to_fix'
  | 'to_upload'
  | 'to_live'
  | 'to_review'
  /**
   * Careful: **`no_file` is not a step like the others.** It has no place in
   * the work chain, and it is not a queue to be emptied.
   *
   * It is still kept inside `Stage`, because the server's filter works exactly
   * the same way; a separate type would mean writing `stageOf` twice.
   * Careful: the only difference is **where it sits**: in the dropdown, not in the chip row.
   */
  | 'no_file';
export type FilterKey = TargetStatus | 'all' | Stage;

/**
 * **The first two are the researcher's daily queues.**
 *
 * Careful: the order is intentional: the two work queues first, the
 * supervision filters after. The Uploaded and Live buttons **already existed**
 * on every row, and researchers already had permission; what was missing was
 * *"which ones"*, a way to separate today's work from the pile of 39,000 rows.
 * The result: out of 27,632, the button had been pressed **only once**.
 *
 * Careful: these are **steps**, not a `status`: `uploadedAt`/`liveAt` are dates,
 * not states (otherwise the row would leave `done` and every count would silently drop).
 */
/** Whether a chip is a step or a status: decided in one place, not two */
export const stageOf = (key: FilterKey): Stage | undefined =>
  key === 'to_check' ||
  key === 'to_fix' ||
  key === 'to_upload' ||
  key === 'to_live' ||
  key === 'to_review' ||
  key === 'no_file'
    ? key
    : undefined;

/**
 * **Only the work queues are chips** (owner's decision: the row looked
 * crowded).
 *
 * Careful: there used to be nine chips here: four queues and five **statuses**
 * (All · Waiting · In hand · Done · Skipped). But the statuses are
 * **alternatives**: you can never select two at once. Something of which only
 * one can be chosen belongs in a dropdown (`STATUS_OPTIONS`), not a chip row,
 * and that folds five controls into one.
 *
 * Careful: the four queues stay as chips because **they carry counts**, and
 * the count tells you before clicking whether there is work today. Put in a
 * dropdown, you would have to open it to see the count, and nobody would.
 */
export const FILTERS: { key: FilterKey; label: string; stage: Stage }[] = [
  { key: 'to_check', label: 'To check', stage: 'to_check' },
  { key: 'to_fix', label: 'To fix', stage: 'to_fix' },
  { key: 'to_upload', label: 'To upload', stage: 'to_upload' },
  { key: 'to_live', label: 'To make live', stage: 'to_live' },
];

/**
 * Careful: **`to_review` is not here; it has its own page** (owner's
 * instruction: add a page called Review under Design Pool in the sidebar).
 *
 * The chip was here for a day and then moved: **moved, not copied**. The four
 * above are the researcher's daily work; looking at dropped designs is the
 * owner's and manager's job: other people, another rhythm. Careful: the same
 * queue in two places would be two doors, and the whole point of the August
 * trimming was **less** on this page.

/**
 * The status dropdown: the five brought down from the chips.
 *
 * Careful: `done_today` is **not** a real status: it is a shortcut that sets
 * `filter='done'` plus today's two dates together. It used to be a separate
 * button ("Completed today"), and it is the shortest way to find work done by
 * a mistaken Complete press, so it was not removed, only moved.
 */
export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All targets' },
  { value: 'pool', label: 'Waiting' },
  { value: 'assigned', label: 'In hand' },
  { value: 'done', label: 'Done' },
  { value: 'done_today', label: 'Done · today' },
  /**
   * **Marked done, yet the file was never opened.** Requested by the owner.
   *
   * Careful: **this is not a chip, and that is the whole decision.** A chip
   * carries a number, and with a number it would become a **queue**: something
   * to empty daily, in effect an alert. The owner said "a quiet list, not an
   * alert", so it is in the dropdown: whoever looks for it finds it, and it
   * does not catch anyone's eye daily.
   */
  { value: 'no_file', label: 'Done · no file trace' },
  { value: 'skipped', label: 'Skipped' },
  /**
   * **Dead links**: the page no longer exists on Amazon.
   *
   * Careful: without this, deleted rows **could not be seen anywhere**, yet
   * they sit in the table. And then there would be no way to answer "how many
   * links have died?", yet that number tells how stale the researcher's list is.
   */
  { value: 'deleted', label: 'Deleted' },
];

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
