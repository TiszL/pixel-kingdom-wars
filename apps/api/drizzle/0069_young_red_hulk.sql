CREATE TABLE "hero_raid_reservations" (
	"player_wallet" text NOT NULL,
	"hero" "hero_key" NOT NULL,
	"raid_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hero_raid_reservations_player_hero_pk" PRIMARY KEY("player_wallet","hero")
);
--> statement-breakpoint
ALTER TABLE "hero_raid_reservations" ADD CONSTRAINT "hero_raid_reservations_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_raid_reservations" ADD CONSTRAINT "hero_raid_reservations_raid_id_raids_id_fk" FOREIGN KEY ("raid_id") REFERENCES "public"."raids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hero_raid_reservations_raid_hero_uq" ON "hero_raid_reservations" USING btree ("raid_id","hero");--> statement-breakpoint
CREATE INDEX "hero_raid_reservations_raid_idx" ON "hero_raid_reservations" USING btree ("raid_id");--> statement-breakpoint
-- Rolling-upgrade bridge: only SIM7 raids are compatible with the server that
-- understands this reservation table. Keep the oldest still-live raid per
-- attacker and reserve every valid frozen hero in it; later duplicate raids
-- remain deliberately unreserved and fail closed at submit (with compensation).
WITH "ranked_live_raids" AS (
	SELECT "id", "attacker_wallet", "army_snapshot", "created_at",
		row_number() OVER (
			PARTITION BY "attacker_wallet"
			ORDER BY "created_at" ASC, "id" ASC
		) AS "raid_rank"
	FROM "raids"
	WHERE "status" = 'pending_orders'
		AND "sim_version" = 7
		AND "orders_deadline_at" >= now()
		AND jsonb_typeof("army_snapshot"->'heroes') = 'array'
		AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements_text(
				CASE WHEN jsonb_typeof("army_snapshot"->'heroes') = 'array'
					THEN "army_snapshot"->'heroes' ELSE '[]'::jsonb END
			) AS "candidate_hero"("hero")
			WHERE "candidate_hero"."hero" IN ('vex', 'theodor')
		)
), "chosen_raids" AS (
	SELECT * FROM "ranked_live_raids" WHERE "raid_rank" = 1
)
INSERT INTO "hero_raid_reservations" ("player_wallet", "hero", "raid_id", "created_at")
SELECT DISTINCT "chosen_raids"."attacker_wallet",
	CASE "frozen_hero"."hero"
		WHEN 'vex' THEN 'vex'::"hero_key"
		WHEN 'theodor' THEN 'theodor'::"hero_key"
	END,
	"chosen_raids"."id",
	"chosen_raids"."created_at"
FROM "chosen_raids"
CROSS JOIN LATERAL jsonb_array_elements_text("chosen_raids"."army_snapshot"->'heroes')
	AS "frozen_hero"("hero")
WHERE "frozen_hero"."hero" IN ('vex', 'theodor')
ON CONFLICT DO NOTHING;
