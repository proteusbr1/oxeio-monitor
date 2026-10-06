import { api } from './client';

/**
 * Tasks: coordinators (and managers, the owner) add them to a pool; each
 * morning they are handed out to the people who receive tasks.
 *
 * The types mirror `server/src/tasks/` (the Tasks module); a field renamed
 * there must be renamed here, or the screen silently shows `undefined`.
 */

/**
 * Why a pasted line was not taken.
 *
 * Careful: the reasons say what to do, not who is to blame. With "something
 * went wrong" the person pasting would not know what to fix on the line.
 */
export type RejectReason =
  | 'too_long'
  | 'bad_link'
  | 'duplicate_in_paste'
  | 'already_exists';

export const REJECT_TEXT: Record<RejectReason, string> = {
  too_long: 'Too long — keep the reference under 200 characters',
  bad_link: 'The link must start with http:// or https://',
  duplicate_in_paste: 'Already in this same list',
  already_exists: 'Already a task with this reference',
};

export interface RejectedLine {
  line: number;
  text: string;
  reason: RejectReason;
}

export interface BulkResult {
  added: number;
  /**
   * Not an error, but not hidden either: "I pasted 500, 473 went in" must not
   * be a mystery.
   */
  alreadyKnown: number;
  /** Careful: at most 200; the real count is in `rejectedTotal`. */
  rejected: RejectedLine[];
  /** How many were really dropped, even when the list is trimmed. */
  rejectedTotal: number;
  poolSize: number;
}

export interface TaskStats {
  pool: number;
  assigned: number;
  done: number;
  skipped: number;
  /** Taken out of the work for good, with a reason; deleted by hand. */
  deleted: number;
  /** How many each person is handed per day (the pool's daily share). */
  perAssignee: number;
  /** Delivered; on top of `done`, not instead of it. */
  delivered: number;
  /** Published — the last step. */
  published: number;
  /** Finished but not yet delivered. */
  toDeliver: number;
  /** Delivered but not yet published. */
  toPublish: number;
  /**
   * Skipped or deleted, but the owner/manager has not looked yet.
   *
   * Careful: old rows without a reason are not included; there is nothing to
   * review on them.
   */
  toReview: number;
  /**
   * Check still pending: finished, nobody has checked it yet.
   *
   * Careful: a machine does not check anything; this only counts "which have
   * not been looked at".
   */
  toCheck: number;
  /** A check found a problem, not yet fixed. */
  toFix: number;
}

export interface MyTask {
  id: number;
  /** What the task is about — free text, unique (e.g. an order or ticket number). */
  reference: string;
  /** Where the work is — `null` when the task came without a link. */
  link: string | null;
  taskNumber: number | null;
  assignedAt: string | null;
  /**
   * The system saw the task being started: "work in progress".
   *
   * Careful: this is not completion. Start detection (Settings → Tasks) sees
   * a window whose title starts with the task number. Completion is declared
   * by the person, with the Complete button. Always `null` while start
   * detection is off.
   */
  startedAt: string | null;
  /**
   * Finished today.
   *
   * Careful: `null` = still in hand. This one field decides which section of
   * the card the row sits in: "in hand" or "finished today".
   *
   * Careful: the server sends nothing outside today, so a value here always
   * means "can still be reverted".
   */
  completedAt: string | null;
}

export function addTasks(text: string): Promise<BulkResult> {
  return api<BulkResult>('/tasks/bulk', { method: 'POST', body: { text } });
}

export function taskStats(signal?: AbortSignal): Promise<TaskStats> {
  return api<TaskStats>('/tasks/stats', { signal });
}

export function distributeTasks(): Promise<{ assigned: number }> {
  return api<{ assigned: number }>('/tasks/distribute', { method: 'POST' });
}

export function myTasks(signal?: AbortSignal): Promise<MyTask[]> {
  return api<MyTask[]>('/me/tasks', { signal });
}

/**
 * "I finished it".
 *
 * Careful: this is unavoidable. The system can at best see the start (start
 * detection), never the finish.
 */
export function completeTask(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/me/tasks/${id}/done`, { method: 'POST' });
}

/**
 * "I pressed Complete by mistake".
 *
 * Careful: the server checks three conditions: today's, own, and not advanced
 * along the chain. When a condition fails, the message says why instead of
 * staying silent.
 */
export function undoTask(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/me/tasks/${id}/undone`, { method: 'POST' });
}

/** Careful: `reason` is required — a skip without a reason cannot be reviewed. */
export function skipTask(id: number, reason: DropReason): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/me/tasks/${id}/skip`, {
    method: 'POST',
    body: { reason },
  });
}

export type TaskStatus = 'pool' | 'assigned' | 'done' | 'skipped' | 'deleted';

/**
 * Why a task left the work queue.
 *
 * Careful: this order is the screen's order; the most common reason comes
 * first so it stays within reach, and `other` comes last.
 */
export const DROP_REASONS = ['not_needed', 'cannot_do', 'duplicate', 'other'] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/**
 * Careful: what is stored is the machine value, what is shown is this text.
 * They are kept separate so a label can be reworded without touching old rows.
 */
export const DROP_REASON_LABEL: Record<DropReason, string> = {
  not_needed: 'No longer needed',
  cannot_do: "Can't be done",
  duplicate: 'Duplicate',
  other: 'Other',
};

/** Result of a delete: how many went, and how many finished ones stayed. */
export interface DeleteResult {
  deleted: number;
  keptDone: number;
}

export interface TaskRow {
  id: number;
  reference: string;
  link: string | null;
  status: TaskStatus;
  taskNumber: number | null;
  /** Careful: `null` for a departed employee's row; the name is then in `sourceNote`. */
  assignedTo: { empCode: string; fullName: string } | null;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedVia: string | null;

  /**
   * Total seconds a window whose title starts with the task number was in
   * front, in the apps set for start detection.
   *
   * Careful: three states, not two:
   * `> 0` measured; `0` marked finished but never on screen; `null` nothing
   * to say — window titles from that time are not stored (`TaskPage.traceSince`),
   * the row is not marked finished yet, or start detection is off.
   *
   * Careful: `0` and `null` must not be shown the same way: one is a
   * measurement, the other is ignorance.
   */
  onScreenSec: number | null;

  /**
   * Who marked it "finished".
   *
   * Careful: do not confuse it with `assignedTo`; the person assigned and the
   * person who marked it finished may differ (the owner can press it too).
   */
  completedBy: { fullName: string; role: string } | null;

  /**
   * Who brought the task in.
   *
   * Careful: do not confuse it with `assignedTo`, which is the employee (who
   * does the work); this is the user (who added it).
   *
   * Careful: there is no `| null`: the column is `NOT NULL`, every row has a
   * source. Pretending it is optional would force pointless `?? '—'` on screen.
   */
  addedBy: { fullName: string; role: string };
  /** When it arrived; rows of the same batch land at the same moment. */
  addedAt: string;
  /** Checked; `null` = not yet checked. */
  checkedAt: string | null;
  /** Problem found; `null` with `checkedAt` set = it was fine. */
  errorFoundAt: string | null;
  /** The problem has been fixed. */
  fixedAt: string | null;
  deliveredAt: string | null;
  publishedAt: string | null;
  /** Careful: the reference of what was published, as opposed to `reference` above. */
  publishedRef: string | null;
  /**
   * Why it was dropped; present on `skipped` and `deleted` rows, `null` elsewhere.
   * Careful: `null` on old rows, because reasons were not asked for back then.
   */
  dropReason: DropReason | null;
  /** Who looked at it and when; `null` means still in the queue. */
  reviewedAt: string | null;
  reviewedBy: { fullName: string; role: string } | null;
  /** Raw text carried over from an imported list (who did it, when). */
  sourceNote: string | null;
}

export interface TaskPage {
  rows: TaskRow[];
  total: number;
  page: number;
  pages: number;

  /**
   * The date (`YYYY-MM-DD`) from which window titles are stored; the answer
   * to why `onScreenSec === null`.
   *
   * Careful: the server derives this from the data; it is not a constant, so
   * the date must not be hand-written on the screen.
   */
  traceSince: string | null;

  /**
   * Whether start detection is on (apps set in Settings → Tasks and the Apps
   * & websites module on) — the same `active` that `GET /settings/tasks`
   * answers, here for everyone who sees the pool. Decides whether the "On
   * screen" column and the "never on screen" filter exist at all.
   */
  startDetection: boolean;
}

export type Stage =
  | 'to_check'
  | 'to_fix'
  | 'to_deliver'
  | 'to_publish'
  | 'to_review'
  /**
   * Careful: `no_file` is a question, not a step: marked finished, but never
   * on screen. The server's name is kept for the filter value.
   */
  | 'no_file';

/**
 * The full list: owner, manager, coordinator.
 *
 * Careful: pagination is required; the table can hold tens of thousands of
 * rows. `q` matches the reference or the task number.
 */
export function listTasks(
  params: {
    status?: TaskStatus;
    q?: string;
    page?: number;
    /** Which assignee; `employees.id`. */
    staffId?: number;
    /**
     * Who brought it in; `users.id`.
     * Careful: a separate id space from the one above: `employees` vs `users`.
     */
    addedById?: number;
    /** `YYYY-MM-DD`; the last-work date falls inside this range. */
    from?: string;
    to?: string;
    /** Which step of the chain it is stuck at. */
    stage?: Stage;
  },
  signal?: AbortSignal,
): Promise<TaskPage> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  if (params.staffId) qs.set('staffId', String(params.staffId));
  if (params.addedById) qs.set('addedById', String(params.addedById));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.stage) qs.set('stage', params.stage);
  if (params.page && params.page > 1) qs.set('page', String(params.page));

  const suffix = qs.toString();
  return api<TaskPage>(`/tasks${suffix ? `?${suffix}` : ''}`, { signal });
}

/**
 * Edit the list: owner, manager, coordinator.
 *
 * Careful: there is no way to change the reference. It is the row's identity,
 * and changing it would shift the basis of the duplicate guard. Only the
 * status can change.
 */
export function updateTask(id: number, status: TaskStatus): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/tasks/${id}`, {
    method: 'PATCH',
    body: { status },
  });
}

/**
 * Delete: the row stays, marked "Deleted".
 *
 * Careful: a real `DELETE` would also remove the `reference` UNIQUE guard, so
 * a dead task could re-enter the pool tomorrow and be handed out again.
 */
export function deleteTask(id: number, reason: DropReason): Promise<DeleteResult> {
  // Careful: the reason goes in the query because many proxies silently drop a DELETE body
  return api<DeleteResult>(`/tasks/${id}?reason=${reason}`, {
    method: 'DELETE',
  });
}

/**
 * Several selected rows at once.
 *
 * Careful: `POST`, not `DELETE`; many proxies silently drop a body on `DELETE`.
 */
export function deleteTasks(ids: number[], reason: DropReason): Promise<DeleteResult> {
  return api<DeleteResult>('/tasks/delete', {
    method: 'POST',
    body: { ids, reason },
  });
}

/**
 * "I have looked": owner and manager only.
 *
 * Careful: the row's status does not change. It is an acknowledgement, not a
 * decision: "I saw it".
 */
export function markReviewed(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/tasks/${id}/reviewed`, { method: 'POST' });
}

/** "Delivered": owner, manager, coordinator. */
export function markDelivered(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/tasks/${id}/delivered`, { method: 'POST' });
}

/**
 * "Checked": when `ok: false`, the row goes to the fix queue.
 *
 * Careful: ownership of the task does not change; who checked and who fixed
 * are recorded in separate fields.
 */
export function markChecked(id: number, ok: boolean): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/tasks/${id}/checked`, {
    method: 'POST',
    body: { ok },
  });
}

/** "Fixed": a task with a problem has been corrected. */
export function markFixed(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/tasks/${id}/fixed`, { method: 'POST' });
}

/** "Published": the reference of what was published is optional. */
export function markPublished(id: number, publishedRef?: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/tasks/${id}/published`, {
    method: 'POST',
    body: publishedRef ? { publishedRef } : {},
  });
}

/** For the filter dropdown: people who have any tasks under their name. */
export interface TaskAssignee {
  id: number;
  empCode: string;
  fullName: string;
}

export function listTaskAssignees(signal?: AbortSignal): Promise<TaskAssignee[]> {
  return api<TaskAssignee[]>('/tasks/assignees', { signal });
}

/**
 * How many tasks each person brought in.
 *
 * Careful: do not confuse it with `TaskAssignee`, where `id` means
 * `employees.id`; here it is `users.id`. That is why the name differs.
 *
 * `count` comes along, so the dropdown itself shows the answer; no filtering needed.
 */
export interface TaskAdder {
  id: number;
  fullName: string;
  role: 'owner' | 'manager' | 'coordinator' | 'employee';
  count: number;
}

/**
 * The owner's/manager's "undo finished", for any day.
 *
 * Careful: it cannot be done with `updateTask(id, 'assigned')`. That path only
 * changes `status` and does not clear `completedAt`, and the queues rely on it.
 */
export function undoComplete(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/tasks/${id}/undone`, { method: 'POST' });
}

export function listTaskAdders(signal?: AbortSignal): Promise<TaskAdder[]> {
  return api<TaskAdder[]>('/tasks/adders', { signal });
}

/**
 * Settings → Tasks (owner only; 404 while the module is off).
 *
 * Start detection: a window whose title starts with a task's number, in front
 * in one of these apps, marks the task started. Empty list = off.
 */
export interface TaskSettings {
  startDetection: {
    /** Process names, matched case-insensitively — e.g. `WINWORD.EXE`. */
    apps: string[];
  };
}

export interface TaskSettingsView extends TaskSettings {
  /**
   * Whether detection is working now: apps are set and the Apps & websites
   * module is on (window titles come from it). Computed by the server.
   */
  active: boolean;
}

export function getTaskSettings(signal?: AbortSignal): Promise<TaskSettingsView> {
  return api<TaskSettingsView>('/settings/tasks', { signal });
}

export function saveTaskSettings(body: TaskSettings): Promise<TaskSettingsView> {
  return api<TaskSettingsView>('/settings/tasks', { method: 'PATCH', body });
}
