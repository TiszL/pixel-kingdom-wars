-- Authenticated retirement terminal and exact local projection. RPC finality is
-- supplied only by the private application's bound chain readers, never flags.
SET LOCAL lock_timeout='10s';
DO $$BEGIN PERFORM public.shardkeep_charter_retirement_source();END $$;
CREATE TABLE public.charter_retirement_terminals(
 retirement_id uuid PRIMARY KEY REFERENCES public.charter_retirements(id),id uuid NOT NULL UNIQUE,
 outcome text NOT NULL CHECK(outcome IN('completed','cancelled')),record jsonb NOT NULL,inventory jsonb NOT NULL,source jsonb NOT NULL,
 clan_before jsonb NOT NULL,roster_before jsonb NOT NULL,head_before jsonb NOT NULL,chest_before jsonb NOT NULL,chest_after jsonb NOT NULL,
 payment_source jsonb NOT NULL,tx_key text NOT NULL,completed_at timestamptz NOT NULL CHECK(isfinite(completed_at))
);
CREATE TABLE public.charter_retirement_effects(
 retirement_id uuid NOT NULL REFERENCES public.charter_retirement_terminals(retirement_id),kind text NOT NULL,target text NOT NULL,
 before_row jsonb NOT NULL,after_row jsonb,tx_key text NOT NULL,PRIMARY KEY(retirement_id,kind,target)
);
CREATE TABLE public.charter_retirement_completions(
 retirement_id uuid PRIMARY KEY REFERENCES public.charter_retirement_terminals(retirement_id),terminal_id uuid NOT NULL UNIQUE REFERENCES public.charter_retirement_terminals(id),tx_key text NOT NULL
);
CREATE TABLE public.charter_retirement_projection_contract(singleton boolean PRIMARY KEY CHECK(singleton),previous_sha256 text NOT NULL,source_sha256 text NOT NULL);
REVOKE ALL ON public.charter_retirement_terminals,public.charter_retirement_effects,public.charter_retirement_completions,public.charter_retirement_projection_contract FROM PUBLIC;
-- A cancelled original stays immutable. A later genuine fence may create a new
-- original under the same clan mutex; an unresolved/completed original cannot.
ALTER TABLE public.charter_retirements DROP CONSTRAINT charter_retirements_clan_id_key;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_source() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS(SELECT 1 FROM public.charter_retirement_projection_contract successor
  JOIN public.charter_retirement_contract previous ON previous.singleton=successor.singleton
  WHERE successor.singleton AND successor.previous_sha256=previous.source_sha256 AND successor.source_sha256=public.shardkeep_charter_retirement_fingerprint())
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();PERFORM public.shardkeep_charter_tournament_hooks();
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_inventory(rid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('version',1,'revision',count(*)::text,'count',count(*),'messages',coalesce(jsonb_agg(record->'candidateHex'),'[]'::jsonb)) FROM public.charter_retirement_attempts WHERE retirement_id=rid
$$;
CREATE FUNCTION public.shardkeep_charter_retirement_projection(tab text,before_row jsonb,after_row jsonb) RETURNS boolean
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.charter_retirement_terminals t WHERE t.outcome='completed' AND t.tx_key=pg_current_xact_id()::text
 AND NOT EXISTS(SELECT 1 FROM public.charter_retirement_completions done WHERE done.retirement_id=t.retirement_id)
 AND ((tab='clans' AND before_row=t.clan_before AND after_row IS NULL)
  OR(tab='clan_members' AND after_row IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.roster_before) m WHERE m=before_row))
  OR(tab='clan_charter_raid_chest_heads' AND before_row=t.chest_before AND after_row=t.chest_after)))
$$;
CREATE FUNCTION public.shardkeep_charter_retirement_effects_complete(rid uuid,committing boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t public.charter_retirement_terminals%ROWTYPE;r public.charter_retirements%ROWTYPE;x jsonb;actual jsonb;n integer:=0;
BEGIN
 SELECT * INTO t FROM public.charter_retirement_terminals WHERE retirement_id=rid;SELECT * INTO r FROM public.charter_retirements WHERE id=rid;
 IF t.id IS NULL OR r.id IS NULL OR t.source IS DISTINCT FROM r.source OR t.inventory IS DISTINCT FROM public.shardkeep_charter_retirement_inventory(rid)
 OR t.clan_before->>'id' IS DISTINCT FROM r.clan_id::text OR t.clan_before->>'leader_wallet' IS DISTINCT FROM r.actor OR t.clan_before->>'chest_shards' IS DISTINCT FROM '0'
 OR t.head_before IS DISTINCT FROM r.source->'head' OR t.chest_before->'clan_state' IS DISTINCT FROM t.clan_before
 OR t.payment_source IS DISTINCT FROM(SELECT source FROM public.clan_charter_member_payments WHERE fence_id=r.fence_id)
 OR t.payment_source->'fence' IS DISTINCT FROM r.source->'fence'
 OR t.roster_before IS DISTINCT FROM(SELECT coalesce(jsonb_agg(original_membership ORDER BY member_wallet COLLATE "C"),'[]'::jsonb) FROM public.clan_charter_member_roster WHERE fence_id=r.fence_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
 IF t.outcome='completed' THEN
  IF t.chest_after IS DISTINCT FROM jsonb_set(jsonb_set(t.chest_before,'{revision}',to_jsonb((t.chest_before->>'revision')::bigint+1)),'{clan_state}','null'::jsonb)
   OR NOT EXISTS(SELECT 1 FROM public.charter_retirement_effects WHERE retirement_id=rid AND kind='clans' AND target=r.clan_id::text AND before_row=t.clan_before AND after_row IS NULL AND tx_key=t.tx_key)
   OR NOT EXISTS(SELECT 1 FROM public.charter_retirement_effects WHERE retirement_id=rid AND kind='clan_charter_raid_chest_heads' AND target=r.clan_id::text AND before_row=t.chest_before AND after_row=t.chest_after AND tx_key=t.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(t.roster_before) LOOP
   IF NOT EXISTS(SELECT 1 FROM public.charter_retirement_effects WHERE retirement_id=rid AND kind='clan_members' AND target=x->>'player_wallet' AND before_row=x AND after_row IS NULL AND tx_key=t.tx_key)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;n:=n+1;
  END LOOP;n:=n+2;
  -- A completed tombstone is permanent, even on historical reads.
  IF EXISTS(SELECT 1 FROM public.clans WHERE id=r.clan_id) OR EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=r.clan_id)
  OR t.chest_after IS DISTINCT FROM(SELECT to_jsonb(h) FROM public.clan_charter_raid_chest_heads h WHERE clan_id=r.clan_id)
  OR t.head_before IS DISTINCT FROM(SELECT to_jsonb(h) FROM public.charter_sale_heads h WHERE clan_id=r.clan_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
 ELSE
  IF t.chest_after IS DISTINCT FROM t.chest_before THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
  IF committing THEN
   SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.player_wallet COLLATE "C"),'[]'::jsonb) INTO actual FROM public.clan_members m WHERE clan_id=r.clan_id;
   IF actual IS DISTINCT FROM t.roster_before OR t.clan_before IS DISTINCT FROM(SELECT to_jsonb(c) FROM public.clans c WHERE id=r.clan_id)
    OR t.chest_before IS DISTINCT FROM(SELECT to_jsonb(h) FROM public.clan_charter_raid_chest_heads h WHERE clan_id=r.clan_id)
    OR t.head_before IS DISTINCT FROM(SELECT to_jsonb(h) FROM public.charter_sale_heads h WHERE clan_id=r.clan_id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
  END IF;
 END IF;
 IF(SELECT count(*) FROM public.charter_retirement_effects WHERE retirement_id=rid)<>n THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_history(rid uuid,committing boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 PERFORM public.shardkeep_charter_retirement_source();
 IF NOT EXISTS(SELECT 1 FROM public.charter_retirement_terminals t JOIN public.charter_retirement_completions c
  ON c.retirement_id=t.retirement_id AND c.terminal_id=t.id AND c.tx_key=t.tx_key WHERE t.retirement_id=rid)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
 PERFORM public.shardkeep_charter_retirement_effects_complete(rid,committing);
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_released(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE rid uuid;BEGIN
 SELECT r.id INTO rid FROM public.charter_retirements r JOIN public.charter_retirement_terminals t ON t.retirement_id=r.id
  WHERE r.fence_id=fid AND t.outcome='cancelled';IF rid IS NULL THEN RETURN false;END IF;
 PERFORM public.shardkeep_charter_retirement_history(rid,false);RETURN true;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_historical_fence(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE r public.charter_retirements%ROWTYPE;BEGIN
 SELECT r0.* INTO r FROM public.charter_retirements r0 JOIN public.charter_retirement_terminals t ON t.retirement_id=r0.id WHERE r0.fence_id=fid;
 IF r.id IS NULL THEN RETURN false;END IF;
 PERFORM public.shardkeep_charter_retirement_history(r.id,false);PERFORM public.shardkeep_charter_member_payment_read(fid,r.actor);RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_retirement_terminal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_retirements%ROWTYPE;t public.charter_retirement_terminals%ROWTYPE;a jsonb;w jsonb;expected jsonb;programs jsonb;candidate text;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_retirement_owner();
 IF TG_TABLE_NAME='charter_retirement_projection_contract' THEN
  IF EXISTS(SELECT 1 FROM public.charter_retirement_projection_contract) OR NEW.singleton IS DISTINCT FROM true
   OR NEW.previous_sha256 IS DISTINCT FROM(SELECT source_sha256 FROM public.charter_retirement_contract WHERE singleton)
   OR NEW.source_sha256 IS DISTINCT FROM public.shardkeep_charter_retirement_fingerprint() THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;RETURN NEW;
 END IF;
 PERFORM public.shardkeep_charter_retirement_source();
 IF TG_TABLE_NAME='charter_retirement_terminals' THEN
  SELECT * INTO r FROM public.charter_retirements WHERE id=NEW.retirement_id FOR UPDATE NOWAIT;
  IF r.id IS NULL OR r.source IS DISTINCT FROM public.shardkeep_charter_retirement_clearance(r.actor,r.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
  NEW.id:=gen_random_uuid();NEW.tx_key:=pg_current_xact_id()::text;NEW.completed_at:=clock_timestamp();NEW.source:=r.source;NEW.inventory:=public.shardkeep_charter_retirement_inventory(r.id);
  SELECT to_jsonb(c) INTO STRICT NEW.clan_before FROM public.clans c WHERE id=r.clan_id;
  SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.player_wallet COLLATE "C"),'[]'::jsonb) INTO NEW.roster_before FROM public.clan_members m WHERE clan_id=r.clan_id;
  SELECT to_jsonb(h) INTO STRICT NEW.head_before FROM public.charter_sale_heads h WHERE clan_id=r.clan_id;
  SELECT to_jsonb(h) INTO STRICT NEW.chest_before FROM public.clan_charter_raid_chest_heads h WHERE clan_id=r.clan_id FOR UPDATE NOWAIT;
  SELECT source INTO STRICT NEW.payment_source FROM public.clan_charter_member_payments WHERE fence_id=r.fence_id;
  NEW.chest_after:=NEW.chest_before;SELECT record INTO a FROM public.charter_retirement_attempts WHERE retirement_id=r.id;SELECT record INTO w FROM public.charter_retirement_wires WHERE retirement_id=r.id;
  candidate:=a->>'candidateHex';
  IF NEW.record->'original' IS DISTINCT FROM r.original OR NEW.record->>'retirementAuthorized' IS DISTINCT FROM 'false' OR NEW.record->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_EVIDENCE';END IF;
  IF NEW.outcome='completed' THEN
   expected:=jsonb_build_object('retirementId',r.id,'fenceId',r.fence_id,'clanId',r.clan_id,'charter',r.original->'creation'->'chain'->'charter','asset',r.original->'creation'->'chain'->'asset','leader',r.actor,
    'priorRevision',(r.original->'retirement'->>'expectedRevision')::bigint,'revision',(r.original->'retirement'->>'expectedRevision')::bigint+1,'clearanceHash',r.original->'retirement'->'clearanceHash','permitId',substr(candidate,147,32),'acceptedAt',NEW.record->'receipt'->'acceptedAt');
   IF a IS NULL OR w IS NULL OR NEW.record->'receipt' IS DISTINCT FROM expected
    OR NEW.record->>'retirementId' IS DISTINCT FROM r.id::text OR NEW.record->>'clanId' IS DISTINCT FROM r.clan_id::text OR NEW.record->>'leader' IS DISTINCT FROM r.actor
    OR NEW.record->>'priorRevision' IS DISTINCT FROM r.original->'retirement'->>'expectedRevision'
    OR NEW.record->>'revision' IS DISTINCT FROM((r.original->'retirement'->>'expectedRevision')::bigint+1)::text
    OR NEW.record->>'signature' IS DISTINCT FROM w->>'signature' OR NEW.record->>'wireSha256' IS DISTINCT FROM w->>'wireSha256' OR NEW.record->>'messageSha256' IS DISTINCT FROM w->>'messageSha256'
    OR NEW.record->>'finalizedTransitionObserved' IS DISTINCT FROM 'true' OR NEW.record->>'currentStateMatchesResult' IS DISTINCT FROM 'true'
    OR coalesce(NEW.record->'receipt'->>'acceptedAt','')!~'^[1-9][0-9]*$' OR(NEW.record->'receipt'->>'acceptedAt')::numeric>=public.shardkeep_charter_sale_expiry(candidate)
    OR coalesce(NEW.record->>'receiptSha256','')!~'^[0-9a-f]{64}$' OR(NEW.record->>'observedSlot')::bigint<(NEW.record->>'slot')::bigint
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_EVIDENCE';END IF;
   NEW.chest_after:=jsonb_set(jsonb_set(NEW.chest_before,'{revision}',to_jsonb((NEW.chest_before->>'revision')::bigint+1)),'{clan_state}','null'::jsonb);
  ELSIF NEW.outcome='cancelled' THEN
   SELECT original_terminal->'observation'->'mint'->'source'->'programs' INTO programs FROM public.charter_sale_births WHERE clan_id=r.clan_id;
   IF NEW.record->>'outcome' IS DISTINCT FROM 'absent-after-expiry' OR NEW.record->'inventory' IS DISTINCT FROM NEW.inventory
    OR NEW.record->'source'->>'genesisHash' IS DISTINCT FROM r.original->'creation'->'chain'->>'genesisHash'
    OR jsonb_build_array(NEW.record->'source'->'programs'->'economy',NEW.record->'source'->'programs'->'craft',NEW.record->'source'->'programs'->'core') IS DISTINCT FROM programs
    OR coalesce(NEW.record->>'unixTimestamp','')!~'^[1-9][0-9]*$' OR(a IS NOT NULL AND(NEW.record->>'unixTimestamp')::numeric<=public.shardkeep_charter_sale_expiry(candidate))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_EVIDENCE';END IF;
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INPUT';END IF;
 ELSIF TG_TABLE_NAME='charter_retirement_effects' THEN
  SELECT * INTO t FROM public.charter_retirement_terminals WHERE retirement_id=NEW.retirement_id;
  IF pg_trigger_depth()<3 OR t.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR t.outcome<>'completed'
   OR NOT public.shardkeep_charter_retirement_projection(NEW.kind,NEW.before_row,NEW.after_row)
   OR NEW.target IS DISTINCT FROM (CASE WHEN NEW.kind='clan_members' THEN NEW.before_row->>'player_wallet' WHEN NEW.kind='clans' THEN NEW.before_row->>'id' ELSE NEW.before_row->>'clan_id' END)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ORIGIN';END IF;NEW.tx_key:=t.tx_key;
 ELSIF TG_TABLE_NAME='charter_retirement_completions' THEN
  SELECT * INTO t FROM public.charter_retirement_terminals WHERE retirement_id=NEW.retirement_id;
  IF pg_trigger_depth()<>2 OR t.tx_key IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ORIGIN';END IF;
  PERFORM public.shardkeep_charter_retirement_effects_complete(t.retirement_id,true);NEW.terminal_id:=t.id;NEW.tx_key:=t.tx_key;
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t public.charter_retirement_terminals%ROWTYPE;prior jsonb;next jsonb;BEGIN
 IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NAME<>TG_TABLE_NAME||'_retirement_effect'
  OR NOT((TG_TABLE_NAME IN('clans','clan_members') AND TG_OP='DELETE') OR(TG_TABLE_NAME='clan_charter_raid_chest_heads' AND TG_OP='UPDATE'))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 prior:=to_jsonb(OLD);next:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 FOR t IN SELECT * FROM public.charter_retirement_terminals WHERE tx_key=pg_current_xact_id()::text AND outcome='completed' LOOP
  IF public.shardkeep_charter_retirement_projection(TG_TABLE_NAME,prior,next) AND
   ((TG_TABLE_NAME='clan_members' AND prior->>'clan_id'=t.clan_before->>'id') OR(TG_TABLE_NAME='clans' AND prior=t.clan_before) OR(TG_TABLE_NAME='clan_charter_raid_chest_heads' AND prior=t.chest_before)) THEN
   INSERT INTO public.charter_retirement_effects(retirement_id,kind,target,before_row,after_row)
    VALUES(t.retirement_id,TG_TABLE_NAME,CASE WHEN TG_TABLE_NAME='clan_members' THEN prior->>'player_wallet' WHEN TG_TABLE_NAME='clans' THEN prior->>'id' ELSE prior->>'clan_id' END,prior,next);
  END IF;
 END LOOP;RETURN NULL;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_apply() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE member jsonb;BEGIN
 IF TG_RELID<>'public.charter_retirement_terminals'::regclass OR TG_NAME<>'charter_retirement_terminals_apply' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 IF NEW.outcome='completed' THEN
  FOR member IN SELECT value FROM jsonb_array_elements(NEW.roster_before) LOOP
   DELETE FROM public.clan_members m WHERE m.player_wallet=member->>'player_wallet' AND to_jsonb(m)=member;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
  END LOOP;
  DELETE FROM public.clans c WHERE c.id=(NEW.clan_before->>'id')::uuid AND to_jsonb(c)=NEW.clan_before;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_INCOMPLETE';END IF;
 END IF;
 INSERT INTO public.charter_retirement_completions(retirement_id) VALUES(NEW.retirement_id);RETURN NULL;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.charter_retirement_terminals'::regclass OR TG_NAME<>'charter_retirement_terminals_zz_complete' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 PERFORM public.shardkeep_charter_retirement_history(NEW.retirement_id,true);RETURN NULL;
END $$;
--> statement-breakpoint

-- Narrow successor definitions; the accepted earlier migration files stay unchanged.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE owner_id oid;ids text[];cid uuid;v record;
BEGIN
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_sales'::regclass;
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_TABLE_NAME NOT IN('clans','clan_members','ledger_transactions','ledger_entries','accounts','raids')
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_charter_sale_no_truncate' ELSE '_charter_sale_source' END))
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
  WHERE t.tgrelid=TG_RELID AND t.tgname=TG_NAME AND t.tgfoid='public.shardkeep_charter_sale_source()'::regprocedure
  AND t.tgtype=(CASE WHEN TG_OP='TRUNCATE' THEN 34 ELSE 31 END) AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgnargs=0
  AND t.tgattr=''::int2vector AND p.prosecdef AND p.proowner=owner_id AND c.relowner=owner_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 -- RC-first includes dormant epochs: a writer's old snapshot cannot hide a
 -- source installed after that snapshot. No runtime private grants are needed.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_READ_COMMITTED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_epochs) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 IF TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';
 END IF;
 IF TG_TABLE_NAME IN('clans','clan_members') AND TG_OP IN('INSERT','UPDATE') AND EXISTS(SELECT 1 FROM public.charter_retirements r JOIN public.charter_retirement_terminals t ON t.retirement_id=r.id
  WHERE t.outcome='completed' AND r.clan_id=CASE WHEN TG_TABLE_NAME='clans' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'clan_id')::uuid END)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_TOMBSTONE';END IF;
 IF TG_TABLE_NAME='clans' THEN
  IF TG_OP='INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts p JOIN public.charter_creation_reservations r ON r.id=p.reservation_id
    WHERE r.clan_id=NEW.id AND p.operation='activate' AND p.tx_key=pg_current_xact_id()::text) THEN
    INSERT INTO public.charter_sale_clan_inserts(clan_id,original_clan) VALUES(NEW.id,to_jsonb(NEW));
   END IF;
  ELSIF EXISTS(SELECT 1 FROM public.charter_sale_births WHERE clan_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN
    IF public.shardkeep_charter_retirement_projection('clans',to_jsonb(OLD),NULL) THEN RETURN OLD;END IF;
    RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
   IF public.shardkeep_charter_sale_projection('clans',to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
   IF(NEW.id,NEW.name,NEW.tag,NEW.created_at,NEW.leader_wallet) IS DISTINCT FROM(OLD.id,OLD.name,OLD.tag,OLD.created_at,OLD.leader_wallet)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='clan_members' THEN
  IF public.shardkeep_charter_sale_projection('clan_members',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
  IF TG_OP='INSERT' THEN ids:=ARRAY[NEW.player_wallet];ELSIF TG_OP='DELETE' THEN ids:=ARRAY[OLD.player_wallet];ELSE ids:=ARRAY[OLD.player_wallet,NEW.player_wallet];END IF;
  IF EXISTS(SELECT 1 FROM public.charter_sales s JOIN public.charter_sale_acceptances a ON a.sale_id=s.id
   WHERE s.buyer=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals t WHERE t.sale_id=s.id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_BUYER_RESERVED';END IF;
 ELSIF TG_TABLE_NAME='ledger_transactions' THEN
  IF TG_OP<>'INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.charter_sale_ante_posts saved WHERE saved.ledger_id=OLD.id OR(TG_OP='UPDATE' AND saved.ledger_id=NEW.id))
    OR OLD.type IN('raid.ante','raid.ante.system_refund') OR OLD.idempotency_key LIKE 'raid-ante:%' OR OLD.idempotency_key LIKE 'raid-ante-refund:%'
    OR(TG_OP='UPDATE' AND(NEW.type IN('raid.ante','raid.ante.system_refund') OR NEW.idempotency_key LIKE 'raid-ante:%' OR NEW.idempotency_key LIKE 'raid-ante-refund:%'))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.charter_sale_ante_posts saved WHERE saved.ledger_id=OLD.txn_id OR(TG_OP='UPDATE' AND saved.ledger_id=NEW.txn_id))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  IF TG_OP<>'INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.charter_sale_ante_entries saved WHERE saved.original_entry->>'account_id'=OLD.id::text)
    AND(TG_OP='DELETE' OR to_jsonb(OLD)-'balance' IS DISTINCT FROM to_jsonb(NEW)-'balance')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
   IF TG_OP='UPDATE' THEN
    IF EXISTS(SELECT 1 FROM public.charter_sale_ante_entries saved WHERE saved.tx_key=pg_current_xact_id()::text AND saved.original_entry->>'account_id'=OLD.id::text
     AND NOT EXISTS(SELECT 1 FROM public.charter_sale_ante_effects effect WHERE effect.entry_id=saved.entry_id)
     AND(saved.before_balance IS DISTINCT FROM OLD.balance OR(saved.original_entry->>'balance_after')::bigint IS DISTINCT FROM NEW.balance))
    THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_member_fence_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE affected uuid[];clan uuid;payment public.clan_charter_member_payments%ROWTYPE;active_fence uuid;
BEGIN
 IF TG_RELID NOT IN('public.clans'::regclass,'public.clan_members'::regclass,'public.clan_charter_raid_events'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_charter_member_fence_truncate' ELSE '_charter_member_fence' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_member_fence_boundary()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;
 -- This must precede fence lookup: an old RR snapshot must never hide a newly
 -- committed fence, including while all feature flags are off.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_READ_COMMITTED';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_fences) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';END IF;RETURN NULL;
 END IF;
 -- Once this transaction records a retirement terminal, all clan/roster
 -- writes must be that exact pending projection. This remains effective after
 -- SET CONSTRAINTS flushes its deferred completion check early.
 IF TG_TABLE_NAME IN('clans','clan_members') AND EXISTS(SELECT 1 FROM public.charter_retirement_terminals WHERE tx_key=pg_current_xact_id()::text) THEN
  IF TG_OP='DELETE' AND public.shardkeep_charter_retirement_projection(TG_TABLE_NAME,to_jsonb(OLD),NULL) THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ORIGIN';
 END IF;
 IF TG_TABLE_NAME='clan_charter_raid_events' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;affected:=ARRAY[NEW.original_clan_id];
 ELSIF TG_TABLE_NAME='clan_members' THEN
  IF TG_OP='INSERT' THEN affected:=ARRAY[NEW.clan_id];ELSIF TG_OP='DELETE' THEN affected:=ARRAY[OLD.clan_id];ELSE affected:=ARRAY[OLD.clan_id,NEW.clan_id];END IF;
 ELSE
  IF TG_OP='DELETE' THEN affected:=ARRAY[OLD.id];ELSE affected:=ARRAY[OLD.id,NEW.id];END IF;
 END IF;
 FOR clan IN SELECT DISTINCT id FROM unnest(affected) id WHERE id IS NOT NULL ORDER BY id LOOP
  PERFORM 1 FROM public.clans WHERE id=clan FOR UPDATE NOWAIT;
  SELECT id INTO active_fence FROM public.clan_charter_member_fences f WHERE f.clan_id=clan AND NOT public.shardkeep_charter_sale_released(f.id);
  IF active_fence IS NOT NULL THEN
   IF public.shardkeep_charter_sale_projection(TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN CONTINUE;END IF;
   IF TG_OP='DELETE' AND public.shardkeep_charter_retirement_projection(TG_TABLE_NAME,to_jsonb(OLD),NULL) THEN CONTINUE;END IF;
   SELECT * INTO payment FROM public.clan_charter_member_payments WHERE fence_id=active_fence;
   IF TG_TABLE_NAME='clans' AND TG_OP='UPDATE' THEN
    -- The sole extraction exception is the actual same-transaction payout.
    -- Retained positive credits cannot refill a finalized member chest.
    IF payment.id IS NOT NULL AND payment.tx_key=pg_current_xact_id()::text
     AND NEW.chest_shards=0 AND OLD.chest_shards=payment.total_shards AND OLD.chest_shards>0
     AND to_jsonb(OLD)=payment.source->'headBefore'->'clan_state'
     AND to_jsonb(NEW)-'chest_shards'=to_jsonb(OLD)-'chest_shards' THEN
      PERFORM public.shardkeep_charter_member_payment_validate(payment.id,false);CONTINUE;
    END IF;
    IF payment.id IS NULL AND NEW.chest_shards>OLD.chest_shards
     AND to_jsonb(NEW)-'chest_shards'=to_jsonb(OLD)-'chest_shards' THEN CONTINUE;END IF;
   END IF;
   RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_released(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_sale_fence_releases%ROWTYPE;t public.charter_sale_terminals%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 -- Shared legacy fence predicate: a distinct authenticated retirement cancellation
 -- releases its own fence without inventing a sale or a sale release row.
 IF NOT FOUND THEN RETURN public.shardkeep_charter_retirement_released(fid);END IF;
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=r.sale_id;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=r.sale_id;
 IF t.id IS NULL OR t.id IS DISTINCT FROM r.terminal_id OR a.fence_id IS DISTINCT FROM fid OR r.tx_key IS DISTINCT FROM t.tx_key
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_historical_fence(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE release public.charter_sale_fence_releases%ROWTYPE;f public.clan_charter_member_fences%ROWTYPE;t public.charter_sale_terminals%ROWTYPE;roster jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_fence_releases WHERE fence_id=fid) THEN RETURN false;END IF;
 IF NOT public.shardkeep_charter_sale_released(fid) THEN RETURN false;END IF;
 SELECT * INTO release FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid;
 SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=release.sale_id;
 PERFORM public.shardkeep_charter_sale_terminal_history(t.sale_id,false);
 SELECT coalesce(jsonb_agg(original_membership ORDER BY member_wallet COLLATE "C"),'[]'::jsonb) INTO roster FROM public.clan_charter_member_roster WHERE fence_id=fid;
 IF roster IS DISTINCT FROM t.roster_before OR f.original_clan-'chest_shards' IS DISTINCT FROM t.clan_before-'chest_shards'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 IF release.payment_source IS NOT NULL THEN PERFORM public.shardkeep_charter_member_payment_read(fid,f.actor_wallet);END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_source(fid uuid,paid_source jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;h public.clan_charter_raid_chest_heads%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;e public.clan_charter_raid_events%ROWTYPE;
 c jsonb;prehead jsonb;state jsonb;revision bigint;total bigint;roster jsonb;eligible text[];allocations jsonb;
 retirement public.charter_retirement_terminals%ROWTYPE;
 historical boolean:=false;release public.charter_sale_fence_releases%ROWTYPE;terminal public.charter_sale_terminals%ROWTYPE;
 witnesses jsonb:='[]'::jsonb;events jsonb:='[]'::jsonb;proof jsonb;n bigint;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
 SELECT * INTO release FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 IF release.fence_id IS NOT NULL AND paid_source IS NOT NULL THEN
  IF NOT public.shardkeep_charter_sale_released(fid) OR release.payment_source IS DISTINCT FROM paid_source
   OR paid_source->'fence' IS DISTINCT FROM to_jsonb(f)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=release.sale_id;
  historical:=true;
 END IF;
 SELECT t.* INTO retirement FROM public.charter_retirement_terminals t JOIN public.charter_retirements r ON r.id=t.retirement_id WHERE r.fence_id=fid;
 IF retirement.id IS NOT NULL AND paid_source IS NOT NULL THEN
  PERFORM public.shardkeep_charter_retirement_history(retirement.retirement_id,false);
  IF retirement.payment_source IS DISTINCT FROM paid_source OR paid_source->'fence' IS DISTINCT FROM to_jsonb(f) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  historical:=true;terminal.clan_before:=retirement.clan_before;
 END IF;
 SELECT to_jsonb(live) INTO c FROM public.clans live WHERE id=f.clan_id;
 SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=f.clan_id;
 IF historical THEN
  IF (paid_source->'headBefore')-ARRAY['revision','clan_state'] IS DISTINCT FROM to_jsonb(h)-ARRAY['revision','clan_state']
   OR h.revision<(paid_source->'headBefore'->>'revision')::bigint
   OR terminal.clan_before IS DISTINCT FROM jsonb_set(paid_source->'headBefore'->'clan_state','{chest_shards}','0'::jsonb)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  h:=jsonb_populate_record(NULL::public.clan_charter_raid_chest_heads,paid_source->'headBefore');
  c:=terminal.clan_before;h.clan_state:=c;h.revision:=h.revision+CASE WHEN(paid_source->>'totalShards')::bigint>0 THEN 1 ELSE 0 END;
 END IF;
 IF h.clan_id IS NULL OR c IS NULL OR h.clan_state IS DISTINCT FROM c OR h.clan_state IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=f.source_id)
 OR f.original_clan->>'id' IS DISTINCT FROM f.clan_id::text OR f.original_clan->>'leader_wallet' IS DISTINCT FROM f.actor_wallet
 OR(f.original_clan->>'chest_shards')::bigint IS DISTINCT FROM f.chest_shards
 OR f.original_clan-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR NOT(EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
  AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id) OR(h.first_raid_id IS NULL AND EXISTS(SELECT 1 FROM public.charter_sale_births b
   JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id
   WHERE b.clan_id=h.clan_id AND ep.rule_id=h.rule_id AND ep.source_id=f.source_id AND ci.epoch_id=b.epoch_id AND ci.tx_key=b.tx_key)))
 OR f.raid_ordinal IS DISTINCT FROM(SELECT count(*) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND(NOT historical OR clan_ordinal<=f.raid_ordinal))
 OR f.raid_ordinal IS DISTINCT FROM coalesce((SELECT max(clan_ordinal) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND(NOT historical OR clan_ordinal<=f.raid_ordinal)),0)
 OR(NOT historical AND f.raid_ordinal IS DISTINCT FROM coalesce((SELECT ordinal FROM public.clan_charter_event_heads WHERE clan_id=f.clan_id),0))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 prehead:=coalesce(paid_source->'headBefore',to_jsonb(h));state:=prehead->'clan_state';revision:=(prehead->>'revision')::bigint;
 total:=(state->>'chest_shards')::bigint;
 IF total IS NULL OR total<f.chest_shards OR revision IS NULL OR revision<0
 OR prehead-ARRAY['clan_state','revision'] IS DISTINCT FROM to_jsonb(h)-ARRAY['clan_state','revision']
 OR state-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR(paid_source IS NOT NULL AND(h.revision IS DISTINCT FROM revision+CASE WHEN total>0 THEN 1 ELSE 0 END
  OR c IS DISTINCT FROM jsonb_set(state,'{chest_shards}','0'::jsonb)))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.member_wallet COLLATE "C"),'[]'::jsonb),
  coalesce(array_agg(m.member_wallet ORDER BY m.member_wallet COLLATE "C") FILTER(WHERE m.eligible),'{}'::text[])
 INTO roster,eligible FROM public.clan_charter_member_roster m WHERE m.fence_id=fid;
 IF jsonb_array_length(roster)<>f.roster_count OR cardinality(eligible)<>f.eligible_count
 OR(NOT historical AND f.roster_count<>(SELECT count(*) FROM public.clan_members WHERE clan_id=f.clan_id))
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_member_roster WHERE fence_id=fid AND member_wallet=f.actor_wallet)
 OR EXISTS(SELECT 1 FROM public.clan_charter_member_roster m LEFT JOIN public.clan_members live ON live.player_wallet=m.member_wallet
  WHERE m.fence_id=fid AND((NOT historical AND(m.original_membership IS DISTINCT FROM to_jsonb(live) OR live.clan_id IS DISTINCT FROM f.clan_id))
   OR m.original_membership->>'player_wallet' IS DISTINCT FROM m.member_wallet
   OR(m.eligible AND(m.original_base->>'id' IS DISTINCT FROM m.base_id::text OR m.base_id IS NULL OR m.slot IS NULL OR m.slot<=0
    OR m.original_base->>'owner_wallet' IS DISTINCT FROM m.member_wallet OR m.original_base->>'status' IS DISTINCT FROM 'active'
    OR m.original_base->>'land_paid_at' IS NULL OR m.original_slot->>'base_id' IS DISTINCT FROM m.base_id::text
    OR m.original_slot->>'wallet' IS DISTINCT FROM m.member_wallet OR m.original_slot->>'active' IS DISTINCT FROM 'true'
    OR m.original_slot->>'slot' IS DISTINCT FROM m.slot::text))
   OR(NOT m.eligible AND num_nonnulls(m.base_id,m.slot,m.original_base,m.original_slot)<>0)))
 OR(total>0 AND cardinality(eligible)=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 FOR e IN SELECT * FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND clan_ordinal<=f.raid_ordinal ORDER BY clan_ordinal LOOP
  proof:=public.shardkeep_clan_charter_raid_chest_proof(e.raid_id,true);
  IF e.source_id IS DISTINCT FROM f.source_id OR e.tithe_rule_id IS DISTINCT FROM h.rule_id
   OR proof->>'status' IS DISTINCT FROM 'reconciled' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  events:=events||jsonb_build_array(jsonb_build_object('event',to_jsonb(e),'proof',proof));
 END LOOP;
 WHILE state IS DISTINCT FROM f.original_clan LOOP
  IF revision<=0 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT * INTO w FROM public.clan_charter_chest_updates WHERE actual_clan_id=f.clan_id AND chest_predecessor_revision=revision-1;
  IF NOT FOUND OR w.source_id IS DISTINCT FROM f.source_id OR w.delta<=0 OR w.after_clan IS DISTINCT FROM state
   OR w.before_clan-'chest_shards' IS DISTINCT FROM state-'chest_shards'
   OR(w.after_clan->>'chest_shards')::bigint-(w.before_clan->>'chest_shards')::bigint IS DISTINCT FROM w.delta
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_loot_posts p JOIN public.clan_charter_raid_events r ON r.raid_id=p.raid_id
    WHERE p.ledger_id=w.ledger_id AND r.original_clan_id=f.clan_id AND r.clan_ordinal<=f.raid_ordinal
     AND public.shardkeep_clan_charter_raid_chest_proof(r.raid_id,true)->>'status'='reconciled')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  witnesses:=witnesses||jsonb_build_array(to_jsonb(w));state:=w.before_clan;revision:=revision-1;
 END LOOP;
 n:=cardinality(eligible);
 IF n=0 THEN
  -- The zero-chest/empty-eligible case is valid. Do not rely on an empty
  -- unnest to prevent PostgreSQL from evaluating division by zero.
  allocations:='[]'::jsonb;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',wallet,'shards',
   (total/n+CASE WHEN position<=total%n THEN 1 ELSE 0 END)::text) ORDER BY position),'[]'::jsonb)
  INTO allocations FROM unnest(eligible) WITH ORDINALITY x(wallet,position);
 END IF;
 RETURN jsonb_build_object('fence',to_jsonb(f),'roster',roster,'headBefore',prehead,'witnesses',witnesses,'events',events,
  'startRevision',revision::text,'totalShards',total::text,'allocations',allocations);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_retirements%ROWTYPE;q jsonb;candidate text;programs jsonb;epoch public.charter_sale_epochs%ROWTYPE;artifact jsonb;pid text;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_retirement_owner();
 IF TG_TABLE_NAME='charter_retirement_contract' THEN
  IF EXISTS(SELECT 1 FROM public.charter_retirement_contract) OR NEW.singleton IS DISTINCT FROM true OR NEW.source_sha256 IS DISTINCT FROM public.shardkeep_charter_retirement_fingerprint()
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;RETURN NEW;
 END IF;
 PERFORM public.shardkeep_charter_retirement_source();
 IF TG_TABLE_NAME='charter_retirements' THEN
  NEW.source:=public.shardkeep_charter_retirement_clearance(NEW.actor,NEW.fence_id);NEW.clan_id:=(NEW.source->'fence'->>'clan_id')::uuid;
  IF EXISTS(SELECT 1 FROM public.charter_retirements prior WHERE prior.clan_id=NEW.clan_id AND NOT EXISTS(SELECT 1 FROM public.charter_retirement_terminals t WHERE t.retirement_id=prior.id AND t.outcome='cancelled'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_HELD';END IF;
  NEW.id:=gen_random_uuid();NEW.created_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;
  NEW.original:=jsonb_build_object('creation',NEW.source->'creation','retirement',jsonb_build_object('id',NEW.id,'fenceId',NEW.fence_id,'clanId',NEW.clan_id,'leader',NEW.actor,
   'expectedRevision',(NEW.source->'head'->>'revision')::bigint,'clearanceHash',encode(sha256(convert_to('SHARDKEEP_CHARTER_RETIREMENT_CLEARANCE_V1'||NEW.source::text,'UTF8')),'hex')));RETURN NEW;
 END IF;
 SELECT * INTO r FROM public.charter_retirements WHERE id=NEW.retirement_id FOR UPDATE NOWAIT;
 IF r.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_retirement_terminals WHERE retirement_id=r.id)
  OR r.source IS DISTINCT FROM public.shardkeep_charter_retirement_clearance(r.actor,r.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 NEW.tx_key:=pg_current_xact_id()::text;
 IF TG_TABLE_NAME='charter_retirement_attempts' THEN
  q:=NEW.record->'quote';candidate:=q->'packetInput'->>'candidateHex';SELECT * INTO epoch FROM public.charter_sale_epochs;
  SELECT original_terminal->'observation'->'mint'->'source'->'programs' INTO programs FROM public.charter_sale_births WHERE clan_id=r.clan_id;
  IF q->'packetInput'->'original' IS DISTINCT FROM r.original OR q->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR q->>'retirementAuthorized' IS DISTINCT FROM 'false' OR q->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   OR q->'observation'->>'registryRevision' IS DISTINCT FROM r.original->'retirement'->>'expectedRevision'
   OR q->'observation'->>'registryLeader' IS DISTINCT FROM r.actor OR q->'observation'->>'lockKind' IS DISTINCT FROM '0'
   OR q->'observation'->>'lockId' IS DISTINCT FROM repeat('0',32) OR q->'observation'->>'admissionPaused' IS DISTINCT FROM 'false' OR q->'observation'->>'craftPaused' IS DISTINCT FROM 'false'
   OR q->'observation'->'source'->>'genesisHash' IS DISTINCT FROM r.original->'creation'->'chain'->>'genesisHash'
   OR jsonb_build_array(q->'observation'->'source'->'programs'->'economy',q->'observation'->'source'->'programs'->'craft',q->'observation'->'source'->'programs'->'core') IS DISTINCT FROM programs
   OR length(coalesce(candidate,''))<>322 OR coalesce(candidate,'')!~'^[0-9a-f]+$' OR substr(candidate,145,2)<>'09'
   OR NEW.record->>'elapsedMs' IS NULL OR(NEW.record->>'elapsedMs')::double precision<0 OR(NEW.record->>'elapsedMs')::double precision>(epoch.policy->>'observationMaxAgeMs')::double precision
   OR(NEW.record->>'elapsedMs')::double precision='NaN'::double precision THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_QUOTE';END IF;
  PERFORM public.shardkeep_charter_sale_expiry(candidate);pid:=substr(candidate,147,32);
  LOCK TABLE public.charter_creation_permit_messages,public.charter_sale_attempts,public.charter_tournament_attempts IN SHARE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.charter_creation_permit_messages WHERE encode(substring(message_bytes from 74 for 16),'hex')=pid)
   OR EXISTS(SELECT 1 FROM public.charter_sale_attempts WHERE substr(record->>'candidateHex',147,32)=pid)
   OR EXISTS(SELECT 1 FROM public.charter_tournament_attempts WHERE permit_id=pid) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_PERMIT_REUSE';END IF;
  NEW.id:=gen_random_uuid();NEW.permit_id:=pid;NEW.record:=jsonb_build_object('id',NEW.id,'candidateHex',candidate,'policySigner',q->'packetInput'->'policySigner','quote',q);
 ELSIF TG_TABLE_NAME='charter_retirement_preparations' THEN
  IF NEW.record IS DISTINCT FROM jsonb_build_object('policySignatureHex',NEW.record->'policySignatureHex','packet',NEW.record->'packet')
   OR coalesce(NEW.record->>'policySignatureHex','')!~'^[0-9a-f]{128}$' OR NEW.record->'packet'->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR NEW.record->'packet'->>'relayAuthorized' IS DISTINCT FROM 'false' OR NEW.record->'packet'->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->'packet'->>'messageHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ARTIFACT';END IF;
 ELSIF TG_TABLE_NAME='charter_retirement_wires' THEN
  SELECT record INTO artifact FROM public.charter_retirement_preparations WHERE retirement_id=r.id;
  IF NEW.record IS DISTINCT FROM jsonb_build_object('signedTransactionHex',NEW.record->'signedTransactionHex','signature',NEW.record->'signature','wireSha256',NEW.record->'wireSha256','messageSha256',NEW.record->'messageSha256')
   OR NEW.record->>'messageSha256' IS DISTINCT FROM artifact->'packet'->>'messageSha256'
   OR NEW.record->>'wireSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->>'signedTransactionHex','hex')),'hex') THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ARTIFACT';END IF;
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_sale_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_READ_COMMITTED';END IF;
 IF TG_RELID<>'public.charter_sales'::regclass OR TG_NAME<>'charter_sales_retirement_barrier' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 PERFORM 1 FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.charter_retirements r WHERE r.clan_id=NEW.clan_id AND NOT EXISTS(SELECT 1 FROM public.charter_retirement_terminals t WHERE t.retirement_id=r.id AND t.outcome='cancelled'))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_HELD';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_read(actor text,rid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.charter_retirements%ROWTYPE;t public.charter_retirement_terminals%ROWTYPE;a jsonb;p jsonb;w jsonb;BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO r FROM public.charter_retirements WHERE id=rid;
 IF r.id IS NULL OR r.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_NOT_FOUND';END IF;
 SELECT * INTO t FROM public.charter_retirement_terminals WHERE retirement_id=rid;
 IF t.id IS NOT NULL THEN
  PERFORM public.shardkeep_charter_retirement_history(rid,false);PERFORM public.shardkeep_charter_member_payment_read(r.fence_id,r.actor);
 ELSIF r.source IS DISTINCT FROM public.shardkeep_charter_retirement_clearance(actor,r.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 SELECT record INTO a FROM public.charter_retirement_attempts WHERE retirement_id=rid;SELECT record INTO p FROM public.charter_retirement_preparations WHERE retirement_id=rid;SELECT record INTO w FROM public.charter_retirement_wires WHERE retirement_id=rid;
 RETURN jsonb_build_object('version',1,'original',r.original,'status',coalesce(t.outcome,CASE WHEN w IS NOT NULL THEN 'signed' WHEN p IS NOT NULL THEN 'prepared' WHEN a IS NOT NULL THEN 'issuing' ELSE 'cleared' END),
  'source',r.source,'memberPayment',jsonb_build_object('id',r.source->'payment'->'id','totalShards',r.source->'payment'->'totalShards'),'attempt',a,'preparation',p,'signed',w,
  'terminal',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'outcome',t.outcome,'record',t.record) END,'inventory',public.shardkeep_charter_retirement_inventory(rid));
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_terminal(actor text,rid uuid,outcome_value text,evidence jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE r public.charter_retirements%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO r FROM public.charter_retirements WHERE id=rid FOR UPDATE NOWAIT;
 IF r.id IS NULL OR r.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_retirement_terminals WHERE retirement_id=rid) THEN RETURN public.shardkeep_charter_retirement_read(actor,rid);END IF;
 INSERT INTO public.charter_retirement_terminals(retirement_id,outcome,record) VALUES(rid,outcome_value,evidence);
 PERFORM public.shardkeep_charter_retirement_history(rid,true);RETURN public.shardkeep_charter_retirement_read(actor,rid);
END $$;
CREATE TRIGGER clans_retirement_effect AFTER DELETE ON public.clans FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_effect();
CREATE TRIGGER clan_members_retirement_effect AFTER DELETE ON public.clan_members FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_effect();
CREATE TRIGGER clan_charter_raid_chest_heads_retirement_effect AFTER UPDATE ON public.clan_charter_raid_chest_heads FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_effect();
CREATE TRIGGER charter_retirement_terminals_apply AFTER INSERT ON public.charter_retirement_terminals FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_apply();
CREATE CONSTRAINT TRIGGER charter_retirement_terminals_zz_complete AFTER INSERT ON public.charter_retirement_terminals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_complete();
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_retirement_terminals','charter_retirement_effects','charter_retirement_completions','charter_retirement_projection_contract'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_terminal_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_retirement_terminal_guard()',tab||'_no_truncate',tab);
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'shardkeep_charter_retirement_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
INSERT INTO public.charter_retirement_projection_contract SELECT true,source_sha256,public.shardkeep_charter_retirement_fingerprint() FROM public.charter_retirement_contract WHERE singleton;
