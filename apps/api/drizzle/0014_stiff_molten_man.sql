ALTER TABLE "players" ADD COLUMN "totp_last_used_step" bigint;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "twofa_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "twofa_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_request_ledger_txn_id_unique" UNIQUE("request_ledger_txn_id");