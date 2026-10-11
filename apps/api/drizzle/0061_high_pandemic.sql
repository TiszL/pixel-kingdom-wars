ALTER TABLE "players" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
-- Existing enabled authenticators predate the maturation policy. Treat them as
-- safely mature instead of unexpectedly withholding a previously available path.
UPDATE "players"
SET "totp_enabled_at" = TIMESTAMPTZ '1970-01-01 00:00:00+00'
WHERE "totp_enabled" = true;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_totp_enabled_at_ck" CHECK ((totp_enabled AND totp_enabled_at IS NOT NULL) OR (NOT totp_enabled AND totp_enabled_at IS NULL));
