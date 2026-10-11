ALTER TABLE "tester_feedback" ADD COLUMN "exported_at" timestamp with time zone;--> statement-breakpoint
-- Owner 2026-09-04: FIXED is a flag beside the triage status; a fixed report is
-- an accepted one with fixed_at stamped. Fold the transitional status value.
-- The text cast matters: a fresh database applies 0103..0105 in ONE
-- transaction, and Postgres refuses an enum constant added in that same
-- transaction ("unsafe use of new value"); comparing the column as text does
-- not create the constant.
UPDATE "tester_feedback" SET "status" = 'accepted', "fixed_at" = COALESCE("fixed_at", "reviewed_at", now()) WHERE "status"::text = 'fixed';
