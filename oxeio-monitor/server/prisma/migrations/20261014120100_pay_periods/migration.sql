-- CreateEnum
CREATE TYPE "StatementDelivery" AS ENUM ('pending', 'sent', 'failed', 'no_recipients', 'not_configured', 'no_staff');

-- CreateTable
CREATE TABLE "pay_periods" (
    "id" SERIAL NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "snapshot_at" TIMESTAMPTZ(3),
    "delivery_status" "StatementDelivery",
    "delivery_error" TEXT,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_period_lines" (
    "id" SERIAL NOT NULL,
    "period_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "measured_sec" INTEGER NOT NULL,
    "carry_in_sec" INTEGER NOT NULL,
    "to_post_min" INTEGER NOT NULL,
    "leave_days" INTEGER NOT NULL DEFAULT 0,
    "holiday_days" INTEGER NOT NULL DEFAULT 0,
    "no_data_days" INTEGER NOT NULL DEFAULT 0,
    "posted_min" INTEGER,
    "posted_at" TIMESTAMPTZ(3),
    "posted_by_id" INTEGER,
    "note" TEXT,

    CONSTRAINT "pay_period_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pay_periods_start_date_key" ON "pay_periods"("start_date");
CREATE INDEX "pay_period_lines_employee_id_idx" ON "pay_period_lines"("employee_id");
CREATE UNIQUE INDEX "pay_period_lines_period_id_employee_id_key" ON "pay_period_lines"("period_id", "employee_id");

-- AddForeignKey
ALTER TABLE "pay_period_lines" ADD CONSTRAINT "pay_period_lines_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "pay_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pay_period_lines" ADD CONSTRAINT "pay_period_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pay_period_lines" ADD CONSTRAINT "pay_period_lines_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
