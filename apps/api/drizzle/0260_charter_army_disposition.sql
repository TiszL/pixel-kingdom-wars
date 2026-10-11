-- S5 HELD. Prospective army-change compensation only. No old terminal is
-- classified, no fee/refund policy changes, no existing source seal is replaced.
SET LOCAL lock_timeout='10s';
CREATE TABLE public.charter_army_dispositions(
 raid_id uuid PRIMARY KEY REFERENCES public.charter_sale_raid_admissions(raid_id),
 actor text NOT NULL,lease uuid NOT NULL,requested jsonb NOT NULL,
 admission jsonb NOT NULL,before_raid jsonb NOT NULL,army jsonb NOT NULL,
 ante_accounts jsonb NOT NULL,observed_at timestamptz NOT NULL,tx_key text NOT NULL
);
CREATE TABLE public.charter_army_disposition_contract(
 singleton boolean PRIMARY KEY CHECK(singleton),source_sha256 text NOT NULL
);
REVOKE ALL ON public.charter_army_dispositions,public.charter_army_disposition_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_army_disposition_fingerprint() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proargtypes::text) ORDER BY p.proname)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN(
   'shardkeep_charter_army_disposition_fingerprint','shardkeep_charter_army_disposition_source','shardkeep_charter_army_disposition_guard',
   'shardkeep_charter_army_disposition_begin','shardkeep_charter_army_disposition_proof','shardkeep_charter_army_disposition_complete',
   'shardkeep_charter_sale_ante_proof','shardkeep_charter_sale_ante_capture','shardkeep_charter_sale_ante_post','shardkeep_charter_sale_hooks')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,
  (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid)) ORDER BY c.relname)
  FROM pg_class c WHERE c.oid IN('public.charter_army_dispositions'::regclass,'public.charter_army_disposition_contract'::regclass)),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN('public.charter_army_dispositions'::regclass,'public.charter_army_disposition_contract'::regclass))
 )::text,'UTF8')),'hex')
$$;
CREATE FUNCTION public.shardkeep_charter_army_disposition_source() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin'
 OR public.shardkeep_charter_army_disposition_fingerprint() IS DISTINCT FROM
  (SELECT source_sha256 FROM public.charter_army_disposition_contract WHERE singleton)
 THEN RAISE EXCEPTION 'CHARTER_ARMY_SOURCE';END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_army_disposition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.raids%ROWTYPE;a public.charter_sale_raid_admissions%ROWTYPE;item record;available bigint;shortage boolean:=false;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'CHARTER_ARMY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='charter_army_disposition_contract' THEN
  IF TG_NAME<>'charter_army_disposition_contract_guard' OR EXISTS(SELECT 1 FROM public.charter_army_disposition_contract)
   OR NEW.singleton IS DISTINCT FROM true OR NEW.source_sha256 IS DISTINCT FROM public.shardkeep_charter_army_disposition_fingerprint()
  THEN RAISE EXCEPTION 'CHARTER_ARMY_SOURCE';END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME<>'charter_army_dispositions' OR TG_NAME<>'charter_army_dispositions_guard'
 OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CHARTER_ARMY_SOURCE';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();
 PERFORM wallet FROM public.players WHERE wallet=NEW.actor FOR UPDATE;
 SELECT * INTO r FROM public.raids WHERE id=NEW.raid_id FOR UPDATE;
 SELECT * INTO a FROM public.charter_sale_raid_admissions WHERE raid_id=r.id;
 IF r.id IS NULL OR r.attacker_wallet IS DISTINCT FROM NEW.actor OR r.status<>'pending_orders'
 OR NEW.lease IS NULL OR r.simulation_lease_token IS DISTINCT FROM NEW.lease OR a.raid_id IS NULL
 OR a.original_raid->'army_snapshot' IS DISTINCT FROM to_jsonb(r)->'army_snapshot'
 OR a.original_raid->'attacker_base_id' IS DISTINCT FROM to_jsonb(r)->'attacker_base_id'
 OR a.event->>'attacker_wallet' IS DISTINCT FROM NEW.actor
 OR r.sim_version IS DISTINCT FROM(SELECT (policy->>'simVersion')::integer FROM public.charter_sale_epochs WHERE id=a.epoch_id)
 OR EXISTS(SELECT 1 FROM public.raid_live_states l WHERE l.raid_id=r.id AND(l.started_at IS NOT NULL OR l.armed_at IS NOT NULL))
 OR jsonb_typeof(NEW.requested) IS DISTINCT FROM 'object' OR NEW.requested='{}'::jsonb
 THEN RAISE EXCEPTION 'CHARTER_ARMY_INPUT';END IF;
 PERFORM public.shardkeep_charter_sale_ante_proof(r.id,false);
 -- Preserve original base identity; a sibling base cannot establish shortage.
 IF r.attacker_base_id IS NULL THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.troop),'[]'::jsonb) INTO NEW.army
   FROM(SELECT * FROM public.army WHERE player_wallet=r.attacker_wallet ORDER BY troop FOR UPDATE) x;
 ELSE
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.troop),'[]'::jsonb) INTO NEW.army
   FROM(SELECT * FROM public.base_army WHERE base_id=r.attacker_base_id ORDER BY troop FOR UPDATE) x;
 END IF;
 FOR item IN SELECT key,value FROM jsonb_each(NEW.requested) LOOP
  IF item.key<>ALL(enum_range(NULL::public.troop_type)::text[]) OR jsonb_typeof(item.value)<>'number'
   OR item.value::text!~'^[1-9][0-9]{0,9}$' OR (item.value::text)::numeric>2147483647
   OR jsonb_typeof(to_jsonb(r)#>ARRAY['army_snapshot','counts',item.key]) IS DISTINCT FROM 'number'
   OR (item.value::text)::numeric>(to_jsonb(r)#>>ARRAY['army_snapshot','counts',item.key])::numeric
  THEN RAISE EXCEPTION 'CHARTER_ARMY_INPUT';END IF;
  SELECT coalesce((SELECT (v->>'count')::bigint FROM jsonb_array_elements(NEW.army) v WHERE v->>'troop'=item.key),0) INTO available;
  IF available<0 THEN RAISE EXCEPTION 'CHARTER_ARMY_SOURCE';END IF;
  shortage:=shortage OR available<(item.value::text)::bigint;
 END LOOP;
 IF NOT shortage THEN RETURN NULL;END IF;
 NEW.admission:=to_jsonb(a);NEW.before_raid:=to_jsonb(r);NEW.tx_key:=pg_current_xact_id()::text;NEW.observed_at:=clock_timestamp();
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) INTO NEW.ante_accounts FROM(
  SELECT ac.* FROM public.accounts ac WHERE ac.id IN(SELECT (original_entry->>'account_id')::uuid FROM public.charter_sale_ante_entries WHERE ledger_id=a.ante_post)
  ORDER BY ac.id FOR UPDATE) x;
 RETURN NEW;
END $$;
CREATE TRIGGER charter_army_dispositions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.charter_army_dispositions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_army_disposition_guard();
CREATE TRIGGER charter_army_dispositions_no_truncate BEFORE TRUNCATE ON public.charter_army_dispositions FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_army_disposition_guard();
CREATE TRIGGER charter_army_disposition_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.charter_army_disposition_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_army_disposition_guard();
CREATE TRIGGER charter_army_disposition_contract_no_truncate BEFORE TRUNCATE ON public.charter_army_disposition_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_army_disposition_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_army_disposition_begin(rid uuid,actor text,lease uuid,requested jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE saved uuid;BEGIN
 PERFORM public.shardkeep_charter_army_disposition_source();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CHARTER_ARMY_READ_COMMITTED';END IF;
 IF session_user<>current_user AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.charter_army_dispositions'::regclass,'public.charter_army_disposition_contract'::regclass)
  AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 THEN RAISE EXCEPTION 'CHARTER_ARMY_PRIVATE_GRANTS' USING ERRCODE='42501';END IF;
 -- Unenrolled gameplay retains its existing behavior; no source is invented.
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_raid_admissions WHERE raid_id=rid) THEN RETURN true;END IF;
 INSERT INTO public.charter_army_dispositions(raid_id,actor,lease,requested) VALUES(rid,actor,lease,requested) RETURNING raid_id INTO saved;
 RETURN saved IS NOT NULL;
END $$;
CREATE FUNCTION public.shardkeep_charter_army_disposition_proof(rid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE d public.charter_army_dispositions%ROWTYPE;o public.charter_sale_raid_outcomes%ROWTYPE;t public.clan_charter_raid_terminals%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_army_disposition_source();SELECT * INTO d FROM public.charter_army_dispositions WHERE raid_id=rid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO o FROM public.charter_sale_raid_outcomes WHERE raid_id=rid;
 SELECT * INTO t FROM public.clan_charter_raid_terminals WHERE raid_id=rid;
 IF d.admission IS DISTINCT FROM(SELECT to_jsonb(a) FROM public.charter_sale_raid_admissions a WHERE raid_id=rid)
 OR o.raid_id IS NULL OR t.raid_id IS NULL OR d.before_raid IS DISTINCT FROM o.before_raid
 OR t.before_raid IS DISTINCT FROM o.before_raid OR t.after_raid IS DISTINCT FROM o.after_raid
 OR d.tx_key IS DISTINCT FROM o.tx_key OR d.tx_key IS DISTINCT FROM t.tx_key OR t.terminal_status<>'expired'
 OR o.after_raid IS DISTINCT FROM(d.before_raid||jsonb_build_object('status','expired','simulation_lease_token',NULL,'simulation_lease_until',NULL,'simulation_system_attempted_at',NULL))
 OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE idempotency_key='raid-ante-refund:'||rid::text)
 THEN RAISE EXCEPTION 'CHARTER_ARMY_TERMINAL';END IF;
 RETURN to_jsonb(d);
END $$;
CREATE FUNCTION public.shardkeep_charter_army_disposition_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE d public.charter_army_dispositions%ROWTYPE;actual jsonb;BEGIN
 IF TG_RELID<>'public.charter_army_dispositions'::regclass OR TG_NAME<>'charter_army_dispositions_complete' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CHARTER_ARMY_SOURCE';END IF;
 SELECT * INTO d FROM public.charter_army_dispositions WHERE raid_id=NEW.raid_id;
 PERFORM public.shardkeep_charter_army_disposition_proof(d.raid_id);
 SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) INTO actual FROM public.accounts a WHERE a.id IN(SELECT (v->>'id')::uuid FROM jsonb_array_elements(d.ante_accounts) v);
 IF actual IS DISTINCT FROM d.ante_accounts THEN RAISE EXCEPTION 'CHARTER_ARMY_ACCOUNTING';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER charter_army_dispositions_complete AFTER INSERT ON public.charter_army_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_army_disposition_complete();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_ante_proof(rid uuid,terminal_required boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_sale_raid_admissions%ROWTYPE;ep public.charter_sale_epochs%ROWTYPE;
 p public.charter_sale_ante_posts%ROWTYPE;refund public.charter_sale_ante_posts%ROWTYPE;o public.charter_sale_raid_outcomes%ROWTYPE;
 t public.clan_charter_raid_terminals%ROWTYPE;source jsonb;entries jsonb;refund_entries jsonb;destination jsonb;amount bigint;classification text;
BEGIN
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO a FROM public.charter_sale_raid_admissions WHERE raid_id=rid;
 IF a.raid_id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 SELECT * INTO ep FROM public.charter_sale_epochs WHERE id=a.epoch_id;
 IF ep.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_events e WHERE e.raid_id=rid AND to_jsonb(e)=a.event)
  OR a.event->>'source_id' IS DISTINCT FROM ep.source_id::text
  OR a.event->>'chest_admission_tx' IS DISTINCT FROM a.tx_key
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 IF a.event->>'kind' IN('campaign','pve') THEN amount:=0;
 ELSE amount:=(ep.policy->'anteSchedule'->>least(greatest(a.keep_level,1)-1,jsonb_array_length(ep.policy->'anteSchedule')-1))::bigint;END IF;
 IF a.ante_amount IS DISTINCT FROM amount OR(a.ante_post IS NULL) IS DISTINCT FROM(amount=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 IF amount>0 THEN
  SELECT * INTO p FROM public.charter_sale_ante_posts WHERE ledger_id=a.ante_post;
  IF p.epoch_id IS DISTINCT FROM ep.id OR p.tx_key IS DISTINCT FROM a.tx_key
   OR p.original_transaction->>'type' IS DISTINCT FROM 'raid.ante'
   OR p.original_transaction->>'idempotency_key' IS DISTINCT FROM 'raid-ante:'||(a.original_raid->>'idempotency_key')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  PERFORM public.shardkeep_charter_sale_ante_post(p.ledger_id);
  SELECT jsonb_agg(to_jsonb(e) ORDER BY e.entry_id) INTO entries FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id;
  SELECT e.account_identity INTO source FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id AND(e.original_entry->>'delta')::bigint=-amount;
  SELECT e.account_identity INTO destination FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id AND(e.original_entry->>'delta')::bigint=amount;
  IF jsonb_array_length(entries)<>2 OR destination->>'kind' IS DISTINCT FROM 'shard_burn'
   OR destination->>'owner_wallet' IS NOT NULL OR destination->>'base_id' IS NOT NULL
   OR(a.original_raid->>'attacker_base_id' IS NULL AND(source->>'kind' IS DISTINCT FROM 'player_shards' OR source->>'owner_wallet' IS DISTINCT FROM a.event->>'attacker_wallet' OR source->>'base_id' IS NOT NULL))
   OR(a.original_raid->>'attacker_base_id' IS NOT NULL AND(source->>'kind' IS DISTINCT FROM 'base_shards' OR source->>'base_id' IS DISTINCT FROM a.event->>'attacker_base_id' OR source->>'owner_wallet' IS NOT NULL))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 END IF;
 SELECT * INTO o FROM public.charter_sale_raid_outcomes WHERE raid_id=rid;
 IF NOT terminal_required THEN RETURN jsonb_build_object('admission',to_jsonb(a),'post',to_jsonb(p),'entries',entries);END IF;
 SELECT * INTO t FROM public.clan_charter_raid_terminals WHERE raid_id=rid;
 IF o.raid_id IS NULL OR t.raid_id IS NULL OR o.before_raid IS DISTINCT FROM t.before_raid OR o.after_raid IS DISTINCT FROM t.after_raid
  OR o.tx_key IS DISTINCT FROM t.tx_key OR t.terminal_status NOT IN('resolved','expired')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_PENDING';END IF;
 SELECT * INTO refund FROM public.charter_sale_ante_posts WHERE original_transaction->>'idempotency_key'='raid-ante-refund:'||rid::text;
 IF amount=0 THEN
  IF refund.ledger_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;classification:='no-ante';
 ELSIF t.terminal_status='resolved' THEN
  IF refund.ledger_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;classification:='resolved-retained';
 ELSIF refund.ledger_id IS NOT NULL THEN
  PERFORM public.shardkeep_charter_sale_ante_post(refund.ledger_id);
  SELECT jsonb_agg(to_jsonb(e) ORDER BY e.entry_id) INTO refund_entries FROM public.charter_sale_ante_entries e WHERE e.ledger_id=refund.ledger_id;
  IF refund.tx_key IS DISTINCT FROM o.tx_key OR refund.original_transaction->>'type' IS DISTINCT FROM 'raid.ante.system_refund'
   OR refund.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('raidId',rid,'wallet',a.event->>'attacker_wallet','originalKey',p.original_transaction->>'idempotency_key')
   OR jsonb_array_length(refund_entries)<>2 OR EXISTS(SELECT 1 FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id
    AND NOT EXISTS(SELECT 1 FROM public.charter_sale_ante_entries reversed WHERE reversed.ledger_id=refund.ledger_id
      AND reversed.account_identity=e.account_identity AND(reversed.original_entry->>'delta')::bigint=-(e.original_entry->>'delta')::bigint))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;classification:='system-refunded';
 ELSIF EXISTS(SELECT 1 FROM public.charter_army_dispositions WHERE raid_id=rid) THEN
  PERFORM public.shardkeep_charter_army_disposition_proof(rid);classification:='army-changed-retained';
 ELSE
  -- Absence alone is not a retained-ante terminal. This is the existing actual
  -- current-SIM ordinary batch abandonment predicate captured at transition.
  IF(o.before_raid->>'sim_version')::integer IS DISTINCT FROM(ep.policy->>'simVersion')::integer
   OR o.before_raid->>'simulation_lease_token' IS NOT NULL OR o.before_raid->>'simulation_system_attempted_at' IS NOT NULL
   OR(o.live_state IS NOT NULL AND(o.live_state->>'mode'='live' OR o.live_state->>'started_at' IS NOT NULL OR o.live_state->>'armed_at' IS NOT NULL))
   OR(o.before_raid->>'orders_deadline_at')::timestamptz+(ep.policy->>'batchGraceSeconds')::integer*interval '1 second'>=o.observed_at
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_AMBIGUOUS';END IF;classification:='ordinary-abandoned';
 END IF;
 RETURN jsonb_build_object('admission',to_jsonb(a),'post',to_jsonb(p),'entries',entries,'outcome',to_jsonb(o),
  'refund',to_jsonb(refund),'refundEntries',refund_entries,'classification',classification)
  ||CASE WHEN classification='army-changed-retained' THEN jsonb_build_object('disposition',public.shardkeep_charter_army_disposition_proof(rid)) ELSE '{}'::jsonb END;
END $$;

--> statement-breakpoint
DO $$DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'shardkeep_charter_army_disposition_%'
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.name);END LOOP;
END $$;
INSERT INTO public.charter_army_disposition_contract VALUES(true,public.shardkeep_charter_army_disposition_fingerprint());
DO $$DECLARE role_name text;BEGIN
 FOREACH role_name IN ARRAY ARRAY['shardkeep_api_runtime','shardkeep_worker_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.shardkeep_charter_army_disposition_begin(uuid,text,uuid,jsonb) TO %I',role_name);
  END IF;
 END LOOP;
END $$;
