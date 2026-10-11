CREATE TYPE "public"."tester_feedback_importance" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."tester_feedback_status" AS ENUM('new', 'reviewed', 'accepted', 'rejected', 'duplicate');--> statement-breakpoint
CREATE TABLE "tester_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"context" jsonb,
	"status" "tester_feedback_status" DEFAULT 'new' NOT NULL,
	"importance" "tester_feedback_importance",
	"base_points" integer DEFAULT 0 NOT NULL,
	"bonus_points" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"admin_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tester_feedback_points_ck" CHECK ("tester_feedback"."points" >= 0 AND "tester_feedback"."base_points" >= 0 AND "tester_feedback"."bonus_points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tester_milestones" (
	"wallet" text NOT NULL,
	"key" text NOT NULL,
	"points" integer NOT NULL,
	"source" text NOT NULL,
	"achieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb,
	CONSTRAINT "tester_milestones_wallet_key_pk" PRIMARY KEY("wallet","key"),
	CONSTRAINT "tester_milestones_points_ck" CHECK ("tester_milestones"."points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tester_feedback" ADD CONSTRAINT "tester_feedback_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tester_milestones" ADD CONSTRAINT "tester_milestones_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tester_feedback_wallet_idx" ON "tester_feedback" USING btree ("wallet","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tester_feedback_status_idx" ON "tester_feedback" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tester_milestones_key_idx" ON "tester_milestones" USING btree ("key");