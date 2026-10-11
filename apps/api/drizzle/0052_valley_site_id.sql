-- P5 (docs/LAND-DEED-ONBOARDING-PLAN.md): FREEZE EVERY VALLEY'S PLACE ON THE PLANET.
--
-- The globe derived a valley's site from `row_number() over (order by created_at, id)`
-- at request time (game/globe.ts), so a base's place was a function of the valley
-- TABLE'S CONTENTS and not of the valley: delete one row, or let two `created_at`s
-- reorder, and every valley after it is renumbered — teleporting every base inside
-- them, silently, because a pin on a globe has no way to look wrong. The deed now
-- names a parcel's place (game/deedMetadata.ts's Location trait), and a document that
-- says where your land is cannot rest on a number the next DELETE changes.
--
-- ADDITIVE AND INVISIBLE. site_id is backfilled from the EXACT expression that was
-- being computed per request, so every existing valley keeps the pin it already had
-- and the globe does not move on the day this lands. Three statements rather than
-- drizzle's one `ADD COLUMN ... NOT NULL` (which cannot succeed on a populated
-- table): add nullable, backfill, then tighten. Same shape as 0044's name_key.
ALTER TABLE "valleys" ADD COLUMN "site_id" integer;--> statement-breakpoint
UPDATE "valleys" v SET "site_id" = d.ordinal FROM (
  SELECT "id", (row_number() OVER (ORDER BY "created_at", "id") - 1)::int AS ordinal
  FROM "valleys"
) d WHERE v."id" = d."id";--> statement-breakpoint
ALTER TABLE "valleys" ALTER COLUMN "site_id" SET NOT NULL;--> statement-breakpoint
-- Two valleys on one pin would render as one place holding two neighbourhoods, and
-- (after P5b) two deeds naming the same coordinates. The DB is the only layer that
-- can actually refuse it, so it does.
ALTER TABLE "valleys" ADD CONSTRAINT "valleys_site_id_uq" UNIQUE("site_id");
