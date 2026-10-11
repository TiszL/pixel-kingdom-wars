ALTER TABLE "email_otps" ADD COLUMN "target_email" text;--> statement-breakpoint
ALTER TABLE "email_otps" ADD COLUMN "challenge_context" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "pending_email" text;--> statement-breakpoint
-- Pre-0059 challenges used an offline-brute-forceable SHA-256 digest and were
-- not bound to a recipient/context. They live for minutes, so consume them at
-- the cryptographic boundary instead of carrying an unsafe compatibility path.
UPDATE "email_otps" SET "consumed_at" = NOW() WHERE "consumed_at" IS NULL;--> statement-breakpoint
-- Before pending_email existed, starting a replacement immediately demoted the
-- address. Preserve any unfinished first enrollment as pending; a new keyed code
-- is required because every legacy challenge above was deliberately consumed.
UPDATE "players"
SET "pending_email" = "email", "email" = NULL
WHERE "email_verified" = false AND "email" IS NOT NULL;
