CREATE TABLE "base_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deed_asset_id" text NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	"prior_keep_level" integer NOT NULL,
	"prior_expansions" integer NOT NULL,
	"prior_entry_paid_at" timestamp with time zone,
	"buildings_moved" integer NOT NULL,
	"jobs_moved" integer NOT NULL,
	"shields_moved" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "players_deed_asset_uq" ON "players" USING btree ("deed_asset_id") WHERE deed_asset_id IS NOT NULL;