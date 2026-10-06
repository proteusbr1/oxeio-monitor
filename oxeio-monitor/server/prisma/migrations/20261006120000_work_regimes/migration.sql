-- CreateEnum
CREATE TYPE "TargetBasis" AS ENUM ('month', 'week', 'day', 'none');

-- CreateEnum
CREATE TYPE "PayBasis" AS ENUM ('monthly', 'hourly', 'none');

-- AlterTable
ALTER TABLE "work_policies" ADD COLUMN     "break_minutes" INTEGER,
ADD COLUMN     "daily_target_hours" DECIMAL(4,2),
ADD COLUMN     "deduct_shortfall" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "overtime_multiplier" DECIMAL(4,2),
ADD COLUMN     "target_basis" "TargetBasis" NOT NULL DEFAULT 'month',
ADD COLUMN     "weekly_target_hours" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "hourly_rate" DECIMAL(12,2),
ADD COLUMN     "pay_basis" "PayBasis" NOT NULL DEFAULT 'monthly';

-- AlterTable
ALTER TABLE "salary_periods" ADD COLUMN     "hourly_rate" DECIMAL(12,2),
ADD COLUMN     "pay_basis" "PayBasis" NOT NULL DEFAULT 'monthly',
ALTER COLUMN "monthly_salary" DROP NOT NULL;

