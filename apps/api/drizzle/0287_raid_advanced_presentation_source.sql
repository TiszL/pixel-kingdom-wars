-- Exact two-function successor; prior seal rows and cosmetic validators unchanged.
SET LOCAL lock_timeout='10s';
DO $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.raid_starter_presentation_contract'::regclass)
 OR(SELECT record FROM public.raid_starter_presentation_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_raid_starter_contract()
 THEN RAISE EXCEPTION 'RAID_ADVANCED_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.raid_advanced_presentation_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.raid_advanced_presentation_contract FROM PUBLIC;
CREATE FUNCTION public.shardkeep_raid_advanced_predecessor() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(public.shardkeep_raid_starter_contract(),'{functions}',
  (public.shardkeep_raid_starter_contract()->'functions')||jsonb_build_object(
  'shardkeep_raid_starter_retirement_predecessor()',record#>'{functions,shardkeep_raid_starter_retirement_predecessor()}',
  'shardkeep_raid_starter_sources_valid()',record#>'{functions,shardkeep_raid_starter_sources_valid()}'))
 FROM public.raid_starter_presentation_contract WHERE singleton
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_raid_starter_retirement_predecessor() RETURNS text
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
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(c.relname='raids' AND t.tgname IN('raid_starter_capture','raid_advanced_capture')) AND c.relnamespace='public'::regnamespace
   AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts')))
 )::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'previous',(SELECT record FROM public.raid_starter_presentation_contract WHERE singleton),
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'subclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid::regclass::text,i.inhparent::regclass::text) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid))) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('raid_advanced_presentations','raid_advanced_presentation_contract')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'acl',CASE WHEN p.proname IN('shardkeep_raid_advanced_presentation','shardkeep_raid_advanced_candidate') THEN NULL ELSE p.proacl::text END,'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(left(p.proname,length('shardkeep_raid_advanced_'))='shardkeep_raid_advanced_' OR p.proname IN('shardkeep_raid_starter_retirement_predecessor','shardkeep_raid_starter_sources_valid'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND(t.tgrelid IN('public.raid_advanced_presentations'::regclass,'public.raid_advanced_presentation_contract'::regclass)
   OR(t.tgrelid='public.raids'::regclass AND t.tgname='raid_advanced_capture'))))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH expected(name,source,definer) AS(VALUES
 ('shardkeep_raid_advanced_projection','a101345e97a8b57f2b49a0d80febb92ff0dd5d3b2d46bc14045c277a3640231e',false),
 ('shardkeep_raid_advanced_candidate','16d846292eeb5106ee86042355ec017a76ac2fb376bbe67f9a88159aea0a4bc5',true),
 ('shardkeep_raid_advanced_guard','ac6f77abf44e5a6b58f65fb551185e019da4a784e94c2f4e5fed6243611328a9',false),
 ('shardkeep_raid_advanced_capture','db65a5c0d361e0c827baf4a932ad0cfdc8a16c9222ca69e4dfa137447899e88b',true),
 ('shardkeep_raid_advanced_presentation','b742fbca1da102957c970b864ab12290f6a8de0f2b761aeb53e4621b467989d0',true),
 ('shardkeep_raid_starter_retirement_predecessor','44f2633a42518c2d9dd54d9f8698f52b350d5565cc15e82e9b4a4758a3702522',false),
 ('shardkeep_raid_starter_sources_valid','a6b1040ab566e2203b2c2eb673e8fbebe2aa6f237e7fa826f82a5ab6d0d59a98',false))
 SELECT NOT EXISTS(SELECT 1 FROM expected e WHERE(SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=e.name)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=e.name
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.source AND p.prosecdef=e.definer AND p.proowner=current_user::regrole::oid
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']))
 AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.raids'::regclass AND t.tgname='raid_advanced_capture'
  AND t.tgtype=5 AND t.tgenabled='O' AND t.tgfoid='public.shardkeep_raid_advanced_capture()'::regprocedure
  AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid='public.raid_advanced_presentations'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  ='[["raid_id","uuid",true],["defender_base_id","uuid",true],["defender_wallet","text",true],["captured_at","timestamp with time zone",true],["snapshot_sha256","text",true],["facts","jsonb",true],["source_record","jsonb",true]]'::jsonb
 AND NOT EXISTS(WITH expected(rel,name,fn,kind) AS(VALUES
  ('raid_advanced_presentations','raid_advanced_guard','shardkeep_raid_advanced_guard()',31),
  ('raid_advanced_presentations','raid_advanced_no_truncate','shardkeep_raid_advanced_guard()',34),
  ('raid_advanced_presentation_contract','raid_advanced_seal_guard','shardkeep_raid_advanced_seal_guard()',31),
  ('raid_advanced_presentation_contract','raid_advanced_seal_no_truncate','shardkeep_raid_advanced_seal_guard()',34))
  SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
   WHERE t.tgrelid=to_regclass('public.'||e.rel) AND t.tgname=e.name AND t.tgfoid=to_regprocedure('public.'||e.fn)
    AND t.tgtype=e.kind AND t.tgenabled='O' AND NOT t.tgisinternal AND NOT t.tgdeferrable
    AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.raid_advanced_presentations'::regclass,'public.raid_advanced_presentation_contract'::regclass)
  AND(c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass OR c.relowner<>current_user::regrole::oid
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
   OR(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)<>2
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee<>c.relowner)))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.raid_advanced_presentation_contract'::regclass)
 AND public.shardkeep_raid_advanced_private_source()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid IN('public.shardkeep_raid_advanced_presentation(uuid)'::regprocedure,'public.shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz)'::regprocedure)
  AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(
   SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.raid_advanced_presentations'::regclass,'public.raid_advanced_presentation_contract'::regclass)
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND(SELECT record FROM public.raid_advanced_presentation_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_raid_advanced_contract()
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_raid_starter_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.raid_starter_presentation_contract'::regclass)
 AND public.shardkeep_raid_starter_private_source()
 AND public.shardkeep_raid_advanced_sources_valid()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.shardkeep_raid_starter_presentation(uuid)'::regprocedure
  AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(
   SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.raid_starter_presentations'::regclass,'public.raid_starter_presentation_contract'::regclass)
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND(SELECT record FROM public.raid_starter_presentation_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_raid_advanced_predecessor()
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.raid_advanced_presentation_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'raid_advanced_seal_guard' OR current_user<>session_user
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.raid_advanced_presentation_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'RAID_ADVANCED_SEAL_IMMUTABLE';END IF;
 IF (SELECT record FROM public.raid_starter_presentation_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_raid_advanced_predecessor()
 OR NOT public.shardkeep_raid_advanced_private_source() OR NOT public.shardkeep_bound_cosmetic_wake_predecessor_valid()
 OR(SELECT record FROM public.bound_cosmetic_wake_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_raid_starter_wake_predecessor()
 OR NEW.record IS DISTINCT FROM public.shardkeep_raid_advanced_contract()
 THEN RAISE EXCEPTION 'RAID_ADVANCED_SEAL_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER raid_advanced_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.raid_advanced_presentation_contract
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raid_advanced_seal_guard();
CREATE TRIGGER raid_advanced_seal_no_truncate BEFORE TRUNCATE ON public.raid_advanced_presentation_contract
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_raid_advanced_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_raid_advanced_predecessor(),public.shardkeep_raid_advanced_contract(),public.shardkeep_raid_advanced_private_source(),public.shardkeep_raid_advanced_sources_valid(),public.shardkeep_raid_advanced_seal_guard() FROM PUBLIC;
INSERT INTO public.raid_advanced_presentation_contract(record) SELECT public.shardkeep_raid_advanced_contract();
SELECT public.shardkeep_charter_retirement_source(),public.shardkeep_divine_fragment_source();
DO $$BEGIN IF NOT public.shardkeep_raid_starter_sources_valid() OR NOT public.shardkeep_bound_cosmetic_wake_sources_valid()
 THEN RAISE EXCEPTION 'RAID_ADVANCED_FINAL_SOURCE';END IF;END $$;
