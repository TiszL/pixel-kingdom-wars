CREATE TABLE "global_chat_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"message_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"author_wallet" text NOT NULL,
	"client_message_id" uuid NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "global_chat_moderation_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_wallet" text NOT NULL,
	"action" text NOT NULL,
	"target_wallet" text,
	"message_id" bigint,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_chat_mutes" (
	"wallet" text PRIMARY KEY NOT NULL,
	"muted_until" timestamp with time zone,
	"reason" text NOT NULL,
	"actor_wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_chat_rate_limits" (
	"kind" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "global_chat_rate_limits_kind_subject_hash_window_start_pk" PRIMARY KEY("kind","subject_hash","window_start"),
	CONSTRAINT "global_chat_rate_limits_count_ck" CHECK ("global_chat_rate_limits"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "global_chat_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"reporter_wallet" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_text" text NOT NULL,
	"evidence_text_hash" text NOT NULL,
	"evidence_author_wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "global_chat_events" ADD CONSTRAINT "global_chat_events_message_id_global_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."global_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_messages" ADD CONSTRAINT "global_chat_messages_author_wallet_players_wallet_fk" FOREIGN KEY ("author_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_moderation_audit" ADD CONSTRAINT "global_chat_moderation_audit_actor_wallet_players_wallet_fk" FOREIGN KEY ("actor_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_moderation_audit" ADD CONSTRAINT "global_chat_moderation_audit_target_wallet_players_wallet_fk" FOREIGN KEY ("target_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_moderation_audit" ADD CONSTRAINT "global_chat_moderation_audit_message_id_global_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."global_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_mutes" ADD CONSTRAINT "global_chat_mutes_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_mutes" ADD CONSTRAINT "global_chat_mutes_actor_wallet_players_wallet_fk" FOREIGN KEY ("actor_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD CONSTRAINT "global_chat_reports_message_id_global_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."global_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD CONSTRAINT "global_chat_reports_reporter_wallet_players_wallet_fk" FOREIGN KEY ("reporter_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_reports" ADD CONSTRAINT "global_chat_reports_evidence_author_wallet_players_wallet_fk" FOREIGN KEY ("evidence_author_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "global_chat_events_cursor_idx" ON "global_chat_events" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "global_chat_messages_author_client_uq" ON "global_chat_messages" USING btree ("author_wallet","client_message_id");--> statement-breakpoint
CREATE INDEX "global_chat_messages_visible_idx" ON "global_chat_messages" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "global_chat_reports_message_reporter_uq" ON "global_chat_reports" USING btree ("message_id","reporter_wallet");