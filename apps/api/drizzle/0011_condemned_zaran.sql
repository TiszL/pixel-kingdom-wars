ALTER TYPE "public"."deposit_kind" ADD VALUE 'mine';--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "payload" jsonb;