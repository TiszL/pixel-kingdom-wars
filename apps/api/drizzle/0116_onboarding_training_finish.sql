-- Owner 2026-09-08: one free first-army completion per wallet, never per deed.
-- This actor-history latch intentionally has no player FK: lazy completion
-- holds the base first, while transfers lock players first. A new FK check
-- creates a players/base lock inversion (covered by a real lock-wait test).
-- Actors come from canonical player/base rows; history survives account cleanup.
CREATE TABLE onboarding_training_wallets (
 wallet text PRIMARY KEY, completed_at timestamptz, review_evidence jsonb
);
--> statement-breakpoint
CREATE TABLE onboarding_training_finishes (
 wallet text PRIMARY KEY REFERENCES players(wallet), idempotency_key text NOT NULL,
 base_id uuid REFERENCES bases(id), consent jsonb NOT NULL, completed jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (jsonb_typeof(consent)='object' AND jsonb_typeof(consent->'queue')='array'),
 CHECK (jsonb_typeof(completed)='array' AND jsonb_array_length(completed)>0)
);
--> statement-breakpoint
-- Canonical wallet progress proves an actor. A stable deed with no transfer
-- history also proves its sole owner. Transfer timestamps cannot prove which
-- owner completed: created_at is transaction start, not lock acquisition or
-- commit order. Never use timestamps or UUID sorting to guess that actor.
INSERT INTO onboarding_training_wallets(wallet,completed_at)
SELECT completed.wallet,min(completed_at) FROM (
 SELECT p.player_wallet wallet,p.completed_at FROM quest_progress p JOIN quests q ON q.id=p.quest_id
 WHERE q.scope='onboarding' AND q.template_code='first_troops' AND p.completed_at IS NOT NULL
 UNION ALL
 SELECT b.owner_wallet,p.completed_at
 FROM base_quest_progress p JOIN quests q ON q.id=p.quest_id JOIN bases b ON b.id=p.base_id
 WHERE q.scope='onboarding' AND q.template_code='first_troops' AND p.completed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM base_transfers t WHERE t.deed_asset_id=coalesce(b.deed_asset_id,b.deed_mint_asset_id))
) completed JOIN players ON players.wallet=completed.wallet GROUP BY completed.wallet
ON CONFLICT(wallet) DO UPDATE SET completed_at=least(onboarding_training_wallets.completed_at,EXCLUDED.completed_at),review_evidence=NULL;
--> statement-breakpoint
-- Completed conveyed deeds have unresolved historical actors. Preserve the
-- exact evidence and all candidate wallets (every from/to/current owner), with
-- completed_at NULL unless an independent canonical wallet proof exists.
-- This holds only the one-time gift; ordinary training and play remain open.
WITH uncertain AS (
 SELECT b.id base_id,p.quest_id,p.completed_at,b.owner_wallet,
   jsonb_agg(jsonb_build_object('id',t.id,'fromWallet',t.from_wallet,'toWallet',t.to_wallet,
     'recordedAt',t.created_at) ORDER BY t.id) transfers,
   array_agg(t.from_wallet)||array_agg(t.to_wallet)||ARRAY[b.owner_wallet] owners
 FROM base_quest_progress p JOIN quests q ON q.id=p.quest_id JOIN bases b ON b.id=p.base_id
 JOIN base_transfers t ON t.deed_asset_id=coalesce(b.deed_asset_id,b.deed_mint_asset_id)
 WHERE q.scope='onboarding' AND q.template_code='first_troops' AND p.completed_at IS NOT NULL
 GROUP BY b.id,p.quest_id,p.completed_at,b.owner_wallet
), candidates AS (
 SELECT DISTINCT u.base_id,u.quest_id,u.completed_at,u.transfers,owner wallet
 FROM uncertain u CROSS JOIN LATERAL unnest(u.owners) owner
)
INSERT INTO onboarding_training_wallets(wallet,review_evidence)
SELECT c.wallet,jsonb_agg(jsonb_build_object('reason','historical-completion-owner-unresolved',
 'baseId',c.base_id,'questId',c.quest_id,'completedAt',c.completed_at,'transfers',c.transfers)
 ORDER BY c.base_id,c.quest_id)
FROM candidates c JOIN players p ON p.wallet=c.wallet
WHERE NOT EXISTS(SELECT 1 FROM onboarding_training_wallets w WHERE w.wallet=c.wallet AND w.completed_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM onboarding_training_finishes f WHERE f.wallet=c.wallet)
GROUP BY c.wallet
ON CONFLICT(wallet) DO UPDATE SET review_evidence=EXCLUDED.review_evidence
 WHERE onboarding_training_wallets.completed_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION capture_onboarding_training_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text;
BEGIN
 IF NEW.completed_at IS NULL OR (TG_OP='UPDATE' AND OLD.completed_at IS NOT NULL) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM quests WHERE id=NEW.quest_id AND scope='onboarding' AND template_code='first_troops') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='base_quest_progress' THEN SELECT owner_wallet INTO actor FROM bases WHERE id=NEW.base_id;
 ELSE actor:=NEW.player_wallet; END IF;
 -- The same row is locked by free completion. A simultaneous completion on a
 -- sibling deed cannot race this wallet's eligibility check.
 INSERT INTO onboarding_training_wallets(wallet,completed_at) VALUES(actor,NEW.completed_at)
 ON CONFLICT(wallet) DO UPDATE SET completed_at=least(onboarding_training_wallets.completed_at,EXCLUDED.completed_at),review_evidence=NULL;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER onboarding_training_completion AFTER INSERT OR UPDATE ON base_quest_progress
 FOR EACH ROW EXECUTE FUNCTION capture_onboarding_training_completion();
--> statement-breakpoint
CREATE TRIGGER onboarding_training_completion AFTER INSERT OR UPDATE ON quest_progress
 FOR EACH ROW EXECUTE FUNCTION capture_onboarding_training_completion();
