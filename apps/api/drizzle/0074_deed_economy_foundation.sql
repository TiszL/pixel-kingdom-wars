CREATE TABLE "base_army" (
	"base_id" uuid NOT NULL,
	"troop" "troop_type" NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "base_army_base_id_troop_pk" PRIMARY KEY("base_id","troop"),
	CONSTRAINT "base_army_count_nonnegative_ck" CHECK ("base_army"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_battle_records" (
	"base_id" uuid NOT NULL,
	"raid_id" uuid NOT NULL,
	"role" "raid_battle_role" NOT NULL,
	"owner_wallet_at_battle" text NOT NULL,
	"counterparty_base_id" uuid,
	"stars" integer NOT NULL,
	"destruction_pct" integer NOT NULL,
	"loot_delta_shards" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_battle_records_base_id_raid_id_role_pk" PRIMARY KEY("base_id","raid_id","role"),
	CONSTRAINT "base_battle_records_raid_role_uq" UNIQUE("raid_id","role"),
	CONSTRAINT "base_battle_records_stars_ck" CHECK ("base_battle_records"."stars" BETWEEN 0 AND 3),
	CONSTRAINT "base_battle_records_destruction_ck" CHECK ("base_battle_records"."destruction_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "base_campaign_progress" (
	"base_id" uuid NOT NULL,
	"stage" integer NOT NULL,
	"best_stars" integer DEFAULT 0 NOT NULL,
	"first_three_star_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_campaign_progress_base_id_stage_pk" PRIMARY KEY("base_id","stage"),
	CONSTRAINT "base_campaign_progress_stage_ck" CHECK ("base_campaign_progress"."stage" >= 1),
	CONSTRAINT "base_campaign_progress_stars_ck" CHECK ("base_campaign_progress"."best_stars" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "base_daily_activity" (
	"base_id" uuid NOT NULL,
	"day" date NOT NULL,
	"claimed_at" timestamp with time zone,
	"raids" integer DEFAULT 0 NOT NULL,
	"builds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "base_daily_activity_base_id_day_pk" PRIMARY KEY("base_id","day"),
	CONSTRAINT "base_daily_activity_counts_ck" CHECK ("base_daily_activity"."raids" >= 0 AND "base_daily_activity"."builds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_economy_backfills" (
	"legacy_wallet" text PRIMARY KEY NOT NULL,
	"primary_base_id" uuid NOT NULL,
	"source_shard_account_id" uuid,
	"destination_shard_account_id" uuid NOT NULL,
	"legacy_shard_balance" bigint DEFAULT 0 NOT NULL,
	"source_forge_escrow_account_id" uuid NOT NULL,
	"destination_forge_escrow_account_id" uuid NOT NULL,
	"legacy_forge_escrow_shards" bigint DEFAULT 0 NOT NULL,
	"ledger_status" text DEFAULT 'pending' NOT NULL,
	"ledger_transfer_txn_id" uuid,
	"forge_ledger_transfer_txn_id" uuid,
	"legacy_mine_buffer_pending" bigint DEFAULT 0 NOT NULL,
	"mine_backfilled_at" timestamp with time zone,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "base_economy_backfills_ledger_transfer_txn_id_unique" UNIQUE("ledger_transfer_txn_id"),
	CONSTRAINT "base_economy_backfills_forge_ledger_transfer_txn_id_unique" UNIQUE("forge_ledger_transfer_txn_id"),
	CONSTRAINT "base_economy_backfills_shards_nonnegative_ck" CHECK (
    "base_economy_backfills"."legacy_shard_balance" >= 0 AND "base_economy_backfills"."legacy_forge_escrow_shards" >= 0 AND "base_economy_backfills"."legacy_mine_buffer_pending" >= 0
  ),
	CONSTRAINT "base_economy_backfills_sources_ck" CHECK (
    "base_economy_backfills"."legacy_shard_balance" = 0 OR "base_economy_backfills"."source_shard_account_id" IS NOT NULL
  ),
	CONSTRAINT "base_economy_backfills_status_ck" CHECK ("base_economy_backfills"."ledger_status" IN ('pending', 'posting', 'complete', 'failed')),
	CONSTRAINT "base_economy_backfills_completion_ck" CHECK (
    ("base_economy_backfills"."ledger_status" = 'complete' AND "base_economy_backfills"."completed_at" IS NOT NULL
      AND (("base_economy_backfills"."legacy_shard_balance" = 0 AND "base_economy_backfills"."ledger_transfer_txn_id" IS NULL)
        OR ("base_economy_backfills"."legacy_shard_balance" > 0 AND "base_economy_backfills"."ledger_transfer_txn_id" IS NOT NULL))
      AND (("base_economy_backfills"."legacy_forge_escrow_shards" = 0 AND "base_economy_backfills"."forge_ledger_transfer_txn_id" IS NULL)
        OR ("base_economy_backfills"."legacy_forge_escrow_shards" > 0 AND "base_economy_backfills"."forge_ledger_transfer_txn_id" IS NOT NULL)))
    OR ("base_economy_backfills"."ledger_status" <> 'complete' AND "base_economy_backfills"."completed_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "base_forge_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"base_id" uuid NOT NULL,
	"contributed_shards" bigint DEFAULT 0 NOT NULL,
	"raid_debited_shards" bigint DEFAULT 0 NOT NULL,
	"counted_shards" bigint,
	"shards_refunded" bigint,
	"keep_paid" bigint,
	"settlement_owner_wallet" text,
	"items_dropped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_forge_positions_day_base_uq" UNIQUE("day","base_id"),
	CONSTRAINT "base_forge_positions_amounts_ck" CHECK (
    "base_forge_positions"."contributed_shards" >= 0
    AND "base_forge_positions"."raid_debited_shards" >= 0
    AND "base_forge_positions"."raid_debited_shards" <= "base_forge_positions"."contributed_shards"
    AND ("base_forge_positions"."counted_shards" IS NULL OR "base_forge_positions"."counted_shards" >= 0)
    AND ("base_forge_positions"."shards_refunded" IS NULL OR "base_forge_positions"."shards_refunded" >= 0)
    AND ("base_forge_positions"."keep_paid" IS NULL OR "base_forge_positions"."keep_paid" >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE "base_hero_equipment" (
	"base_id" uuid NOT NULL,
	"hero" "hero_key" NOT NULL,
	"slot" "gear_slot" NOT NULL,
	"item_id" text NOT NULL,
	"equipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_hero_equipment_base_id_hero_slot_pk" PRIMARY KEY("base_id","hero","slot")
);
--> statement-breakpoint
CREATE TABLE "base_hero_loadouts" (
	"base_id" uuid NOT NULL,
	"hero" "hero_key" NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_hero_loadouts_base_id_hero_pk" PRIMARY KEY("base_id","hero"),
	CONSTRAINT "base_hero_loadouts_version_ck" CHECK ("base_hero_loadouts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_hero_progress" (
	"base_id" uuid NOT NULL,
	"hero" "hero_key" NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"recovery_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_hero_progress_base_id_hero_pk" PRIMARY KEY("base_id","hero"),
	CONSTRAINT "base_hero_progress_level_ck" CHECK ("base_hero_progress"."level" >= 1)
);
--> statement-breakpoint
CREATE TABLE "base_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"seen_at" timestamp with time zone,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_items_base_item_uq" UNIQUE("base_id","item_id"),
	CONSTRAINT "base_items_qty_nonnegative_ck" CHECK ("base_items"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_profiles" (
	"base_id" uuid PRIMARY KEY NOT NULL,
	"trophies" integer DEFAULT 0 NOT NULL,
	"league" "league" DEFAULT 'bronze' NOT NULL,
	"week_start_trophies" integer DEFAULT 0 NOT NULL,
	"purchased_energy" integer DEFAULT 0 NOT NULL,
	"keep_skin" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_profiles_trophies_nonnegative_ck" CHECK ("base_profiles"."trophies" >= 0),
	CONSTRAINT "base_profiles_energy_nonnegative_ck" CHECK ("base_profiles"."purchased_energy" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_quest_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "base_quest_progress_quest_base_uq" UNIQUE("quest_id","base_id"),
	CONSTRAINT "base_quest_progress_nonnegative_ck" CHECK ("base_quest_progress"."progress" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_raid_locks" (
	"base_id" uuid PRIMARY KEY NOT NULL,
	"raid_id" uuid NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" "base_raid_lock_state" DEFAULT 'reserved' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_raid_locks_raid_id_unique" UNIQUE("raid_id"),
	CONSTRAINT "base_raid_locks_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "base_streaks" (
	"base_id" uuid PRIMARY KEY NOT NULL,
	"current_days" integer DEFAULT 0 NOT NULL,
	"last_active_date" date,
	"ever_completed_week1" boolean DEFAULT false NOT NULL,
	"cache_claimed_day" date,
	CONSTRAINT "base_streaks_days_nonnegative_ck" CHECK ("base_streaks"."current_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "base_training_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"troop" "troop_type" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finishes_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"legacy_queue_id" uuid,
	CONSTRAINT "base_training_queue_legacy_queue_id_unique" UNIQUE("legacy_queue_id")
);
--> statement-breakpoint
CREATE TABLE "base_troop_research" (
	"base_id" uuid NOT NULL,
	"troop" "troop_type" NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"researching_to_level" integer,
	"finishes_at" timestamp with time zone,
	CONSTRAINT "base_troop_research_base_id_troop_pk" PRIMARY KEY("base_id","troop"),
	CONSTRAINT "base_troop_research_level_ck" CHECK ("base_troop_research"."level" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "mine_accrual_states" (
	"mine_building_id" uuid PRIMARY KEY NOT NULL,
	"accrued_shards" bigint DEFAULT 0 NOT NULL,
	"last_accrual_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mine_accrual_states_shards_nonnegative_ck" CHECK ("mine_accrual_states"."accrued_shards" >= 0),
	CONSTRAINT "mine_accrual_states_version_nonnegative_ck" CHECK ("mine_accrual_states"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "raid_commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"raid_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"client_command_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"server_offset_ms" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raid_commands_raid_sequence_uq" UNIQUE("raid_id","sequence"),
	CONSTRAINT "raid_commands_raid_client_uq" UNIQUE("raid_id","client_command_id"),
	CONSTRAINT "raid_commands_sequence_ck" CHECK ("raid_commands"."sequence" >= 0 AND "raid_commands"."server_offset_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "raid_live_states" (
	"raid_id" uuid PRIMARY KEY NOT NULL,
	"command_protocol_version" integer NOT NULL,
	"last_sequence" integer DEFAULT -1 NOT NULL,
	"started_at" timestamp with time zone,
	"battle_ends_at" timestamp with time zone,
	"stream_closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raid_live_states_version_ck" CHECK ("raid_live_states"."command_protocol_version" >= 1 AND "raid_live_states"."last_sequence" >= -1),
	CONSTRAINT "raid_live_states_clock_ck" CHECK (
    ("raid_live_states"."started_at" IS NULL AND "raid_live_states"."battle_ends_at" IS NULL)
    OR ("raid_live_states"."started_at" IS NOT NULL AND "raid_live_states"."battle_ends_at" > "raid_live_states"."started_at")
  )
);
--> statement-breakpoint
CREATE TABLE "raid_loot_reservations" (
	"raid_id" uuid PRIMARY KEY NOT NULL,
	"formula_version" integer NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"attacker_base_id" uuid NOT NULL,
	"defender_base_id" uuid NOT NULL,
	"state" "raid_loot_reservation_state" DEFAULT 'reserved' NOT NULL,
	"spendable_reserved_shards" bigint DEFAULT 0 NOT NULL,
	"forge_reserved_shards" bigint DEFAULT 0 NOT NULL,
	"mine_reserved_shards" bigint DEFAULT 0 NOT NULL,
	"private_snapshot_hash" text NOT NULL,
	"reserve_ledger_txn_id" uuid,
	"terminal_ledger_txn_id" uuid,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "raid_loot_reservations_reserve_ledger_txn_id_unique" UNIQUE("reserve_ledger_txn_id"),
	CONSTRAINT "raid_loot_reservations_terminal_ledger_txn_id_unique" UNIQUE("terminal_ledger_txn_id"),
	CONSTRAINT "raid_loot_reservations_versions_ck" CHECK ("raid_loot_reservations"."formula_version" >= 1 AND "raid_loot_reservations"."row_version" >= 0),
	CONSTRAINT "raid_loot_reservations_amounts_ck" CHECK (
    "raid_loot_reservations"."spendable_reserved_shards" >= 0 AND "raid_loot_reservations"."forge_reserved_shards" >= 0 AND "raid_loot_reservations"."mine_reserved_shards" >= 0
  ),
	CONSTRAINT "raid_loot_reservations_terminal_ck" CHECK (
    ("raid_loot_reservations"."state" = 'reserved' AND "raid_loot_reservations"."settled_at" IS NULL AND "raid_loot_reservations"."released_at" IS NULL)
    OR ("raid_loot_reservations"."state" = 'settled' AND "raid_loot_reservations"."settled_at" IS NOT NULL AND "raid_loot_reservations"."released_at" IS NULL)
    OR ("raid_loot_reservations"."state" = 'released' AND "raid_loot_reservations"."released_at" IS NOT NULL AND "raid_loot_reservations"."settled_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "raid_mine_loot_reservations" (
	"raid_id" uuid NOT NULL,
	"mine_building_id" uuid NOT NULL,
	"frozen_shards" bigint NOT NULL,
	"awarded_shards" bigint,
	CONSTRAINT "raid_mine_loot_reservations_raid_id_mine_building_id_pk" PRIMARY KEY("raid_id","mine_building_id"),
	CONSTRAINT "raid_mine_loot_reservations_amount_ck" CHECK (
    "raid_mine_loot_reservations"."frozen_shards" >= 0 AND ("raid_mine_loot_reservations"."awarded_shards" IS NULL OR ("raid_mine_loot_reservations"."awarded_shards" >= 0 AND "raid_mine_loot_reservations"."awarded_shards" <= "raid_mine_loot_reservations"."frozen_shards"))
  )
);
--> statement-breakpoint
CREATE TABLE "raid_replay_timelines" (
	"raid_id" uuid PRIMARY KEY NOT NULL,
	"format_version" integer NOT NULL,
	"codec" text NOT NULL,
	"timeline" "bytea" NOT NULL,
	"byte_length" integer NOT NULL,
	"event_count" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raid_replay_timelines_counts_ck" CHECK (
    "raid_replay_timelines"."format_version" >= 1 AND "raid_replay_timelines"."byte_length" >= 0 AND "raid_replay_timelines"."event_count" >= 0 AND "raid_replay_timelines"."duration_ms" >= 0
  ),
	CONSTRAINT "raid_replay_timelines_byte_length_ck" CHECK (octet_length("raid_replay_timelines"."timeline") = "raid_replay_timelines"."byte_length")
);
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_owner_kind_unique";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "base_army" ADD CONSTRAINT "base_army_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_battle_records" ADD CONSTRAINT "base_battle_records_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_battle_records" ADD CONSTRAINT "base_battle_records_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_battle_records" ADD CONSTRAINT "base_battle_records_owner_wallet_at_battle_players_wallet_fk" FOREIGN KEY ("owner_wallet_at_battle") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_battle_records" ADD CONSTRAINT "base_battle_records_counterparty_base_id_bases_id_fk" FOREIGN KEY ("counterparty_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_campaign_progress" ADD CONSTRAINT "base_campaign_progress_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_daily_activity" ADD CONSTRAINT "base_daily_activity_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_legacy_wallet_players_wallet_fk" FOREIGN KEY ("legacy_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_primary_base_id_bases_id_fk" FOREIGN KEY ("primary_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_source_shard_account_id_accounts_id_fk" FOREIGN KEY ("source_shard_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_destination_shard_account_id_accounts_id_fk" FOREIGN KEY ("destination_shard_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_source_forge_escrow_account_id_accounts_id_fk" FOREIGN KEY ("source_forge_escrow_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_destination_forge_escrow_account_id_accounts_id_fk" FOREIGN KEY ("destination_forge_escrow_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_ledger_transfer_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transfer_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_economy_backfills" ADD CONSTRAINT "base_economy_backfills_forge_ledger_transfer_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("forge_ledger_transfer_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forge_positions" ADD CONSTRAINT "base_forge_positions_settlement_owner_wallet_players_wallet_fk" FOREIGN KEY ("settlement_owner_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_hero_equipment" ADD CONSTRAINT "base_hero_equipment_loadout_fk" FOREIGN KEY ("base_id","hero") REFERENCES "public"."base_hero_loadouts"("base_id","hero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_hero_equipment" ADD CONSTRAINT "base_hero_equipment_item_fk" FOREIGN KEY ("base_id","item_id") REFERENCES "public"."base_items"("base_id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_hero_loadouts" ADD CONSTRAINT "base_hero_loadouts_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_hero_progress" ADD CONSTRAINT "base_hero_progress_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_items" ADD CONSTRAINT "base_items_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_profiles" ADD CONSTRAINT "base_profiles_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_quest_progress" ADD CONSTRAINT "base_quest_progress_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_quest_progress" ADD CONSTRAINT "base_quest_progress_quest_id_quests_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_raid_locks" ADD CONSTRAINT "base_raid_locks_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_raid_locks" ADD CONSTRAINT "base_raid_locks_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_streaks" ADD CONSTRAINT "base_streaks_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_training_queue" ADD CONSTRAINT "base_training_queue_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_troop_research" ADD CONSTRAINT "base_troop_research_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mine_accrual_states" ADD CONSTRAINT "mine_accrual_states_mine_building_id_buildings_id_fk" FOREIGN KEY ("mine_building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_commands" ADD CONSTRAINT "raid_commands_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD CONSTRAINT "raid_live_states_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_loot_reservations" ADD CONSTRAINT "raid_loot_reservations_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_loot_reservations" ADD CONSTRAINT "raid_loot_reservations_attacker_base_id_bases_id_fk" FOREIGN KEY ("attacker_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_loot_reservations" ADD CONSTRAINT "raid_loot_reservations_defender_base_id_bases_id_fk" FOREIGN KEY ("defender_base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_loot_reservations" ADD CONSTRAINT "raid_loot_reservations_reserve_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("reserve_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_loot_reservations" ADD CONSTRAINT "raid_loot_reservations_terminal_ledger_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("terminal_ledger_txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_mine_loot_reservations" ADD CONSTRAINT "raid_mine_loot_reservations_raid_id_raid_loot_reservations_raid_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raid_loot_reservations"("raid_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_mine_loot_reservations" ADD CONSTRAINT "raid_mine_loot_reservations_mine_building_id_buildings_id_fk" FOREIGN KEY ("mine_building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_replay_timelines" ADD CONSTRAINT "raid_replay_timelines_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_battle_records_history_idx" ON "base_battle_records" USING btree ("base_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "base_economy_backfills_primary_base_uq" ON "base_economy_backfills" USING btree ("primary_base_id");--> statement-breakpoint
CREATE INDEX "base_forge_positions_open_idx" ON "base_forge_positions" USING btree ("base_id","day");--> statement-breakpoint
CREATE INDEX "base_hero_equipment_item_idx" ON "base_hero_equipment" USING btree ("base_id","item_id");--> statement-breakpoint
CREATE INDEX "base_quest_progress_base_idx" ON "base_quest_progress" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "base_raid_locks_expiry_idx" ON "base_raid_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "base_training_queue_due_idx" ON "base_training_queue" USING btree ("base_id","finishes_at");--> statement-breakpoint
CREATE INDEX "raid_commands_reconnect_idx" ON "raid_commands" USING btree ("raid_id","sequence");--> statement-breakpoint
CREATE INDEX "raid_live_states_deadline_idx" ON "raid_live_states" USING btree ("battle_ends_at");--> statement-breakpoint
CREATE INDEX "raid_loot_reservations_defender_idx" ON "raid_loot_reservations" USING btree ("defender_base_id","reserved_at");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_kind_unique" ON "accounts" USING btree (coalesce("owner_wallet", ''),"kind") WHERE "accounts"."base_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_base_kind_unique" ON "accounts" USING btree ("base_id","kind") WHERE "accounts"."base_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_scope_ck" CHECK (
    ("accounts"."base_id" IS NOT NULL AND "accounts"."owner_wallet" IS NULL AND "accounts"."kind" IN ('base_shards', 'base_forge_escrow'))
    OR
    ("accounts"."base_id" IS NULL AND "accounts"."owner_wallet" IS NOT NULL AND "accounts"."kind" IN ('player_keep', 'player_sol_credit', 'player_shards'))
    OR
    ("accounts"."base_id" IS NULL AND "accounts"."owner_wallet" IS NULL AND "accounts"."kind" NOT IN ('player_keep', 'player_sol_credit', 'player_shards', 'base_shards', 'base_forge_escrow'))
  );
--> statement-breakpoint

-- Deterministic legacy target: lowest ACTIVE slot; if a wallet has no active
-- slot, lowest slot; if neither exists, lowest stable base UUID. This is an
-- ownership assignment only. Ledger balances are NEVER edited by migration SQL.
CREATE TEMP TABLE "_deed_economy_primary_base" ON COMMIT DROP AS
SELECT DISTINCT ON (p."wallet") p."wallet", b."id" AS "base_id"
FROM "players" p
JOIN "bases" b ON b."owner_wallet" = p."wallet"
LEFT JOIN "base_slots" bs ON bs."base_id" = b."id" AND bs."wallet" = p."wallet"
ORDER BY p."wallet", CASE WHEN bs."active" THEN 0 WHEN bs."slot" IS NOT NULL THEN 1 ELSE 2 END,
         bs."slot" NULLS LAST, b."id";
--> statement-breakpoint

-- Create empty deed ledger accounts. Populating base_shards requires an
-- append-only postTransaction; base_economy_backfills below is the durable,
-- fail-loud work queue for that application boot step.
INSERT INTO "accounts" ("base_id", "kind", "currency", "balance")
SELECT b."id", 'base_shards', 'SHARDS', 0 FROM "bases" b
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "accounts" ("base_id", "kind", "currency", "balance")
SELECT b."id", 'base_forge_escrow', 'SHARDS', 0 FROM "bases" b
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "_deed_economy_primary_base")
     AND NOT EXISTS (
       SELECT 1 FROM "accounts" WHERE "owner_wallet" IS NULL AND "base_id" IS NULL AND "kind" = 'forge_escrow'
     ) THEN
    RAISE EXCEPTION '0074 cannot attribute legacy Forge stake: system forge_escrow account is missing';
  END IF;
END $$;
--> statement-breakpoint

INSERT INTO "base_economy_backfills" (
  "legacy_wallet", "primary_base_id", "source_shard_account_id",
  "destination_shard_account_id", "legacy_shard_balance",
  "source_forge_escrow_account_id", "destination_forge_escrow_account_id",
  "legacy_forge_escrow_shards",
  "legacy_mine_buffer_pending", "ledger_status"
)
SELECT pb."wallet", pb."base_id", src."id", dst."id", coalesce(src."balance", 0),
       sys_forge."id", dst_forge."id", coalesce(open_forge."shards", 0),
       coalesce(ms."accrued_shards", 0), 'pending'
FROM "_deed_economy_primary_base" pb
JOIN "accounts" dst ON dst."base_id" = pb."base_id" AND dst."kind" = 'base_shards'
JOIN "accounts" dst_forge ON dst_forge."base_id" = pb."base_id" AND dst_forge."kind" = 'base_forge_escrow'
JOIN "accounts" sys_forge ON sys_forge."owner_wallet" IS NULL AND sys_forge."base_id" IS NULL AND sys_forge."kind" = 'forge_escrow'
LEFT JOIN "accounts" src ON src."owner_wallet" = pb."wallet" AND src."kind" = 'player_shards'
LEFT JOIN "mine_state" ms ON ms."player_wallet" = pb."wallet"
LEFT JOIN LATERAL (
  SELECT coalesce(sum(fc."shards"), 0)::bigint AS "shards"
  FROM "forge_contributions" fc
  WHERE fc."player_wallet" = pb."wallet" AND fc."settled_at" IS NULL
) open_forge ON true
ON CONFLICT ("legacy_wallet") DO NOTHING;
--> statement-breakpoint

-- Preserve each unsettled UTC-day position exactly. Its pooled escrow backing
-- moves only when the application consumes the fail-loud backfill queue.
INSERT INTO "base_forge_positions" (
  "day", "base_id", "contributed_shards", "raid_debited_shards", "items_dropped"
)
SELECT fc."day", pb."base_id", fc."shards", 0, '[]'::jsonb
FROM "_deed_economy_primary_base" pb
JOIN "forge_contributions" fc ON fc."player_wallet" = pb."wallet" AND fc."settled_at" IS NULL
ON CONFLICT ("day", "base_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "base_profiles" (
  "base_id", "trophies", "league", "week_start_trophies",
  "purchased_energy", "keep_skin", "updated_at"
)
SELECT pb."base_id", p."trophies", p."league", p."week_start_trophies",
       p."purchased_energy", p."keep_skin", now()
FROM "_deed_economy_primary_base" pb JOIN "players" p ON p."wallet" = pb."wallet"
ON CONFLICT ("base_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_army" ("base_id", "troop", "count")
SELECT pb."base_id", a."troop", a."count"
FROM "_deed_economy_primary_base" pb JOIN "army" a ON a."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "troop") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_training_queue" (
  "base_id", "troop", "started_at", "finishes_at", "completed_at", "legacy_queue_id"
)
SELECT pb."base_id", q."troop", q."started_at", q."finishes_at", q."completed_at", q."id"
FROM "_deed_economy_primary_base" pb JOIN "training_queue" q ON q."player_wallet" = pb."wallet"
ON CONFLICT ("legacy_queue_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_troop_research" (
  "base_id", "troop", "level", "researching_to_level", "finishes_at"
)
SELECT pb."base_id", r."troop", r."level", r."researching_to_level", r."finishes_at"
FROM "_deed_economy_primary_base" pb JOIN "troop_research" r ON r."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "troop") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_hero_progress" ("base_id", "hero", "level", "recovery_until", "updated_at")
SELECT pb."base_id", h."hero", h."level", h."recovery_until", h."updated_at"
FROM "_deed_economy_primary_base" pb JOIN "hero_levels" h ON h."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "hero") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_items" ("base_id", "item_id", "qty", "seen_at", "acquired_at")
SELECT pb."base_id", i."item_id", i."qty", i."seen_at", i."acquired_at"
FROM "_deed_economy_primary_base" pb JOIN "player_items" i ON i."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "item_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_hero_loadouts" ("base_id", "hero", "version", "updated_at")
SELECT pb."base_id", h."hero", h."version", h."updated_at"
FROM "_deed_economy_primary_base" pb JOIN "hero_loadouts" h ON h."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "hero") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_hero_equipment" ("base_id", "hero", "slot", "item_id", "equipped_at")
SELECT pb."base_id", h."hero", h."slot", h."item_id", h."equipped_at"
FROM "_deed_economy_primary_base" pb JOIN "hero_equipment" h ON h."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "hero", "slot") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_quest_progress" (
  "base_id", "quest_id", "progress", "completed_at", "claimed_at"
)
SELECT pb."base_id", q."quest_id", q."progress", q."completed_at", q."claimed_at"
FROM "_deed_economy_primary_base" pb JOIN "quest_progress" q ON q."player_wallet" = pb."wallet"
ON CONFLICT ("quest_id", "base_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_streaks" (
  "base_id", "current_days", "last_active_date", "ever_completed_week1", "cache_claimed_day"
)
SELECT pb."base_id", s."current_days", s."last_active_date", s."ever_completed_week1", s."cache_claimed_day"
FROM "_deed_economy_primary_base" pb JOIN "streaks" s ON s."player_wallet" = pb."wallet"
ON CONFLICT ("base_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_daily_activity" ("base_id", "day", "claimed_at", "raids", "builds")
SELECT pb."base_id", d."day", d."claimed_at", d."raids", d."builds"
FROM "_deed_economy_primary_base" pb JOIN "daily_activity" d ON d."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "day") DO NOTHING;
--> statement-breakpoint
INSERT INTO "base_campaign_progress" (
  "base_id", "stage", "best_stars", "first_three_star_at", "updated_at"
)
SELECT pb."base_id", c."stage", c."best_stars", c."first_three_star_at", c."updated_at"
FROM "_deed_economy_primary_base" pb JOIN "campaign_progress" c ON c."player_wallet" = pb."wallet"
ON CONFLICT ("base_id", "stage") DO NOTHING;
--> statement-breakpoint

-- Wallet-wide legacy Mine state becomes one physical Mine buffer on the primary
-- deed. If no completed Mine exists it stays in base_economy_backfills until a
-- service can attach it to the first Mine without inventing a building.
WITH target AS (
  SELECT DISTINCT ON (bf."legacy_wallet") bf."legacy_wallet", m."id" AS "mine_id",
         bf."legacy_mine_buffer_pending", ms."last_accrual_at"
  FROM "base_economy_backfills" bf
  JOIN "buildings" m ON m."base_id" = bf."primary_base_id" AND m."type" = 'mine'
  LEFT JOIN "builder_jobs" j ON j."building_id" = m."id" AND j."kind" = 'build' AND j."completed_at" IS NULL
  LEFT JOIN "mine_state" ms ON ms."player_wallet" = bf."legacy_wallet"
  WHERE j."id" IS NULL
  ORDER BY bf."legacy_wallet", m."id"
)
INSERT INTO "mine_accrual_states" ("mine_building_id", "accrued_shards", "last_accrual_at")
SELECT "mine_id", "legacy_mine_buffer_pending", coalesce("last_accrual_at", now()) FROM target
ON CONFLICT ("mine_building_id") DO NOTHING;
--> statement-breakpoint
-- Every other completed physical Mine starts with an explicit zero buffer and a
-- cutover-time anchor. The first deterministic Mine above already owns the
-- wallet-wide legacy buffer; reusing its old anchor for every Mine would mint
-- the same pre-cutover elapsed interval once per building.
INSERT INTO "mine_accrual_states" ("mine_building_id", "accrued_shards", "last_accrual_at")
SELECT m."id", 0, now()
FROM "buildings" m
LEFT JOIN "builder_jobs" j
  ON j."building_id" = m."id" AND j."kind" = 'build' AND j."completed_at" IS NULL
WHERE m."type" = 'mine' AND m."base_id" IS NOT NULL AND j."id" IS NULL
ON CONFLICT ("mine_building_id") DO NOTHING;
--> statement-breakpoint
UPDATE "base_economy_backfills" bf SET "legacy_mine_buffer_pending" = 0, "mine_backfilled_at" = now()
WHERE EXISTS (
  SELECT 1 FROM "mine_accrual_states" mas
  JOIN "buildings" m ON m."id" = mas."mine_building_id"
  WHERE m."base_id" = bf."primary_base_id"
);
--> statement-breakpoint

-- Fence old contribution/settlement writers immediately. Historical settled
-- allocation CLAIM/EXPIRY fields remain writable; they are wallet KEEP debts
-- and do not touch the migrated open SHARDS positions. New deed-aware services
-- write base_forge_positions and may reconcile through the explicit queue.
CREATE FUNCTION "shardkeep_fence_legacy_forge_write"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('shardkeep.deed_forge_reconcile', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "base_economy_backfills" WHERE "legacy_wallet" = NEW."player_wallet") THEN
      RAISE EXCEPTION 'LEGACY_FORGE_WRITER_FENCED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "base_economy_backfills" WHERE "legacy_wallet" = OLD."player_wallet") THEN
      RAISE EXCEPTION 'LEGACY_FORGE_WRITER_FENCED' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM "base_economy_backfills" WHERE "legacy_wallet" = OLD."player_wallet")
     AND (NEW."day" IS DISTINCT FROM OLD."day"
       OR NEW."player_wallet" IS DISTINCT FROM OLD."player_wallet"
       OR NEW."shards" IS DISTINCT FROM OLD."shards"
       OR NEW."settled_at" IS DISTINCT FROM OLD."settled_at"
       OR NEW."keep_paid" IS DISTINCT FROM OLD."keep_paid"
       OR NEW."shards_refunded" IS DISTINCT FROM OLD."shards_refunded"
       OR NEW."item_dropped" IS DISTINCT FROM OLD."item_dropped"
       OR NEW."keep_escrow_txn_id" IS DISTINCT FROM OLD."keep_escrow_txn_id") THEN
    RAISE EXCEPTION 'LEGACY_FORGE_WRITER_FENCED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "forge_contributions_deed_writer_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "forge_contributions"
FOR EACH ROW EXECUTE FUNCTION "shardkeep_fence_legacy_forge_write"();
