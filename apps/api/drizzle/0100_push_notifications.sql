CREATE TABLE "push_events" (
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivery_id" uuid,
	"outcome" text,
	CONSTRAINT "push_events_kind_ref_id_pk" PRIMARY KEY("kind","ref_id"),
	CONSTRAINT "push_events_kind_ck" CHECK ("push_events"."kind" IN ('raided', 'build', 'training', 'mail')),
	CONSTRAINT "push_events_outcome_ck" CHECK (
    ("push_events"."outcome" IS NULL AND "push_events"."sent_at" IS NULL AND "push_events"."delivery_id" IS NULL)
    OR ("push_events"."outcome" = 'sent' AND "push_events"."sent_at" IS NOT NULL AND "push_events"."delivery_id" IS NOT NULL)
    OR ("push_events"."outcome" IN ('failed', 'capped') AND "push_events"."sent_at" IS NULL AND "push_events"."delivery_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_subscriptions_failures_nonnegative_ck" CHECK ("push_subscriptions"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "push_events" ADD CONSTRAINT "push_events_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_events_wallet_idx" ON "push_events" USING btree ("wallet","created_at");--> statement-breakpoint
CREATE INDEX "push_events_wallet_sent_idx" ON "push_events" USING btree ("wallet","sent_at") WHERE "push_events"."sent_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "push_subscriptions_live_wallet_idx" ON "push_subscriptions" USING btree ("wallet","enabled_at") WHERE "push_subscriptions"."disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "base_training_queue_notification_due_idx" ON "base_training_queue" USING btree ("finishes_at") WHERE "base_training_queue"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "builder_jobs_notification_due_idx" ON "builder_jobs" USING btree ("finishes_at");--> statement-breakpoint
CREATE INDEX "mail_messages_notification_due_idx" ON "mail_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "raids_notification_due_idx" ON "raids" USING btree ("resolved_at") WHERE "raids"."status" = 'resolved' AND "raids"."defender_wallet" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "training_queue_notification_due_idx" ON "training_queue" USING btree ("finishes_at") WHERE "training_queue"."cancelled_at" IS NULL;
