-- Exact additive successor for one new raid hook. Old source files and seal rows stay immutable.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_starter_retirement_predecessor() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proargtypes::text,
  CASE WHEN p.proname LIKE 'shardkeep_charter_retirement_%' THEN p.proacl::text ELSE NULL END) ORDER BY p.proname,p.proargtypes::text)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(p.proname LIKE 'shardkeep_charter_%' OR p.proname LIKE 'shardkeep_clan_charter_%')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,CASE WHEN c.relname LIKE 'charter_retirement%' THEN c.relacl::text ELSE NULL END,
  (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid)) ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(c.relname='raids' AND t.tgname='raid_starter_capture') AND c.relnamespace='public'::regnamespace
   AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts')))
 )::text,'UTF8')),'hex')
$$;
CREATE FUNCTION public.shardkeep_raid_starter_visual_predecessor() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(jsonb_set(public.shardkeep_bound_cosmetic_visual_contract(),'{retirement}',to_jsonb(public.shardkeep_raid_starter_retirement_predecessor())),
 '{functions}',(public.shardkeep_bound_cosmetic_visual_contract()->'functions')||jsonb_build_object(
 'shardkeep_bound_cosmetic_visual_sources_valid()',record#>'{functions,shardkeep_bound_cosmetic_visual_sources_valid()}'))
 FROM public.bound_cosmetic_charter_contract WHERE singleton
$$;
CREATE FUNCTION public.shardkeep_raid_starter_wake_predecessor() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(public.shardkeep_bound_cosmetic_wake_contract(),'{functions}',
 (public.shardkeep_bound_cosmetic_wake_contract()->'functions')||jsonb_build_object(
 'shardkeep_bound_cosmetic_wake_predecessor_valid()',record#>'{functions,shardkeep_bound_cosmetic_wake_predecessor_valid()}',
 'shardkeep_bound_cosmetic_wake_sources_valid()',record#>'{functions,shardkeep_bound_cosmetic_wake_sources_valid()}'))
 FROM public.bound_cosmetic_wake_contract WHERE singleton
$$;

--> statement-breakpoint
DO $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.bound_cosmetic_wake_contract'::regclass)
 OR(public.shardkeep_bound_cosmetic_visual_contract()#>'{functions,shardkeep_bound_cosmetic_visual_sources_valid()}')
  IS DISTINCT FROM(SELECT record#>'{functions,shardkeep_bound_cosmetic_visual_sources_valid()}' FROM public.bound_cosmetic_charter_contract WHERE singleton)
 OR(public.shardkeep_bound_cosmetic_wake_contract()#>'{functions,shardkeep_bound_cosmetic_wake_predecessor_valid()}')
  IS DISTINCT FROM(SELECT record#>'{functions,shardkeep_bound_cosmetic_wake_predecessor_valid()}' FROM public.bound_cosmetic_wake_contract WHERE singleton)
 OR(public.shardkeep_bound_cosmetic_wake_contract()#>'{functions,shardkeep_bound_cosmetic_wake_sources_valid()}')
  IS DISTINCT FROM(SELECT record#>'{functions,shardkeep_bound_cosmetic_wake_sources_valid()}' FROM public.bound_cosmetic_wake_contract WHERE singleton)
 OR(SELECT record FROM public.bound_cosmetic_charter_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_raid_starter_visual_predecessor()
 OR(SELECT record FROM public.bound_cosmetic_wake_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_raid_starter_wake_predecessor()
 THEN RAISE EXCEPTION 'RAID_STARTER_PREDECESSOR';END IF;
END $$;

--> statement-breakpoint
CREATE TABLE public.raid_starter_presentation_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.raid_starter_presentation_contract FROM PUBLIC;
CREATE FUNCTION public.shardkeep_raid_starter_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'previous',jsonb_build_object('visual',(SELECT to_jsonb(c) FROM public.bound_cosmetic_charter_contract c WHERE singleton),
  'wake',(SELECT record FROM public.bound_cosmetic_wake_contract WHERE singleton)),
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'subclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid::regclass::text,i.inhparent::regclass::text) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid))) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('raid_starter_presentations','raid_starter_presentation_contract')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'acl',CASE WHEN p.proname='shardkeep_raid_starter_presentation' THEN NULL ELSE p.proacl::text END,'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(left(p.proname,length('shardkeep_raid_starter_'))='shardkeep_raid_starter_' OR p.proname IN('shardkeep_bound_cosmetic_visual_sources_valid','shardkeep_bound_cosmetic_wake_predecessor_valid','shardkeep_bound_cosmetic_wake_sources_valid'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND(t.tgrelid IN('public.raid_starter_presentations'::regclass,'public.raid_starter_presentation_contract'::regclass)
   OR(t.tgrelid='public.raids'::regclass AND t.tgname='raid_starter_capture'))))
$$;

--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_starter_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH expected(name,source,definer) AS(VALUES
 ('shardkeep_raid_starter_projection','70b27504b61578ee03d3a2c031ed7cd438e7da44e53c383a64cd0046b22f8b50',false),
 ('shardkeep_raid_starter_guard','95214b53303128baf623514e468decae405d9256fe9f3d0bb2bcc9e24ab060b5',false),
 ('shardkeep_raid_starter_capture','b6f9f485841a8ac6cf677bee2b2a6af2a03d91b788950c547d99365dcbd1db0a',true),
 ('shardkeep_raid_starter_presentation','74b02f5726eb3d568962e301b7d770b4d9165721ee12ff5153a3cac42fb7926a',true))
 SELECT NOT EXISTS(SELECT 1 FROM expected e WHERE(SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=e.name)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=e.name
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.source AND p.prosecdef=e.definer AND p.proowner=current_user::regrole::oid
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']))
 AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.raids'::regclass AND t.tgname='raid_starter_capture'
  AND t.tgtype=5 AND t.tgenabled='O' AND t.tgfoid='public.shardkeep_raid_starter_capture()'::regprocedure
  AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid='public.raid_starter_presentations'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  ='[["raid_id","uuid",true],["defender_base_id","uuid",true],["defender_wallet","text",true],["captured_at","timestamp with time zone",true],["snapshot_sha256","text",true],["presentation","jsonb",true]]'::jsonb
 AND NOT EXISTS(WITH expected(rel,name,fn,kind) AS(VALUES
  ('raid_starter_presentations','raid_starter_guard','shardkeep_raid_starter_guard()',31),
  ('raid_starter_presentations','raid_starter_no_truncate','shardkeep_raid_starter_guard()',34),
  ('raid_starter_presentation_contract','raid_starter_seal_guard','shardkeep_raid_starter_seal_guard()',31),
  ('raid_starter_presentation_contract','raid_starter_seal_no_truncate','shardkeep_raid_starter_seal_guard()',34))
  SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
   WHERE t.tgrelid=to_regclass('public.'||e.rel) AND t.tgname=e.name AND t.tgfoid=to_regprocedure('public.'||e.fn)
    AND t.tgtype=e.kind AND t.tgenabled='O' AND NOT t.tgisinternal AND NOT t.tgdeferrable
    AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.raid_starter_presentations'::regclass,'public.raid_starter_presentation_contract'::regclass)
  AND(c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass OR c.relowner<>current_user::regrole::oid
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
   OR(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)<>2
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee<>c.relowner)))
$$;

--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_starter_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.raid_starter_presentation_contract'::regclass)
 AND public.shardkeep_raid_starter_private_source()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.shardkeep_raid_starter_presentation(uuid)'::regprocedure
  AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(
   SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.raid_starter_presentations'::regclass,'public.raid_starter_presentation_contract'::regclass)
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND(SELECT record FROM public.raid_starter_presentation_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_raid_starter_contract()
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_bound_cosmetic_visual_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.bound_cosmetic_charter_contract'::regclass)
 AND public.shardkeep_raid_starter_sources_valid()
 AND public.shardkeep_bound_cosmetic_return_sources_valid()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.pronamespace='public'::regnamespace AND p.proname IN('shardkeep_bound_cosmetic_base_visual','shardkeep_bound_cosmetic_raid_visual')
   AND a.grantee<>p.proowner AND(a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>p.proowner
    OR a.grantee NOT IN(coalesce(to_regrole('shardkeep_api_runtime')::oid,0),coalesce(to_regrole('shardkeep_worker_runtime')::oid,0)) OR a.grantee=0))
 AND EXISTS(SELECT 1 FROM public.bound_cosmetic_charter_contract c JOIN public.charter_migration_contract p ON p.singleton=c.singleton
  WHERE c.singleton AND c.previous_sha256=p.source_sha256 AND c.record=public.shardkeep_raid_starter_visual_predecessor())
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_bound_cosmetic_wake_predecessor_valid() RETURNS boolean
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
  WHERE c.singleton AND c.previous_sha256=p.source_sha256 AND c.record=public.shardkeep_raid_starter_visual_predecessor())
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_bound_cosmetic_wake_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.bound_cosmetic_wake_contract'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,15)='bound_cosmetic_' AND c.relkind='r'
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid IN('public.shardkeep_bound_cosmetic_starter_wake(uuid)'::regprocedure,'public.shardkeep_bound_cosmetic_advanced_wake(uuid)'::regprocedure)
   AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND public.shardkeep_raid_starter_sources_valid()
 AND public.shardkeep_bound_cosmetic_wake_predecessor_valid()
 AND(SELECT record FROM public.bound_cosmetic_wake_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_raid_starter_wake_predecessor()
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_starter_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.raid_starter_presentation_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'raid_starter_seal_guard' OR current_user<>session_user
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.raid_starter_presentation_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'RAID_STARTER_SEAL_IMMUTABLE';END IF;
 IF NOT public.shardkeep_raid_starter_private_source() OR NOT public.shardkeep_bound_cosmetic_wake_predecessor_valid()
 OR(SELECT record FROM public.bound_cosmetic_wake_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_raid_starter_wake_predecessor()
 OR NEW.record IS DISTINCT FROM public.shardkeep_raid_starter_contract()
 THEN RAISE EXCEPTION 'RAID_STARTER_SEAL_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER raid_starter_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.raid_starter_presentation_contract
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raid_starter_seal_guard();
CREATE TRIGGER raid_starter_seal_no_truncate BEFORE TRUNCATE ON public.raid_starter_presentation_contract
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_raid_starter_seal_guard();

REVOKE ALL ON FUNCTION public.shardkeep_raid_starter_retirement_predecessor(),public.shardkeep_raid_starter_visual_predecessor(),public.shardkeep_raid_starter_wake_predecessor(),public.shardkeep_raid_starter_contract(),public.shardkeep_raid_starter_private_source(),public.shardkeep_raid_starter_sources_valid(),public.shardkeep_raid_starter_seal_guard() FROM PUBLIC;
INSERT INTO public.raid_starter_presentation_contract(record) SELECT public.shardkeep_raid_starter_contract();
SELECT public.shardkeep_charter_retirement_source(),public.shardkeep_divine_fragment_source();
DO $$BEGIN IF NOT public.shardkeep_bound_cosmetic_visual_sources_valid() THEN RAISE EXCEPTION 'RAID_STARTER_FINAL_SOURCE';END IF;END $$;
