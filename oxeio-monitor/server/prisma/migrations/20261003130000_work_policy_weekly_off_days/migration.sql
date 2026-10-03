-- Several weekly days off per policy (e.g. Sat + Sun), instead of one.
--
-- ⚠️ The old column is copied, then dropped: two columns saying which days
-- are off would sooner or later disagree, and workdays, targets, pace and
-- prorated salary all hang on this one answer. A single day off becomes a
-- one-element list, so an existing policy (Friday = 5) counts exactly as
-- before; NULL ("no weekly day off") becomes an empty list.
ALTER TABLE "work_policies"
    ADD COLUMN "weekly_off_days" SMALLINT[] NOT NULL DEFAULT ARRAY[]::SMALLINT[];

UPDATE "work_policies"
   SET "weekly_off_days" = ARRAY["weekly_off_day"]
 WHERE "weekly_off_day" IS NOT NULL;

ALTER TABLE "work_policies" DROP COLUMN "weekly_off_day";
