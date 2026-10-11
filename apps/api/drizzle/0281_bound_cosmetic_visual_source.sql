-- Additive admission of the bound Market visual INSERT hook. Prior Charter
-- seal rows remain immutable; only this exact new trigger is excluded when
-- verifying the previously accepted retirement fingerprint. The four accepted
-- 0267 ledger hooks and their two constraint rows also require explicit admission:
-- they predate this visual work but were absent from the retained 0264 seal.
SET LOCAL lock_timeout='10s';
DO $$DECLARE predecessor text;BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_migration_contract'::regclass)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.raids'::regclass
  AND t.tgname='bound_cosmetic_raid_capture' AND t.tgtype=5 AND t.tgenabled='O'
  AND t.tgfoid='public.shardkeep_bound_cosmetic_raid_capture()'::regprocedure
  AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PREDECESSOR';END IF;
 IF EXISTS(WITH expected(rel,name,fn,kind,deferred) AS(VALUES
  ('ledger_transactions','ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_guard()',31,false),
  ('ledger_entries','ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_guard()',31,false),
  ('ledger_transactions','ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_shards_complete()',5,true),
  ('ledger_entries','ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_shards_complete()',5,true))
  SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
   WHERE t.tgrelid=to_regclass('public.'||e.rel) AND t.tgname=e.name AND t.tgfoid=to_regprocedure('public.'||e.fn)
    AND t.tgtype=e.kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgqual IS NULL
    AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
    AND(CASE WHEN e.deferred THEN EXISTS(SELECT 1 FROM pg_constraint k WHERE k.oid=t.tgconstraint
      AND k.conrelid=t.tgrelid AND k.conname=e.name AND k.contype='t' AND k.condeferrable AND k.condeferred
      AND pg_get_constraintdef(k.oid)='TRIGGER DEFERRABLE INITIALLY DEFERRED') ELSE t.tgconstraint=0 END)))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PREDECESSOR';END IF;
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proargtypes::text,
  CASE WHEN p.proname LIKE 'shardkeep_charter_retirement_%' THEN p.proacl::text ELSE NULL END) ORDER BY p.proname,p.proargtypes::text)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(p.proname LIKE 'shardkeep_charter_%' OR p.proname LIKE 'shardkeep_clan_charter_%')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,CASE WHEN c.relname LIKE 'charter_retirement%' THEN c.relacl::text ELSE NULL END,
  (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid AND NOT EXISTS(SELECT 1 FROM pg_trigger admitted
   WHERE admitted.tgconstraint=k.oid AND admitted.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass)
    AND admitted.tgname='ordinary_crafting_shards_complete'))) ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT((c.relname='raids' AND t.tgname='bound_cosmetic_raid_capture')
    OR(c.relname IN('ledger_transactions','ledger_entries') AND t.tgname IN('ordinary_crafting_shards_guard','ordinary_crafting_shards_complete'))) AND c.relnamespace='public'::regnamespace
   AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts')))
 )::text,'UTF8')),'hex') INTO predecessor;
 IF NOT EXISTS(SELECT 1 FROM public.charter_migration_contract next
  JOIN public.charter_retirement_draft_contract draft ON draft.singleton=next.singleton
  JOIN public.charter_retirement_projection_contract projection ON projection.singleton=next.singleton
  JOIN public.charter_retirement_contract first ON first.singleton=next.singleton
  WHERE next.singleton AND projection.previous_sha256=first.source_sha256 AND draft.previous_sha256=projection.source_sha256
   AND next.previous_sha256=draft.source_sha256 AND next.source_sha256=predecessor)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PREDECESSOR';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();
 PERFORM public.shardkeep_charter_tournament_hooks();
 PERFORM public.shardkeep_charter_tournament_source_check();
 IF NOT public.shardkeep_bound_cosmetic_return_sources_valid() THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
-- Frozen 0280 source bodies/attributes are checked before admitting a new seal.
DO $$BEGIN
 IF EXISTS(WITH expected(signature,body_sha256,definer,volatility,language_name,return_name) AS(VALUES
  ('shardkeep_bound_cosmetic_market_awnings(uuid,text)','680fbbb69264cf2dc32485520e5731b54856fd3a669a7e5cdc092f3a7db635b3',false,'s','sql','jsonb'),
  ('shardkeep_bound_cosmetic_preference_guard()','9cf0245a268ca1e4cb9baec1d00da61b502eca22439f01827b8b4aaeb98e5645',false,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_base_visual(uuid,text)','265b36061db188a20d63f9e17e238e56b5a3323a2a207214f77de27848fa4d95',true,'s','plpgsql','jsonb'),
  ('shardkeep_bound_cosmetic_raid_guard()','b55c9f4b4e431f009b48aef416d4bbb9acb567a8c5afcc83871e4c1f4a462313',false,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_raid_capture()','d011e49fee8aaa4c8f7e21620e89d9a73b8137143f1b0c17c578cf4c72dc8d29',true,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_raid_visual(uuid)','f3372c83aa3e8153e029a66f1bc15cc1475effc64328b56e16cab053d2825daf',true,'s','plpgsql','jsonb')
 ) SELECT 1 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature)
 LEFT JOIN pg_language l ON l.oid=p.prolang
 WHERE p.oid IS NULL OR p.proowner<>current_user::regrole::oid OR p.prosecdef IS DISTINCT FROM e.definer
  OR p.provolatile::text<>e.volatility OR l.lanname<>e.language_name OR p.prorettype<>to_regtype(e.return_name)
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  OR p.prokind<>'f' OR p.proisstrict OR p.proleakproof
  OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>e.body_sha256)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PRIVATE_SOURCE';END IF;
 IF EXISTS(WITH expected(rel,columns,defs) AS(VALUES
  ('bound_cosmetic_preferences','[["wallet","text",true],["base_id","uuid",true],["awning_enabled","boolean",true],["revision","bigint",true],["updated_at","timestamp with time zone",true]]'::jsonb,
   '["CHECK ((revision > 0))","CHECK (isfinite(updated_at))","FOREIGN KEY (base_id) REFERENCES bases(id)","FOREIGN KEY (wallet) REFERENCES players(wallet)","PRIMARY KEY (wallet, base_id)"]'::jsonb),
  ('bound_cosmetic_raid_visuals','[["raid_id","uuid",true],["visual","jsonb",true]]'::jsonb,
   '["FOREIGN KEY (raid_id) REFERENCES raids(id)","PRIMARY KEY (raid_id)"]'::jsonb))
  SELECT 1 FROM expected e WHERE e.columns IS DISTINCT FROM(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
    FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||e.rel) AND a.attnum>0 AND NOT a.attisdropped)
   OR e.defs IS DISTINCT FROM(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=to_regclass('public.'||e.rel))
   OR EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('public.'||e.rel) AND NOT k.convalidated)
   OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||e.rel) AND a.attnum>0 AND NOT a.attisdropped
    AND(a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'' OR NOT a.attislocal OR a.attinhcount<>0))
   OR EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=to_regclass('public.'||e.rel))
   OR(SELECT count(*) FROM pg_index i WHERE i.indrelid=to_regclass('public.'||e.rel))<>1
   OR EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=to_regclass('public.'||e.rel) AND(NOT i.indisvalid OR NOT i.indisready)))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PRIVATE_SOURCE';END IF;
 IF EXISTS(WITH expected(rel,name,fn,kind) AS(VALUES
  ('bound_cosmetic_preferences','bound_cosmetic_preference_guard','shardkeep_bound_cosmetic_preference_guard()',31),
  ('bound_cosmetic_preferences','bound_cosmetic_preference_no_truncate','shardkeep_bound_cosmetic_preference_guard()',34),
  ('bound_cosmetic_raid_visuals','bound_cosmetic_raid_guard','shardkeep_bound_cosmetic_raid_guard()',31),
  ('bound_cosmetic_raid_visuals','bound_cosmetic_raid_no_truncate','shardkeep_bound_cosmetic_raid_guard()',34))
  SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||e.rel)
   AND t.tgname=e.name AND t.tgfoid=to_regprocedure('public.'||e.fn) AND t.tgtype=e.kind AND t.tgenabled='O'
   AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL)
   OR(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||e.rel) AND NOT t.tgisinternal)<>2)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PRIVATE_SOURCE';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.bound_cosmetic_charter_contract(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 previous_sha256 text NOT NULL CHECK(previous_sha256~'^[0-9a-f]{64}$'),record jsonb NOT NULL
);
REVOKE ALL ON public.bound_cosmetic_charter_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_visual_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('retirement',public.shardkeep_charter_retirement_fingerprint(),
 'predecessors',jsonb_build_object(
  'first',(SELECT to_jsonb(x) FROM public.charter_retirement_contract x WHERE singleton),
  'projection',(SELECT to_jsonb(x) FROM public.charter_retirement_projection_contract x WHERE singleton),
  'draft',(SELECT to_jsonb(x) FROM public.charter_retirement_draft_contract x WHERE singleton),
  'migration',(SELECT to_jsonb(x) FROM public.charter_migration_contract x WHERE singleton)),
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),
  'kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'hasSubclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid,i.inhparent,i.inhseqno) ORDER BY i.inhrelid,i.inhparent,i.inhseqno) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,to_jsonb(a.attacl),pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid)))
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['bound_cosmetic_preferences','bound_cosmetic_raid_visuals','bound_cosmetic_charter_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',to_jsonb(p.proconfig),
  -- The two public projection readers receive only the explicitly allowed
  -- runtime-group EXECUTE grants below; all other function ACLs stay exact.
  'acl',CASE WHEN p.proname IN('shardkeep_bound_cosmetic_base_visual','shardkeep_bound_cosmetic_raid_visual') THEN NULL ELSE to_jsonb(p.proacl) END,
  'definition',pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY[
   'shardkeep_bound_cosmetic_market_awnings','shardkeep_bound_cosmetic_preference_guard','shardkeep_bound_cosmetic_base_visual',
   'shardkeep_bound_cosmetic_raid_capture','shardkeep_bound_cosmetic_raid_guard','shardkeep_bound_cosmetic_raid_visual',
   'shardkeep_bound_cosmetic_visual_contract','shardkeep_bound_cosmetic_visual_sources_valid','shardkeep_bound_cosmetic_visual_seal_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND(t.tgrelid IN('public.bound_cosmetic_preferences'::regclass,'public.bound_cosmetic_raid_visuals'::regclass,'public.bound_cosmetic_charter_contract'::regclass)
   OR(t.tgrelid='public.raids'::regclass AND t.tgname='bound_cosmetic_raid_capture'))))
$$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_visual_contract() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_visual_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.bound_cosmetic_charter_contract'::regclass)
 AND public.shardkeep_bound_cosmetic_return_sources_valid()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.pronamespace='public'::regnamespace AND p.proname IN('shardkeep_bound_cosmetic_base_visual','shardkeep_bound_cosmetic_raid_visual')
   AND a.grantee<>p.proowner AND(a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>p.proowner
    OR a.grantee NOT IN(coalesce(to_regrole('shardkeep_api_runtime')::oid,0),coalesce(to_regrole('shardkeep_worker_runtime')::oid,0)) OR a.grantee=0))
 AND EXISTS(SELECT 1 FROM public.bound_cosmetic_charter_contract c JOIN public.charter_migration_contract p ON p.singleton=c.singleton
  WHERE c.singleton AND c.previous_sha256=p.source_sha256 AND c.record=public.shardkeep_bound_cosmetic_visual_contract())
$$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_visual_sources_valid() FROM PUBLIC;
--> statement-breakpoint
-- Preserve the full retained chain and both original dependent hook checks.
-- This validator's own new body is included by the retirement fingerprint.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_source() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS(SELECT 1 FROM public.bound_cosmetic_charter_contract successor
  JOIN public.charter_migration_contract next ON next.singleton=successor.singleton
  JOIN public.charter_retirement_draft_contract draft ON draft.singleton=next.singleton
  JOIN public.charter_retirement_projection_contract projection ON projection.singleton=next.singleton
  JOIN public.charter_retirement_contract first ON first.singleton=next.singleton
  WHERE successor.singleton AND projection.previous_sha256=first.source_sha256 AND draft.previous_sha256=projection.source_sha256
   AND next.previous_sha256=draft.source_sha256 AND successor.previous_sha256=next.source_sha256)
  OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();PERFORM public.shardkeep_charter_tournament_hooks();
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_visual_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.bound_cosmetic_charter_contract'::regclass OR TG_NAME<>'bound_cosmetic_visual_seal_guard'
 OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR current_user<>session_user
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_SEAL_IMMUTABLE';END IF;
 IF EXISTS(SELECT 1 FROM public.bound_cosmetic_charter_contract) OR NEW.singleton IS DISTINCT FROM true
 OR NEW.previous_sha256 IS DISTINCT FROM(SELECT source_sha256 FROM public.charter_migration_contract WHERE singleton)
 OR NEW.record IS DISTINCT FROM public.shardkeep_bound_cosmetic_visual_contract()
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_SEAL_IMMUTABLE';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  AND c.relname=ANY(ARRAY['bound_cosmetic_preferences','bound_cosmetic_raid_visuals','bound_cosmetic_charter_contract'])
  AND(c.relowner<>current_user::regrole::oid OR c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND x.grantee<>c.relowner)))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PRIVATE_SOURCE';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY[
  'shardkeep_bound_cosmetic_market_awnings','shardkeep_bound_cosmetic_preference_guard','shardkeep_bound_cosmetic_base_visual',
  'shardkeep_bound_cosmetic_raid_capture','shardkeep_bound_cosmetic_raid_guard','shardkeep_bound_cosmetic_raid_visual',
  'shardkeep_bound_cosmetic_visual_contract','shardkeep_bound_cosmetic_visual_sources_valid','shardkeep_bound_cosmetic_visual_seal_guard'])
  AND(p.proowner<>current_user::regrole::oid OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
   AND(p.proname NOT IN('shardkeep_bound_cosmetic_base_visual','shardkeep_bound_cosmetic_raid_visual') OR a.grantee=0 OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>p.proowner
    OR a.grantee NOT IN(coalesce(to_regrole('shardkeep_api_runtime')::oid,0),coalesce(to_regrole('shardkeep_worker_runtime')::oid,0))))))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_VISUAL_PRIVATE_SOURCE';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_visual_seal_guard() FROM PUBLIC;
CREATE TRIGGER bound_cosmetic_visual_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_charter_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_visual_seal_guard();
CREATE TRIGGER bound_cosmetic_visual_seal_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_charter_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_visual_seal_guard();
INSERT INTO public.bound_cosmetic_charter_contract(previous_sha256,record)
 SELECT source_sha256,public.shardkeep_bound_cosmetic_visual_contract() FROM public.charter_migration_contract WHERE singleton;
SELECT public.shardkeep_charter_retirement_source(),public.shardkeep_charter_tournament_source_check();
