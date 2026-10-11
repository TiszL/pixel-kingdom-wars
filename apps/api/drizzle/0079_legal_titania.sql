ALTER TABLE "players" ADD COLUMN "avatar_hash" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "avatar_generation" uuid;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "avatar_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_avatar_hash_ck" CHECK (avatar_hash IS NULL OR avatar_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_avatar_pointer_ck" CHECK ((avatar_hash IS NULL) = (avatar_generation IS NULL));--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_avatar_due_idx" ON "outbox" USING btree ("kind","status","next_attempt_at","id");--> statement-breakpoint
-- D-026: a free/deedless stable base never occupies an Earth cell. Restrict the
-- cleanup through bases.land_paid_at rather than owner/player state: paid inactive
-- deed/audit bases keep their parcel, while only the accidental unpaid rows lose it.
-- Production's one-way deed cutover is already `ready`, so its database trigger
-- rejects every physical-table write from an unmarked session. Drizzle runs one
-- migration in one transaction; this LOCAL marker authorizes only this audited,
-- base-keyed cleanup and disappears on commit/rollback.
SELECT set_config('shardkeep.deed_economy_writer', 'v1', true);--> statement-breakpoint
DELETE FROM "plots"
USING "bases"
WHERE "plots"."base_id" = "bases"."id"
  AND "bases"."land_paid_at" IS NULL
  AND "bases"."deed_asset_id" IS NULL
  AND "bases"."deed_mint_asset_id" IS NULL;
