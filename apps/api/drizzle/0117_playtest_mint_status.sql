-- Owner 2026-09-09: retain safe failure/last-success diagnostics independently
-- of the current finalized inventory receipt. No mint proofs or awards change.
CREATE TABLE playtest_mint_status (
 id text PRIMARY KEY CHECK (id='land-deeds'),
 last_attempt_at timestamptz NOT NULL,
 last_success_at timestamptz,
 state text NOT NULL CHECK (state IN ('complete','unavailable')),
 reason text,
 diagnostics jsonb NOT NULL
);
--> statement-breakpoint
INSERT INTO playtest_mint_status(id,last_attempt_at,last_success_at,state,diagnostics)
 SELECT id,completed_at,completed_at,'complete','{"stage":"collection_after","attempts":0,"contextRetries":0}'::jsonb
 FROM playtest_mint_inventory WHERE id='land-deeds';
