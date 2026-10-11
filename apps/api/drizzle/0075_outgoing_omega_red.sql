-- D-035 deed Forge custody. A settled base position must name its SHARDS burn
-- and (when positive) KEEP allocation. Claim/expiry are mutually exclusive and
-- carry their own ledger transaction, so a deed transfer can change who claims
-- without rewriting history or losing audit attribution.
ALTER TABLE "base_forge_positions" DROP CONSTRAINT "base_forge_positions_amounts_ck";--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD COLUMN "shard_settlement_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD COLUMN "keep_escrow_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD COLUMN "claim_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD COLUMN "expire_txn_id" uuid;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_shard_settlement_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("shard_settlement_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_keep_escrow_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("keep_escrow_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_claim_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("claim_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_expire_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("expire_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_shard_settlement_txn_id_unique" UNIQUE("shard_settlement_txn_id");--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_keep_escrow_txn_id_unique" UNIQUE("keep_escrow_txn_id");--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_claim_txn_id_unique" UNIQUE("claim_txn_id");--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_expire_txn_id_unique" UNIQUE("expire_txn_id");--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_custody_ck" CHECK (
    ("base_forge_positions"."settled_at" IS NULL
      AND "base_forge_positions"."counted_shards" IS NULL AND "base_forge_positions"."shards_refunded" IS NULL AND "base_forge_positions"."keep_paid" IS NULL
      AND "base_forge_positions"."settlement_owner_wallet" IS NULL
      AND "base_forge_positions"."shard_settlement_txn_id" IS NULL AND "base_forge_positions"."keep_escrow_txn_id" IS NULL
      AND "base_forge_positions"."claimed_at" IS NULL AND "base_forge_positions"."claim_txn_id" IS NULL
      AND "base_forge_positions"."expired_at" IS NULL AND "base_forge_positions"."expire_txn_id" IS NULL)
    OR
    ("base_forge_positions"."settled_at" IS NOT NULL
      AND "base_forge_positions"."counted_shards" IS NOT NULL AND "base_forge_positions"."shards_refunded" IS NOT NULL AND "base_forge_positions"."keep_paid" IS NOT NULL
      AND "base_forge_positions"."settlement_owner_wallet" IS NOT NULL
      AND (("base_forge_positions"."counted_shards" = 0 AND "base_forge_positions"."shard_settlement_txn_id" IS NULL)
        OR ("base_forge_positions"."counted_shards" > 0 AND "base_forge_positions"."shard_settlement_txn_id" IS NOT NULL))
      AND (("base_forge_positions"."keep_paid" = 0 AND "base_forge_positions"."keep_escrow_txn_id" IS NULL
          AND "base_forge_positions"."claimed_at" IS NULL AND "base_forge_positions"."claim_txn_id" IS NULL
          AND "base_forge_positions"."expired_at" IS NULL AND "base_forge_positions"."expire_txn_id" IS NULL)
        OR ("base_forge_positions"."keep_paid" > 0 AND "base_forge_positions"."keep_escrow_txn_id" IS NOT NULL
          AND (("base_forge_positions"."claimed_at" IS NULL AND "base_forge_positions"."claim_txn_id" IS NULL
              AND "base_forge_positions"."expired_at" IS NULL AND "base_forge_positions"."expire_txn_id" IS NULL)
            OR ("base_forge_positions"."claimed_at" IS NOT NULL AND "base_forge_positions"."claim_txn_id" IS NOT NULL
              AND "base_forge_positions"."expired_at" IS NULL AND "base_forge_positions"."expire_txn_id" IS NULL)
            OR ("base_forge_positions"."claimed_at" IS NULL AND "base_forge_positions"."claim_txn_id" IS NULL
              AND "base_forge_positions"."expired_at" IS NOT NULL AND "base_forge_positions"."expire_txn_id" IS NOT NULL)))))
  );--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_amounts_ck" CHECK (
    "base_forge_positions"."contributed_shards" >= 0
    AND "base_forge_positions"."raid_debited_shards" >= 0
    AND "base_forge_positions"."raid_debited_shards" <= "base_forge_positions"."contributed_shards"
    AND ("base_forge_positions"."counted_shards" IS NULL OR "base_forge_positions"."counted_shards" >= 0)
    AND ("base_forge_positions"."shards_refunded" IS NULL OR "base_forge_positions"."shards_refunded" >= 0)
    AND ("base_forge_positions"."keep_paid" IS NULL OR "base_forge_positions"."keep_paid" >= 0)
    AND ("base_forge_positions"."counted_shards" IS NULL OR "base_forge_positions"."counted_shards" <= "base_forge_positions"."contributed_shards" - "base_forge_positions"."raid_debited_shards")
  );
