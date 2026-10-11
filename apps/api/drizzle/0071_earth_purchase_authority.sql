ALTER TYPE "public"."deposit_kind" ADD VALUE 'deed' BEFORE 'builder';--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "payment_signature" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_payment_signature_unique" UNIQUE("payment_signature");--> statement-breakpoint
CREATE TABLE "forge_base_daily_usage" (
	"day" text NOT NULL,
	"base_id" uuid NOT NULL,
	"day_owner_wallet" text NOT NULL,
	"shards" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_base_daily_usage_day_base_id_pk" PRIMARY KEY("day","base_id"),
	CONSTRAINT "forge_base_daily_usage_nonnegative_ck" CHECK ("forge_base_daily_usage"."shards" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plot_reservations" DROP CONSTRAINT "plot_reservations_earth_cell_unique";--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD COLUMN "site_id" integer;--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD COLUMN "x" integer;--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD COLUMN "y" integer;--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD COLUMN "country_a3" text;--> statement-breakpoint
-- A converted pre-0071 reservation can recover its frozen inverse identity
-- from the exact plot it became. A still-pending legacy row has no durable
-- site/x/y identity at all: abort rather than silently reinterpret a payment
-- against today's Earth data or delete in-flight audit evidence.
UPDATE "plot_reservations" AS r SET
	"site_id" = v."site_id", "x" = p."x", "y" = p."y", "country_a3" = p."country_a3"
FROM "plots" AS p
JOIN "valleys" AS v ON v."id" = p."valley_id"
WHERE p."base_id" = r."base_id" AND p."earth_cell" = r."earth_cell";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "plot_reservations"
		WHERE "site_id" IS NULL OR "x" IS NULL OR "y" IS NULL OR "country_a3" IS NULL
	) THEN
		RAISE EXCEPTION '0071: unresolved pre-Earth purchase reservation; preserve and reconcile it before migration';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "plot_reservations" ALTER COLUMN "site_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plot_reservations" ALTER COLUMN "x" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plot_reservations" ALTER COLUMN "y" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plot_reservations" ALTER COLUMN "country_a3" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_base_daily_usage" ADD CONSTRAINT "forge_base_daily_usage_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_base_daily_usage" ADD CONSTRAINT "forge_base_daily_usage_day_owner_wallet_players_wallet_fk" FOREIGN KEY ("day_owner_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Key-shape predicates deliberately avoid deposit_kind enum literals. Drizzle's
-- migrator runs a clean history in one transaction, while PostgreSQL forbids
-- using values added by an earlier ALTER TYPE until that transaction commits.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "deposits"
		WHERE "status" = 'pending' AND "payload" ? 'buildingId'
		AND (("payload"->>'buildingId') IS NULL OR NOT (
			("payload"->>'buildingId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		))
	) THEN
		RAISE EXCEPTION '0071: malformed pending mine target requires payment reconciliation before migration';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "deposits"
		WHERE "status" = 'pending' AND "payload" ? 'buildingId'
		GROUP BY (("payload"->>'buildingId')::uuid) HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION '0071: duplicate pending mine targets require payment reconciliation before migration';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_mine_target_pending_uq" ON "deposits" USING btree ((("payload"->>'buildingId')::uuid)) WHERE "deposits"."status" = 'pending' AND "deposits"."payload" ? 'buildingId';--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_mine_build_slot_pending_uq" ON "deposits" USING btree (("payload"->>'baseId'),(("payload"->>'expectedMines')::integer)) WHERE "deposits"."status" = 'pending' AND "deposits"."payload" ? 'baseId' AND "deposits"."payload" ? 'expectedMines';--> statement-breakpoint
-- Existing legacy rows remain watchable and may transition to a terminal
-- status. During a rolling deploy, however, an old pod must not create another
-- payable mine reference without the stable target/slot fields that new code
-- uses to deduplicate it. Key shapes avoid the newly-added deed enum value.
CREATE FUNCTION "shardkeep_reject_legacy_pending_mine_intent"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."status" = 'pending' AND NEW."payload" ? 'buildingId' AND (
		(NEW."payload"->>'buildingId') IS NULL OR NOT (
			(NEW."payload"->>'buildingId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		)
	) THEN
		RAISE EXCEPTION 'pending mine target is not a UUID'
			USING ERRCODE = '23514';
	END IF;
	IF NEW."status" = 'pending' AND (
		(NEW."payload" ? 'buildingId' AND NOT (NEW."payload" ? 'baseId'))
		OR (NEW."payload" ? 'tx' AND NEW."payload" ? 'ty' AND NOT (NEW."payload" ? 'baseId'))
	) THEN
		RAISE EXCEPTION 'legacy pending mine intent shape is no longer accepted'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "deposits_reject_legacy_pending_mine_intent"
BEFORE INSERT ON "deposits"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_reject_legacy_pending_mine_intent"();--> statement-breakpoint
CREATE UNIQUE INDEX "plot_reservations_live_earth_cell_uq" ON "plot_reservations" USING btree ("earth_cell") WHERE state IN ('reserved', 'paid', 'converted');--> statement-breakpoint
CREATE UNIQUE INDEX "plot_reservations_live_base_uq" ON "plot_reservations" USING btree ("base_id") WHERE state IN ('reserved', 'paid', 'converted');--> statement-breakpoint
ALTER TABLE "plot_reservations" ADD CONSTRAINT "plot_reservations_country_a3_shape" CHECK ("plot_reservations"."country_a3" ~ '^[A-Z]{3}$');
