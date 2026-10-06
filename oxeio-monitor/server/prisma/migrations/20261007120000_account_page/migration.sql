-- AlterTable
ALTER TABLE "users" ADD COLUMN     "preferences" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "sessions_revoked_at" TIMESTAMPTZ(3);
