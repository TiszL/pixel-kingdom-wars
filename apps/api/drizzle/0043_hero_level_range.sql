-- Money-path review 2026-07-29 finding #5: hero_levels.level had no range
-- constraint. clampLevel() protects reads today, but an ops/backfill write of
-- level = 0 would let a player re-buy L1->2 at the cheapest price. The DB is
-- the last line: 1..20 mirrors HERO_LEVELING.maxLevel in shared constants.
ALTER TABLE "hero_levels" ADD CONSTRAINT "hero_levels_level_range"
  CHECK ("level" BETWEEN 1 AND 20);
