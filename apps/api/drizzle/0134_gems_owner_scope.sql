-- HELD: separate owner approval is required before this money-table constraint
-- replacement is admitted to main or applied outside disposable test databases
-- (WORKING-RULES S5 and owner correction §7). This step neither moves balances
-- nor changes account ownership. The existing scope rule is extended only for
-- wallet-owned player_gems/player_gems_store; system and deed scope stay intact.
-- Drop/add run atomically within this migration; repeating them is safe.
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_owner_scope_ck";
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_scope_ck" CHECK (
    ("accounts"."base_id" IS NOT NULL AND "accounts"."owner_wallet" IS NULL AND "accounts"."kind" IN ('base_shards', 'base_forge_escrow'))
    OR
    ("accounts"."base_id" IS NULL AND "accounts"."owner_wallet" IS NOT NULL AND "accounts"."kind" IN ('player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store'))
    OR
    ("accounts"."base_id" IS NULL AND "accounts"."owner_wallet" IS NULL AND "accounts"."kind" NOT IN ('player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store', 'base_shards', 'base_forge_escrow'))
  );--> statement-breakpoint
