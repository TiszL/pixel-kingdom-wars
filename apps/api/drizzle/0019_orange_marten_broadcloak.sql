CREATE TYPE "public"."shieldless_mode" AS ENUM('off', 'scheduled', 'purge');--> statement-breakpoint
CREATE TABLE "game_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"emission_mult_bps" integer DEFAULT 10000 NOT NULL,
	"emission_updated_at" timestamp with time zone,
	"shieldless_mode" "shieldless_mode" DEFAULT 'off' NOT NULL,
	"purge_start_at" timestamp with time zone,
	"purge_end_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
