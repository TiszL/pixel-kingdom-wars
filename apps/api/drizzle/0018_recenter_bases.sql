-- Re-center every base into the CENTERED claim (owner 2026-07-20 CoC layout).
-- The plot grew 18->30 and the claim moved from low-anchored [2,16) to centered
-- [8,22); this shifts existing base data so coordinates match footprints.claimRect
-- again and the deploy ring surrounds the base. Data-only (no schema change), so
-- the pure-sim golden fixtures are unaffected.

-- Buildings: shift by the per-player re-center delta (6 - expansions). A fresh base
-- moves +6; each expansion already pushed the low-anchored min toward center, so the
-- delta shrinks to 0 at expansion 6 (a 26-claim is [2,28) under both schemes).
UPDATE "buildings" AS b
   SET "tx" = b."tx" + (6 - p."expansions"),
       "ty" = b."ty" + (6 - p."expansions")
  FROM "players" AS p
 WHERE b."player_wallet" = p."wallet";
--> statement-breakpoint

-- Active obstacles: shift by the SAME per-player delta so the building/obstacle
-- non-overlap invariant is preserved by construction. Tombstoned (cleared) rows keep
-- their old coords (inert, never re-collide).
UPDATE "obstacles" AS o
   SET "tx" = o."tx" + (6 - p."expansions"),
       "ty" = o."ty" + (6 - p."expansions")
  FROM "players" AS p
 WHERE o."player_wallet" = p."wallet"
   AND o."cleared_at" IS NULL;
--> statement-breakpoint

-- Shed obstacles pushed off the 30-plot by the shift. Max obstacle size is 2 and
-- claims cap at [2,28), so this only drops inert far-field decor, never an in-claim
-- obstacle.
DELETE FROM "obstacles" WHERE "tx" > 29 OR "ty" > 29;
--> statement-breakpoint

-- PvE camp snapshots: re-center the frozen jsonb the same way (flat +6 -- camps have
-- no expansions) and attach the centered claim bounds [8,22) = claimRect(0). In-place
-- rewrite preserves camp ids + raids.pve_camp_id FKs + respawn state.
UPDATE "pve_camps" SET "snapshot" =
  ("snapshot" - 'buildings')
  || jsonb_build_object(
       'buildings', (
         SELECT jsonb_agg(
                  elem || jsonb_build_object(
                    'tx', (elem->>'tx')::int + 6,
                    'ty', (elem->>'ty')::int + 6
                  )
                )
           FROM jsonb_array_elements("snapshot"->'buildings') AS elem
       ),
       'claimMin', 8,
       'claimMax', 22
     );
