-- Migration source: registered in 0114_open_playtest_campaigns.sql.
-- D-118. Exact event times and immutable actor snapshots; no inferred historical cohorts.
ALTER TABLE raids ADD COLUMN bulk_deployment_accepted_at timestamptz;
--> statement-breakpoint
CREATE TABLE player_action_events (
 id text PRIMARY KEY, wallet text NOT NULL REFERENCES players(wallet), source_key text NOT NULL,
 occurred_at timestamptz NOT NULL, base_id uuid, active boolean NOT NULL, fought boolean NOT NULL DEFAULT false,
 source_table text NOT NULL, source_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
 invalidated_for_scoring_at timestamptz, captured_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX player_action_events_wallet_time_idx ON player_action_events(wallet, occurred_at);
--> statement-breakpoint
CREATE INDEX player_action_events_time_idx ON player_action_events(occurred_at);
--> statement-breakpoint
CREATE INDEX player_action_events_source_idx ON player_action_events(source_table, source_id);
--> statement-breakpoint
CREATE INDEX player_action_events_state_idx ON player_action_events(source_key, base_id, occurred_at DESC, captured_at DESC, id);
--> statement-breakpoint
CREATE TABLE player_activity_days (
 wallet text NOT NULL REFERENCES players(wallet), day date NOT NULL, first_at timestamptz NOT NULL,
 last_at timestamptz NOT NULL, fought boolean NOT NULL, PRIMARY KEY(wallet, day)
);
--> statement-breakpoint
CREATE INDEX player_activity_days_day_idx ON player_activity_days(day);
--> statement-breakpoint
CREATE TABLE playtest_activity_coverage (key text PRIMARY KEY, started_at timestamptz NOT NULL);
--> statement-breakpoint
INSERT INTO playtest_activity_coverage VALUES ('authoritative-v1', clock_timestamp());
--> statement-breakpoint

-- Trusted history/derived evidence only. Live sources must use the fenced wrapper.
CREATE FUNCTION record_player_action(w text, k text, tbl text, ref text, at_time timestamptz,
 b uuid DEFAULT NULL, is_active boolean DEFAULT true, is_fight boolean DEFAULT false, meta jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE event_id text;
BEGIN
 IF w IS NULL OR at_time IS NULL THEN RETURN; END IF;
 event_id := tbl || ':' || ref || ':' || k || ':' || w;
 INSERT INTO player_action_events(id,wallet,source_key,occurred_at,base_id,active,fought,source_table,source_id,metadata)
 VALUES(event_id,w,k,at_time,b,is_active,is_fight,tbl,ref,meta)
 ON CONFLICT(id) DO NOTHING;
END $$;
--> statement-breakpoint

-- Source timestamps can precede a blocked commit. Acquire the closeout fence
-- BEFORE sampling acceptance time so late writes never enter frozen windows.
CREATE FUNCTION capture_live_player_action(w text, k text, tbl text, ref text, source_time timestamptz,
 b uuid DEFAULT NULL, is_active boolean DEFAULT true, is_fight boolean DEFAULT false, meta jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE accepted_at timestamptz;
BEGIN
 LOCK TABLE player_action_events IN ROW EXCLUSIVE MODE;
 accepted_at := clock_timestamp();
 PERFORM record_player_action(w,k,tbl,ref,accepted_at,b,is_active,is_fight,
  coalesce(meta,'{}'::jsonb) || jsonb_build_object('sourceOccurredAt',source_time));
END $$;
--> statement-breakpoint

CREATE FUNCTION project_player_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date; referral record;
BEGIN
 IF NOT NEW.active THEN RETURN NEW; END IF;
 d := (NEW.occurred_at AT TIME ZONE 'UTC')::date;
 -- The same wallet/day lock prevents concurrent actions and cancellation from
 -- losing a real day or resurrecting a cancelled-only day.
 PERFORM pg_advisory_xact_lock(hashtextextended('activity:' || NEW.wallet || ':' || d::text, 0));
 DELETE FROM player_activity_days WHERE wallet=NEW.wallet AND day=d;
 INSERT INTO player_activity_days(wallet,day,first_at,last_at,fought)
 SELECT NEW.wallet,d,min(occurred_at),max(occurred_at),bool_or(fought) FROM player_action_events
 WHERE wallet=NEW.wallet AND active AND invalidated_for_scoring_at IS NULL
 AND occurred_at >= d::timestamp AT TIME ZONE 'UTC'
 AND occurred_at < (d+1)::timestamp AT TIME ZONE 'UTC' HAVING count(*) > 0;
 IF TG_OP='INSERT' AND NEW.active AND NEW.invalidated_for_scoring_at IS NULL THEN
  FOR referral IN SELECT r.referrer_wallet FROM referrals r
   WHERE r.referee_wallet=NEW.wallet AND r.qualified_at <= NEW.occurred_at
   AND EXISTS(SELECT 1 FROM bases b WHERE b.owner_wallet=NEW.wallet AND b.status='active' AND b.land_paid_at IS NOT NULL)
  LOOP
   -- Emit every action: the campaign filters its exact join/start boundary,
   -- then counts distinct referees within each UTC day.
   PERFORM record_player_action(referral.referrer_wallet,'referral_active','player_action_events',NEW.id,
    NEW.occurred_at,NULL,false,false,jsonb_build_object('refereeWallet',NEW.wallet));
  END LOOP;
 END IF;
 IF TG_OP='UPDATE' AND NEW.invalidated_for_scoring_at IS NOT NULL THEN
  UPDATE player_action_events SET invalidated_for_scoring_at=NEW.invalidated_for_scoring_at
  WHERE source_table='player_action_events' AND source_id=NEW.id AND invalidated_for_scoring_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER player_activity_project AFTER INSERT OR UPDATE OF invalidated_for_scoring_at
 ON player_action_events FOR EACH ROW EXECUTE FUNCTION project_player_activity();
--> statement-breakpoint

CREATE FUNCTION capture_player_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb := to_jsonb(NEW); o jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 w text; b uuid; k text; at_time timestamptz; meta jsonb := '{}'; r raids%ROWTYPE; previous_id uuid; event_source_table text := TG_TABLE_NAME; account_row accounts%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='ledger_entries' THEN
  SELECT to_jsonb(t) INTO n FROM ledger_transactions t WHERE t.id=NEW.txn_id;
  SELECT * INTO account_row FROM accounts WHERE id=NEW.account_id;
  event_source_table := 'ledger_transactions';
  k := CASE n->>'type' WHEN 'mine.collect' THEN 'mine_collected' WHEN 'cache.claim' THEN 'cache_claimed'
   WHEN 'army.train' THEN 'troops_trained' WHEN 'forge.contribute' THEN 'forge_deployed'
   WHEN 'forge.claim' THEN 'forge_claimed' WHEN 'item.buy' THEN 'shop_bought'
   WHEN 'build.place' THEN 'build_started' WHEN 'build.upgrade' THEN 'build_started'
   WHEN 'build.mine' THEN 'build_started' WHEN 'build.repair' THEN 'build_started'
   WHEN 'build.upgrade_mine' THEN 'build_started' WHEN 'build.upgrade_goldforge' THEN 'build_started' END;
  IF k IS NULL THEN RETURN NEW; END IF;
  meta := n->'metadata'; b := coalesce((meta->>'baseId')::uuid,account_row.base_id);
  w := coalesce(meta->>'wallet',meta->>'claimedBy');
  IF w IS NULL AND b IS NOT NULL THEN SELECT owner_wallet INTO w FROM bases WHERE id=b; END IF;
  IF w IS NULL THEN w := account_row.owner_wallet; END IF;
  -- System entries carry no actor; the player/base entry of this same balanced
  -- transaction supplies it. Captured before any later transfer can rewrite it.
  IF w IS NULL THEN RETURN NEW; END IF;
  at_time := (n->>'created_at')::timestamptz;
 ELSIF TG_TABLE_NAME='builder_jobs' THEN
  IF TG_OP='UPDATE' THEN
   IF n->>'cancelled_at' IS NOT NULL AND o->>'cancelled_at' IS NULL THEN
    LOCK TABLE player_action_events IN ROW EXCLUSIVE MODE;
    UPDATE player_action_events event SET invalidated_for_scoring_at=clock_timestamp()
    WHERE ((event.source_table='builder_jobs' AND event.source_id=n->>'id') OR
     (event.source_table='ledger_transactions' AND event.source_id=n->>'debit_ledger_txn_id')) AND event.invalidated_for_scoring_at IS NULL;
   END IF;
   RETURN NEW; -- Transfers/completion do not manufacture a second action.
  END IF;
  IF n->>'cancelled_at' IS NOT NULL THEN RETURN NEW; END IF;
  k := 'build_started'; b := (n->>'base_id')::uuid; w := n->>'player_wallet'; at_time := (n->>'started_at')::timestamptz;
 ELSIF TG_TABLE_NAME IN ('quest_progress','base_quest_progress','mail_messages') THEN
  IF n->>'claimed_at' IS NULL OR o->>'claimed_at' IS NOT NULL THEN RETURN NEW; END IF;
  at_time := (n->>'claimed_at')::timestamptz;
  k := CASE WHEN TG_TABLE_NAME='mail_messages' THEN 'mail_claimed' ELSE 'quest_claimed' END;
  b := coalesce(n->>'base_id',n->>'claim_base_id')::uuid;
  w := coalesce(n->>'player_wallet',n->>'recipient_wallet');
  IF w IS NULL AND b IS NOT NULL THEN SELECT owner_wallet INTO w FROM bases WHERE id=b; END IF;
 ELSIF TG_TABLE_NAME='raid_commands' THEN
  IF n->>'kind' NOT IN ('deploy','hero') THEN RETURN NEW; END IF;
  SELECT * INTO r FROM raids WHERE id=(n->>'raid_id')::uuid;
  PERFORM capture_live_player_action(r.attacker_wallet,'battle_fought','raid_commands',n->>'id',
   (n->>'accepted_at')::timestamptz,r.attacker_base_id,true,true,
   jsonb_build_object('raidId',r.id,'opponentWallet',r.defender_wallet,'campaignStage',r.campaign_stage));
  RETURN NEW;
 ELSIF TG_TABLE_NAME='raids' THEN
  IF n->>'bulk_deployment_accepted_at' IS NOT NULL AND o->>'bulk_deployment_accepted_at' IS NULL THEN
   PERFORM capture_live_player_action(n->>'attacker_wallet','battle_fought','raids',n->>'id',
    (n->>'bulk_deployment_accepted_at')::timestamptz,(n->>'attacker_base_id')::uuid,true,true,
    jsonb_build_object('raidId',n->>'id','opponentWallet',n->>'defender_wallet','campaignStage',n->'campaign_stage'));
  END IF;
  IF n->>'status'<>'resolved' OR o->>'status'='resolved' THEN RETURN NEW; END IF;
  IF coalesce(jsonb_array_length(n->'orders'->'deploys'),0)+coalesce(jsonb_array_length(n->'orders'->'heroDeploys'),0)=0 THEN RETURN NEW; END IF;
  w := n->>'attacker_wallet'; b := (n->>'attacker_base_id')::uuid;
  at_time := coalesce((n->>'resolved_at')::timestamptz,(n->>'created_at')::timestamptz);
  meta := jsonb_build_object('raidId',n->>'id','opponentWallet',n->>'defender_wallet',
   'campaignStage',n->'campaign_stage','stars',n->'result'->'stars');
  SELECT id INTO previous_id FROM raids p WHERE p.attacker_wallet=n->>'defender_wallet'
   AND p.defender_wallet=w AND p.status='resolved' AND p.resolved_at < (n->>'created_at')::timestamptz
   AND p.created_at > (n->>'created_at')::timestamptz
    - make_interval(hours => nullif(current_setting('shardkeep.revenge_lock_hours',true),'')::integer)
   AND p.attacker_base_id=(n->>'defender_base_id')::uuid AND p.defender_base_id=b
   AND EXISTS(SELECT 1 FROM bases ab,bases db WHERE ab.id=b AND ab.owner_wallet=w
    AND db.id=(n->>'defender_base_id')::uuid AND db.owner_wallet=n->>'defender_wallet'
    AND NOT EXISTS(SELECT 1 FROM base_transfers bt WHERE bt.deed_asset_id IN (ab.deed_asset_id,db.deed_asset_id)
     AND bt.created_at>=p.created_at))
   AND coalesce(jsonb_array_length(p.orders->'deploys'),0)+coalesce(jsonb_array_length(p.orders->'heroDeploys'),0)>0
   ORDER BY p.resolved_at DESC,p.id LIMIT 1;
  IF previous_id IS NOT NULL THEN meta := meta || jsonb_build_object('originalAttackId',previous_id); END IF;
  -- Resolution may be worker-delayed: result points are not a fresh player action.
  IF n->>'defender_wallet' IS NULL THEN
   IF n->>'campaign_stage' IS NULL OR coalesce((n->'result'->>'stars')::int,0)>0 THEN k:='pve_battle'; END IF;
  ELSIF n->>'defender_wallet'<>w THEN
   IF coalesce((n->'result'->>'stars')::int,0)>0 THEN k:='pvp_win';
   ELSIF coalesce(n->'result'->>'retreated','false')<>'true' THEN
    PERFORM capture_live_player_action(n->>'defender_wallet','defence_held','raids',n->>'id',at_time,
     (n->>'defender_base_id')::uuid,false,false,meta);
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='item_listings' THEN
  IF TG_OP='INSERT' THEN
   PERFORM capture_live_player_action(n->>'seller_wallet','market_listed',TG_TABLE_NAME,n->>'id',
    (n->>'created_at')::timestamptz,(n->>'base_id')::uuid);
  END IF;
  IF n->>'status'<>'sold' OR o->>'status'='sold' THEN RETURN NEW; END IF;
  k:='market_bought'; w:=n->>'buyer_wallet'; b:=(n->>'buyer_base_id')::uuid;
  at_time:=coalesce((n->>'settled_at')::timestamptz,(n->>'created_at')::timestamptz);
 ELSIF TG_TABLE_NAME IN ('deposits','withdrawals') THEN
  IF TG_TABLE_NAME='deposits' THEN
   IF n->>'status'<>'credited' OR o->>'status'='credited' THEN RETURN NEW; END IF;
   k:=CASE WHEN n->>'kind'='keep_deposit' THEN 'keep_deposit' ELSE 'sol_deposit' END;
   at_time:=coalesce((n->>'finalized_at')::timestamptz,(n->>'created_at')::timestamptz);
  ELSE
   IF n->>'status'<>'sent' OR o->>'status'='sent' THEN RETURN NEW; END IF;
   k:='withdrawal_sent'; at_time:=coalesce((n->>'completed_at')::timestamptz,(n->>'created_at')::timestamptz);
  END IF;
  w:=n->>'player_wallet';
 ELSE
  k:=CASE TG_TABLE_NAME WHEN 'item_uses' THEN 'item_used' WHEN 'global_chat_messages' THEN 'chat_sent' WHEN 'tester_feedback' THEN 'feedback_sent' END;
  w:=coalesce(n->>'player_wallet',n->>'author_wallet',n->>'wallet');
  at_time:=coalesce((n->>'used_at')::timestamptz,(n->>'created_at')::timestamptz);
 END IF;
 IF k IS NOT NULL THEN PERFORM capture_live_player_action(w,k,event_source_table,n->>'id',at_time,b,TG_TABLE_NAME<>'raids',false,meta); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_entries','builder_jobs','quest_progress','base_quest_progress','mail_messages',
 'raid_commands','raids','item_listings','deposits','withdrawals','item_uses','global_chat_messages','tester_feedback'] LOOP
  EXECUTE format('CREATE TRIGGER capture_player_action AFTER INSERT %s ON %I FOR EACH ROW EXECUTE FUNCTION capture_player_action()',
   CASE WHEN t IN ('builder_jobs','quest_progress','base_quest_progress','mail_messages','raids','item_listings','deposits','withdrawals') THEN 'OR UPDATE' ELSE '' END,t);
 END LOOP;
END $$;
--> statement-breakpoint

-- Deed state evidence starts at the migration boundary, not a fabricated mint date.
CREATE FUNCTION capture_deed_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.owner_wallet,NEW.status,NEW.land_paid_at,NEW.deed_asset_id)
  IS NOT DISTINCT FROM (OLD.owner_wallet,OLD.status,OLD.land_paid_at,OLD.deed_asset_id) THEN RETURN NEW; END IF;
 PERFORM capture_live_player_action(n->>'owner_wallet','deed_eligibility','bases',
  n->>'id' || ':' || gen_random_uuid()::text,clock_timestamp(),(n->>'id')::uuid,false,false,
  jsonb_build_object('status',CASE WHEN TG_OP='DELETE' THEN 'deleted' ELSE n->>'status' END,
   'paid',n->>'land_paid_at' IS NOT NULL,'deedAssetId',n->>'deed_asset_id','ownerWallet',n->>'owner_wallet'));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER capture_deed_eligibility AFTER INSERT OR UPDATE OR DELETE ON bases
 FOR EACH ROW EXECUTE FUNCTION capture_deed_eligibility();
--> statement-breakpoint
SELECT record_player_action(b.owner_wallet,'deed_eligibility','bases',b.id::text || ':initial',
 c.started_at,b.id,false,false,jsonb_build_object('status',b.status,'paid',b.land_paid_at IS NOT NULL,
 'deedAssetId',b.deed_asset_id,'ownerWallet',b.owner_wallet))
 FROM bases b CROSS JOIN playtest_activity_coverage c WHERE c.key='authoritative-v1';
--> statement-breakpoint

-- The mutable verifier cache is not closeout history. Retain every observation
-- with its capture boundary and the chain check time as separate provenance.
CREATE FUNCTION capture_deed_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text;
BEGIN
 SELECT owner_wallet INTO actor FROM bases WHERE id=NEW.base_id;
 PERFORM capture_live_player_action(actor,'deed_observation','deed_ownership_observations',
  NEW.id::text || ':' || gen_random_uuid()::text,NEW.checked_at,NEW.base_id,false,false,
  jsonb_build_object('assetId',NEW.asset_id,'owner',NEW.owner,'slot',NEW.slot::text,
   'status',NEW.status,'checkedAt',NEW.checked_at));
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER capture_deed_observation AFTER INSERT OR UPDATE ON deed_ownership_observations
 FOR EACH ROW EXECUTE FUNCTION capture_deed_observation();
--> statement-breakpoint
SELECT record_player_action(b.owner_wallet,'deed_observation','deed_ownership_observations',o.id::text || ':initial',
 c.started_at,b.id,false,false,jsonb_build_object('assetId',o.asset_id,'owner',o.owner,'slot',o.slot::text,
 'status',o.status,'checkedAt',o.checked_at,'sourceOccurredAt',o.checked_at))
 FROM deed_ownership_observations o JOIN bases b ON b.id=o.base_id
 CROSS JOIN playtest_activity_coverage c WHERE c.key='authoritative-v1';
--> statement-breakpoint

-- Migration source: registered in 0114_open_playtest_campaigns.sql.
CREATE TABLE playtest_campaigns (id text PRIMARY KEY, kind text NOT NULL UNIQUE CHECK(kind IN ('founding','rewarded')), start_at timestamptz, end_at timestamptz, registration_open boolean NOT NULL DEFAULT false, cancelled_at timestamptz, finalized_at timestamptz, reconciled_at timestamptz, snapshot_at timestamptz, revision integer NOT NULL DEFAULT 1 CHECK(revision > 0), created_at timestamptz NOT NULL DEFAULT now(), CHECK((start_at IS NULL AND end_at IS NULL) OR (start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)));
--> statement-breakpoint
CREATE TABLE playtest_participants (campaign_id text NOT NULL REFERENCES playtest_campaigns(id), wallet text NOT NULL REFERENCES players(wallet), joined_at timestamptz NOT NULL DEFAULT now(), disqualified_at timestamptz, disqualification_reason text, bonus_at timestamptz, PRIMARY KEY(campaign_id,wallet));
--> statement-breakpoint
CREATE TABLE playtest_campaign_days (campaign_id text NOT NULL REFERENCES playtest_campaigns(id), wallet text NOT NULL REFERENCES players(wallet), day text NOT NULL, key text NOT NULL, count integer NOT NULL CHECK(count >= 0), points integer NOT NULL CHECK(points >= 0), achieved_at timestamptz NOT NULL, evidence jsonb NOT NULL, PRIMARY KEY(campaign_id,wallet,day,key));
--> statement-breakpoint
CREATE TABLE playtest_mint_evidence (asset_id text PRIMARY KEY, original_wallet text, confirmed_at timestamptz, slot text, transaction_index integer, signature text, verified_at timestamptz, error text, CHECK(verified_at IS NULL OR (original_wallet IS NOT NULL AND confirmed_at IS NOT NULL AND slot IS NOT NULL AND slot ~ '^[0-9]+$' AND transaction_index IS NOT NULL AND transaction_index >= 0 AND signature IS NOT NULL AND error IS NULL)));
--> statement-breakpoint
CREATE TABLE playtest_founders (wallet text PRIMARY KEY, position integer NOT NULL UNIQUE, username text NOT NULL, asset_id text NOT NULL REFERENCES playtest_mint_evidence(asset_id), evidence jsonb NOT NULL, snapshot_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE TABLE playtest_submissions (id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES playtest_campaigns(id), wallet text NOT NULL REFERENCES players(wallet), kind text NOT NULL, report_id text, url text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,report_id), CHECK((kind='video' AND url IS NOT NULL AND report_id IS NULL) OR (kind='report' AND report_id IS NOT NULL AND url IS NULL)));
--> statement-breakpoint
CREATE TABLE playtest_awards (campaign_id text NOT NULL REFERENCES playtest_campaigns(id), prize_id text NOT NULL, wallet text NOT NULL, username text NOT NULL, amount_usd integer NOT NULL, category text NOT NULL, evidence jsonb NOT NULL, decided_at timestamptz NOT NULL, paid_at timestamptz, payment_reference text, PRIMARY KEY(campaign_id,prize_id), UNIQUE(campaign_id,wallet,category));
--> statement-breakpoint
CREATE TABLE playtest_campaign_audit (campaign_id text NOT NULL REFERENCES playtest_campaigns(id), request_id text NOT NULL, actor text NOT NULL, action text NOT NULL, request_hash text NOT NULL, revision integer NOT NULL, detail jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(campaign_id,request_id));
--> statement-breakpoint
CREATE INDEX playtest_campaign_audit_revision_idx ON playtest_campaign_audit(campaign_id,revision);
--> statement-breakpoint
CREATE TABLE playtest_campaign_scores (campaign_id text NOT NULL REFERENCES playtest_campaigns(id), wallet text NOT NULL REFERENCES players(wallet), username text NOT NULL, points integer NOT NULL, active_days integer NOT NULL, longest_streak integer NOT NULL, revenge integer NOT NULL, stages integer NOT NULL, achieved_at timestamptz NOT NULL, eligible boolean NOT NULL, evidence jsonb NOT NULL, PRIMARY KEY(campaign_id,wallet), CHECK(points>=0 AND active_days>=0 AND longest_streak>=0 AND revenge>=0 AND stages>=0));
--> statement-breakpoint
CREATE TABLE playtest_mint_inventory (id text PRIMARY KEY, through_slot text NOT NULL CHECK(through_slot ~ '^[0-9]+$'), asset_count integer NOT NULL CHECK(asset_count>=0), completed_at timestamptz NOT NULL);
--> statement-breakpoint
CREATE TABLE playtest_close_deed_evidence (campaign_id text NOT NULL REFERENCES playtest_campaigns(id), asset_id text NOT NULL, owner_at_close text, through_slot text, verified_at timestamptz, error text, evidence jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(campaign_id,asset_id), CHECK(verified_at IS NULL OR (owner_at_close IS NOT NULL AND through_slot IS NOT NULL AND through_slot ~ '^[0-9]+$' AND error IS NULL)));
--> statement-breakpoint
