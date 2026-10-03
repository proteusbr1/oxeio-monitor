-- The owner's signature on each agent MSI (base64 DER ECDSA), passed on in
-- the update offer. NULL = published unsigned — every existing version, and
-- what agents without an update key accept, as before.
ALTER TABLE "agent_versions" ADD COLUMN "signature" TEXT;
