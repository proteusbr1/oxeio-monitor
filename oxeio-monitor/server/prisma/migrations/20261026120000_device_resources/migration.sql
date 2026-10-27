-- The agent's own resource use (handles, private memory, GDI/USER objects,
-- known injected DLLs such as nvspcap64.dll), sent in the heartbeat. The
-- latest report is kept on the device. NULL until an agent that sends it
-- checks in, so nothing changes for older agents.
ALTER TABLE "devices"
    ADD COLUMN "resources" JSONB,
    ADD COLUMN "resources_at" TIMESTAMPTZ(3);
