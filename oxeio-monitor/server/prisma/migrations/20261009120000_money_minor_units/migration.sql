-- Money columns: "amount in hundredths of the currency" is named after the
-- generic minor unit, not one currency's. Rename only: every stored value
-- stays as it is (still integers, still hundredths), and the CHECK
-- constraints (`deposit_policy_amount_positive`,
-- `security_deposits_amount_positive`) follow the column automatically.

ALTER TABLE "deposit_policy" RENAME COLUMN "amount_paisa" TO "amount_minor";
ALTER TABLE "security_deposits" RENAME COLUMN "amount_paisa" TO "amount_minor";
ALTER TABLE "deposit_settlements" RENAME COLUMN "amount_paisa" TO "amount_minor";
