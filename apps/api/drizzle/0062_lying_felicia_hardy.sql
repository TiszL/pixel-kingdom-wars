CREATE TYPE "public"."gear_slot" AS ENUM('helm', 'amulet', 'chest', 'cloak', 'gloves', 'ring', 'boots', 'banner', 'weapon', 'offhand');--> statement-breakpoint
CREATE TABLE "hero_equipment" (
	"player_wallet" text NOT NULL,
	"hero" "hero_key" NOT NULL,
	"slot" "gear_slot" NOT NULL,
	"item_id" text NOT NULL,
	"equipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hero_equipment_player_wallet_hero_slot_pk" PRIMARY KEY("player_wallet","hero","slot")
);
--> statement-breakpoint
CREATE TABLE "hero_loadouts" (
	"player_wallet" text NOT NULL,
	"hero" "hero_key" NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hero_loadouts_player_wallet_hero_pk" PRIMARY KEY("player_wallet","hero"),
	CONSTRAINT "hero_loadouts_version_nonnegative_ck" CHECK ("hero_loadouts"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "player_items" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hero_equipment" ADD CONSTRAINT "hero_equipment_loadout_fk" FOREIGN KEY ("player_wallet","hero") REFERENCES "public"."hero_loadouts"("player_wallet","hero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_equipment" ADD CONSTRAINT "hero_equipment_owned_item_fk" FOREIGN KEY ("player_wallet","item_id") REFERENCES "public"."player_items"("player_wallet","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_loadouts" ADD CONSTRAINT "hero_loadouts_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hero_equipment_owner_item_idx" ON "hero_equipment" USING btree ("player_wallet","item_id");--> statement-breakpoint
ALTER TABLE "player_items" ADD CONSTRAINT "player_items_qty_nonnegative_ck" CHECK ("player_items"."qty" >= 0);