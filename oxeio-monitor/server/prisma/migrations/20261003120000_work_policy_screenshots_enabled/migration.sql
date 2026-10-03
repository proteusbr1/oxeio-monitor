-- Screenshots can be turned off per work policy (default on = as before).
--
-- ⚠️ Off stops the screenshot only. The agent keeps sampling the screen on
-- the PC for the jiggler check (G46) and that fingerprint never leaves the
-- machine, so turning screenshots off does not change how hours are counted.
ALTER TABLE "work_policies"
    ADD COLUMN "screenshots_enabled" BOOLEAN NOT NULL DEFAULT true;
