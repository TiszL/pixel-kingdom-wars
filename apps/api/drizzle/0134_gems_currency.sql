-- D-152 / E2-GEMS-CONTRACT §1.1: append Gems labels without replacing types,
-- retyping money columns, or dropping existing partial indexes. Each migration
-- commits separately: dependent DDL in 0134_gems_schema uses these labels only
-- after this transaction commits. Existing enum/type OIDs and label order stay.
ALTER TYPE "public"."account_kind" ADD VALUE IF NOT EXISTS 'player_gems';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE IF NOT EXISTS 'player_gems_store';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE IF NOT EXISTS 'gems_mint';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE IF NOT EXISTS 'gems_sink';--> statement-breakpoint
ALTER TYPE "public"."account_kind" ADD VALUE IF NOT EXISTS 'gems_reward_budget';--> statement-breakpoint
ALTER TYPE "public"."currency" ADD VALUE IF NOT EXISTS 'GEMS';--> statement-breakpoint
ALTER TYPE "public"."deposit_kind" ADD VALUE IF NOT EXISTS 'gems_buy';
