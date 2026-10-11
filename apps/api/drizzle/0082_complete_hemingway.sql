CREATE TABLE "global_chat_blocks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"blocker_wallet" text NOT NULL,
	"blocked_wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_chat_blocks_not_self_ck" CHECK ("global_chat_blocks"."blocker_wallet" <> "global_chat_blocks"."blocked_wallet")
);
--> statement-breakpoint
ALTER TABLE "game_config" ADD COLUMN "global_chat_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "global_chat_messages" ADD COLUMN "author_name_at_send" text NOT NULL;--> statement-breakpoint
ALTER TABLE "global_chat_messages" ADD COLUMN "author_seeker_verified_at_send" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD COLUMN "evidence_author_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD COLUMN "evidence_seeker_verified" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "global_chat_blocks" ADD CONSTRAINT "global_chat_blocks_blocker_wallet_players_wallet_fk" FOREIGN KEY ("blocker_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_blocks" ADD CONSTRAINT "global_chat_blocks_blocked_wallet_players_wallet_fk" FOREIGN KEY ("blocked_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "global_chat_blocks_pair_uq" ON "global_chat_blocks" USING btree ("blocker_wallet","blocked_wallet");--> statement-breakpoint
CREATE INDEX "global_chat_blocks_owner_cursor_idx" ON "global_chat_blocks" USING btree ("blocker_wallet","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "global_chat_reports_retention_idx" ON "global_chat_reports" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "global_chat_rate_limits_retention_idx" ON "global_chat_rate_limits" USING btree ("window_start","kind","subject_hash");--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD CONSTRAINT "global_chat_reports_resolved_by_players_wallet_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_events" ADD CONSTRAINT "global_chat_events_kind_ck" CHECK ("global_chat_events"."kind" IN ('message', 'redaction'));--> statement-breakpoint
ALTER TABLE "global_chat_moderation_audit" ADD CONSTRAINT "global_chat_moderation_audit_action_ck" CHECK (
  "global_chat_moderation_audit"."action" IN ('redact', 'mute', 'unmute', 'resolve_report', 'toggle_chat')
);--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD CONSTRAINT "global_chat_reports_resolution_ck" CHECK (
    ("global_chat_reports"."resolved_at" IS NULL AND "global_chat_reports"."resolved_by" IS NULL AND "global_chat_reports"."resolution" IS NULL)
    OR
    ("global_chat_reports"."resolved_at" IS NOT NULL AND "global_chat_reports"."resolved_by" IS NOT NULL
      AND "global_chat_reports"."resolution" IN ('dismissed', 'redacted'))
  );
