import { api } from './client';

/** Design targets: researchers submit them, designers get a list. */

export type RejectReason =
  | 'not_amazon'
  | 'short_link'
  | 'no_asin'
  | 'duplicate_in_paste';

/**
 * Careful: the reasons say what to do, not who is to blame. With "something went
 * wrong" the researcher would not know what to do about the line.
 */
export const REJECT_TEXT: Record<RejectReason, string> = {
  short_link: 'Open the short link and paste the real URL',
  not_amazon: 'Not an Amazon link',
  no_asin: 'No product in this link (a search page?)',
  duplicate_in_paste: 'Already in this same list',
};

export interface RejectedLine {
  line: number;
  text: string;
  reason: RejectReason;
}

export interface BulkResult {
  added: number;
  /**
   * Not an error, but not hidden either: "I submitted 500, 473 went in" must not be a mystery.
   */
  alreadyKnown: number;
  /** Careful: at most 200; the real count is in `rejectedTotal`. */
  rejected: RejectedLine[];
  /** How many were really dropped, even when the list is trimmed. */
  rejectedTotal: number;
  poolSize: number;
}

export interface TargetStats {
  pool: number;
  assigned: number;
  done: number;
  skipped: number;
  /** The page does not exist on Amazon at all; deleted by hand. */
  deleted: number;
  perDesigner: number;
  /** Sent to Amazon; on top of `done`, not instead of it. */
  uploaded: number;
  /** Listed for sale. */
  live: number;
  /**
   * The researcher's queue: finished but not yet uploaded.
   *
   * Careful: rows from before 23 August are not counted. The 27 thousand old jobs
   * that were imported went to Amazon long ago, when the button did not exist.
   */
  toUpload: number;
  /** Uploaded but not yet live. */
  toLive: number;
  /**
   * Skipped, but the owner/manager has not looked yet.
   *
   * Careful: the 93 old `skipped` rows are not included. They carry no reason, so
   * there is nothing to review.
   */
  toReview: number;
  /**
   * Spelling check still pending (ADR-038): Sumaiya's queue.
   *
   * Careful: a machine does not read spelling; this only counts "which have not been checked".
   */
  toCheck: number;
  /** Mistakes found, not yet fixed: Belal's queue. */
  toFix: number;
}

export interface MyTarget {
  id: number;
  asin: string;
  /** Built by the server from the ASIN; the web does not assemble it. */
  url: string;
  jobNumber: number | null;
  assignedAt: string | null;
  /**
   * The file was opened: "work in progress".
   *
   * Careful: this is not completion. It is the moment the agent sees the number and
   * the file being opened. Completion is declared by the designer, with the
   * Complete button.
   */
  startedAt: string | null;
  /**
   * Finished today.
   *
   * Careful: `null` = still in hand. This one field decides which section of the
   * card the row sits in: "in hand" or "finished today".
   *
   * Careful: the server sends nothing outside today, so a value here always means
   * "can still be reverted".
   */
  completedAt: string | null;
}

export function addTargets(text: string): Promise<BulkResult> {
  return api<BulkResult>('/design-targets/bulk', { method: 'POST', body: { text } });
}

export function targetStats(signal?: AbortSignal): Promise<TargetStats> {
  return api<TargetStats>('/design-targets/stats', { signal });
}

export function distributeTargets(): Promise<{ assigned: number }> {
  return api<{ assigned: number }>('/design-targets/distribute', { method: 'POST' });
}

export function myTargets(signal?: AbortSignal): Promise<MyTarget[]> {
  return api<MyTarget[]>('/me/targets', { signal });
}

/**
 * "I finished it" (the owner's request).
 *
 * Careful: this is unavoidable. The system can only see the start (the file
 * opening), not the finish.
 */
export function completeTarget(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/me/targets/${id}/done`, { method: 'POST' });
}

/**
 * "I pressed Complete by mistake".
 *
 * Careful: the server checks three conditions: today's, own, and not advanced
 * along the chain. When a condition fails, the message says why instead of staying silent.
 */
export function undoTarget(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/me/targets/${id}/undone`, { method: 'POST' });
}

/**
 * Careful: `reason` is now required. It used to be optional and the screen never
 * sent it, so not one of the 93 skipped rows had a reason.
 */
export function skipTarget(
  id: number,
  reason: DropReason,
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/me/targets/${id}/skip`, {
    method: 'POST',
    body: { reason },
  });
}

export type TargetStatus = 'pool' | 'assigned' | 'done' | 'skipped' | 'deleted';

/**
 * Why a target left the work queue (the owner's request).
 *
 * Careful: this order is the screen's order, and `not_found` comes first because
 * it happens most in the field (the page does not exist on Amazon). The most-used
 * option stays within reach.
 */
export const DROP_REASONS = ['not_found', 'copyright', 'events'] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/**
 * Careful: what is stored is the machine value, what is shown is this text. They
 * are kept separate so that one day "Not Found" can be relabelled "Page gone"
 * without touching old rows.
 */
export const DROP_REASON_LABEL: Record<DropReason, string> = {
  not_found: 'Not Found',
  copyright: 'Copyright',
  events: 'Events',
};

/** Result of a delete: how many went, and how many finished ones stayed. */
export interface DeleteResult {
  deleted: number;
  keptDone: number;
}

export interface TargetRow {
  id: number;
  asin: string;
  url: string;
  status: TargetStatus;
  jobNumber: number | null;
  /** Careful: `null` for a departed employee's row; the name is then in `sourceNote`. */
  assignedTo: { empCode: string; fullName: string } | null;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedVia: string | null;

  /**
   * Total seconds the file for that job number was open in the design app.
   *
   * Careful: three states, not two:
   * `> 0` measured; `0` marked finished but never opened; `null` nothing to say,
   * either because window titles from that time are not stored
   * (`TargetPage.traceSince`) or because the row has not been marked finished yet.
   *
   * Careful: `0` and `null` must not be shown the same way: one is a measurement,
   * the other is ignorance.
   */
  fileSec: number | null;

  /**
   * Who marked it "finished".
   *
   * Careful: do not confuse it with `assignedTo`; the person assigned and the
   * person who marked it finished may differ (the owner can press it too).
   */
  completedBy: { fullName: string; role: string } | null;

  /**
   * Who brought the target in.
   *
   * Careful: do not confuse it with `assignedTo`, which is the employee (who will
   * design it); this is the user (who brought the link).
   *
   * Careful: there is no `| null`: the column is `NOT NULL`, every row has a source.
   * Pretending it is optional would force pointless `?? '—'` on the screen.
   */
  addedBy: { fullName: string; role: string };
  /** When it arrived; rows of the same batch land at the same moment. */
  addedAt: string;
  /** Spelling checked; `null` = not yet checked (ADR-038). */
  checkedAt: string | null;
  /** Mistake found; `null` with `checkedAt` set = it was fine. */
  errorFoundAt: string | null;
  /** The mistake has been fixed. */
  fixedAt: string | null;
  uploadedAt: string | null;
  liveAt: string | null;
  /** Careful: the ASIN of our own product, as opposed to the `asin` sample above. */
  liveAsin: string | null;
  /**
   * Why it was dropped; present on `skipped` and `deleted` rows, `null` elsewhere.
   * Careful: `null` on old rows, because reasons were not asked for back then.
   */
  dropReason: DropReason | null;
  /** Who looked at it and when; `null` means still in the queue. */
  reviewedAt: string | null;
  reviewedBy: { fullName: string; role: string } | null;
  /** The raw text from the old Excel sheet, e.g. `Hafiz-24-05-2026`. */
  sourceNote: string | null;
}

export interface TargetPage {
  rows: TargetRow[];
  total: number;
  page: number;
  pages: number;

  /**
   * The date (`YYYY-MM-DD`) from which window titles are stored; the answer to why
   * `fileSec === null`.
   *
   * Careful: the server derives this from the data; it is not a constant, so the
   * date must not be hand-written on the screen.
   */
  traceSince: string | null;
}

/**
 * The full list: owner, manager, researcher.
 *
 * Careful: pagination is required; the table has over 39 thousand rows.
 * `q` accepts either a URL or an ASIN, so you can paste a link to see whether it
 * was done before, and by whom.
 */
export function listTargets(
  params: {
    status?: TargetStatus;
    q?: string;
    page?: number;
    /** Which designer; `employees.id`. */
    staffId?: number;
    /**
     * Who brought it in; `users.id`.
     * Careful: a separate id space from the one above: `employees` vs `users`.
     */
    addedById?: number;
    /** `YYYY-MM-DD`; the last-work date falls inside this range. */
    from?: string;
    to?: string;
    /** Which step of the chain it is stuck at: the researcher's queue. */
    /** Careful: `to_review` is a later addition: dropped, yet nobody has looked. */
    /**
     * Careful: `no_file` is a question, not a step: marked finished, but the file was never opened.
     */
    stage?:
      | 'to_check'
      | 'to_fix'
      | 'to_upload'
      | 'to_live'
      | 'to_review'
      | 'no_file';
  },
  signal?: AbortSignal,
): Promise<TargetPage> {
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
  return api<TargetPage>(`/design-targets${suffix ? `?${suffix}` : ''}`, { signal });
}

/**
 * Edit the list: owner, manager, researcher.
 *
 * Careful: there is no way to change the ASIN. It is the row's identity, and
 * changing it would shift the basis of the duplicate guard. Only the status can change.
 */
export function updateTarget(id: number, status: TargetStatus): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/design-targets/${id}`, {
    method: 'PATCH',
    body: { status },
  });
}

/**
 * Delete: the row stays, marked "Deleted".
 *
 * Careful: this used to be a real `DELETE`, which also removed the `asin` UNIQUE
 * guard, so a dead ASIN could re-enter the pool tomorrow and get distributed again.
 */
export function deleteTarget(
  id: number,
  reason: DropReason,
): Promise<DeleteResult> {
  // Careful: the reason goes in the query because many proxies silently drop a DELETE body
  return api<DeleteResult>(`/design-targets/${id}?reason=${reason}`, {
    method: 'DELETE',
  });
}

/**
 * Several selected rows at once (the owner's request).
 *
 * Careful: `POST`, not `DELETE`; many proxies silently drop a body on `DELETE`.
 */
export function deleteTargets(
  ids: number[],
  reason: DropReason,
): Promise<DeleteResult> {
  return api<DeleteResult>('/design-targets/delete', {
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
  return api<{ ok: boolean }>(`/design-targets/${id}/reviewed`, {
    method: 'POST',
  });
}

/** "Uploaded": owner, manager, researcher. */
export function markUploaded(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/design-targets/${id}/uploaded`, { method: 'POST' });
}

/** "Live on Amazon": the ASIN of the new product is optional. */
/**
 * "Spelling checked": when `ok: false`, the row goes to the fix queue.
 *
 * Careful: design ownership does not change; who checked and who fixed are
 * recorded in separate fields.
 */
export function markChecked(id: number, ok: boolean): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/design-targets/${id}/checked`, {
    method: 'POST',
    body: { ok },
  });
}

/** "Fixed": a design with a mistake has been corrected. */
export function markFixed(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/design-targets/${id}/fixed`, { method: 'POST' });
}

export function markLive(id: number, liveAsin?: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/design-targets/${id}/live`, {
    method: 'POST',
    body: liveAsin ? { liveAsin } : {},
  });
}

/** For the filter dropdown: people who have any targets under their name. */
export interface TargetDesigner {
  id: number;
  empCode: string;
  fullName: string;
}

export function listTargetDesigners(signal?: AbortSignal): Promise<TargetDesigner[]> {
  return api<TargetDesigner[]>('/design-targets/designers', { signal });
}

/**
 * How many targets each person brought in.
 *
 * Careful: do not confuse it with `TargetDesigner`, where `id` means
 * `employees.id`; here it is `users.id`. That is why the name differs.
 *
 * `count` comes along, so the dropdown itself shows the answer; no filtering needed.
 */
export interface TargetAdder {
  id: number;
  fullName: string;
  role: 'owner' | 'manager' | 'researcher' | 'employee';
  count: number;
}

/**
 * The owner's/manager's "undo finished", for any day.
 *
 * Careful: it cannot be done with `updateTarget(id, 'assigned')`. That path only
 * changes `status` and does not clear `completedAt`, and the queues rely on it.
 */
export function undoComplete(id: number): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/design-targets/${id}/undone`, { method: 'POST' });
}

export function listTargetAdders(signal?: AbortSignal): Promise<TargetAdder[]> {
  return api<TargetAdder[]>('/design-targets/adders', { signal });
}
