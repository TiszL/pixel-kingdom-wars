CREATE TYPE "public"."base_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."deed_observation_status" AS ENUM('owned', 'mismatch', 'ineligible', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."plot_reservation_state" AS ENUM('reserved', 'paid', 'converted', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "base_slots" (
	"wallet" text NOT NULL,
	"slot" smallint NOT NULL,
	"base_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"selected_at" timestamp with time zone,
	CONSTRAINT "base_slots_wallet_slot_pk" PRIMARY KEY("wallet","slot"),
	CONSTRAINT "base_slots_slot_ck" CHECK ("base_slots"."slot" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_wallet" text NOT NULL,
	"deed_asset_id" text,
	"status" "base_status" DEFAULT 'active' NOT NULL,
	"keep_level" integer DEFAULT 1 NOT NULL,
	"builders" integer DEFAULT 1 NOT NULL,
	"expansions" integer DEFAULT 0 NOT NULL,
	"land_paid_at" timestamp with time zone,
	"deed_minting_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bases_keep_level_ck" CHECK ("bases"."keep_level" BETWEEN 1 AND 20),
	CONSTRAINT "bases_builders_ck" CHECK ("bases"."builders" BETWEEN 1 AND 6),
	CONSTRAINT "bases_expansions_ck" CHECK ("bases"."expansions" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE TABLE "deed_ownership_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"base_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"owner" text,
	"slot" bigint,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"status" "deed_observation_status" NOT NULL,
	"audit_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plot_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"earth_cell" integer NOT NULL,
	"state" "plot_reservation_state" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plot_reservations_deposit_id_unique" UNIQUE("deposit_id"),
	CONSTRAINT "plot_reservations_earth_cell_unique" UNIQUE("earth_cell")
);
--> statement-breakpoint
ALTER TABLE "plots" DROP CONSTRAINT "plots_player_wallet_unique";--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "buildings" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "layouts" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "obstacles" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "plots" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "attacker_base_id" uuid;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "defender_base_id" uuid;--> statement-breakpoint
ALTER TABLE "shields" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "base_slots" ADD CONSTRAINT "base_slots_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_slots" ADD CONSTRAINT "base_slots_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_owner_wallet_players_wallet_fk" FOREIGN KEY ("owner_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deed_ownership_observations" ADD CONSTRAINT "deed_ownership_observations_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD CONSTRAINT "plot_reservations_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD CONSTRAINT "plot_reservations_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "base_slots_base_uq" ON "base_slots" USING btree ("base_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bases_deed_asset_uq" ON "bases" USING btree ("deed_asset_id") WHERE deed_asset_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bases_owner_status_idx" ON "bases" USING btree ("owner_wallet","status");--> statement-breakpoint
CREATE INDEX "deed_observations_base_checked_idx" ON "deed_ownership_observations" USING btree ("base_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "plot_reservations_expiry_idx" ON "plot_reservations" USING btree ("state","expires_at");--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obstacles" ADD CONSTRAINT "obstacles_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_attacker_base_id_bases_id_fk" FOREIGN KEY ("attacker_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_defender_base_id_bases_id_fk" FOREIGN KEY ("defender_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shields" ADD CONSTRAINT "shields_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builder_jobs_base_idx" ON "builder_jobs" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "buildings_base_idx" ON "buildings" USING btree ("base_id");--> statement-breakpoint
CREATE UNIQUE INDEX "layouts_base_slot_uq" ON "layouts" USING btree ("base_id","slot") WHERE base_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "obstacles_base_idx" ON "obstacles" USING btree ("base_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plots_base_uq" ON "plots" USING btree ("base_id") WHERE base_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plots_legacy_player_uq" ON "plots" USING btree ("player_wallet") WHERE base_id IS NULL;--> statement-breakpoint
CREATE INDEX "plots_player_idx" ON "plots" USING btree ("player_wallet");--> statement-breakpoint
CREATE INDEX "shields_base_expires_idx" ON "shields" USING btree ("base_id","expires_at");
--> statement-breakpoint
-- Backfill exactly one stable identity for every wallet that actually owns base
-- state. Wallet-only accounts remain wallet-only until ensureStartingBase creates
-- their first structure.
INSERT INTO "bases" (
  "owner_wallet", "deed_asset_id", "status", "keep_level", "builders",
  "expansions", "land_paid_at", "deed_minting_at", "created_at", "updated_at"
)
SELECT p."wallet", p."deed_asset_id", 'active', p."keep_level", p."builders",
       p."expansions", p."entry_paid_at", p."deed_minting_at", p."created_at", now()
FROM "players" p
WHERE p."entry_paid_at" IS NOT NULL OR p."deed_asset_id" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "buildings" b WHERE b."player_wallet" = p."wallet")
   OR EXISTS (SELECT 1 FROM "obstacles" o WHERE o."player_wallet" = p."wallet")
   OR EXISTS (SELECT 1 FROM "plots" x WHERE x."player_wallet" = p."wallet");
--> statement-breakpoint
UPDATE "buildings" x SET "base_id" = b."id" FROM "bases" b
WHERE x."base_id" IS NULL AND b."owner_wallet" = x."player_wallet";
--> statement-breakpoint
UPDATE "obstacles" x SET "base_id" = b."id" FROM "bases" b
WHERE x."base_id" IS NULL AND b."owner_wallet" = x."player_wallet";
--> statement-breakpoint
UPDATE "builder_jobs" x SET "base_id" = b."id" FROM "bases" b
WHERE x."base_id" IS NULL AND b."owner_wallet" = x."player_wallet";
--> statement-breakpoint
UPDATE "layouts" x SET "base_id" = b."id" FROM "bases" b
WHERE x."base_id" IS NULL AND b."owner_wallet" = x."player_wallet";
--> statement-breakpoint
UPDATE "shields" x SET "base_id" = b."id" FROM "bases" b
WHERE x."base_id" IS NULL AND b."owner_wallet" = x."player_wallet";
--> statement-breakpoint
UPDATE "plots" x SET "base_id" = b."id" FROM "bases" b
WHERE x."base_id" IS NULL AND b."owner_wallet" = x."player_wallet";
--> statement-breakpoint
UPDATE "raids" x SET "attacker_base_id" = b."id" FROM "bases" b
WHERE x."attacker_base_id" IS NULL AND b."owner_wallet" = x."attacker_wallet";
--> statement-breakpoint
UPDATE "raids" x SET "defender_base_id" = b."id" FROM "bases" b
WHERE x."defender_base_id" IS NULL AND x."defender_wallet" IS NOT NULL
  AND b."owner_wallet" = x."defender_wallet";
--> statement-breakpoint
INSERT INTO "base_slots" ("wallet", "slot", "base_id", "active", "selected_at")
SELECT "owner_wallet", 1, "id", true, now() FROM "bases";
--> statement-breakpoint
-- Compatibility inserts get a base identity only while the wallet has exactly
-- one active base. Once a wallet has several, omission fails loudly instead of
-- writing state into an arbitrary base.
CREATE FUNCTION "assign_legacy_base_id"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolved uuid; matches integer;
BEGIN
  IF NEW."base_id" IS NOT NULL THEN RETURN NEW; END IF;
  SELECT min(bs."base_id"::text)::uuid, count(*)::integer INTO resolved, matches
  FROM "base_slots" bs WHERE bs."wallet" = NEW."player_wallet" AND bs."active";
  IF matches = 1 THEN NEW."base_id" := resolved;
  ELSIF matches > 1 THEN RAISE EXCEPTION 'BASE_ID_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "buildings_legacy_base_id" BEFORE INSERT ON "buildings"
FOR EACH ROW EXECUTE FUNCTION "assign_legacy_base_id"();
--> statement-breakpoint
CREATE TRIGGER "obstacles_legacy_base_id" BEFORE INSERT ON "obstacles"
FOR EACH ROW EXECUTE FUNCTION "assign_legacy_base_id"();
--> statement-breakpoint
CREATE TRIGGER "builder_jobs_legacy_base_id" BEFORE INSERT ON "builder_jobs"
FOR EACH ROW EXECUTE FUNCTION "assign_legacy_base_id"();
--> statement-breakpoint
CREATE TRIGGER "layouts_legacy_base_id" BEFORE INSERT ON "layouts"
FOR EACH ROW EXECUTE FUNCTION "assign_legacy_base_id"();
--> statement-breakpoint
CREATE TRIGGER "shields_legacy_base_id" BEFORE INSERT ON "shields"
FOR EACH ROW EXECUTE FUNCTION "assign_legacy_base_id"();
--> statement-breakpoint
CREATE TRIGGER "plots_legacy_base_id" BEFORE INSERT ON "plots"
FOR EACH ROW EXECUTE FUNCTION "assign_legacy_base_id"();
