-- Owner 2026-08-29: quests should direct the player like a lock-in, "but they
-- should be able to skip tutorial if they dont want to". This is that switch,
-- and it has to be server-side because the requirement is that it survives a
-- reload. Nullable and un-backfilled on purpose: NULL = "still being guided",
-- which is the correct state for every existing row.
ALTER TABLE "tutorial_progress" ADD COLUMN "guide_skipped_at" timestamp with time zone;
