CREATE TYPE "public"."auth_nonce_purpose" AS ENUM('signin', 'seeker_link');--> statement-breakpoint
CREATE TABLE "seeker_links" (
	"wallet" text PRIMARY KEY NOT NULL,
	"seeker_wallet" text NOT NULL,
	"sgt_mint" text NOT NULL,
	"member_number" integer,
	"skr_domain" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_nonces" ADD COLUMN "purpose" "auth_nonce_purpose" DEFAULT 'signin' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_nonces" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "name_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "name_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "seeker_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "seeker_links" ADD CONSTRAINT "seeker_links_wallet_players_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seeker_links_sgt_mint_uq" ON "seeker_links" USING btree ("sgt_mint");--> statement-breakpoint
CREATE UNIQUE INDEX "seeker_links_seeker_wallet_uq" ON "seeker_links" USING btree ("seeker_wallet");--> statement-breakpoint
-- Backfill name_key from the names that already exist. players.name has never
-- been unique (clans.name always was), so duplicates are expected here and the
-- index below WILL fail without this step. The oldest account keeps the bare
-- key. Nobody's DISPLAY name is changed — only the internal key.
--
-- UNIQUENESS IS BY CONSTRUCTION, not by luck. Exactly two key namespaces:
--   1. BARE  lower(name) — held by at most one row per name (rn = 1), so these
--      are pairwise distinct by definition.
--   2. '#' || wallet — everyone else. `wallet` is the players PRIMARY KEY, so
--      these are pairwise distinct too.
-- The namespaces cannot meet, because any name whose fold already starts with
-- '#' is pushed into namespace 2. And no player can ever land in namespace 2's
-- shape by choosing a name: '#' is outside USERNAMES.pattern (alphanumeric
-- ends, [A-Za-z0-9_-] inside) and outside the `.skr` label charset, so every
-- key writable by game/username.ts starts with a letter or digit.
-- The previous `k || '-' || rn` scheme had NO such guarantee — a player already
-- named literally 'k-2' collides with the deduped second 'k', the CREATE UNIQUE
-- INDEX below fails, and the entire migration aborts on live data (reproduced
-- on a migrated database; security review F2).
--
-- Keys shaped like a `.skr` domain also go to namespace 2 (security review F6):
-- the OLD charset allowed dots, so a legacy player could be sitting on
-- 'torqueond.skr' and would permanently squat the one username the genuine
-- on-chain owner of that domain can prove. The bare key buys a legacy holder
-- nothing — dotted keys are unreachable through the new charset — while for the
-- domain's real owner it is the only name they can prove.
UPDATE "players" p SET "name_key" = d.key FROM (
  SELECT "wallet",
         CASE WHEN rn = 1 AND k NOT LIKE '#%' AND k NOT LIKE '%.skr'
              THEN k ELSE '#' || "wallet" END AS key
  FROM (
    SELECT "wallet", lower("name") AS k,
           row_number() OVER (PARTITION BY lower("name") ORDER BY "created_at", "wallet") AS rn
    FROM "players" WHERE "name" <> ''
  ) s
) d WHERE p."wallet" = d."wallet";--> statement-breakpoint
CREATE UNIQUE INDEX "players_name_key_uq" ON "players" USING btree ("name_key") WHERE name_key <> '';