-- oxeio-monitor/server/prisma/migrations/20261012120000_presence_measure/migration.sql
-- CreateEnum
CREATE TYPE "HoursMeasure" AS ENUM ('active', 'presence');

-- AlterTable
ALTER TABLE "work_policies" ADD COLUMN     "hours_measure" "HoursMeasure" NOT NULL DEFAULT 'active',
ADD COLUMN     "presence_gap_min" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "daily_summary" ADD COLUMN     "presence_sec" INTEGER NOT NULL DEFAULT 0;
