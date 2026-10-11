-- Hand-edited (0044 precedent). drizzle-kit generated `ALTER TYPE ... ADD
-- VALUE 'seeker'`, but the backfill below must USE that value, Postgres
-- forbids using an enum value added earlier in the SAME transaction, and the
-- drizzle migrator runs every pending migration in one transaction — so a
-- fresh deploy would die on "unsafe use of new value". Recreating the type is
-- the transaction-safe equivalent (values of a type CREATED in-transaction are
-- usable immediately); the end state matches the 0050 meta snapshot exactly.
ALTER TYPE "public"."alpha_access_source" RENAME TO "alpha_access_source_old";--> statement-breakpoint
CREATE TYPE "public"."alpha_access_source" AS ENUM('env', 'invite', 'manual', 'seeker');--> statement-breakpoint
ALTER TABLE "alpha_access" ALTER COLUMN "source" TYPE "public"."alpha_access_source" USING "source"::text::"public"."alpha_access_source";--> statement-breakpoint
DROP TYPE "public"."alpha_access_source_old";--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "sgt_checked_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (owner 2026-08-08): accounts that proved a Seeker BEFORE
-- auto-admission shipped must not need a re-link to be admitted — the claim
-- paths only grant when a seeker_links row is written, and these rows already
-- exist. Same sticky semantics as a link-time grant; includes REVOKED links on
-- purpose: the mint claim is the one-time admission ticket, and a later badge
-- loss never revokes access (apps/api/src/auth/seeker.ts claimSgtHolding).
INSERT INTO "alpha_access" ("wallet", "source")
SELECT "wallet", 'seeker' FROM "seeker_links"
ON CONFLICT ("wallet") DO NOTHING;