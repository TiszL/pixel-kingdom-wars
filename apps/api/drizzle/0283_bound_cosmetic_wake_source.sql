-- Additive Wake source admission. Keep 0278–0281 files and seal rows unchanged.
-- Only the two exact capture hooks and two validator entry bodies differ.
SET LOCAL lock_timeout='10s';
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_advanced_predecessor() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH relations AS (
  SELECT c.oid,c.relname,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND (c.relname IN('advanced_vehicle_installations','advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies',
   'ordinary_equipment_jobs','ordinary_equipment_completions','ordinary_equipment_stocks','ordinary_equipment_reservations','ordinary_equipment_releases','ordinary_equipment_secondary_outputs','ordinary_equipment_secondary_returns','ordinary_equipment_secondary_entries',
   'expedition_term_snapshots','resource_stock_operations','resource_stock_entries','resource_stocks'))
 ), functions AS (
  SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prolang,p.prorettype,p.proargtypes::text args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.oid IN(SELECT t.tgfoid FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(r.relname='advanced_expeditions' AND t.tgname='bound_cosmetic_advanced_wake_capture'))
   OR p.proname IN('shardkeep_vehicle_lifecycle','shardkeep_vehicle_service_state_v214','shardkeep_vehicle_service_effect_v214','shardkeep_vehicle_service_proof_valid_v214','shardkeep_advanced_return_fingerprint','shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence'))
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'relations',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner) ORDER BY relname) FROM relations),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc,'owner',proowner,'definer',prosecdef,'config',proconfig,'language',prolang,'returns',prorettype,'args',args,
   'acl',CASE WHEN proname IN('shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence') THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a) END) ORDER BY proname,args) FROM functions),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,'function',t.tgfoid,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initial',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(r.relname='advanced_expeditions' AND t.tgname='bound_cosmetic_advanced_wake_capture')),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(r.relname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid)
 )::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_starter_predecessor() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH relations AS (
  SELECT c.oid,c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN('starter_expeditions','starter_expedition_inflight','starter_expedition_returns','starter_expedition_entries','fleet_installations')
 ), functions AS (
  SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prolang,p.prorettype,p.proargtypes::text args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.oid IN(SELECT t.tgfoid FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(r.relname='starter_expeditions' AND t.tgname='bound_cosmetic_starter_wake_capture'))
   OR p.proname IN('shardkeep_starter_return_fingerprint','shardkeep_finish_starter_equipment'))
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'advanced',public.shardkeep_bound_cosmetic_wake_advanced_predecessor(),
  'relations',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner) ORDER BY relname) FROM relations),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc,'owner',proowner,'definer',prosecdef,'config',proconfig,'language',prolang,'returns',prorettype,'args',args,
   'acl',CASE WHEN proname='shardkeep_finish_starter_equipment' THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a) END) ORDER BY proname,args) FROM functions),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,'function',t.tgfoid,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initial',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(r.relname='starter_expeditions' AND t.tgname='bound_cosmetic_starter_wake_capture')),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(r.relname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid)
 )::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_predecessor_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH old AS(SELECT record FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton),
 normalized AS(SELECT jsonb_set(public.shardkeep_divine_fragment_contract(),'{functions}',
  (public.shardkeep_divine_fragment_contract()->'functions')||jsonb_build_object(
   'shardkeep_bound_cosmetic_return_sources_valid()',old.record#>'{functions,shardkeep_bound_cosmetic_return_sources_valid()}',
   'shardkeep_divine_fragment_source()',old.record#>'{functions,shardkeep_divine_fragment_source()}')) value FROM old)
 SELECT (SELECT value FROM normalized) IS NOT DISTINCT FROM(SELECT record FROM old)
 AND (SELECT record FROM public.bound_cosmetic_return_contract WHERE singleton) IS NOT DISTINCT FROM
  jsonb_build_object('advanced',public.shardkeep_bound_cosmetic_wake_advanced_predecessor(),
   'starter',public.shardkeep_bound_cosmetic_wake_starter_predecessor(),
   'predecessors',jsonb_build_object('advanced',(SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton),
    'starter',(SELECT source_sha256 FROM public.ordinary_equipment_starter_return_seal WHERE singleton)),
   'sources',(SELECT value FROM normalized))
 AND EXISTS(SELECT 1 FROM public.bound_cosmetic_charter_contract c JOIN public.charter_migration_contract p ON p.singleton=c.singleton
  WHERE c.singleton AND c.previous_sha256=p.source_sha256 AND c.record=public.shardkeep_bound_cosmetic_visual_contract())
$$;
--> statement-breakpoint
-- Freeze the eight source bodies authored in 0282 before admitting this successor.
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(WITH expected(signature,body_sha256,definer,volatility,language_name,return_name) AS(VALUES
  ('shardkeep_bound_cosmetic_wake_selection(text,timestamptz)','1cc02ff077a3ad9b773940484c92ebe0f0fd99a14e1f46d91628ddde3370aa1c',false,'s','plpgsql','jsonb'),
  ('shardkeep_bound_cosmetic_wake_preference_guard()','aa3ff727c74e3a2d2efd9f4d32c13ce1a93170838a4714295331d1d555513d78',false,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_wake_preference(text,boolean,bigint,timestamptz)','5819e1ac9bfc323b473d2b17208c451f7ef0981f8f847a281d7b7ccde01395c2',false,'v','plpgsql','jsonb'),
  ('shardkeep_bound_cosmetic_wake_guard()','153eb5fb17f9aa3d386610fda4eeda923236b7bbe2753f649027a2be24bd79dc',false,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_starter_wake_capture()','a00654ef1af8362dbe679659ab79a8dfdf7fc230779a7846cd34f6fec1434ea9',true,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_advanced_wake_capture()','b1ce6da70920335b9371c5cb84a518da420b0585431677883638ae861bafb77b',true,'v','plpgsql','trigger'),
  ('shardkeep_bound_cosmetic_starter_wake(uuid)','cc3a22345296ca2d3bef2ad7faf5e278357d426af83e1f77da65a0a97c37f332',true,'s','plpgsql','jsonb'),
  ('shardkeep_bound_cosmetic_advanced_wake(uuid)','1243f66b39d522f2c27daed971561f05c115f8233d9c7bcd47b97291072700ed',true,'s','plpgsql','jsonb')
 ) SELECT 1 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature) LEFT JOIN pg_language l ON l.oid=p.prolang
 WHERE p.oid IS NULL OR p.proowner<>current_user::regrole::oid OR p.prosecdef IS DISTINCT FROM e.definer
  OR p.provolatile::text<>e.volatility OR l.lanname<>e.language_name OR p.prorettype<>to_regtype(e.return_name)
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  OR p.prokind<>'f' OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u'
  OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>e.body_sha256)
 AND NOT EXISTS(WITH expected(rel,columns,defs) AS(VALUES
  ('bound_cosmetic_wake_preferences','[["wallet","text",true],["enabled","boolean",true],["revision","bigint",true],["updated_at","timestamp with time zone",true]]'::jsonb,
   '["CHECK ((revision > 0))","CHECK (isfinite(updated_at))","FOREIGN KEY (wallet) REFERENCES players(wallet)","PRIMARY KEY (wallet)"]'::jsonb),
  ('bound_cosmetic_starter_wakes','[["expedition_id","uuid",true],["visual","jsonb",true],["selection_record","jsonb",true]]'::jsonb,
   '["FOREIGN KEY (expedition_id) REFERENCES starter_expeditions(id)","PRIMARY KEY (expedition_id)"]'::jsonb),
  ('bound_cosmetic_advanced_wakes','[["expedition_id","uuid",true],["visual","jsonb",true],["selection_record","jsonb",true]]'::jsonb,
   '["FOREIGN KEY (expedition_id) REFERENCES advanced_expeditions(id)","PRIMARY KEY (expedition_id)"]'::jsonb))
 SELECT 1 FROM expected e WHERE e.columns IS DISTINCT FROM(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
   FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||e.rel) AND a.attnum>0 AND NOT a.attisdropped)
  OR e.defs IS DISTINCT FROM(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=to_regclass('public.'||e.rel))
  OR EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('public.'||e.rel) AND NOT k.convalidated)
  OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||e.rel) AND a.attnum>0 AND NOT a.attisdropped
   AND(a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'' OR NOT a.attislocal OR a.attinhcount<>0))
  OR EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=to_regclass('public.'||e.rel))
  OR(SELECT count(*) FROM pg_index i WHERE i.indrelid=to_regclass('public.'||e.rel))<>1
  OR EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=to_regclass('public.'||e.rel) AND(NOT i.indisvalid OR NOT i.indisready)))
 AND NOT EXISTS(WITH expected(rel,name,fn,kind) AS(VALUES
  ('bound_cosmetic_wake_preferences','bound_cosmetic_wake_preference_guard','shardkeep_bound_cosmetic_wake_preference_guard()',31),
  ('bound_cosmetic_wake_preferences','bound_cosmetic_wake_preference_no_truncate','shardkeep_bound_cosmetic_wake_preference_guard()',34),
  ('bound_cosmetic_starter_wakes','bound_cosmetic_wake_guard','shardkeep_bound_cosmetic_wake_guard()',31),
  ('bound_cosmetic_starter_wakes','bound_cosmetic_wake_no_truncate','shardkeep_bound_cosmetic_wake_guard()',34),
  ('bound_cosmetic_advanced_wakes','bound_cosmetic_wake_guard','shardkeep_bound_cosmetic_wake_guard()',31),
  ('bound_cosmetic_advanced_wakes','bound_cosmetic_wake_no_truncate','shardkeep_bound_cosmetic_wake_guard()',34),
  ('starter_expeditions','bound_cosmetic_starter_wake_capture','shardkeep_bound_cosmetic_starter_wake_capture()',5),
  ('advanced_expeditions','bound_cosmetic_advanced_wake_capture','shardkeep_bound_cosmetic_advanced_wake_capture()',5))
 SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||e.rel)
  AND t.tgname=e.name AND t.tgfoid=to_regprocedure('public.'||e.fn) AND t.tgtype=e.kind AND t.tgenabled='O'
  AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.bound_cosmetic_wake_preferences'::regclass,'public.bound_cosmetic_starter_wakes'::regclass,'public.bound_cosmetic_advanced_wakes'::regclass)
  AND(c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass OR c.relowner<>current_user::regrole::oid
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
   OR(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)<>2
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee<>c.relowner)))
$$;
DO $$BEGIN
 IF NOT public.shardkeep_bound_cosmetic_wake_private_source() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PRIVATE_SOURCE';END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_predecessor_valid()
 OR(SELECT record FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract()
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.bound_cosmetic_wake_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.bound_cosmetic_wake_contract FROM PUBLIC;
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'return',public.shardkeep_bound_cosmetic_return_contract(),
 'previous',jsonb_build_object('return',(SELECT record FROM public.bound_cosmetic_return_contract WHERE singleton),
  'divine',(SELECT record FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton),
  'visual',(SELECT to_jsonb(c) FROM public.bound_cosmetic_charter_contract c WHERE singleton)),
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'subclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid::regclass::text,i.inhparent::regclass::text) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid))) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['bound_cosmetic_wake_preferences','bound_cosmetic_starter_wakes','bound_cosmetic_advanced_wakes','bound_cosmetic_wake_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'acl',CASE WHEN p.proname IN('shardkeep_bound_cosmetic_starter_wake','shardkeep_bound_cosmetic_advanced_wake') THEN NULL ELSE p.proacl::text END,
  'definition',pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['shardkeep_bound_cosmetic_wake_selection','shardkeep_bound_cosmetic_wake_preference_guard','shardkeep_bound_cosmetic_wake_preference','shardkeep_bound_cosmetic_wake_guard','shardkeep_bound_cosmetic_starter_wake_capture','shardkeep_bound_cosmetic_advanced_wake_capture','shardkeep_bound_cosmetic_starter_wake','shardkeep_bound_cosmetic_advanced_wake','shardkeep_bound_cosmetic_wake_advanced_predecessor','shardkeep_bound_cosmetic_wake_starter_predecessor','shardkeep_bound_cosmetic_wake_predecessor_valid','shardkeep_bound_cosmetic_wake_private_source','shardkeep_bound_cosmetic_wake_contract','shardkeep_bound_cosmetic_wake_sources_valid','shardkeep_bound_cosmetic_wake_seal_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace
   AND(c.relname=ANY(ARRAY['bound_cosmetic_wake_preferences','bound_cosmetic_starter_wakes','bound_cosmetic_advanced_wakes','bound_cosmetic_wake_contract']) OR(c.relname='starter_expeditions' AND t.tgname='bound_cosmetic_starter_wake_capture') OR(c.relname='advanced_expeditions' AND t.tgname='bound_cosmetic_advanced_wake_capture'))))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.bound_cosmetic_wake_contract'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,15)='bound_cosmetic_' AND c.relkind='r'
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid IN('public.shardkeep_bound_cosmetic_starter_wake(uuid)'::regprocedure,'public.shardkeep_bound_cosmetic_advanced_wake(uuid)'::regprocedure)
   AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND public.shardkeep_bound_cosmetic_wake_predecessor_valid()
 AND(SELECT record FROM public.bound_cosmetic_wake_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_bound_cosmetic_wake_contract()
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_bound_cosmetic_return_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.bound_cosmetic_return_contract'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,15)='bound_cosmetic_' AND c.relkind='r'
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND public.shardkeep_bound_cosmetic_wake_sources_valid()
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_sources_valid() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.bound_cosmetic_wake_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'bound_cosmetic_wake_seal_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.bound_cosmetic_wake_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_SEAL_IMMUTABLE';END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_private_source() OR NOT public.shardkeep_bound_cosmetic_wake_predecessor_valid()
 OR NEW.record IS DISTINCT FROM public.shardkeep_bound_cosmetic_wake_contract()
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_SEAL_SOURCE';END IF;
 IF(SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['shardkeep_bound_cosmetic_wake_selection','shardkeep_bound_cosmetic_wake_preference_guard','shardkeep_bound_cosmetic_wake_preference','shardkeep_bound_cosmetic_wake_guard','shardkeep_bound_cosmetic_starter_wake_capture','shardkeep_bound_cosmetic_advanced_wake_capture','shardkeep_bound_cosmetic_starter_wake','shardkeep_bound_cosmetic_advanced_wake','shardkeep_bound_cosmetic_wake_advanced_predecessor','shardkeep_bound_cosmetic_wake_starter_predecessor','shardkeep_bound_cosmetic_wake_predecessor_valid','shardkeep_bound_cosmetic_wake_private_source','shardkeep_bound_cosmetic_wake_contract','shardkeep_bound_cosmetic_wake_sources_valid','shardkeep_bound_cosmetic_wake_seal_guard']))<>15
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['shardkeep_bound_cosmetic_wake_selection','shardkeep_bound_cosmetic_wake_preference_guard','shardkeep_bound_cosmetic_wake_preference','shardkeep_bound_cosmetic_wake_guard','shardkeep_bound_cosmetic_starter_wake_capture','shardkeep_bound_cosmetic_advanced_wake_capture','shardkeep_bound_cosmetic_starter_wake','shardkeep_bound_cosmetic_advanced_wake','shardkeep_bound_cosmetic_wake_advanced_predecessor','shardkeep_bound_cosmetic_wake_starter_predecessor','shardkeep_bound_cosmetic_wake_predecessor_valid','shardkeep_bound_cosmetic_wake_private_source','shardkeep_bound_cosmetic_wake_contract','shardkeep_bound_cosmetic_wake_sources_valid','shardkeep_bound_cosmetic_wake_seal_guard'])
  AND(p.proowner<>current_user::regrole::oid OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PRIVATE_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bound_cosmetic_wake_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_wake_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_seal_guard();
CREATE TRIGGER bound_cosmetic_wake_seal_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_wake_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_wake_selection(text,timestamptz),public.shardkeep_bound_cosmetic_wake_preference_guard(),public.shardkeep_bound_cosmetic_wake_preference(text,boolean,bigint,timestamptz),public.shardkeep_bound_cosmetic_wake_guard(),public.shardkeep_bound_cosmetic_starter_wake_capture(),public.shardkeep_bound_cosmetic_advanced_wake_capture(),public.shardkeep_bound_cosmetic_starter_wake(uuid),public.shardkeep_bound_cosmetic_advanced_wake(uuid),public.shardkeep_bound_cosmetic_wake_advanced_predecessor(),public.shardkeep_bound_cosmetic_wake_starter_predecessor(),public.shardkeep_bound_cosmetic_wake_predecessor_valid(),public.shardkeep_bound_cosmetic_wake_private_source(),public.shardkeep_bound_cosmetic_wake_contract(),public.shardkeep_bound_cosmetic_wake_sources_valid(),public.shardkeep_bound_cosmetic_wake_seal_guard() FROM PUBLIC;
INSERT INTO public.bound_cosmetic_wake_contract(record) SELECT public.shardkeep_bound_cosmetic_wake_contract();
SELECT public.shardkeep_divine_fragment_source();
DO $$BEGIN IF NOT public.shardkeep_bound_cosmetic_visual_sources_valid() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_VISUAL_SOURCE';END IF;END $$;
