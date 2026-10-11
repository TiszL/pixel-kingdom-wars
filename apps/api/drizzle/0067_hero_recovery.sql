-- Nullable is the backward-compatible backfill: every legacy hero is immediately
-- available, and only authoritative attacker settlement writes a future value.
ALTER TABLE "hero_levels" ADD COLUMN "recovery_until" timestamp with time zone;
