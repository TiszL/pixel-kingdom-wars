-- Hand-edited (0050/0084 precedent). drizzle-kit generated `ALTER TYPE ... ADD
-- VALUE 'onboarding'`, but Postgres forbids ALTER TYPE ADD VALUE inside a
-- transaction block and the drizzle migrator runs every pending migration in
-- one transaction. Recreating the type is the transaction-safe equivalent;
-- the end state matches the 0093 meta snapshot exactly.
-- Owner 2026-08-28: onboarding is quest driven — the five first-run objectives
-- (camp, mine, barracks, land, first raid) are quest rows of their own scope so
-- they reuse quest_progress/base_quest_progress and the claim route, and so the
-- all-three DAILY bonus (which counts scope='daily') can never see them.
-- `quests.scope` is the only column of this type.
ALTER TYPE "public"."quest_scope" RENAME TO "quest_scope_old";--> statement-breakpoint
CREATE TYPE "public"."quest_scope" AS ENUM('daily', 'weekly', 'onboarding');--> statement-breakpoint
ALTER TABLE "quests" ALTER COLUMN "scope" TYPE "public"."quest_scope" USING "scope"::text::"public"."quest_scope";--> statement-breakpoint
DROP TYPE "public"."quest_scope_old";
