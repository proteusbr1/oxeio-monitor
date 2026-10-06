-- One-off history correction: G164 · G165 (7 September 2026, already run)
--
-- Careful: not a regular job; kept as a record. Story: docs/09-Build-Log.md § ৩ঞ৩১.১৩
-- It was run with:
--   ssh oxeio-new "docker exec -i oxeio-postgres psql -U oxeio -d oxeio" < this file
-- Result: UPDATE 7 · segments falling outside the envelope 52 -> 0
--
\set ON_ERROR_STOP on
BEGIN;

-- G164 backfill: a session's bounds must cover its own segments.
--
-- Careful: exactly what `widen()` did: the start only MOVES BACK, the end only MOVES
-- FORWARD.
-- Careful: an open session (`ended_at IS NULL`) gets no end set; the CASE handles
--     that, and it matters: open sessions are the input to day-close and logoff-close.
-- Careful: `end_reason` is not touched; `widen()` does not touch it either.

UPDATE work_sessions s
SET started_at = LEAST(s.started_at, b.min_start),
    ended_at   = CASE WHEN s.ended_at IS NULL THEN NULL
                      ELSE GREATEST(s.ended_at, b.max_end) END
FROM (SELECT session_id, min(started_at) AS min_start, max(ended_at) AS max_end
      FROM activity_segments GROUP BY session_id) b
WHERE b.session_id = s.id
  AND (s.started_at > b.min_start
       OR (s.ended_at IS NOT NULL AND s.ended_at < b.max_end));

-- Guard: from now on not a single segment may lie outside its own session
DO $$
DECLARE bad int; neg int;
BEGIN
  SELECT count(*) INTO bad
  FROM work_sessions s JOIN activity_segments a ON a.session_id = s.id
  WHERE a.started_at < s.started_at
     OR (s.ended_at IS NOT NULL AND a.ended_at > s.ended_at);

  SELECT count(*) INTO neg
  FROM work_sessions WHERE ended_at IS NOT NULL AND ended_at < started_at;

  IF bad <> 0 OR neg <> 0 THEN
    RAISE EXCEPTION 'guard failed: outside=% negative=%', bad, neg;
  END IF;
END $$;

COMMIT;

SELECT 'broken_after' AS k, count(DISTINCT s.id)::text AS v
FROM work_sessions s JOIN activity_segments a ON a.session_id = s.id
WHERE a.started_at < s.started_at
   OR (s.ended_at IS NOT NULL AND a.ended_at > s.ended_at);
