CREATE TYPE "public"."base_raid_lock_state" AS ENUM('reserved', 'live', 'releasing');--> statement-breakpoint
CREATE TYPE "public"."raid_battle_role" AS ENUM('attacker', 'defender');--> statement-breakpoint
CREATE TYPE "public"."raid_loot_reservation_state" AS ENUM('reserved', 'settled', 'released');--> statement-breakpoint
-- PostgreSQL forbids USING an ALTER TYPE ... ADD VALUE result until commit,
-- while Drizzle intentionally wraps every pending migration in one transaction.
-- Historical migration 0026 added both account_kind labels and SHARDS currency
-- this way. Replace both enums transactionally instead of puncturing the
-- migrator's atomic boundary with COMMIT/BEGIN. The text casts preserve every
-- existing value on production databases where 0026 is already committed, and
-- make a first migration run safe when 0026 and 0074 share one transaction.
ALTER TYPE "public"."account_kind" RENAME TO "account_kind_legacy_0073";--> statement-breakpoint
CREATE TYPE "public"."account_kind" AS ENUM(
  'player_keep', 'player_sol_credit', 'emission_pool', 'burn', 'league_pool',
  'treasury', 'quest_bucket', 'sol_treasury', 'withdrawal_escrow',
  'onchain_outflow', 'onchain_inflow', 'keep_genesis', 'league_sol_pool',
  'player_shards', 'forge_escrow', 'forge_payout_escrow', 'clan_chest',
  'shard_genesis', 'shard_burn', 'base_shards', 'base_forge_escrow',
  'raid_loot_escrow'
);--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "kind" TYPE "public"."account_kind"
  USING "kind"::text::"public"."account_kind";--> statement-breakpoint
DROP TYPE "public"."account_kind_legacy_0073";--> statement-breakpoint
ALTER TYPE "public"."currency" RENAME TO "currency_legacy_0073";--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('KEEP', 'SOL', 'SHARDS');--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "currency" TYPE "public"."currency"
  USING "currency"::text::"public"."currency";--> statement-breakpoint
ALTER TABLE "withdrawals" ALTER COLUMN "currency" TYPE "public"."currency"
  USING "currency"::text::"public"."currency";--> statement-breakpoint
DROP TYPE "public"."currency_legacy_0073";
