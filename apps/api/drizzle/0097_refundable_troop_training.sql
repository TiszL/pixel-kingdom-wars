ALTER TABLE "base_training_queue" ADD COLUMN "economy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD COLUMN "paid_shard_cost" bigint;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD COLUMN "debit_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD COLUMN "refund_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD COLUMN "cancel_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD COLUMN "quest_credited_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "economy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "paid_shard_cost" bigint;--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "debit_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "refund_ledger_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "cancel_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "training_queue" ADD COLUMN "quest_credited_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "training_cancel_day" date;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "training_cancel_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "training_cancel_day" date;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "training_cancel_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_refund_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_debit_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("debit_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_refund_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("refund_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "base_training_queue_base_cancel_key_uq" ON "base_training_queue" USING btree ("base_id","cancel_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "training_queue_player_cancel_key_uq" ON "training_queue" USING btree ("player_wallet","cancel_idempotency_key");--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_debit_ledger_txn_id_unique" UNIQUE("debit_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_refund_ledger_txn_id_unique" UNIQUE("refund_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_debit_ledger_txn_id_unique" UNIQUE("debit_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_refund_ledger_txn_id_unique" UNIQUE("refund_ledger_txn_id");--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_economy_version_ck" CHECK ("base_training_queue"."economy_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_state_ck" CHECK (
    ("base_training_queue"."economy_version" = 1 AND "base_training_queue"."paid_shard_cost" IS NULL AND "base_training_queue"."debit_ledger_txn_id" IS NULL
      AND "base_training_queue"."cancelled_at" IS NULL AND "base_training_queue"."refund_ledger_txn_id" IS NULL
      AND "base_training_queue"."cancel_idempotency_key" IS NULL AND "base_training_queue"."quest_credited_at" IS NOT NULL)
    OR ("base_training_queue"."economy_version" = 2 AND "base_training_queue"."paid_shard_cost" > 0 AND "base_training_queue"."debit_ledger_txn_id" IS NOT NULL AND (
      ("base_training_queue"."completed_at" IS NULL AND "base_training_queue"."cancelled_at" IS NULL AND "base_training_queue"."refund_ledger_txn_id" IS NULL
        AND "base_training_queue"."cancel_idempotency_key" IS NULL AND "base_training_queue"."quest_credited_at" IS NULL)
      OR ("base_training_queue"."completed_at" IS NOT NULL AND "base_training_queue"."cancelled_at" IS NULL AND "base_training_queue"."refund_ledger_txn_id" IS NULL
        AND "base_training_queue"."cancel_idempotency_key" IS NULL)
      OR ("base_training_queue"."completed_at" IS NOT NULL AND "base_training_queue"."cancelled_at" IS NOT NULL AND "base_training_queue"."refund_ledger_txn_id" IS NOT NULL
        AND "base_training_queue"."refund_ledger_txn_id" <> "base_training_queue"."debit_ledger_txn_id"
        AND "base_training_queue"."cancel_idempotency_key" IS NOT NULL AND "base_training_queue"."quest_credited_at" IS NULL)
    ))
  );--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_economy_version_ck" CHECK ("training_queue"."economy_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "training_queue" ADD CONSTRAINT "training_queue_state_ck" CHECK (
    ("training_queue"."economy_version" = 1 AND "training_queue"."paid_shard_cost" IS NULL AND "training_queue"."debit_ledger_txn_id" IS NULL
      AND "training_queue"."cancelled_at" IS NULL AND "training_queue"."refund_ledger_txn_id" IS NULL
      AND "training_queue"."cancel_idempotency_key" IS NULL AND "training_queue"."quest_credited_at" IS NOT NULL)
    OR ("training_queue"."economy_version" = 2 AND "training_queue"."paid_shard_cost" > 0 AND "training_queue"."debit_ledger_txn_id" IS NOT NULL AND (
      ("training_queue"."completed_at" IS NULL AND "training_queue"."cancelled_at" IS NULL AND "training_queue"."refund_ledger_txn_id" IS NULL
        AND "training_queue"."cancel_idempotency_key" IS NULL AND "training_queue"."quest_credited_at" IS NULL)
      OR ("training_queue"."completed_at" IS NOT NULL AND "training_queue"."cancelled_at" IS NULL AND "training_queue"."refund_ledger_txn_id" IS NULL
        AND "training_queue"."cancel_idempotency_key" IS NULL)
      OR ("training_queue"."completed_at" IS NOT NULL AND "training_queue"."cancelled_at" IS NOT NULL AND "training_queue"."refund_ledger_txn_id" IS NOT NULL
        AND "training_queue"."refund_ledger_txn_id" <> "training_queue"."debit_ledger_txn_id"
        AND "training_queue"."cancel_idempotency_key" IS NOT NULL AND "training_queue"."quest_credited_at" IS NULL)
    ))
  );--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_training_cancel_count_ck" CHECK ("players"."training_cancel_count" >= 0);--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_training_cancel_day_ck" CHECK (("players"."training_cancel_day" IS NULL) = ("players"."training_cancel_count" = 0));--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_training_cancel_count_ck" CHECK ("bases"."training_cancel_count" >= 0);--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_training_cancel_day_ck" CHECK (("bases"."training_cancel_day" IS NULL) = ("bases"."training_cancel_count" = 0));
