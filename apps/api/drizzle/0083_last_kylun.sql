ALTER TYPE "public"."account_kind" ADD VALUE 'mail_keep_escrow';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'mail_shards_escrow';--> statement-breakpoint
ALTER TYPE "public"."builder_job_kind" ADD VALUE 'repair';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE 'airdefence';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE 'powdermine';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE 'pitfall';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE 'airmine';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE 'clanhall';--> statement-breakpoint
CREATE TABLE "mail_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint,
	"item_id" text,
	"qty" integer,
	CONSTRAINT "mail_attachments_message_position_uq" UNIQUE("message_id","position"),
	CONSTRAINT "mail_attachments_payload_ck" CHECK (
    ("mail_attachments"."kind" IN ('KEEP', 'SHARDS') AND "mail_attachments"."amount" > 0
      AND "mail_attachments"."item_id" IS NULL AND "mail_attachments"."qty" IS NULL)
    OR ("mail_attachments"."kind" = 'ITEM' AND "mail_attachments"."amount" IS NULL
      AND "mail_attachments"."item_id" IS NOT NULL AND "mail_attachments"."qty" > 0)
  )
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_wallet" text NOT NULL,
	"sender_kind" text NOT NULL,
	"sender_wallet" text,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"reward_state" text,
	"reserve_ledger_txn_id" uuid,
	"claim_ledger_txn_id" uuid,
	"unwind_ledger_txn_id" uuid,
	"claim_base_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	CONSTRAINT "mail_messages_reserve_ledger_txn_id_unique" UNIQUE("reserve_ledger_txn_id"),
	CONSTRAINT "mail_messages_claim_ledger_txn_id_unique" UNIQUE("claim_ledger_txn_id"),
	CONSTRAINT "mail_messages_unwind_ledger_txn_id_unique" UNIQUE("unwind_ledger_txn_id"),
	CONSTRAINT "mail_messages_recipient_dedupe_uq" UNIQUE("recipient_wallet","dedupe_key"),
	CONSTRAINT "mail_messages_sender_ck" CHECK (
    ("mail_messages"."sender_kind" = 'system' AND "mail_messages"."sender_wallet" IS NULL)
    OR ("mail_messages"."sender_kind" = 'admin' AND "mail_messages"."sender_wallet" IS NOT NULL)
  ),
	CONSTRAINT "mail_messages_lifecycle_ck" CHECK (
    ("mail_messages"."kind" = 'info' AND "mail_messages"."reward_state" IS NULL AND "mail_messages"."expires_at" IS NULL
      AND "mail_messages"."reserve_ledger_txn_id" IS NULL AND "mail_messages"."claim_ledger_txn_id" IS NULL
      AND "mail_messages"."unwind_ledger_txn_id" IS NULL AND "mail_messages"."claim_base_id" IS NULL
      AND "mail_messages"."claimed_at" IS NULL AND "mail_messages"."expired_at" IS NULL)
    OR
    ("mail_messages"."kind" = 'reward' AND "mail_messages"."reward_state" IN ('pending', 'claimed', 'expired')
      AND "mail_messages"."expires_at" IS NOT NULL
      AND (
        ("mail_messages"."reward_state" = 'pending' AND "mail_messages"."claim_ledger_txn_id" IS NULL
          AND "mail_messages"."unwind_ledger_txn_id" IS NULL AND "mail_messages"."claimed_at" IS NULL AND "mail_messages"."expired_at" IS NULL)
        OR ("mail_messages"."reward_state" = 'claimed' AND "mail_messages"."unwind_ledger_txn_id" IS NULL
          AND "mail_messages"."claimed_at" IS NOT NULL AND "mail_messages"."expired_at" IS NULL)
        OR ("mail_messages"."reward_state" = 'expired' AND "mail_messages"."claim_ledger_txn_id" IS NULL
          AND "mail_messages"."claim_base_id" IS NULL AND "mail_messages"."claimed_at" IS NULL AND "mail_messages"."expired_at" IS NOT NULL)
      ))
  )
);
--> statement-breakpoint
ALTER TABLE "buildings" ADD COLUMN "trap_spent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_recipient_wallet_players_wallet_fk" FOREIGN KEY ("recipient_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_sender_wallet_players_wallet_fk" FOREIGN KEY ("sender_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_reserve_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("reserve_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_claim_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("claim_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_unwind_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("unwind_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_claim_base_id_bases_id_fk" FOREIGN KEY ("claim_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_attachments_message_idx" ON "mail_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_messages_inbox_idx" ON "mail_messages" USING btree ("recipient_wallet","archived_at","created_at","id");--> statement-breakpoint
CREATE INDEX "mail_messages_expiry_idx" ON "mail_messages" USING btree ("reward_state","expires_at","id");