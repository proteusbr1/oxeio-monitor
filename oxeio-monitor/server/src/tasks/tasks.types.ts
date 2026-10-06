import type { TaskStatus } from '@prisma/client';

import type { RejectedLine } from './tasks.rules';

/**
 * The shapes the Tasks routes answer with, and the limits they share.
 *
 * Kept apart from the services so the controllers, the services and the tests
 * all read one definition.
 */

/**
 * The most rejected lines sent back. The count (`rejectedTotal`) stays true;
 * only the list is trimmed.
 */
export const REJECTED_SHOWN = 200;

/**
 * `POST /tasks/bulk` →
 * `{ added, alreadyKnown, rejected: { line, text, reason }[], rejectedTotal, poolSize }`
 */
export interface BulkResult {
  /** How many were newly added */
  added: number;
  /** Already in the table: these are also in `rejected` with reason `already_exists` */
  alreadyKnown: number;
  /**
   * In line order, at most `REJECTED_SHOWN`; reasons: `too_long`, `bad_link`,
   * `duplicate_in_paste`, `already_exists`
   */
  rejected: RejectedLine[];
  /** How many were really rejected; the full count even when the list is trimmed */
  rejectedTotal: number;
  /** How many are now waiting in the pool */
  poolSize: number;
}

/** 50 per page */
export const TASK_PAGE_SIZE = 50;

/**
 * The most rows one call can delete. The screen shows 50 per page, so nobody
 * will get near this; the ceiling stops accidents and oversized queries.
 */
export const DELETE_MAX = 500;

/** `POST /tasks/delete`, `DELETE /tasks/:id` → `{ deleted, keptDone }` */
export interface DeleteResult {
  /** How many were really marked `deleted` */
  deleted: number;
  /**
   * Careful: rows that were not touched because they are already done. The
   * number is returned so the screen can tell the truth; otherwise 50 would be
   * selected, 48 deleted, and nobody would know what happened to the other two.
   */
  keptDone: number;
}

/** One row of `GET /tasks` */
export interface TaskRow {
  id: number;
  reference: string;
  /** http(s) URL or `null` */
  link: string | null;
  status: TaskStatus;
  taskNumber: number | null;
  /** `null` on a row of staff who have left; the name is in `sourceNote` */
  assignedTo: { empCode: string; fullName: string } | null;
  assignedAt: string | null;
  /** The task number was first seen on screen: "work in progress" */
  startedAt: string | null;
  completedAt: string | null;
  completedVia: string | null;

  /**
   * Total seconds a window whose title starts with the task number was in
   * front, in the start-detection apps.
   *
   * Careful: three states. `> 0` is measured; `0` means "marked done yet
   * never on screen"; `null` means nothing to say (and always `null` while
   * start detection is off). The rule is in [`onScreenSecOf`](./tasks.rules.ts).
   *
   * This is not "was the work done". The number is context, not a verdict.
   */
  onScreenSec: number | null;
  /** Free text from an import, e.g. a former owner's name */
  sourceNote: string | null;

  /**
   * Why the row went out of work: `not_needed`, `cannot_do`, `duplicate`,
   * `other`. Present on both `skipped` and `deleted`; `null` otherwise.
   */
  dropReason: string | null;

  /** The owner/manager has reviewed this dropped row. `null` means still in the queue. */
  reviewedAt: string | null;
  reviewedBy: { fullName: string; role: string } | null;

  /** Who pressed Complete: the owner may do it on someone's behalf */
  completedBy: { fullName: string; role: string } | null;

  /**
   * Who added the task (a user, not a staff row).
   *
   * Careful: never `null`: the column is `NOT NULL`, so every row has a source.
   */
  addedBy: { fullName: string; role: string };
  /** When it arrived; rows of the same paste land at one instant */
  addedAt: string;
  /** Checked; `null` = not checked yet */
  checkedAt: string | null;
  /** A problem was found; `null` with `checkedAt` set = it was fine */
  errorFoundAt: string | null;
  /** The problem was fixed */
  fixedAt: string | null;
  deliveredAt: string | null;
  publishedAt: string | null;
  publishedRef: string | null;
}

/** `GET /tasks` */
export interface TaskList {
  rows: TaskRow[];
  total: number;
  page: number;
  pages: number;
  /** Since which day titles have been stored; explains why `onScreenSec === null` */
  traceSince: string | null;
  /** Start detection is on (apps listed and Apps & websites on): show the "On screen" column */
  startDetection: boolean;
}

/** One row of `GET /me/tasks` */
export interface MyTask {
  id: number;
  reference: string;
  link: string | null;
  taskNumber: number | null;
  assignedAt: string | null;
  /** The task number was seen on screen: "work in progress" */
  startedAt: string | null;
  /**
   * Finished today.
   *
   * Careful: `null` = still in hand. This field decides which section of the
   * screen the row goes in and whether the Undo button appears.
   */
  completedAt: string | null;
}

/** `GET /tasks/stats` */
export type TaskStats = Record<TaskStatus, number> & {
  /** How many each person holds at a time (30) */
  perAssignee: number;
  delivered: number;
  published: number;
  /** Done, not checked yet */
  toCheck: number;
  /** A problem was found and not yet fixed */
  toFix: number;
  /** Done, not delivered yet (rows with an unfixed problem excluded) */
  toDeliver: number;
  /** Delivered, not published yet */
  toPublish: number;
  /** Dropped with a reason, nobody has looked yet */
  toReview: number;
};

export type TaskStage =
  | 'to_check'
  | 'to_fix'
  | 'to_deliver'
  | 'to_publish'
  | 'to_review'
  | 'no_file';
