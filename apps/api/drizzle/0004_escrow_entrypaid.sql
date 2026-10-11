ALTER TYPE "public"."account_kind" ADD VALUE 'withdrawal_escrow';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE 'onchain_outflow';--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "entry_paid_at" timestamp with time zone;