CREATE TABLE "clan_command_receipts" (
	"actor_wallet" text NOT NULL,
	"request_key" uuid NOT NULL,
	"kind" text NOT NULL,
	"clan_id" uuid NOT NULL,
	"base_id" uuid,
	"target_wallet" text,
	"state" text NOT NULL,
	"payout_shards" bigint NOT NULL,
	"ledger_transaction_id" uuid,
	"refusal_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_command_receipts_actor_wallet_request_key_pk" PRIMARY KEY("actor_wallet","request_key"),
	CONSTRAINT "clan_command_consent_ck" CHECK (("clan_command_receipts"."kind" = 'leave' AND "clan_command_receipts"."target_wallet" IS NULL AND "clan_command_receipts"."state" IN ('left','disbanded','refused'))
    OR ("clan_command_receipts"."kind" = 'kick' AND "clan_command_receipts"."base_id" IS NULL AND "clan_command_receipts"."target_wallet" IS NOT NULL AND "clan_command_receipts"."state" IN ('kicked','refused'))),
	CONSTRAINT "clan_command_outcome_ck" CHECK ("clan_command_receipts"."payout_shards" >= 0 AND
    (("clan_command_receipts"."state" = 'refused' AND "clan_command_receipts"."refusal_code" IS NOT NULL AND "clan_command_receipts"."refusal_code" IN ('CLAN_CHANGED','CLAN_LEADER_NOT_ALONE','CLAN_NOT_LEADER','CLAN_SELF_KICK','CLAN_TARGET_ABSENT'))
      OR ("clan_command_receipts"."state" <> 'refused' AND "clan_command_receipts"."refusal_code" IS NULL)) AND
    (("clan_command_receipts"."state" = 'disbanded' AND (("clan_command_receipts"."payout_shards" > 0 AND "clan_command_receipts"."ledger_transaction_id" IS NOT NULL)
      OR ("clan_command_receipts"."payout_shards" = 0 AND "clan_command_receipts"."ledger_transaction_id" IS NULL)))
      OR ("clan_command_receipts"."state" <> 'disbanded' AND "clan_command_receipts"."payout_shards" = 0 AND "clan_command_receipts"."ledger_transaction_id" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "clan_command_receipts" ADD CONSTRAINT "clan_command_receipts_actor_wallet_players_wallet_fk" FOREIGN KEY ("actor_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_command_receipts" ADD CONSTRAINT "clan_command_receipts_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clan_command_payout_uq" ON "clan_command_receipts" USING btree ("ledger_transaction_id") WHERE "clan_command_receipts"."ledger_transaction_id" IS NOT NULL;
--> statement-breakpoint
-- Exact command outcomes are permanent evidence, including definitive refusals.
-- Legacy management writers never edit these rows and require no fabricated
-- backfill. A rolled-back application can omit v1 but cannot erase its history.
CREATE FUNCTION public.shardkeep_clan_command_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'clan command receipts are immutable and retained' USING ERRCODE = '23514';
END
$$;
--> statement-breakpoint
CREATE TRIGGER clan_command_immutable BEFORE UPDATE OR DELETE ON clan_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_command_retention();
--> statement-breakpoint
CREATE TRIGGER clan_command_retention BEFORE TRUNCATE ON clan_command_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_clan_command_retention();
