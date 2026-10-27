-- L3: a screenshot's client_uuid is unique per device, not across all devices.
-- The duplicate lookup in screenshot-ingest.service.ts is scoped to the device;
-- with a global key, another PC's uuid still hit P2002 and could only ever be
-- answered as someone else's row. Existing rows are already unique globally,
-- so they are unique per device too: the new index is created first, then the
-- old one dropped, so there is no moment without a key.

-- CreateIndex
CREATE UNIQUE INDEX "screenshots_device_id_client_uuid_key" ON "screenshots"("device_id", "client_uuid");

-- DropIndex
DROP INDEX "screenshots_client_uuid_key";
