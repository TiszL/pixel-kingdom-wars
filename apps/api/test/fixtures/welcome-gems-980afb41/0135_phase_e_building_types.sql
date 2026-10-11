-- Phase E commit A (D-152 §5, owner 2026-09-20; E2-WORKSHOP-CONTRACT §1): the five
-- DARK building types. Enum labels only — nothing in this migration USES them
-- (Postgres refuses a new enum value inside the transaction that added it), and
-- no row of these types can exist until PHASE_E_BUILDINGS_ENABLED (commit B).
ALTER TYPE "public"."building_type" ADD VALUE IF NOT EXISTS 'workshop';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE IF NOT EXISTS 'lodge';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE IF NOT EXISTS 'market';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE IF NOT EXISTS 'harvester';--> statement-breakpoint
ALTER TYPE "public"."building_type" ADD VALUE IF NOT EXISTS 'berth';
