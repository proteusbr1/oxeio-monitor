-- Tasks module: the old single-studio "design targets" become generic tasks.
--
-- Everything is a rename or a value mapping: no row is lost. Old audit_logs
-- rows keep their old action strings (design_undone, design_deleted, ...);
-- the dashboard still labels them.

-- ── Portal role: researcher → coordinator (same powers) ─────────────────────
ALTER TYPE "UserRole" RENAME VALUE 'researcher' TO 'coordinator';

-- ── design_targets → tasks ──────────────────────────────────────────────────
ALTER TYPE "DesignTargetStatus" RENAME TO "TaskStatus";
ALTER TABLE "design_targets" RENAME TO "tasks";
ALTER SEQUENCE "design_targets_id_seq" RENAME TO "tasks_id_seq";
ALTER SEQUENCE "design_job_number_seq" RENAME TO "task_number_seq";

-- Columns. ⚠️ `last_activity_at` is GENERATED from uploaded_at/live_at among
-- others: PostgreSQL keeps the expression by column number, so a RENAME
-- carries the generated expression along (it then reads delivered_at/published_at).
ALTER TABLE "tasks" RENAME COLUMN "asin" TO "reference";
ALTER TABLE "tasks" RENAME COLUMN "job_number" TO "task_number";
ALTER TABLE "tasks" RENAME COLUMN "uploaded_at" TO "delivered_at";
ALTER TABLE "tasks" RENAME COLUMN "live_at" TO "published_at";
ALTER TABLE "tasks" RENAME COLUMN "live_asin" TO "published_ref";

ALTER TABLE "tasks" ALTER COLUMN "reference" SET DATA TYPE VARCHAR(200);
ALTER TABLE "tasks" ALTER COLUMN "published_ref" SET DATA TYPE VARCHAR(200);
ALTER TABLE "tasks" ADD COLUMN "link" VARCHAR(500);

-- Existing rows keep opening the page they always opened
UPDATE "tasks" SET "link" = 'https://www.amazon.com/dp/' || "reference";

-- Drop reasons: the old studio-specific values map onto the generic list
UPDATE "tasks" SET "drop_reason" = CASE
    WHEN "drop_reason" = 'not_found' THEN 'not_needed'
    WHEN "drop_reason" IN ('copyright', 'events') THEN 'cannot_do'
    WHEN "drop_reason" IN ('not_needed', 'cannot_do', 'duplicate', 'other') THEN "drop_reason"
    ELSE 'other'
  END
  WHERE "drop_reason" IS NOT NULL;
ALTER TABLE "tasks" ALTER COLUMN "drop_reason" SET DATA TYPE VARCHAR(16);

-- Constraint and index names follow the table
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_pkey" TO "tasks_pkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_added_by_id_fkey" TO "tasks_added_by_id_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_assigned_to_id_fkey" TO "tasks_assigned_to_id_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_completed_by_id_fkey" TO "tasks_completed_by_id_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_checked_by_id_fkey" TO "tasks_checked_by_id_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_fixed_by_id_fkey" TO "tasks_fixed_by_id_fkey";
ALTER TABLE "tasks" RENAME CONSTRAINT "design_targets_reviewed_by_id_fkey" TO "tasks_reviewed_by_id_fkey";

ALTER INDEX "design_targets_asin_key" RENAME TO "tasks_reference_key";
ALTER INDEX "design_targets_job_number_key" RENAME TO "tasks_task_number_key";
ALTER INDEX "design_targets_status_idx" RENAME TO "tasks_status_idx";
ALTER INDEX "design_targets_assigned_to_id_status_idx" RENAME TO "tasks_assigned_to_id_status_idx";
ALTER INDEX "design_targets_completed_by_id_idx" RENAME TO "tasks_completed_by_id_idx";
ALTER INDEX "design_targets_last_activity_at_idx" RENAME TO "tasks_last_activity_at_idx";
ALTER INDEX "design_targets_assigned_to_id_last_activity_at_idx" RENAME TO "tasks_assigned_to_id_last_activity_at_idx";
ALTER INDEX "design_targets_to_check_idx" RENAME TO "tasks_to_check_idx";
ALTER INDEX "design_targets_to_fix_idx" RENAME TO "tasks_to_fix_idx";
ALTER INDEX "design_targets_to_review_idx" RENAME TO "tasks_to_review_idx";

-- ── design_credits → task_credits ───────────────────────────────────────────
ALTER TABLE "design_credits" RENAME TO "task_credits";
ALTER TABLE "task_credits" RENAME COLUMN "design_id" TO "task_number";
ALTER TABLE "task_credits" RENAME CONSTRAINT "design_credits_pkey" TO "task_credits_pkey";
ALTER TABLE "task_credits" RENAME CONSTRAINT "design_credits_employee_id_fkey" TO "task_credits_employee_id_fkey";
ALTER INDEX "design_credits_employee_id_first_work_date_idx" RENAME TO "task_credits_employee_id_first_work_date_idx";

-- ── Daily numbers and targets ───────────────────────────────────────────────
ALTER TABLE "daily_summary" RENAME COLUMN "designs_done" TO "tasks_started";
ALTER TABLE "work_policies" RENAME COLUMN "daily_design_target" TO "daily_task_target";
ALTER TABLE "employees" RENAME COLUMN "daily_design_target" TO "daily_task_target";

-- ── Kind of work → receives tasks ───────────────────────────────────────────
-- Designers and managers received the morning hand-out. Managers had no daily
-- target; an explicit 0 keeps it that way now that "has a target" is
-- receives_tasks AND a target above 0.
ALTER TABLE "employees" ADD COLUMN "receives_tasks" BOOLEAN NOT NULL DEFAULT false;
UPDATE "employees" SET "receives_tasks" = true WHERE "staff_type" IN ('designer', 'manager');
UPDATE "employees" SET "daily_task_target" = 0
  WHERE "staff_type" = 'manager' AND "daily_task_target" IS NULL;
ALTER TABLE "employees" DROP COLUMN "staff_type";
DROP TYPE "StaffType";

-- ── Start detection: the title-number index covers every app ────────────────
-- The apps are a setting now, so the index can no longer name them; it keeps
-- only titles that start with a number, which is what every lookup asks for.
-- ⚠️ The expression must match TASK_NUMBER_SQL_EXPR in task-start.rules.ts
--    character for character, or PostgreSQL silently stops using it.
DROP INDEX IF EXISTS "app_usage_design_id_idx";
CREATE INDEX "app_usage_task_number_idx"
    ON "app_usage" ((substring(btrim(window_title) FROM '^([0-9]{3,7})(?![0-9])')))
    WHERE substring(btrim(window_title) FROM '^([0-9]{3,7})(?![0-9])') IS NOT NULL;

-- ── Settings ────────────────────────────────────────────────────────────────
-- Module switch: the key is now `tasks` (the server still falls back to the
-- old key when `tasks` is absent)
UPDATE "settings"
   SET "value" = "value" || jsonb_build_object('tasks', "value" -> 'designTargets')
 WHERE "key" = 'features'
   AND jsonb_typeof("value") = 'object'
   AND "value" ? 'designTargets'
   AND NOT ("value" ? 'tasks');

-- An install that already has tasks keeps detecting starts in the apps it
-- always watched; a new install starts with detection off
INSERT INTO "settings" ("key", "value", "updated_at")
SELECT 'tasks', '{"startDetection":{"apps":["Illustrator.exe","Photoshop.exe"]}}'::jsonb, CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM "tasks")
ON CONFLICT ("key") DO NOTHING;

