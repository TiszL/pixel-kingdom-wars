-- Hand-edited (0050 precedent). drizzle-kit generated `ALTER TYPE ... ADD
-- VALUE 'referral'`, but Postgres forbids ALTER TYPE ADD VALUE inside a
-- transaction block and the drizzle migrator runs every pending migration in
-- one transaction. Recreating the type is the transaction-safe equivalent;
-- the end state matches the 0084 meta snapshot exactly.
-- D-052 (owner 2026-08-15, M23 a16): an alpha member's referral code admits
-- their friend to the closed alpha — source 'referral'.
ALTER TYPE "public"."alpha_access_source" RENAME TO "alpha_access_source_old";--> statement-breakpoint
CREATE TYPE "public"."alpha_access_source" AS ENUM('env', 'invite', 'manual', 'seeker', 'referral');--> statement-breakpoint
ALTER TABLE "alpha_access" ALTER COLUMN "source" TYPE "public"."alpha_access_source" USING "source"::text::"public"."alpha_access_source";--> statement-breakpoint
DROP TYPE "public"."alpha_access_source_old";
