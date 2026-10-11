ALTER TABLE "base_troop_research" ADD COLUMN "paid_shard_cost" bigint;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD COLUMN "debit_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD COLUMN "refund_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD COLUMN "cancel_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "upgrade_cancel_day" date;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "upgrade_cancel_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "research_cancel_day" date;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "research_cancel_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "paid_shard_cost" bigint;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "debit_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "refund_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "cancel_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "upgrade_cancel_day" date;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "upgrade_cancel_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "research_cancel_day" date;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "research_cancel_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "troop_research" ADD COLUMN "paid_shard_cost" bigint;--> statement-breakpoint
ALTER TABLE "troop_research" ADD COLUMN "debit_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "troop_research" ADD COLUMN "refund_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "troop_research" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "troop_research" ADD COLUMN "cancel_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD CONSTRAINT "base_troop_research_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD CONSTRAINT "base_troop_research_refund_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_refund_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troop_research" ADD CONSTRAINT "troop_research_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troop_research" ADD CONSTRAINT "troop_research_refund_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "base_troop_research_base_cancel_key_uq" ON "base_troop_research" USING btree ("base_id","cancel_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_jobs_player_cancel_key_uq" ON "builder_jobs" USING btree ("player_wallet","cancel_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "troop_research_player_cancel_key_uq" ON "troop_research" USING btree ("player_wallet","cancel_idempotency_key");--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD CONSTRAINT "base_troop_research_debit_ledger_txn_id_unique" UNIQUE("debit_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD CONSTRAINT "base_troop_research_refund_ledger_txn_id_unique" UNIQUE("refund_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_debit_ledger_txn_id_unique" UNIQUE("debit_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_refund_ledger_txn_id_unique" UNIQUE("refund_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "troop_research" ADD CONSTRAINT "troop_research_debit_ledger_txn_id_unique" UNIQUE("debit_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "troop_research" ADD CONSTRAINT "troop_research_refund_ledger_txn_id_unique" UNIQUE("refund_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD CONSTRAINT "base_troop_research_cancel_state_ck" CHECK (
    ("base_troop_research"."paid_shard_cost" IS NULL AND "base_troop_research"."debit_ledger_txn_id" IS NULL
      AND "base_troop_research"."cancelled_at" IS NULL AND "base_troop_research"."refund_ledger_txn_id" IS NULL AND "base_troop_research"."cancel_idempotency_key" IS NULL)
    OR ("base_troop_research"."paid_shard_cost" > 0 AND "base_troop_research"."debit_ledger_txn_id" IS NOT NULL AND (
      ("base_troop_research"."cancelled_at" IS NULL AND "base_troop_research"."refund_ledger_txn_id" IS NULL AND "base_troop_research"."cancel_idempotency_key" IS NULL)
      OR ("base_troop_research"."cancelled_at" IS NOT NULL AND "base_troop_research"."researching_to_level" IS NULL AND "base_troop_research"."refund_ledger_txn_id" IS NOT NULL
        AND "base_troop_research"."refund_ledger_txn_id" <> "base_troop_research"."debit_ledger_txn_id" AND "base_troop_research"."cancel_idempotency_key" IS NOT NULL)
    ))
  );--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_upgrade_cancel_count_ck" CHECK ("bases"."upgrade_cancel_count" >= 0);--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_upgrade_cancel_day_ck" CHECK (("bases"."upgrade_cancel_day" IS NULL) = ("bases"."upgrade_cancel_count" = 0));--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_research_cancel_count_ck" CHECK ("bases"."research_cancel_count" >= 0);--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_research_cancel_day_ck" CHECK (("bases"."research_cancel_day" IS NULL) = ("bases"."research_cancel_count" = 0));--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_cancel_state_ck" CHECK (
    ("builder_jobs"."paid_shard_cost" IS NULL AND "builder_jobs"."debit_ledger_txn_id" IS NULL
      AND "builder_jobs"."cancelled_at" IS NULL AND "builder_jobs"."refund_ledger_txn_id" IS NULL AND "builder_jobs"."cancel_idempotency_key" IS NULL)
    OR ("builder_jobs"."paid_shard_cost" > 0 AND "builder_jobs"."debit_ledger_txn_id" IS NOT NULL AND "builder_jobs"."kind" = 'upgrade' AND (
      ("builder_jobs"."cancelled_at" IS NULL AND "builder_jobs"."refund_ledger_txn_id" IS NULL AND "builder_jobs"."cancel_idempotency_key" IS NULL)
      OR ("builder_jobs"."cancelled_at" IS NOT NULL AND "builder_jobs"."completed_at" IS NOT NULL AND "builder_jobs"."refund_ledger_txn_id" IS NOT NULL
        AND "builder_jobs"."refund_ledger_txn_id" <> "builder_jobs"."debit_ledger_txn_id" AND "builder_jobs"."cancel_idempotency_key" IS NOT NULL)
    ))
  );--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_upgrade_cancel_count_ck" CHECK ("players"."upgrade_cancel_count" >= 0);--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_upgrade_cancel_day_ck" CHECK (("players"."upgrade_cancel_day" IS NULL) = ("players"."upgrade_cancel_count" = 0));--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_research_cancel_count_ck" CHECK ("players"."research_cancel_count" >= 0);--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_research_cancel_day_ck" CHECK (("players"."research_cancel_day" IS NULL) = ("players"."research_cancel_count" = 0));--> statement-breakpoint
ALTER TABLE "troop_research" ADD CONSTRAINT "troop_research_cancel_state_ck" CHECK (
    ("troop_research"."paid_shard_cost" IS NULL AND "troop_research"."debit_ledger_txn_id" IS NULL
      AND "troop_research"."cancelled_at" IS NULL AND "troop_research"."refund_ledger_txn_id" IS NULL AND "troop_research"."cancel_idempotency_key" IS NULL)
    OR ("troop_research"."paid_shard_cost" > 0 AND "troop_research"."debit_ledger_txn_id" IS NOT NULL AND (
      ("troop_research"."cancelled_at" IS NULL AND "troop_research"."refund_ledger_txn_id" IS NULL AND "troop_research"."cancel_idempotency_key" IS NULL)
      OR ("troop_research"."cancelled_at" IS NOT NULL AND "troop_research"."researching_to_level" IS NULL AND "troop_research"."refund_ledger_txn_id" IS NOT NULL
        AND "troop_research"."refund_ledger_txn_id" <> "troop_research"."debit_ledger_txn_id" AND "troop_research"."cancel_idempotency_key" IS NOT NULL)
    ))
  );