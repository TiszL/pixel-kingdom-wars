ALTER TABLE "push_events" DROP CONSTRAINT "push_events_kind_ck";--> statement-breakpoint
ALTER TABLE "push_events" DROP CONSTRAINT "push_events_outcome_ck";--> statement-breakpoint
ALTER TABLE "mine_accrual_states" ADD COLUMN "full_notification_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mine_accrual_states" ADD COLUMN "full_notification_check_at" timestamp with time zone;--> statement-breakpoint
-- Rows that existed at the rollout boundary must be classified from their exact
-- physical buffer: full history is suppressed, while a partial buffer receives
-- its real future fill deadline. New rows are already owned by current code and
-- therefore skip this resumable bootstrap.
ALTER TABLE "mine_accrual_states" ADD COLUMN "full_notification_bootstrap_pending" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mine_accrual_states" ALTER COLUMN "full_notification_bootstrap_pending" SET DEFAULT false;--> statement-breakpoint
CREATE INDEX "mine_accrual_states_full_notification_due_idx" ON "mine_accrual_states" USING btree ("full_notification_check_at") WHERE "mine_accrual_states"."full_notification_check_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mine_accrual_states_full_notification_bootstrap_idx" ON "mine_accrual_states" USING btree ("mine_building_id") WHERE "mine_accrual_states"."full_notification_bootstrap_pending" = true;--> statement-breakpoint
ALTER TABLE "mine_accrual_states" ADD CONSTRAINT "mine_accrual_states_full_notification_cycle_nonnegative_ck" CHECK ("mine_accrual_states"."full_notification_cycle" >= 0);--> statement-breakpoint
ALTER TABLE "push_events" ADD CONSTRAINT "push_events_kind_ck" CHECK ("push_events"."kind" IN ('raided', 'mine_full', 'build', 'training', 'mail'));--> statement-breakpoint
ALTER TABLE "push_events" ADD CONSTRAINT "push_events_outcome_ck" CHECK (
    ("push_events"."outcome" IS NULL AND "push_events"."sent_at" IS NULL AND "push_events"."delivery_id" IS NULL)
    OR ("push_events"."outcome" = 'sent' AND "push_events"."sent_at" IS NOT NULL AND "push_events"."delivery_id" IS NOT NULL)
    OR ("push_events"."outcome" IN ('failed', 'capped', 'suppressed') AND "push_events"."sent_at" IS NULL AND "push_events"."delivery_id" IS NULL)
  );
