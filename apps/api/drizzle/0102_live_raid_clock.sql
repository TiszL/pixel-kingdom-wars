ALTER TABLE "raid_live_states" ADD COLUMN "clock_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD COLUMN "clock_rate" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD COLUMN "clock_anchor_wall_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD COLUMN "clock_anchor_sim_ms" integer;--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD COLUMN "armed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD CONSTRAINT "raid_live_states_clock_v2_range_ck" CHECK (
    "raid_live_states"."clock_revision" >= 0
    AND "raid_live_states"."clock_rate" IN (1, 2)
    AND ("raid_live_states"."clock_anchor_sim_ms" IS NULL OR "raid_live_states"."clock_anchor_sim_ms" BETWEEN 0 AND 90000)
  );--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD CONSTRAINT "raid_live_states_clock_v2_pair_ck" CHECK (
    ("raid_live_states"."clock_anchor_wall_at" IS NULL) = ("raid_live_states"."clock_anchor_sim_ms" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "raid_live_states" ADD CONSTRAINT "raid_live_states_clock_v2_state_ck" CHECK (
    "raid_live_states"."command_protocol_version" != 2
    OR (
      ("raid_live_states"."started_at" IS NULL AND "raid_live_states"."battle_ends_at" IS NULL
        AND "raid_live_states"."clock_anchor_wall_at" IS NULL AND "raid_live_states"."clock_anchor_sim_ms" IS NULL)
      OR ("raid_live_states"."started_at" IS NOT NULL AND "raid_live_states"."battle_ends_at" IS NOT NULL AND "raid_live_states"."battle_ends_at" > "raid_live_states"."started_at"
        AND "raid_live_states"."clock_anchor_wall_at" IS NOT NULL AND "raid_live_states"."clock_anchor_sim_ms" IS NOT NULL)
    )
  );
