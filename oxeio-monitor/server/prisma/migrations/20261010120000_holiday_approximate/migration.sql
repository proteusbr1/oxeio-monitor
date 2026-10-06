-- "This holiday's date is an estimate" becomes a real column.
--
-- It used to be a marker at the end of the holiday's name: the Bengali word
-- for "probable" in parentheses, written by the old seed and read by the
-- reports. A flag hidden in free text in one language is not a product
-- feature, so it moves to `holidays.approximate`.
--
-- Existing rows: a name ending with the marker (ignoring trailing spaces, as
-- the old reader did) gets `approximate = true` and loses the marker; any
-- other row stays as it is. A name that would be left empty keeps its text.

ALTER TABLE "holidays" ADD COLUMN "approximate" BOOLEAN NOT NULL DEFAULT false;

UPDATE "holidays"
SET "approximate" = true,
    "name" = COALESCE(
      NULLIF(rtrim(left(rtrim("name"), -char_length('(সম্ভাব্য)'))), ''),
      "name"
    )
WHERE rtrim("name") LIKE '%(সম্ভাব্য)';

-- New installs start from a generic policy (the setup wizard's default when
-- no country is given); existing rows keep their values.
ALTER TABLE "work_policies" ALTER COLUMN "monthly_target_hours" SET DEFAULT 176;
ALTER TABLE "work_policies" ALTER COLUMN "expected_workdays" SET DEFAULT 22;
ALTER TABLE "work_policies" ALTER COLUMN "timezone" SET DEFAULT 'UTC';
ALTER TABLE "monthly_summary" ALTER COLUMN "target_sec" SET DEFAULT 633600;
