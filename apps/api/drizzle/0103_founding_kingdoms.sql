ALTER TYPE "public"."tester_feedback_status" ADD VALUE 'fixed';--> statement-breakpoint
CREATE TABLE "playtest_stats_snapshots" (
	"computed_at" timestamp with time zone PRIMARY KEY DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tester_daily_points" (
	"wallet" text NOT NULL,
	"day" date NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"points" integer NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb,
	CONSTRAINT "tester_daily_points_wallet_day_key_pk" PRIMARY KEY("wallet","day","key"),
	CONSTRAINT "tester_daily_points_ck" CHECK ("tester_daily_points"."points" >= 0 AND "tester_daily_points"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "first_client" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "tester_feedback" ADD COLUMN "fixed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tester_feedback" ADD COLUMN "fixed_ref" text;--> statement-breakpoint
ALTER TABLE "tester_daily_points" ADD CONSTRAINT "tester_daily_points_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tester_daily_points_day_idx" ON "tester_daily_points" USING btree ("day","key");