-- M3: logout ends that one session. The token's jti goes here and is refused
-- until it would have expired by itself (SESSION_TTL_MIN); the server keeps the
-- list in memory and reloads it from this table at startup.

-- CreateTable
CREATE TABLE "revoked_sessions" (
    "session_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE INDEX "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");
