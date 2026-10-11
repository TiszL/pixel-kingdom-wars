-- D153.181 private matchmaking source. Additive hooks preserve ordinary raid
-- runtime: its actual participant/base locks govern the count witness.
SET LOCAL lock_timeout='10s';
DO $preflight$DECLARE tab text;any_found boolean:=false;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_tournament_raid_requests','charter_tournament_raid_cancellations','charter_tournament_raid_admissions','charter_tournament_raid_outcomes','charter_tournament_raid_replays','charter_tournament_prestart_retreats','charter_tournament_raid_contract'] LOOP IF to_regclass('public.'||tab) IS NOT NULL THEN any_found:=true;END IF;END LOOP;
 IF any_found THEN
  FOREACH tab IN ARRAY ARRAY['charter_tournament_raid_requests','charter_tournament_raid_cancellations','charter_tournament_raid_admissions','charter_tournament_raid_outcomes','charter_tournament_raid_replays','charter_tournament_prestart_retreats','charter_tournament_raid_contract'] LOOP IF to_regclass('public.'||tab) IS NULL THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SCHEMA';END IF;END LOOP;
  IF to_regprocedure('public.shardkeep_charter_tournament_raid_contract()') IS NULL OR to_regprocedure('public.shardkeep_charter_tournament_raid_source()') IS NULL THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SCHEMA';END IF;
  PERFORM public.shardkeep_charter_tournament_raid_source();
 END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.charter_tournament_raid_requests(
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES public.charter_tournament_events(id),actor text NOT NULL REFERENCES public.players(wallet),
 base_id uuid NOT NULL REFERENCES public.bases(id),command_id uuid NOT NULL,private_key uuid NOT NULL UNIQUE,raid_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),entry jsonb NOT NULL,tx_key text NOT NULL,UNIQUE(event_id,actor,command_id)
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_raid_cancellations(
 request_id uuid PRIMARY KEY REFERENCES public.charter_tournament_raid_requests(id),actor text NOT NULL,original_request jsonb NOT NULL,
 cancelled_at timestamptz NOT NULL CHECK(isfinite(cancelled_at)),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_raid_admissions(
 request_id uuid PRIMARY KEY REFERENCES public.charter_tournament_raid_requests(id),raid_id uuid NOT NULL UNIQUE REFERENCES public.raids(id),
 event_id uuid NOT NULL REFERENCES public.charter_tournament_events(id),actor text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),
 original_raid jsonb NOT NULL,count_witness jsonb NOT NULL,entry jsonb NOT NULL,tx_key text NOT NULL,UNIQUE(event_id,actor,ordinal)
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_raid_outcomes(
 raid_id uuid PRIMARY KEY REFERENCES public.charter_tournament_raid_admissions(raid_id),original_terminal jsonb NOT NULL,retreat jsonb,live_state jsonb,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_raid_replays(
 raid_id uuid PRIMARY KEY REFERENCES public.charter_tournament_raid_outcomes(raid_id),original_terminal jsonb NOT NULL,input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),
 stars integer NOT NULL CHECK(stars>=0),destruction integer NOT NULL CHECK(destruction>=0),completed boolean NOT NULL,record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_raid_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
-- D181: normal V2 retreat resolves before simulation. Preserve the original
-- transition and accepted clock separately; mutable reconnect rows are not
-- historical authority. The earlier started/expired and loot checks remain.
CREATE TABLE IF NOT EXISTS public.charter_tournament_prestart_retreats(
 raid_id uuid PRIMARY KEY REFERENCES public.raids(id),source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),
 before_raid jsonb NOT NULL,after_raid jsonb NOT NULL,retreat jsonb NOT NULL,live_state jsonb NOT NULL,tx_key text NOT NULL
);
CREATE OR REPLACE FUNCTION public.shardkeep_charter_prestart_retreat_shape(before_row jsonb,after_row jsonb,retreat jsonb,live_state jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT coalesce(before_row->>'status'='pending_orders' AND after_row->>'status'='resolved'
 AND before_row-ARRAY['status','orders','result','events','simulation_lease_token','simulation_lease_until','simulation_system_attempted_at','resolved_at']
  =after_row-ARRAY['status','orders','result','events','simulation_lease_token','simulation_lease_until','simulation_system_attempted_at','resolved_at']
 AND before_row->>'result' IS NULL AND before_row->>'resolved_at' IS NULL
 AND after_row->'result'='{"stars":0,"destructionPct":0,"keepDestroyed":false,"lootShards":0,"attackerTrophyDelta":0,"defenderTrophyDelta":0,"retreated":true}'::jsonb
 AND after_row->'events'='[]'::jsonb AND after_row->'orders'->'retreated'='true'::jsonb
 AND after_row->'orders'->>'idempotencyKey'='live-finish:'||(after_row->>'id')
 AND after_row->>'simulation_lease_token' IS NULL AND after_row->>'simulation_lease_until' IS NULL AND after_row->>'simulation_system_attempted_at' IS NULL
 AND live_state->>'raid_id'=after_row->>'id' AND live_state->'command_protocol_version'='2'::jsonb
 AND live_state->>'started_at' IS NULL AND live_state->>'battle_ends_at' IS NULL
 AND live_state->>'clock_anchor_wall_at' IS NULL AND live_state->>'clock_anchor_sim_ms' IS NULL
 AND retreat->>'raid_id'=after_row->>'id' AND retreat->>'kind'='retreat'
 AND retreat->'sequence'=live_state->'last_sequence' AND retreat->'server_offset_ms'='0'::jsonb
 AND retreat->'payload'->'_clock'->'protocolVersion'='2'::jsonb AND retreat->'payload'->'_clock'->'simNowMs'='0'::jsonb
 AND retreat->'payload'->'_clock'->>'anchorWallAt' IS NULL AND retreat->'payload'->'_clock'->>'battleEndsAt' IS NULL
 AND (retreat->>'accepted_at')::timestamptz=(after_row->>'resolved_at')::timestamptz
 AND (retreat->>'accepted_at')::timestamptz=(live_state->>'stream_closed_at')::timestamptz
 AND (retreat->>'accepted_at')::timestamptz=(live_state->>'updated_at')::timestamptz
 AND (retreat->>'accepted_at')::timestamptz=(retreat->'payload'->'_clock'->>'serverNow')::timestamptz
 AND (retreat->>'accepted_at')::timestamptz>=(before_row->>'created_at')::timestamptz,false)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_prestart_retreat(rid uuid,before_row jsonb,after_row jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE w public.charter_tournament_prestart_retreats;BEGIN
 SELECT * INTO w FROM public.charter_tournament_prestart_retreats WHERE raid_id=rid;
 IF NOT FOUND THEN RETURN false;END IF;
 IF (SELECT record FROM public.charter_tournament_raid_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_charter_tournament_raid_contract()
 THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_RAID_SOURCE';END IF;
 RETURN w.before_raid=before_row AND w.after_raid=after_row
  AND public.shardkeep_charter_prestart_retreat_shape(w.before_raid,w.after_raid,w.retreat,w.live_state);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_prestart_retreat_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF TG_RELID<>'public.charter_tournament_prestart_retreats'::regclass
  OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'charter_tournament_prestart_retreats_no_truncate' ELSE 'charter_tournament_prestart_retreats_guard' END)
  OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>(CASE WHEN TG_OP='TRUNCATE' THEN 'STATEMENT' ELSE 'ROW' END) OR TG_NARGS<>0
 THEN RAISE EXCEPTION 'CHARTER_PRESTART_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CHARTER_PRESTART_IMMUTABLE';END IF;
 IF pg_trigger_depth()<>2 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.raids'::regclass AND tgname='raids_aa_charter_prestart_retreat'
   AND tgfoid='public.shardkeep_charter_prestart_retreat_capture()'::regprocedure AND tgenabled='O')
 THEN RAISE EXCEPTION 'CHARTER_PRESTART_ORIGIN';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.raids r JOIN public.clan_charter_raid_events e ON e.raid_id=r.id
  JOIN public.charter_sale_raid_admissions a ON a.raid_id=r.id
  WHERE r.id=NEW.raid_id AND e.source_id=NEW.source_id AND to_jsonb(r)=NEW.before_raid
  AND a.original_raid-ARRAY['status','orders','result','events','simulation_lease_token','simulation_lease_until','simulation_system_attempted_at','resolved_at']
   =NEW.before_raid-ARRAY['status','orders','result','events','simulation_lease_token','simulation_lease_until','simulation_system_attempted_at','resolved_at'])
  OR NOT EXISTS(SELECT 1 FROM public.raid_live_states l WHERE l.raid_id=NEW.raid_id AND to_jsonb(l)=NEW.live_state)
  OR NOT EXISTS(SELECT 1 FROM public.raid_commands c WHERE c.raid_id=NEW.raid_id AND to_jsonb(c)=NEW.retreat)
  OR NOT public.shardkeep_charter_prestart_retreat_shape(NEW.before_raid,NEW.after_raid,NEW.retreat,NEW.live_state)
 THEN RAISE EXCEPTION 'CHARTER_PRESTART_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_prestart_retreat_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE source uuid;retreat jsonb;live_state jsonb;BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raids_aa_charter_prestart_retreat' OR TG_WHEN<>'BEFORE'
  OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN RAISE EXCEPTION 'CHARTER_PRESTART_TRIGGER';END IF;
 IF OLD.status<>'pending_orders' OR NEW.status<>'resolved' THEN RETURN NEW;END IF;
 -- B6a-only observation never enrolled original D176 raid inputs. Preserve its
 -- former writer behavior; the unchanged old tithe guards still hold history
 -- that lacks a canonical original admission and terminal proof.
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_raid_admissions WHERE raid_id=OLD.id) THEN RETURN NEW;END IF;
 SELECT source_id INTO source FROM public.clan_charter_raid_events WHERE raid_id=OLD.id;
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
  OR (SELECT record FROM public.charter_tournament_raid_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_charter_tournament_raid_contract()
 THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_RAID_SOURCE';END IF;
 SELECT to_jsonb(l) INTO live_state FROM public.raid_live_states l WHERE l.raid_id=OLD.id;
 SELECT to_jsonb(c) INTO retreat FROM public.raid_commands c WHERE c.raid_id=OLD.id AND c.sequence=(live_state->>'last_sequence')::integer;
 IF NOT public.shardkeep_charter_prestart_retreat_shape(to_jsonb(OLD),to_jsonb(NEW),retreat,live_state)
 THEN RAISE EXCEPTION 'CHARTER_PRESTART_SOURCE';END IF;
 INSERT INTO public.charter_tournament_prestart_retreats VALUES(OLD.id,source,to_jsonb(OLD),to_jsonb(NEW),retreat,live_state,pg_current_xact_id()::text);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_terminal_witness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE parent_oid oid;parent_name text;writer_oid oid;
BEGIN
 IF TG_RELID NOT IN('public.clan_charter_loot_posts'::regclass,'public.clan_charter_loot_entries'::regclass,'public.clan_charter_chest_updates'::regclass,'public.clan_charter_raid_terminals'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) OR pg_trigger_depth()<>2 OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_ORIGIN' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 IF TG_TABLE_NAME='clan_charter_loot_posts' THEN
  parent_oid:='public.ledger_transactions'::regclass;parent_name:='ledger_transactions_clan_charter_loot';writer_oid:='public.shardkeep_clan_charter_capture_loot()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN public.clan_charter_raid_events e ON e.raid_id=NEW.raid_id WHERE t.id=NEW.ledger_id AND e.source_id=NEW.source_id
   AND t.type='raid.loot' AND t.idempotency_key='raid:'||e.raid_id::text||':loot' AND to_jsonb(t)=NEW.original_transaction) THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 ELSIF TG_TABLE_NAME='clan_charter_loot_entries' THEN
  parent_oid:='public.ledger_entries'::regclass;parent_name:='ledger_entries_clan_charter_loot';writer_oid:='public.shardkeep_clan_charter_capture_loot()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id JOIN public.clan_charter_loot_posts p ON p.ledger_id=e.txn_id
   WHERE e.id=NEW.entry_id AND p.ledger_id=NEW.ledger_id AND p.tx_key=NEW.tx_key AND to_jsonb(e)=NEW.original_entry AND to_jsonb(a)-'balance'=NEW.account_identity)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 ELSIF TG_TABLE_NAME='clan_charter_chest_updates' THEN
  parent_oid:='public.clans'::regclass;parent_name:='clans_clan_charter_chest';writer_oid:='public.shardkeep_clan_charter_capture_chest()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.clans c WHERE c.id=NEW.actual_clan_id AND to_jsonb(c)=NEW.after_clan)
   OR NEW.before_clan->>'id' IS DISTINCT FROM NEW.after_clan->>'id'
   OR (NEW.after_clan->>'chest_shards')::bigint-(NEW.before_clan->>'chest_shards')::bigint IS DISTINCT FROM NEW.delta
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 ELSE
  parent_oid:='public.raids'::regclass;parent_name:='raids_clan_charter_terminal';writer_oid:='public.shardkeep_clan_charter_capture_terminal()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.raids r JOIN public.clan_charter_raid_events e ON e.raid_id=r.id WHERE r.id=NEW.raid_id AND e.source_id=NEW.source_id AND to_jsonb(r)=NEW.after_raid)
   OR NEW.before_raid->>'id' IS DISTINCT FROM NEW.raid_id::text OR NEW.after_raid->>'status' IS DISTINCT FROM NEW.terminal_status
   OR NOT((NEW.before_raid->>'status'='resolving' AND NEW.terminal_status='resolved') OR(NEW.before_raid->>'status'='pending_orders' AND NEW.terminal_status='expired') OR public.shardkeep_charter_prestart_retreat(NEW.raid_id,NEW.before_raid,NEW.after_raid))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=parent_oid AND tgname=parent_name AND tgfoid=writer_oid AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_ORIGIN' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_capture_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE event public.clan_charter_raid_events%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raids_clan_charter_terminal' OR TG_WHEN<>'AFTER' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_capture_terminal()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF NOT((OLD.status='resolving' AND NEW.status='resolved') OR(OLD.status='pending_orders' AND NEW.status='expired') OR public.shardkeep_charter_prestart_retreat(NEW.id,to_jsonb(OLD),to_jsonb(NEW))) THEN RETURN NULL;END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 SELECT * INTO event FROM public.clan_charter_raid_events WHERE raid_id=NEW.id;IF NOT FOUND THEN RETURN NULL;END IF;
 IF(OLD.id,OLD.attacker_wallet,OLD.attacker_base_id,OLD.defender_wallet,OLD.defender_base_id,OLD.pve_camp_id,OLD.campaign_stage,OLD.created_at)
 IS DISTINCT FROM(event.raid_id,event.attacker_wallet,event.attacker_base_id,event.defender_wallet,event.defender_base_id,event.pve_camp_id,event.campaign_stage,event.admitted_at)
 OR(NEW.id,NEW.attacker_wallet,NEW.attacker_base_id,NEW.defender_wallet,NEW.defender_base_id,NEW.pve_camp_id,NEW.campaign_stage,NEW.created_at)
 IS DISTINCT FROM(event.raid_id,event.attacker_wallet,event.attacker_base_id,event.defender_wallet,event.defender_base_id,event.pve_camp_id,event.campaign_stage,event.admitted_at)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 INSERT INTO public.clan_charter_raid_terminals VALUES(NEW.id,event.source_id,pg_current_xact_id()::text,to_jsonb(OLD),to_jsonb(NEW),NEW.status::text);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE previous jsonb;next jsonb;ids uuid[];rid uuid;clan uuid;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass,'public.raids'::regclass,'public.clans'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_clan_charter_raid_chest_truncate' ELSE '_clan_charter_raid_chest' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF TG_OP='TRUNCATE' THEN
  -- Empty-only test reset may temporarily disable private retention guards.
  -- No captured history is removable, even when that catalog is incomplete.
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_events WHERE tithe_rule_id IS NOT NULL)
   OR(TG_TABLE_NAME='clans' AND EXISTS(SELECT 1 FROM public.clan_charter_raid_events))
   OR(TG_TABLE_NAME='raids' AND EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;RETURN NULL;
 END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 previous:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
 next:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
 IF TG_OP='UPDATE' AND(previous=next OR(TG_TABLE_NAME='accounts' AND previous-'balance'=next-'balance')) THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='clans' THEN
  -- Deletion/rekey uses the caller's clan tuple lock, never a blocking money
  -- or raid lock. Admission and settlement use this same mutex with NOWAIT.
  -- Historical B6a events without a rule remain held here, including ones
  -- whose narrower B6b observation is readable; no retrospective rate proof.
  IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id) THEN
   FOR rid IN SELECT e.raid_id FROM public.clan_charter_raid_events e WHERE e.original_clan_id=OLD.id ORDER BY e.raid_id LOOP
    IF public.shardkeep_clan_charter_raid_chest_proof(rid,true)->>'status' IS DISTINCT FROM 'reconciled'
    THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PENDING';END IF;
   END LOOP;
  END IF;
  IF TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id AND EXISTS(SELECT 1 FROM public.clan_charter_raid_chest_heads WHERE clan_id=OLD.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 ids:=public.shardkeep_clan_charter_raid_chest_affected(TG_TABLE_NAME,previous)||public.shardkeep_clan_charter_raid_chest_affected(TG_TABLE_NAME,next);
 FOR rid IN SELECT DISTINCT id FROM unnest(ids) id ORDER BY id LOOP
  PERFORM 1 FROM public.clan_charter_raid_events WHERE raid_id=rid FOR UPDATE NOWAIT;
  SELECT original_clan_id INTO clan FROM public.clan_charter_raid_events WHERE raid_id=rid;
  -- A raid-only status change owns the event mutex; its unfinished proof
  -- already prevents dissolution. Money sources additionally own the clan.
  IF clan IS NOT NULL AND TG_TABLE_NAME<>'raids' THEN PERFORM 1 FROM public.clans WHERE id=clan FOR UPDATE NOWAIT;END IF;
  -- Once committed, canonical raw facts are immutable. Ordinary cache balance
  -- updates returned above; unrelated postings never enter this affected set.
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_terminals t WHERE t.raid_id=rid AND t.tx_key<>pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  -- Only actual source transitions can acquire a terminal witness. A TEMP
  -- wrapper cannot supply a fictional predecessor after a direct status jump.
  IF TG_TABLE_NAME='raids' THEN
   IF TG_OP='UPDATE' THEN
    IF NEW.status IN('resolved','expired') AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT((OLD.status='resolving' AND NEW.status='resolved') OR(OLD.status='pending_orders' AND NEW.status='expired') OR public.shardkeep_charter_prestart_retreat(NEW.id,to_jsonb(OLD),to_jsonb(NEW)))
    THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
   END IF;
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='raids' THEN
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
   IF TG_OP='UPDATE' THEN
    IF(OLD.status IN('resolved','expired') AND NEW.status IN('pending_orders','resolving'))
     OR(OLD.id,OLD.attacker_wallet,OLD.attacker_base_id,OLD.defender_wallet,OLD.defender_base_id,OLD.pve_camp_id,OLD.campaign_stage,OLD.created_at)
      IS DISTINCT FROM(NEW.id,NEW.attacker_wallet,NEW.attacker_base_id,NEW.defender_wallet,NEW.defender_base_id,NEW.pve_camp_id,NEW.campaign_stage,NEW.created_at)
    THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_proof(rid uuid,terminal_required boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.clan_charter_raid_events%ROWTYPE;r public.raids%ROWTYPE;rule public.clan_charter_raid_tithe_rules%ROWTYPE;
 h public.clan_charter_raid_chest_heads%ROWTYPE;t public.clan_charter_raid_terminals%ROWTYPE;p public.clan_charter_loot_posts%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;ids uuid[];credits bigint;entries bigint;attack bigint;defend bigint;pool bigint;
 sum_delta numeric;gross numeric;net numeric;cut numeric;expected_cut numeric;valid boolean;current_clan jsonb;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RETURN jsonb_build_object('status','held','reason','hooks_missing');END IF;
 SELECT * INTO e FROM public.clan_charter_raid_events WHERE raid_id=rid;
 IF NOT FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source) THEN RETURN jsonb_build_object('status','unenrolled');END IF;
  RETURN jsonb_build_object('status','held','reason','admission_missing');
 END IF;
 SELECT * INTO r FROM public.raids WHERE id=rid;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=e.source_id)
 OR(e.attacker_wallet,e.attacker_base_id,e.defender_wallet,e.defender_base_id,e.pve_camp_id,e.campaign_stage,e.admitted_at)
 IS DISTINCT FROM(r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,r.pve_camp_id,r.campaign_stage,r.created_at)
 OR e.kind IS DISTINCT FROM(CASE WHEN r.campaign_stage IS NOT NULL THEN 'campaign' WHEN r.pve_camp_id IS NOT NULL THEN 'pve'
   WHEN r.attacker_base_id IS NOT NULL AND r.defender_base_id IS NOT NULL THEN 'deed_pvp' ELSE 'legacy_pvp' END)
 OR num_nonnulls(e.defender_wallet,e.pve_camp_id,e.campaign_stage)<>1 OR e.defender_wallet=e.attacker_wallet
 OR(e.defender_base_id IS NOT NULL AND e.defender_wallet IS NULL) OR e.campaign_stage<=0
 OR(e.original_clan_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clan_charter_event_heads x WHERE x.clan_id=e.original_clan_id
  AND x.ordinal=(SELECT count(*) FROM public.clan_charter_raid_events n WHERE n.original_clan_id=e.original_clan_id)
  AND x.ordinal=(SELECT max(clan_ordinal) FROM public.clan_charter_raid_events n WHERE n.original_clan_id=e.original_clan_id)))
 THEN RETURN jsonb_build_object('status','held','reason','admission_mismatch');END IF;
 IF e.tithe_rule_id IS NULL THEN RETURN jsonb_build_object('status','held','reason','rule_missing');END IF;
 SELECT * INTO rule FROM public.clan_charter_raid_tithe_rules WHERE id=e.tithe_rule_id AND source_id=e.source_id;
 IF NOT FOUND OR rule.version<>1 OR rule.rate_source<>'CLANS.chestTitheBps' OR rule.tithe_bps<0 OR rule.basis_points<=rule.tithe_bps
 OR e.chest_admission_tx IS NULL THEN RETURN jsonb_build_object('status','held','reason','rule_mismatch');END IF;
 IF e.original_clan_id IS NOT NULL THEN
  SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=e.original_clan_id;
  SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=e.original_clan_id;
  IF h.clan_id IS NULL OR h.rule_id IS DISTINCT FROM rule.id
   OR NOT(EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
    AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id) OR(h.first_raid_id IS NULL AND EXISTS(SELECT 1 FROM public.charter_sale_births b
   JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id
   WHERE b.clan_id=h.clan_id AND ep.rule_id=h.rule_id AND ep.source_id=e.source_id AND ci.epoch_id=b.epoch_id AND ci.tx_key=b.tx_key)))
  THEN RETURN jsonb_build_object('status','held','reason','head_mismatch');END IF;
 END IF;
 SELECT * INTO t FROM public.clan_charter_raid_terminals WHERE raid_id=rid;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO ids FROM(
  SELECT ledger_id id FROM public.clan_charter_loot_posts WHERE raid_id=rid
  UNION SELECT id FROM public.ledger_transactions WHERE idempotency_key='raid:'||rid::text||':loot'
   OR(type='raid.loot' AND metadata->>'raidId'=rid::text)) found;
 IF t.raid_id IS NULL THEN
  IF NOT terminal_required AND cardinality(ids)=0 AND r.status IN('pending_orders','resolving') THEN RETURN jsonb_build_object('status','pending');END IF;
  RETURN jsonb_build_object('status','held','reason','terminal_missing');
 END IF;
 IF t.source_id IS DISTINCT FROM e.source_id OR t.after_raid IS DISTINCT FROM to_jsonb(r)
 OR t.after_raid->>'status' IS DISTINCT FROM t.terminal_status OR t.before_raid->>'id' IS DISTINCT FROM rid::text
 OR NOT((t.terminal_status='resolved' AND t.before_raid->>'status'='resolving' AND r.resolved_at IS NOT NULL)
  OR(t.terminal_status='expired' AND t.before_raid->>'status'='pending_orders') OR public.shardkeep_charter_prestart_retreat(rid,t.before_raid,t.after_raid))
 OR jsonb_build_array(t.before_raid->'attacker_wallet',t.before_raid->'attacker_base_id',t.before_raid->'defender_wallet',t.before_raid->'defender_base_id',t.before_raid->'pve_camp_id',t.before_raid->'campaign_stage',t.before_raid->'created_at')
  IS DISTINCT FROM jsonb_build_array(t.after_raid->'attacker_wallet',t.after_raid->'attacker_base_id',t.after_raid->'defender_wallet',t.after_raid->'defender_base_id',t.after_raid->'pve_camp_id',t.after_raid->'campaign_stage',t.after_raid->'created_at')
 THEN RETURN jsonb_build_object('status','held','reason','terminal_mismatch');END IF;
 SELECT count(*) INTO credits FROM public.clan_charter_chest_updates c WHERE c.ledger_id=ANY(ids)
  OR c.candidate_ledger_ids&&ids OR(c.tx_key=t.tx_key AND c.ledger_id IS NULL);
 IF cardinality(ids)=0 THEN
  IF credits<>0 OR(t.terminal_status='resolved' AND e.kind='legacy_pvp' AND t.after_raid->'result'->>'lootShards' IS DISTINCT FROM '0')
  THEN RETURN jsonb_build_object('status','held','reason','loot_missing');END IF;
  cut:=0;
 ELSE
  IF cardinality(ids)<>1 OR e.kind<>'legacy_pvp' OR t.terminal_status<>'resolved' THEN RETURN jsonb_build_object('status','held','reason','unexpected_loot');END IF;
  SELECT * INTO p FROM public.clan_charter_loot_posts WHERE ledger_id=ids[1];
  IF NOT FOUND OR p.raid_id IS DISTINCT FROM rid OR p.source_id IS DISTINCT FROM e.source_id OR p.tx_key IS DISTINCT FROM t.tx_key
   OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions actual WHERE actual.id=p.ledger_id AND actual.type='raid.loot'
    AND actual.idempotency_key='raid:'||rid::text||':loot' AND to_jsonb(actual)=p.original_transaction)
  THEN RETURN jsonb_build_object('status','held','reason','loot_mismatch');END IF;
  WITH all_ids AS(SELECT entry_id id FROM public.clan_charter_loot_entries WHERE ledger_id=p.ledger_id
    UNION SELECT id FROM public.ledger_entries WHERE txn_id=p.ledger_id), legs AS(
   SELECT actual.delta,a.kind,a.owner_wallet,a.currency,a.base_id,
    (saved.ledger_id=p.ledger_id AND saved.tx_key=p.tx_key AND saved.original_entry=to_jsonb(actual)
     AND saved.account_identity=to_jsonb(a)-'balance' AND actual.txn_id=p.ledger_id) okay
   FROM all_ids LEFT JOIN public.ledger_entries actual ON actual.id=all_ids.id
    LEFT JOIN public.accounts a ON a.id=actual.account_id LEFT JOIN public.clan_charter_loot_entries saved ON saved.entry_id=all_ids.id)
  SELECT count(*),bool_and(coalesce(okay,false) AND currency='SHARDS' AND base_id IS NULL),sum(delta),
   count(*) FILTER(WHERE kind='player_shards' AND owner_wallet=e.attacker_wallet AND delta>0),
   count(*) FILTER(WHERE kind='player_shards' AND owner_wallet=e.defender_wallet AND delta<0),
   count(*) FILTER(WHERE kind='clan_chest' AND owner_wallet IS NULL AND delta>0),
   sum(delta) FILTER(WHERE kind='player_shards' AND owner_wallet=e.attacker_wallet AND delta>0),
   -sum(delta) FILTER(WHERE kind='player_shards' AND owner_wallet=e.defender_wallet AND delta<0),
   coalesce(sum(delta) FILTER(WHERE kind='clan_chest' AND owner_wallet IS NULL AND delta>0),0)
  INTO entries,valid,sum_delta,attack,defend,pool,net,gross,cut FROM legs;
  expected_cut:=CASE WHEN e.original_clan_id IS NULL THEN 0 ELSE floor(gross*rule.tithe_bps/rule.basis_points) END;
  IF valid IS DISTINCT FROM true OR entries NOT IN(2,3) OR attack<>1 OR defend<>1 OR pool>1 OR entries<>attack+defend+pool
   OR sum_delta IS DISTINCT FROM 0::numeric OR cut IS DISTINCT FROM expected_cut
   OR t.after_raid->'result'->>'lootShards' IS DISTINCT FROM net::text
   OR p.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('raidId',rid::text,'attacker',e.attacker_wallet,'defender',e.defender_wallet,'clanChest',cut::text)
  THEN RETURN jsonb_build_object('status','held','reason','loot_conservation');END IF;
  IF cut=0 THEN
   IF credits<>0 OR entries<>2 THEN RETURN jsonb_build_object('status','held','reason','unexpected_credit');END IF;
  ELSE
   SELECT * INTO w FROM public.clan_charter_chest_updates WHERE ledger_id=p.ledger_id;
   IF credits<>1 OR w.id IS NULL OR w.actual_clan_id IS DISTINCT FROM e.original_clan_id OR w.source_id IS DISTINCT FROM e.source_id
    OR w.tx_key IS DISTINCT FROM p.tx_key OR w.delta IS DISTINCT FROM cut OR w.pairing IS DISTINCT FROM 'matched'
    OR w.candidate_ledger_ids IS DISTINCT FROM ARRAY[p.ledger_id] OR w.chest_predecessor_revision IS NULL
    OR w.chest_predecessor_revision>=h.revision OR w.before_clan->>'id' IS DISTINCT FROM e.original_clan_id::text
    OR w.after_clan->>'id' IS DISTINCT FROM e.original_clan_id::text
    OR w.before_clan-'chest_shards' IS DISTINCT FROM w.after_clan-'chest_shards'
    OR (w.after_clan->>'chest_shards')::bigint-(w.before_clan->>'chest_shards')::bigint IS DISTINCT FROM w.delta
   THEN RETURN jsonb_build_object('status','held','reason','credit_mismatch');END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('status','reconciled','raidId',rid,'originalClanId',e.original_clan_id,'ruleId',rule.id,
  'terminalStatus',t.terminal_status,'chestShards',cut::text);
END $$;

DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.raids'::regclass AND tgname='raids_aa_charter_prestart_retreat') THEN
  CREATE TRIGGER raids_aa_charter_prestart_retreat BEFORE UPDATE ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_prestart_retreat_capture();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_tournament_prestart_retreats'::regclass AND tgname='charter_tournament_prestart_retreats_guard') THEN
  CREATE TRIGGER charter_tournament_prestart_retreats_guard BEFORE INSERT OR UPDATE OR DELETE ON public.charter_tournament_prestart_retreats FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_prestart_retreat_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_tournament_prestart_retreats'::regclass AND tgname='charter_tournament_prestart_retreats_no_truncate') THEN
  CREATE TRIGGER charter_tournament_prestart_retreats_no_truncate BEFORE TRUNCATE ON public.charter_tournament_prestart_retreats FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_prestart_retreat_guard();END IF;
END $$;
REVOKE ALL ON TABLE public.charter_tournament_prestart_retreats FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_charter_prestart_retreat_shape(jsonb,jsonb,jsonb,jsonb),public.shardkeep_charter_prestart_retreat(uuid,jsonb,jsonb),public.shardkeep_charter_prestart_retreat_guard(),public.shardkeep_charter_prestart_retreat_capture() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_raid_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['charter_tournament_raid_requests','charter_tournament_raid_cancellations','charter_tournament_raid_admissions','charter_tournament_raid_outcomes','charter_tournament_raid_replays','charter_tournament_prestart_retreats','charter_tournament_raid_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_charter_tournament_raid_contract','shardkeep_charter_tournament_raid_source','shardkeep_charter_tournament_raid_guard','shardkeep_charter_tournament_raid_capture','shardkeep_charter_tournament_scores','shardkeep_charter_prestart_retreat_shape','shardkeep_charter_prestart_retreat','shardkeep_charter_prestart_retreat_guard','shardkeep_charter_prestart_retreat_capture','shardkeep_clan_charter_terminal_witness_guard','shardkeep_clan_charter_capture_terminal','shardkeep_clan_charter_raid_chest_source','shardkeep_clan_charter_raid_chest_proof'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgname IN('raids_charter_tournament_capture','raids_aa_charter_prestart_retreat','raids_clan_charter_terminal','raids_clan_charter_raid_chest') OR t.tgrelid=ANY(ARRAY['public.charter_tournament_raid_requests'::regclass,'public.charter_tournament_raid_cancellations'::regclass,'public.charter_tournament_raid_admissions'::regclass,'public.charter_tournament_raid_outcomes'::regclass,'public.charter_tournament_raid_replays'::regclass,'public.charter_tournament_prestart_retreats'::regclass,'public.charter_tournament_raid_contract'::regclass]))))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_raid_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_SOURCE';END IF;
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.charter_tournament_raid_contract'::regclass)) OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.charter_tournament_raid_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_charter_tournament_raid_contract() THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_RAID_SOURCE';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_raid_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE terms jsonb;outcome public.charter_tournament_raid_outcomes;request public.charter_tournament_raid_requests;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='charter_tournament_raid_contract' THEN
  IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_raid_contract) AND NEW.record=public.shardkeep_charter_tournament_raid_contract() THEN RETURN NEW;END IF;RAISE EXCEPTION 'CHARTER_TOURNAMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_tournament_raid_source();
 IF TG_TABLE_NAME='charter_tournament_raid_requests' THEN
  PERFORM 1 FROM public.players WHERE wallet=NEW.actor FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.charter_tournament_events WHERE id=NEW.event_id FOR UPDATE NOWAIT;
  terms:=public.charter_tournament_event_terms(NEW.event_id);
  IF NEW.created_at<(terms->>'playStartsAt')::timestamptz OR NEW.created_at>=(terms->>'playEndsAt')::timestamptz OR EXISTS(SELECT 1 FROM public.charter_tournament_event_terminals WHERE event_id=NEW.event_id) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_WINDOW';END IF;
  IF (SELECT count(*) FROM public.charter_tournament_raid_requests WHERE event_id=NEW.event_id AND actor=NEW.actor)>=(terms->'policy'->>'maxRequestIdentitiesPerWallet')::integer THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REQUEST_LIMIT';END IF;
  NEW.entry:=public.shardkeep_charter_tournament_entry_for_wallet(NEW.event_id,NEW.actor);
  IF NEW.entry IS NULL OR NEW.entry='null'::jsonb THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_NOT_ENTERED';END IF;
  IF (SELECT count(*) FROM public.charter_tournament_raid_requests r WHERE r.event_id=NEW.event_id AND r.actor=NEW.actor AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_raid_admissions a WHERE a.request_id=r.id) AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_raid_cancellations c WHERE c.request_id=r.id))>=(terms->'policy'->>'maxPendingRequestsPerWallet')::integer THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REQUEST_PENDING';END IF;
  IF (SELECT count(*) FROM public.charter_tournament_raid_admissions WHERE event_id=NEW.event_id AND actor=NEW.actor)>=(terms->'policy'->>'raidsPerWallet')::integer THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ORDINAL';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id WHERE b.id=NEW.base_id AND b.owner_wallet=NEW.actor AND b.status='active' AND s.wallet=NEW.actor AND s.active) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER';END IF;
  IF NEW.raid_key IS DISTINCT FROM 'raid:'||encode(sha256(convert_to(NEW.actor,'UTF8')||decode('00','hex')||convert_to('pvp','UTF8')),'hex')||':'||NEW.private_key::text OR EXISTS(SELECT 1 FROM public.raids WHERE idempotency_key IN(NEW.raid_key,NEW.private_key::text)) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_PRIVATE_KEY';END IF;
 ELSIF TG_TABLE_NAME='charter_tournament_raid_cancellations' THEN
  SELECT * INTO STRICT request FROM public.charter_tournament_raid_requests WHERE id=NEW.request_id;
  PERFORM 1 FROM public.players WHERE wallet=request.actor FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.charter_tournament_events WHERE id=request.event_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.charter_tournament_raid_requests WHERE id=request.id FOR UPDATE NOWAIT;
  IF NEW.actor IS DISTINCT FROM request.actor OR NEW.cancelled_at<request.created_at OR EXISTS(SELECT 1 FROM public.charter_tournament_raid_admissions WHERE request_id=request.id) OR EXISTS(SELECT 1 FROM public.raids WHERE idempotency_key IN(request.raid_key,request.private_key::text)) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ALREADY_ADMITTED';END IF;
  NEW.original_request:=to_jsonb(request);
 ELSIF TG_TABLE_NAME IN('charter_tournament_raid_admissions','charter_tournament_raid_outcomes') THEN
  IF pg_trigger_depth()<>2 OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_RAID_TRIGGER';END IF;
 ELSE
  SELECT * INTO STRICT outcome FROM public.charter_tournament_raid_outcomes WHERE raid_id=NEW.raid_id;
  SELECT r.* INTO STRICT request FROM public.charter_tournament_raid_requests r JOIN public.charter_tournament_raid_admissions a ON a.request_id=r.id WHERE a.raid_id=NEW.raid_id;
  terms:=public.charter_tournament_event_terms(request.event_id);
  IF NEW.original_terminal IS DISTINCT FROM outcome.original_terminal OR NEW.completed IS DISTINCT FROM (outcome.original_terminal->>'status'='resolved' AND outcome.live_state->>'started_at' IS NOT NULL) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REPLAY';END IF;
  IF NEW.completed THEN
   IF NEW.stars IS DISTINCT FROM (outcome.original_terminal->'result'->>'stars')::integer OR NEW.destruction IS DISTINCT FROM (outcome.original_terminal->'result'->>'destructionPct')::integer OR NEW.stars>(terms->'policy'->>'maxStarsPerRaid')::integer OR NEW.destruction>(terms->'policy'->>'maxDestructionPerRaid')::integer OR NEW.record->>'inputSha256' IS DISTINCT FROM NEW.input_sha256 OR NEW.record->>'kind' IS DISTINCT FROM 'deterministic-original-replay' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REPLAY';END IF;
  ELSE
   IF NEW.stars<>0 OR NEW.destruction<>0 THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REPLAY';END IF;
   IF outcome.original_terminal->>'status'='expired' THEN
    IF NEW.record->>'kind' IS DISTINCT FROM 'original-expiry' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REPLAY';END IF;
   ELSIF (outcome.original_terminal->>'status'='resolved' AND outcome.live_state->>'started_at' IS NULL AND outcome.live_state->>'stream_closed_at' IS NOT NULL AND outcome.retreat->>'kind'='retreat' AND (outcome.retreat->'payload'->'_clock'->>'simNowMs')::integer=0 AND outcome.original_terminal->'result'->>'retreated'='true' AND outcome.original_terminal->'result'->>'stars'='0' AND outcome.original_terminal->'result'->>'destructionPct'='0' AND outcome.original_terminal->'events'='[]'::jsonb AND NEW.record->>'kind'='original-prestart-retreat') IS NOT TRUE THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REPLAY';END IF;
  END IF;
 END IF;
 NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
END $$;
-- The old runtime role needs no new private-table privileges just to insert or
-- finish an ordinary raid. Definer access is limited to this exact trigger;
-- matching private keys still require the original owner and source checks.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_raid_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE request public.charter_tournament_raid_requests;terms jsonb;entry jsonb;prior jsonb;ordinal integer;admission public.charter_tournament_raid_admissions;retreat jsonb;live_state jsonb;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raids_charter_tournament_capture'
  OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 OR TG_OP NOT IN('INSERT','UPDATE')
 THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_RAID_TRIGGER';END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO request FROM public.charter_tournament_raid_requests WHERE raid_key=NEW.idempotency_key;
  IF NOT FOUND THEN RETURN NEW;END IF;
  IF current_setting('role')<>'none' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER_ISOLATION';END IF;
  PERFORM public.shardkeep_charter_tournament_raid_source();
  PERFORM 1 FROM public.players WHERE wallet=request.actor FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.bases WHERE id=request.base_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.charter_tournament_events WHERE id=request.event_id FOR UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.charter_tournament_raid_cancellations WHERE request_id=request.id) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_REQUEST_CANCELLED';END IF;
  terms:=public.charter_tournament_event_terms(request.event_id);entry:=public.shardkeep_charter_tournament_entry_for_wallet(request.event_id,request.actor);
  IF entry IS DISTINCT FROM request.entry OR NEW.attacker_wallet IS DISTINCT FROM request.actor OR NEW.attacker_base_id IS DISTINCT FROM request.base_id OR NEW.defender_wallet IS NULL OR NEW.defender_base_id IS NULL OR NEW.pve_camp_id IS NOT NULL OR NEW.campaign_stage IS NOT NULL OR NEW.status<>'pending_orders' OR NEW.energy_source IS DISTINCT FROM 'free' OR NEW.army_snapshot ? 'createRequest' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ADMISSION';END IF;
  IF NEW.created_at<(terms->>'playStartsAt')::timestamptz OR NEW.created_at>=(terms->>'playEndsAt')::timestamptz OR NEW.created_at<request.created_at OR EXISTS(SELECT 1 FROM public.charter_tournament_event_terminals WHERE event_id=request.event_id) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_WINDOW';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'createdAt',created_at,'energySource',energy_source) ORDER BY id),'[]') INTO prior FROM public.raids WHERE attacker_base_id=request.base_id AND defender_wallet IS NOT NULL AND status<>'expired' AND created_at>=date_trunc('day',NEW.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND id<>NEW.id;
  IF jsonb_array_length(prior)>=(terms->'policy'->>'freeRaidsPerBaseDay')::integer THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_FREE_ENERGY';END IF;
  SELECT count(*)+1 INTO ordinal FROM public.charter_tournament_raid_admissions WHERE event_id=request.event_id AND actor=request.actor;
  IF ordinal>(terms->'policy'->>'raidsPerWallet')::integer THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ORDINAL';END IF;
  INSERT INTO public.charter_tournament_raid_admissions(request_id,raid_id,event_id,actor,ordinal,original_raid,count_witness,entry,tx_key) VALUES(request.id,NEW.id,request.event_id,request.actor,ordinal,to_jsonb(NEW),prior,entry,pg_current_xact_id()::text);
 ELSE
  SELECT * INTO admission FROM public.charter_tournament_raid_admissions WHERE raid_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW;END IF;
  IF current_setting('role')<>'none' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_OWNER_ISOLATION';END IF;
  PERFORM public.shardkeep_charter_tournament_raid_source();
  IF (to_jsonb(NEW)->'snapshot') IS DISTINCT FROM admission.original_raid->'snapshot' OR to_jsonb(NEW)->'army_snapshot' IS DISTINCT FROM admission.original_raid->'army_snapshot' OR to_jsonb(NEW)->'seed' IS DISTINCT FROM admission.original_raid->'seed' OR NEW.idempotency_key IS DISTINCT FROM admission.original_raid->>'idempotency_key' OR NEW.attacker_wallet IS DISTINCT FROM admission.actor OR NEW.attacker_base_id::text IS DISTINCT FROM admission.original_raid->>'attacker_base_id' THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_ORIGINAL';END IF;
  IF EXISTS(SELECT 1 FROM public.charter_tournament_raid_outcomes WHERE raid_id=NEW.id) THEN
   IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_TERMINAL_IMMUTABLE';END IF;
  ELSIF NEW.status IN('resolved','expired') THEN
   SELECT to_jsonb(c) INTO retreat FROM public.raid_commands c WHERE raid_id=NEW.id AND kind='retreat' ORDER BY sequence DESC LIMIT 1;
   SELECT to_jsonb(l) INTO live_state FROM public.raid_live_states l WHERE raid_id=NEW.id;
   IF NEW.status='expired' AND (live_state->>'started_at' IS NOT NULL OR live_state->>'armed_at' IS NOT NULL) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_PENDING_RAID';END IF;
   INSERT INTO public.charter_tournament_raid_outcomes(raid_id,original_terminal,retreat,live_state,tx_key) VALUES(NEW.id,to_jsonb(NEW),retreat,live_state,pg_current_xact_id()::text);
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_scores(eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$DECLARE result jsonb;BEGIN
 PERFORM public.shardkeep_charter_tournament_raid_source();
 IF EXISTS(SELECT 1 FROM public.charter_tournament_raid_admissions a LEFT JOIN public.charter_tournament_raid_outcomes o ON o.raid_id=a.raid_id LEFT JOIN public.charter_tournament_raid_replays p ON p.raid_id=a.raid_id WHERE a.event_id=eid AND (o.raid_id IS NULL OR p.raid_id IS NULL OR o.original_terminal IS DISTINCT FROM p.original_terminal)) THEN RAISE EXCEPTION 'CHARTER_TOURNAMENT_PENDING_RAID';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('clanId',clan,'stars',stars,'destruction',destruction,'completedRaids',completed) ORDER BY clan),'[]') INTO result FROM(SELECT a.entry->>'clanId' AS clan,sum(p.stars) AS stars,sum(p.destruction) AS destruction,count(*) AS completed FROM public.charter_tournament_raid_admissions a JOIN public.charter_tournament_raid_replays p ON p.raid_id=a.raid_id WHERE a.event_id=eid AND p.completed GROUP BY a.entry->>'clanId') s;
 RETURN result;
END $$;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.raids'::regclass AND tgname='raids_charter_tournament_capture') THEN CREATE TRIGGER raids_charter_tournament_capture AFTER INSERT OR UPDATE ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_raid_capture();END IF;END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_tournament_raid_requests','charter_tournament_raid_cancellations','charter_tournament_raid_admissions','charter_tournament_raid_outcomes','charter_tournament_raid_replays','charter_tournament_raid_contract'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_raid_guard()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_tournament_raid_guard()',tab||'_no_truncate',tab);END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE public.charter_tournament_raid_requests,public.charter_tournament_raid_cancellations,public.charter_tournament_raid_admissions,public.charter_tournament_raid_outcomes,public.charter_tournament_raid_replays,public.charter_tournament_raid_contract FROM PUBLIC;
INSERT INTO public.charter_tournament_raid_contract(record) SELECT public.shardkeep_charter_tournament_raid_contract() WHERE NOT EXISTS(SELECT 1 FROM public.charter_tournament_raid_contract);
REVOKE ALL ON TABLE public.charter_tournament_raid_contract FROM PUBLIC;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('shardkeep_charter_tournament_raid_contract','shardkeep_charter_tournament_raid_source','shardkeep_charter_tournament_raid_guard','shardkeep_charter_tournament_raid_capture','shardkeep_charter_tournament_scores') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.name);END LOOP;END $$;
