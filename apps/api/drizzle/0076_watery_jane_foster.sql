ALTER TABLE "hero_raid_reservations" DROP CONSTRAINT "hero_raid_reservations_player_hero_pk";--> statement-breakpoint
ALTER TABLE "hero_raid_reservations" ALTER COLUMN "player_wallet" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hero_raid_reservations" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "item_listings" ADD COLUMN "buyer_base_id" uuid;--> statement-breakpoint
ALTER TABLE "hero_raid_reservations" ADD CONSTRAINT "hero_raid_reservations_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_buyer_base_id_bases_id_fk" FOREIGN KEY ("buyer_base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- D-035: a stable raid commits the hero copy owned by its persisted attacker
-- base, never whichever wallet happens to own that deed later. Rows that do not
-- match their raid's attacker remain on the fenced legacy arm and therefore
-- fail closed when stable submit-time authorization looks for the base arm.
--
-- A base can have reservation rows from different historical owners if it was
-- transferred between two unresolved creates. Preserve the deterministic
-- oldest commitment; deleting later reservation rows makes those raids take the
-- existing missing-reservation compensation path instead of aborting rollout.
WITH ranked AS (
  SELECT h.ctid,
         row_number() OVER (
           PARTITION BY r."attacker_base_id", h."hero"
           ORDER BY h."created_at", h."raid_id"
         ) AS rn
  FROM "hero_raid_reservations" h
  JOIN "raids" r ON r."id" = h."raid_id"
  WHERE r."attacker_base_id" IS NOT NULL
    AND r."attacker_wallet" = h."player_wallet"
)
DELETE FROM "hero_raid_reservations" h
USING ranked
WHERE h.ctid = ranked.ctid AND ranked.rn > 1;--> statement-breakpoint
UPDATE "hero_raid_reservations" h
SET "base_id" = r."attacker_base_id", "player_wallet" = NULL
FROM "raids" r
WHERE r."id" = h."raid_id"
  AND r."attacker_base_id" IS NOT NULL
  AND r."attacker_wallet" = h."player_wallet";--> statement-breakpoint

-- Attach every recoverable open non-cosmetic listing to the same deterministic
-- primary deed used by 0074. The three identifiers below are the complete
-- account-cosmetic catalog at this migration boundary; they intentionally stay
-- wallet-owned. An active listing needs only its source. A reserved listing also
-- freezes the buyer's destination deed so settlement remains unambiguous after
-- either deed transfers. A historical row whose party no longer owns any base
-- remains the finite, fenced legacy shape (both ids NULL); it can settle/cancel
-- through player_items but no new stable writer can create that shape.
WITH primary_base AS (
  SELECT DISTINCT ON (p."wallet") p."wallet", b."id" AS "base_id"
  FROM "players" p
  JOIN "bases" b ON b."owner_wallet" = p."wallet"
  LEFT JOIN "base_slots" bs ON bs."base_id" = b."id" AND bs."wallet" = p."wallet"
  ORDER BY p."wallet",
           CASE WHEN bs."active" THEN 0 WHEN bs."slot" IS NOT NULL THEN 1 ELSE 2 END,
           bs."slot" NULLS LAST, b."id"
)
UPDATE "item_listings" l
SET "base_id" = pb."base_id"
FROM primary_base pb
WHERE l."seller_wallet" = pb."wallet"
  AND l."status" = 'active'
  AND l."item_id" NOT IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone');--> statement-breakpoint
WITH primary_base AS (
  SELECT DISTINCT ON (p."wallet") p."wallet", b."id" AS "base_id"
  FROM "players" p
  JOIN "bases" b ON b."owner_wallet" = p."wallet"
  LEFT JOIN "base_slots" bs ON bs."base_id" = b."id" AND bs."wallet" = p."wallet"
  ORDER BY p."wallet",
           CASE WHEN bs."active" THEN 0 WHEN bs."slot" IS NOT NULL THEN 1 ELSE 2 END,
           bs."slot" NULLS LAST, b."id"
)
UPDATE "item_listings" l
SET "base_id" = seller."base_id", "buyer_base_id" = buyer."base_id"
FROM primary_base seller, primary_base buyer
WHERE l."seller_wallet" = seller."wallet"
  AND l."reserved_by" = buyer."wallet"
  AND l."status" = 'reserved'
  AND l."item_id" NOT IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone');--> statement-breakpoint

-- 0074 conservatively copied the whole compatibility inventory while the
-- runtime cutover was unfinished. Cosmetics are account property under D-035,
-- so their copied base rows are duplicate economic shadows, not rollback state.
-- Base equipment has an ON DELETE CASCADE FK; a pre-cutover corrupt cosmetic
-- loadout therefore fails closed instead of keeping an undeletable shadow.
DELETE FROM "base_items"
WHERE "item_id" IN ('skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone');--> statement-breakpoint

CREATE UNIQUE INDEX "hero_raid_reservations_player_hero_pk" ON "hero_raid_reservations" USING btree ("player_wallet","hero") WHERE player_wallet IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hero_raid_reservations_base_hero_uq" ON "hero_raid_reservations" USING btree ("base_id","hero") WHERE base_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "item_listings_base_idx" ON "item_listings" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "item_listings_buyer_base_idx" ON "item_listings" USING btree ("buyer_base_id");--> statement-breakpoint
ALTER TABLE "hero_raid_reservations" ADD CONSTRAINT "hero_raid_reservations_owner_xor_ck" CHECK (num_nonnulls("hero_raid_reservations"."player_wallet", "hero_raid_reservations"."base_id") = 1);--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_base_custody_ck" CHECK (
    ("item_listings"."base_id" IS NULL AND "item_listings"."buyer_base_id" IS NULL)
    OR ("item_listings"."base_id" IS NOT NULL AND (
      ("item_listings"."status" IN ('active', 'cancelled') AND "item_listings"."buyer_base_id" IS NULL)
      OR ("item_listings"."status" IN ('reserved', 'sold') AND "item_listings"."buyer_base_id" IS NOT NULL)
    ))
  );
