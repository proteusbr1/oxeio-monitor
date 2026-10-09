-- AlterTable
ALTER TABLE "work_policies" ADD COLUMN     "schedule_enforced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "break_window_from" VARCHAR(5),
ADD COLUMN     "break_window_to" VARCHAR(5),
ADD COLUMN     "tolerance_mark_min" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tolerance_day_min" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "schedule_days" (
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "arrived_min" SMALLINT,
    "left_min" SMALLINT,
    "break_start_min" SMALLINT,
    "break_min" SMALLINT NOT NULL DEFAULT 0,
    "late_min" SMALLINT NOT NULL DEFAULT 0,
    "early_leave_min" SMALLINT NOT NULL DEFAULT 0,
    "balance_min" SMALLINT NOT NULL DEFAULT 0,
    "breaches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "final" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_days_pkey" PRIMARY KEY ("employee_id","work_date")
);

-- CreateIndex
CREATE INDEX "schedule_days_work_date_idx" ON "schedule_days"("work_date");

-- AddForeignKey
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
