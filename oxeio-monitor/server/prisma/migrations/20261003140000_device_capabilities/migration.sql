-- The agent's report on its own parts (idle detection, app tracking,
-- website domains, screenshots, jiggler check, upload), sent in the
-- heartbeat. Stored only when it changes. NULL until an agent that sends
-- it checks in, so nothing changes for older agents.
ALTER TABLE "devices"
    ADD COLUMN "capabilities" JSONB,
    ADD COLUMN "capabilities_at" TIMESTAMPTZ(3);
