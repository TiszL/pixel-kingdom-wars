-- Additive current-only source seal. No predecessor originals or seals change.
SET LOCAL lock_timeout='10s';
CREATE TABLE public.current_advanced_presentation_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.current_advanced_presentation_contract FROM PUBLIC;
CREATE FUNCTION public.shardkeep_current_advanced_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'subclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid::regclass::text,i.inhparent::regclass::text) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid))) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('current_advanced_presentation_contract')),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'acl',CASE WHEN p.proname='shardkeep_current_advanced_presentation' THEN NULL ELSE p.proacl::text END,'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_current_advanced_'))='shardkeep_current_advanced_'),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid='public.current_advanced_presentation_contract'::regclass))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_current_advanced_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz)'::regprocedure
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='4a3a524ebed9d8ca19d468fd287e586d1c625129b5dd5b19ec11aca526191927' AND p.prosecdef AND p.provolatile='v'
  AND p.proowner=current_user::regrole::oid AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp'])
 AND(SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='shardkeep_current_advanced_presentation')=1
 AND(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid='public.current_advanced_presentation_contract'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  ='[["singleton","boolean",true],["record","jsonb",true]]'::jsonb
 AND NOT EXISTS(WITH expected(name,kind) AS(VALUES('current_advanced_seal_guard',31),('current_advanced_seal_no_truncate',34))
  SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
   WHERE t.tgrelid='public.current_advanced_presentation_contract'::regclass AND t.tgname=e.name AND t.tgfoid=to_regprocedure('public.shardkeep_current_advanced_seal_guard()')
    AND t.tgtype=e.kind AND t.tgenabled='O' AND NOT t.tgisinternal AND NOT t.tgdeferrable
    AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.current_advanced_presentation_contract'::regclass
  AND(c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass OR c.relowner<>current_user::regrole::oid
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
   OR(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)<>2
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee<>c.relowner)))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_current_advanced_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.current_advanced_presentation_contract'::regclass)
 AND public.shardkeep_current_advanced_private_source()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz)'::regprocedure
  AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(
   SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.current_advanced_presentation_contract'::regclass
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND(SELECT record FROM public.current_advanced_presentation_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_current_advanced_contract()
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_current_advanced_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.current_advanced_presentation_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'current_advanced_seal_guard' OR current_user<>session_user
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.current_advanced_presentation_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'CURRENT_ADVANCED_SEAL_IMMUTABLE';END IF;
 IF NOT public.shardkeep_current_advanced_private_source() OR NOT public.shardkeep_bound_cosmetic_wake_sources_valid()
 OR NEW.record IS DISTINCT FROM public.shardkeep_current_advanced_contract()
 THEN RAISE EXCEPTION 'CURRENT_ADVANCED_SEAL_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER current_advanced_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.current_advanced_presentation_contract
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_current_advanced_seal_guard();
CREATE TRIGGER current_advanced_seal_no_truncate BEFORE TRUNCATE ON public.current_advanced_presentation_contract
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_current_advanced_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_current_advanced_contract(),public.shardkeep_current_advanced_private_source(),public.shardkeep_current_advanced_sources_valid(),public.shardkeep_current_advanced_seal_guard() FROM PUBLIC;
INSERT INTO public.current_advanced_presentation_contract(record) SELECT public.shardkeep_current_advanced_contract();
DO $$BEGIN IF NOT public.shardkeep_current_advanced_sources_valid() OR NOT public.shardkeep_bound_cosmetic_wake_sources_valid()
 THEN RAISE EXCEPTION 'CURRENT_ADVANCED_FINAL_SOURCE';END IF;END $$;
