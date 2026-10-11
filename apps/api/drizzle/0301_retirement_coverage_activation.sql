-- Root cause (2026-10-10, CI cluster C): the retirement fingerprint that
-- shardkeep_raid_starter_retirement_predecessor() (0285, replaced in 0287)
-- recomputes on every guarded Phase E call hashes pg_trigger.tgenabled of
-- EVERY trigger on accounts, ledger_transactions, ledger_entries and raids. That
-- set includes eleven mining capture triggers that 0161/0166/0179 create
-- DISABLED and that the owner initializers legitimately ENABLE when they insert
-- the coverage row (mining_free_coverage, mining_free_gems_coverage,
-- mining_gems_flow_coverage). After that insert the live fingerprint no longer
-- equals the value sealed in bound_cosmetic_charter_contract, so
-- shardkeep_bound_cosmetic_visual_sources_valid() and
-- shardkeep_bound_cosmetic_wake_predecessor_valid() turn false and every guarded
-- Phase E path (Divine fragments, advanced returns, raid capture, crafting
-- runtime) fails closed for players.
--
-- Additive successor in the 0285/0287 style. Every old seal row stays byte-exact.
-- Exactly three existing bodies are replaced:
--  * shardkeep_raid_starter_retirement_predecessor() now projects each of the
--    eleven coverage-governed triggers with the enablement it had when the
--    retirement value was sealed, but ONLY while its live enablement equals the
--    state its coverage row implies (enabled iff the coverage row exists). Any
--    other enablement projects as drift and fails closed, exactly as before.
--    Every other trigger keeps its live tgenabled, so disabling a charter, ledger
--    or raid trigger is still detected.
--  * shardkeep_raid_advanced_private_source() pins the new body above.
--  * shardkeep_raid_advanced_sources_valid() normalises only the three replaced
--    entries of the raid advanced contract and requires the new seal below.
-- The sealed-time enablement (the baseline) is not recorded anywhere, so this
-- migration finds it: exactly one of the eight per-family D/O vectors must
-- reproduce the sealed retirement value with the live catalog. It is recorded
-- in the new immutable seal row. A database where coverage was initialised
-- before or after the Phase E seals, including one already failing closed
-- because coverage was initialised after them, is repaired; any other drift
-- finds no vector and refuses.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
DO $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.raid_advanced_presentation_contract'::regclass)
 -- Both raid validators are independent of mining coverage, so they hold even
 -- on a database already failing closed because coverage came after the seals.
 OR NOT public.shardkeep_raid_advanced_sources_valid() OR NOT public.shardkeep_raid_starter_sources_valid()
 OR to_regclass('public.retirement_coverage_contract') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_retirement_coverage_'))='shardkeep_retirement_coverage_')
 OR(SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND(t.tgrelid,t.tgname) IN(
  ('public.ledger_entries'::regclass,'ledger_entries_mining_free_capture'),('public.ledger_entries'::regclass,'ledger_entries_mining_free_truncate'),
  ('public.accounts'::regclass,'accounts_mining_free_attribution'),('public.ledger_transactions'::regclass,'ledger_transactions_mining_free_attribution'),
  ('public.ledger_entries'::regclass,'ledger_entries_mining_free_gems_capture'),
  ('public.accounts'::regclass,'accounts_mining_gems_flow_capture'),('public.accounts'::regclass,'accounts_mining_gems_flow_truncate'),
  ('public.ledger_transactions'::regclass,'ledger_transactions_mining_gems_flow_capture'),('public.ledger_transactions'::regclass,'ledger_transactions_mining_gems_flow_truncate'),
  ('public.ledger_entries'::regclass,'ledger_entries_mining_gems_flow_capture'),('public.ledger_entries'::regclass,'ledger_entries_mining_gems_flow_truncate')))<>11
 THEN RAISE EXCEPTION 'RETIREMENT_COVERAGE_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.retirement_coverage_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL,
 baseline jsonb NOT NULL CHECK(jsonb_typeof(baseline)='object' AND(baseline-ARRAY['free','freeGems','gemsFlow'])='{}'::jsonb
  AND baseline->>'free' IN('D','O') AND baseline->>'freeGems' IN('D','O') AND baseline->>'gemsFlow' IN('D','O')));
REVOKE ALL ON public.retirement_coverage_contract FROM PUBLIC;
--> statement-breakpoint
-- The 0287 projection, byte-for-byte, except the tgenabled column of the eleven
-- coverage-governed triggers. $1 is the sealed-time enablement per family.
CREATE FUNCTION public.shardkeep_retirement_coverage_fingerprint(jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH governed(rel,name,family) AS(VALUES
  ('ledger_entries','ledger_entries_mining_free_capture','free'),('ledger_entries','ledger_entries_mining_free_truncate','free'),
  ('accounts','accounts_mining_free_attribution','free'),('ledger_transactions','ledger_transactions_mining_free_attribution','free'),
  ('ledger_entries','ledger_entries_mining_free_gems_capture','freeGems'),
  ('accounts','accounts_mining_gems_flow_capture','gemsFlow'),('accounts','accounts_mining_gems_flow_truncate','gemsFlow'),
  ('ledger_transactions','ledger_transactions_mining_gems_flow_capture','gemsFlow'),('ledger_transactions','ledger_transactions_mining_gems_flow_truncate','gemsFlow'),
  ('ledger_entries','ledger_entries_mining_gems_flow_capture','gemsFlow'),('ledger_entries','ledger_entries_mining_gems_flow_truncate','gemsFlow')),
 implied(family,state) AS(VALUES
  ('free',CASE WHEN EXISTS(SELECT 1 FROM public.mining_free_coverage) THEN 'O' ELSE 'D' END),
  ('freeGems',CASE WHEN EXISTS(SELECT 1 FROM public.mining_free_gems_coverage) THEN 'O' ELSE 'D' END),
  ('gemsFlow',CASE WHEN EXISTS(SELECT 1 FROM public.mining_gems_flow_coverage) THEN 'O' ELSE 'D' END))
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proargtypes::text,
  CASE WHEN p.proname LIKE 'shardkeep_charter_retirement_%' THEN p.proacl::text ELSE NULL END) ORDER BY p.proname,p.proargtypes::text)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(p.proname LIKE 'shardkeep_charter_%' OR p.proname LIKE 'shardkeep_clan_charter_%')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,CASE WHEN c.relname LIKE 'charter_retirement%' THEN c.relacl::text ELSE NULL END,
  (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid)) ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,
  CASE WHEN g.family IS NULL THEN t.tgenabled::text WHEN t.tgenabled::text=i.state THEN $1->>g.family ELSE 'coverage-drift:'||t.tgenabled::text END,
  pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid LEFT JOIN governed g ON g.rel=c.relname AND g.name=t.tgname LEFT JOIN implied i ON i.family=g.family
  WHERE NOT t.tgisinternal AND NOT(c.relname='raids' AND t.tgname IN('raid_starter_capture','raid_advanced_capture')) AND c.relnamespace='public'::regnamespace
   AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts')))
 )::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_retirement_coverage_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'previous',jsonb_build_object('advanced',(SELECT record FROM public.raid_advanced_presentation_contract WHERE singleton),
  'visual',(SELECT to_jsonb(c) FROM public.bound_cosmetic_charter_contract c WHERE singleton)),
 'table',(SELECT jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'subclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid::regclass::text,i.inhparent::regclass::text) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,t.tgnargs,t.tgqual IS NULL,pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
   FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))
  FROM pg_class c WHERE c.oid='public.retirement_coverage_contract'::regclass),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'volatility',p.provolatile,'acl',p.proacl::text,'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(left(p.proname,length('shardkeep_retirement_coverage_'))='shardkeep_retirement_coverage_'
   OR p.proname IN('shardkeep_raid_starter_retirement_predecessor','shardkeep_raid_advanced_private_source','shardkeep_raid_advanced_sources_valid'))))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_retirement_coverage_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.retirement_coverage_contract'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.retirement_coverage_contract'::regclass
  AND(c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee<>c.relowner)
   OR(session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_retirement_coverage_'))='shardkeep_retirement_coverage_' AND a.grantee<>p.proowner)
 AND(SELECT count(*) FROM public.retirement_coverage_contract)=1
 AND(SELECT record FROM public.retirement_coverage_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_retirement_coverage_contract()
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_raid_starter_retirement_predecessor() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.shardkeep_retirement_coverage_fingerprint(baseline) FROM public.retirement_coverage_contract WHERE singleton
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_raid_advanced_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH expected(name,source,definer) AS(VALUES
 ('shardkeep_raid_advanced_projection','a101345e97a8b57f2b49a0d80febb92ff0dd5d3b2d46bc14045c277a3640231e',false),
 ('shardkeep_raid_advanced_candidate','16d846292eeb5106ee86042355ec017a76ac2fb376bbe67f9a88159aea0a4bc5',true),
 ('shardkeep_raid_advanced_guard','ac6f77abf44e5a6b58f65fb551185e019da4a784e94c2f4e5fed6243611328a9',false),
 ('shardkeep_raid_advanced_capture','db65a5c0d361e0c827baf4a932ad0cfdc8a16c9222ca69e4dfa137447899e88b',true),
 ('shardkeep_raid_advanced_presentation','b742fbca1da102957c970b864ab12290f6a8de0f2b761aeb53e4621b467989d0',true),
 ('shardkeep_raid_starter_retirement_predecessor','ea0535f52953b89e50322407f7d54216b71fdc13f6321e71693b1b253c3228be',false),
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
CREATE OR REPLACE FUNCTION public.shardkeep_raid_advanced_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user::regrole::oid=(SELECT relowner FROM pg_class WHERE oid='public.raid_advanced_presentation_contract'::regclass)
 AND public.shardkeep_raid_advanced_private_source()
 AND public.shardkeep_retirement_coverage_sources_valid()
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid IN('public.shardkeep_raid_advanced_presentation(uuid)'::regprocedure,'public.shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz)'::regprocedure)
  AND(a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable OR(a.grantee<>p.proowner AND NOT EXISTS(
   SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')))))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.raid_advanced_presentations'::regclass,'public.raid_advanced_presentation_contract'::regclass)
  AND session_user<>current_user AND(has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND(SELECT jsonb_set(public.shardkeep_raid_advanced_contract(),'{functions}',(public.shardkeep_raid_advanced_contract()->'functions')||jsonb_build_object(
   'shardkeep_raid_starter_retirement_predecessor()',record#>'{functions,shardkeep_raid_starter_retirement_predecessor()}',
   'shardkeep_raid_advanced_private_source()',record#>'{functions,shardkeep_raid_advanced_private_source()}',
   'shardkeep_raid_advanced_sources_valid()',record#>'{functions,shardkeep_raid_advanced_sources_valid()}'))
  FROM public.raid_advanced_presentation_contract WHERE singleton)
 IS NOT DISTINCT FROM(SELECT record FROM public.raid_advanced_presentation_contract WHERE singleton)
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_retirement_coverage_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.retirement_coverage_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'retirement_coverage_seal_guard' OR current_user<>session_user
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.retirement_coverage_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'RETIREMENT_COVERAGE_SEAL_IMMUTABLE';END IF;
 IF NEW.record IS DISTINCT FROM public.shardkeep_retirement_coverage_contract()
 OR public.shardkeep_retirement_coverage_fingerprint(NEW.baseline) IS DISTINCT FROM
  (SELECT record->>'retirement' FROM public.bound_cosmetic_charter_contract WHERE singleton)
 THEN RAISE EXCEPTION 'RETIREMENT_COVERAGE_SEAL_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retirement_coverage_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.retirement_coverage_contract
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_retirement_coverage_seal_guard();
CREATE TRIGGER retirement_coverage_seal_no_truncate BEFORE TRUNCATE ON public.retirement_coverage_contract
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_retirement_coverage_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_retirement_coverage_fingerprint(jsonb),public.shardkeep_retirement_coverage_contract(),
 public.shardkeep_retirement_coverage_sources_valid(),public.shardkeep_retirement_coverage_seal_guard() FROM PUBLIC;
--> statement-breakpoint
-- Exactly one sealed-time enablement vector must reproduce the sealed value.
DO $$DECLARE matches integer;chosen jsonb;BEGIN
 SELECT count(*),min(v.baseline::text)::jsonb INTO matches,chosen
 FROM(SELECT jsonb_build_object('free',f,'freeGems',g,'gemsFlow',w) baseline
  FROM unnest(ARRAY['D','O']) f,unnest(ARRAY['D','O']) g,unnest(ARRAY['D','O']) w) v
 WHERE public.shardkeep_retirement_coverage_fingerprint(v.baseline)=(SELECT record->>'retirement' FROM public.bound_cosmetic_charter_contract WHERE singleton);
 IF matches<>1 THEN RAISE EXCEPTION 'RETIREMENT_COVERAGE_PREDECESSOR';END IF;
 INSERT INTO public.retirement_coverage_contract(record,baseline) SELECT public.shardkeep_retirement_coverage_contract(),chosen;
END $$;
--> statement-breakpoint
SELECT public.shardkeep_charter_retirement_source(),public.shardkeep_divine_fragment_source();
DO $$BEGIN
 IF NOT public.shardkeep_retirement_coverage_sources_valid() OR NOT public.shardkeep_raid_advanced_sources_valid()
 OR NOT public.shardkeep_raid_starter_sources_valid() OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_wake_sources_valid() OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 THEN RAISE EXCEPTION 'RETIREMENT_COVERAGE_FINAL_SOURCE';END IF;
END $$;
