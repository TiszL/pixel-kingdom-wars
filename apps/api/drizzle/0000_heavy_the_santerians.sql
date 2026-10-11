CREATE TYPE "public"."account_kind" AS ENUM('player_keep', 'player_sol_credit', 'emission_pool', 'burn', 'league_pool', 'treasury', 'quest_bucket', 'sol_treasury');--> statement-breakpoint
CREATE TYPE "public"."builder_job_kind" AS ENUM('build', 'upgrade', 'clear_obstacle');--> statement-breakpoint
CREATE TYPE "public"."building_type" AS ENUM('keep', 'mine', 'vault', 'barracks', 'forge', 'camp', 'cannon', 'archertower', 'mortar', 'spiketrap', 'wall');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('KEEP', 'SOL');--> statement-breakpoint
CREATE TYPE "public"."deposit_kind" AS ENUM('entry', 'builder', 'expansion', 'sol_topup', 'keep_deposit');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'finalized', 'credited', 'expired');--> statement-breakpoint
CREATE TYPE "public"."layout_slot" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."league" AS ENUM('bronze', 'silver', 'gold', 'sol');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."quest_scope" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."raid_status" AS ENUM('pending_orders', 'resolved', 'expired');--> statement-breakpoint
CREATE TYPE "public"."shield_source" AS ENUM('loss', 'purchase');--> statement-breakpoint
CREATE TYPE "public"."troop_type" AS ENUM('highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('unbonding', 'cancelled', 'processing', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_wallet" text,
	"kind" "account_kind" NOT NULL,
	"currency" "currency" NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_owner_kind_unique" UNIQUE NULLS NOT DISTINCT("owner_wallet","kind")
);
--> statement-breakpoint
CREATE TABLE "army" (
	"player_wallet" text NOT NULL,
	"troop" "troop_type" NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "army_player_wallet_troop_pk" PRIMARY KEY("player_wallet","troop")
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"nonce" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "auth_nonces_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "builder_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"kind" "builder_job_kind" NOT NULL,
	"building_id" uuid,
	"obstacle_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finishes_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"type" "building_type" NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"tx" integer NOT NULL,
	"ty" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"kind" "deposit_kind" NOT NULL,
	"reference" text NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"tx_signature" text,
	"amount" bigint,
	"ledger_txn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "deposits_reference_unique" UNIQUE("reference"),
	CONSTRAINT "deposits_tx_signature_unique" UNIQUE("tx_signature")
);
--> statement-breakpoint
CREATE TABLE "layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"slot" "layout_slot" NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "layouts_player_slot_unique" UNIQUE("player_wallet","slot")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"txn_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "obstacles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"sprite_key" text NOT NULL,
	"tx" integer NOT NULL,
	"ty" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "players" (
	"wallet" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"keep_level" integer DEFAULT 1 NOT NULL,
	"trophies" integer DEFAULT 0 NOT NULL,
	"league" "league" DEFAULT 'bronze' NOT NULL,
	"week_start_trophies" integer DEFAULT 0 NOT NULL,
	"builders" integer DEFAULT 1 NOT NULL,
	"expansions" integer DEFAULT 0 NOT NULL,
	"referral_code" text,
	"referred_by" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "plots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"valley_id" uuid NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"player_wallet" text,
	CONSTRAINT "plots_player_wallet_unique" UNIQUE("player_wallet"),
	CONSTRAINT "plots_valley_xy_unique" UNIQUE("valley_id","x","y")
);
--> statement-breakpoint
CREATE TABLE "pve_camps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"valley_id" uuid NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"tier" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"loot_keep" bigint NOT NULL,
	"respawns_at" timestamp with time zone,
	CONSTRAINT "pve_camps_valley_xy_unique" UNIQUE("valley_id","x","y")
);
--> statement-breakpoint
CREATE TABLE "quest_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"player_wallet" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "quest_progress_quest_player_unique" UNIQUE("quest_id","player_wallet")
);
--> statement-breakpoint
CREATE TABLE "quests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "quest_scope" NOT NULL,
	"template_code" text NOT NULL,
	"target" integer NOT NULL,
	"reward_keep" bigint NOT NULL,
	"active_on" date NOT NULL,
	CONSTRAINT "quests_scope_day_template_unique" UNIQUE("scope","active_on","template_code")
);
--> statement-breakpoint
CREATE TABLE "raids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attacker_wallet" text NOT NULL,
	"defender_wallet" text,
	"pve_camp_id" uuid,
	"seed" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"army_snapshot" jsonb NOT NULL,
	"orders" jsonb,
	"orders_deadline_at" timestamp with time zone NOT NULL,
	"status" "raid_status" DEFAULT 'pending_orders' NOT NULL,
	"result" jsonb,
	"events" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_wallet" text NOT NULL,
	"referee_wallet" text NOT NULL,
	"qualified_at" timestamp with time zone,
	"match_ends_at" timestamp with time zone,
	"total_matched_keep" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_referee_wallet_unique" UNIQUE("referee_wallet")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"source" "shield_source" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "streaks" (
	"player_wallet" text PRIMARY KEY NOT NULL,
	"current_days" integer DEFAULT 0 NOT NULL,
	"last_active_date" date
);
--> statement-breakpoint
CREATE TABLE "troop_research" (
	"player_wallet" text NOT NULL,
	"troop" "troop_type" NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"researching_to_level" integer,
	"finishes_at" timestamp with time zone,
	CONSTRAINT "troop_research_player_wallet_troop_pk" PRIMARY KEY("player_wallet","troop")
);
--> statement-breakpoint
CREATE TABLE "valleys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_wallet" text NOT NULL,
	"currency" "currency" NOT NULL,
	"amount" bigint NOT NULL,
	"fee_burned" bigint DEFAULT 0 NOT NULL,
	"destination" text NOT NULL,
	"status" "withdrawal_status" DEFAULT 'unbonding' NOT NULL,
	"unbonds_at" timestamp with time zone NOT NULL,
	"tx_signature" text,
	"request_ledger_txn_id" uuid,
	"payout_ledger_txn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "withdrawals_tx_signature_unique" UNIQUE("tx_signature")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_wallet_players_wallet_fk" FOREIGN KEY ("owner_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "army" ADD CONSTRAINT "army_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_jobs" ADD CONSTRAINT "builder_jobs_obstacle_id_obstacles_id_fk" FOREIGN KEY ("obstacle_id") REFERENCES "public"."obstacles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obstacles" ADD CONSTRAINT "obstacles_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_referred_by_players_wallet_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_valley_id_valleys_id_fk" FOREIGN KEY ("valley_id") REFERENCES "public"."valleys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_camps" ADD CONSTRAINT "pve_camps_valley_id_valleys_id_fk" FOREIGN KEY ("valley_id") REFERENCES "public"."valleys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_progress" ADD CONSTRAINT "quest_progress_quest_id_quests_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_progress" ADD CONSTRAINT "quest_progress_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_attacker_wallet_players_wallet_fk" FOREIGN KEY ("attacker_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_defender_wallet_players_wallet_fk" FOREIGN KEY ("defender_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_pve_camp_id_pve_camps_id_fk" FOREIGN KEY ("pve_camp_id") REFERENCES "public"."pve_camps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_wallet_players_wallet_fk" FOREIGN KEY ("referrer_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_wallet_players_wallet_fk" FOREIGN KEY ("referee_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shields" ADD CONSTRAINT "shields_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "troop_research" ADD CONSTRAINT "troop_research_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_request_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("request_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_payout_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("payout_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_nonces_wallet_idx" ON "auth_nonces" USING btree ("wallet","expires_at");--> statement-breakpoint
CREATE INDEX "builder_jobs_player_idx" ON "builder_jobs" USING btree ("player_wallet");--> statement-breakpoint
CREATE INDEX "buildings_player_idx" ON "buildings" USING btree ("player_wallet");--> statement-breakpoint
CREATE INDEX "deposits_player_idx" ON "deposits" USING btree ("player_wallet");--> statement-breakpoint
CREATE INDEX "ledger_entries_txn_idx" ON "ledger_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "obstacles_player_idx" ON "obstacles" USING btree ("player_wallet");--> statement-breakpoint
CREATE INDEX "outbox_status_id_idx" ON "outbox" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "quest_progress_player_idx" ON "quest_progress" USING btree ("player_wallet");--> statement-breakpoint
CREATE INDEX "raids_attacker_created_idx" ON "raids" USING btree ("attacker_wallet","created_at");--> statement-breakpoint
CREATE INDEX "raids_defender_created_idx" ON "raids" USING btree ("defender_wallet","created_at");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_wallet");--> statement-breakpoint
CREATE INDEX "sessions_wallet_idx" ON "sessions" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "shields_player_expires_idx" ON "shields" USING btree ("player_wallet","expires_at");--> statement-breakpoint
CREATE INDEX "withdrawals_player_created_idx" ON "withdrawals" USING btree ("player_wallet","created_at");