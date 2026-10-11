-- K-night-E1 (2026-10-10): 0267 shardkeep_ordinary_crafting_shards_guard() is a
-- BEFORE INSERT OR UPDATE OR DELETE row trigger on ledger_transactions and
-- ledger_entries that always ends RETURN NEW. NEW is NULL for DELETE, and a
-- BEFORE row trigger that returns NULL cancels the row operation, so every
-- DELETE on either ledger table silently deleted nothing and reported success.
-- The AFTER DELETE capture triggers never fired either, so mining evidence that
-- must record a destructive ledger edit saw no DELETE at all. The 0267 sibling
-- hook shardkeep_ordinary_crafting_shards_complete() (deferred AFTER INSERT)
-- assumed the same thing: it re-reads the transaction with SELECT ... STRICT, so
-- once a DELETE is real, a ledger row inserted and deleted in one database
-- transaction aborted the COMMIT with P0002 'query returned no rows'.
--
-- Fix: the guard returns OLD on DELETE, and reads the ledger_transactions row
-- being deleted from OLD (on ledger_entries it already used OLD.txn_id).
-- INSERT and UPDATE are byte-for-byte the same decision as 0267. A DELETE of an
-- ordinary-crafting Shards row is still refused, now loudly: an entry delete
-- raised ORDINARY_CRAFTING_OWNER before and still does; a transaction delete was
-- silently dropped before and now raises the same ORDINARY_CRAFTING_OWNER.
-- The deferred hook treats a transaction that is already gone again as nothing
-- to prove, unless the row as inserted was an ordinary-crafting Shards
-- transaction, which still fails closed with ORDINARY_CRAFTING_SHARDS_UNBOUND.
--
-- Additive successor in the 0298 style. Every existing seal row stays
-- byte-exact. The two hooks' 0267 definitions are fingerprinted by the Divine
-- projection (shardkeep_divine_fragment_contract()), whose own definition is in
-- turn pinned by the 0298 crafting runtime seal. Exactly four existing bodies
-- are replaced:
--  * shardkeep_ordinary_crafting_shards_guard() and
--    shardkeep_ordinary_crafting_shards_complete() - the fixes above.
--  * shardkeep_divine_fragment_contract() - the verbatim 0298 projection, which
--    additionally projects the two hooks' definition leaves from the immutable
--    0279 record, still only while the crafting runtime validator accepts.
--  * shardkeep_crafting_runtime_sources_valid() - the 0298 checks, which now
--    also require the new seal below and normalise exactly the two replaced
--    definition leaves of the crafting runtime contract back to its own record.
-- The new seal pins the real current definitions of those four bodies, the
-- four ledger hook trigger rows and its own functions, so changing any of them
-- (or the seal) makes the crafting runtime validator false, the Divine
-- projection NULL, and every guarded Phase E path fails closed as before.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
-- Reject a changed predecessor before replacing anything.
SELECT public.shardkeep_divine_fragment_source();
DO $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_crafting_runtime_contract'::regclass)
 OR NOT public.shardkeep_crafting_runtime_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 OR NOT public.shardkeep_raid_starter_sources_valid()
 OR NOT public.shardkeep_raid_advanced_sources_valid()
 OR NOT public.shardkeep_service_activity_sources_valid()
 OR NOT public.shardkeep_current_advanced_sources_valid()
 OR NOT public.shardkeep_advanced_identity_sources_valid()
 OR NOT public.shardkeep_retirement_coverage_sources_valid()
 OR to_regclass('public.divine_fragment_ledger_delete_contract') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_ledger_delete_'))='shardkeep_ledger_delete_')
 -- The bodies being replaced are exactly the 0267 ones the 0279 Divine record holds.
 OR(SELECT record#>>'{functions,shardkeep_ordinary_crafting_shards_guard(),definition}' FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton)
  IS DISTINCT FROM pg_get_functiondef('public.shardkeep_ordinary_crafting_shards_guard()'::regprocedure)
 OR(SELECT record#>>'{functions,shardkeep_ordinary_crafting_shards_complete(),definition}' FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton)
  IS DISTINCT FROM pg_get_functiondef('public.shardkeep_ordinary_crafting_shards_complete()'::regprocedure)
 -- The two ledger hooks are the accepted 0267 row triggers (the 0281 admission shape).
 OR(SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname='ordinary_crafting_shards_guard'
  AND t.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass)
  AND t.tgfoid='public.shardkeep_ordinary_crafting_shards_guard()'::regprocedure AND t.tgtype=31 AND t.tgenabled='O'
  AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0)<>2
 OR(SELECT count(*) FROM pg_trigger t WHERE t.tgfoid='public.shardkeep_ordinary_crafting_shards_guard()'::regprocedure)<>2
 OR(SELECT count(*) FROM pg_trigger t WHERE t.tgfoid='public.shardkeep_ordinary_crafting_shards_complete()'::regprocedure)<>2
 THEN RAISE EXCEPTION 'LEDGER_DELETE_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.divine_fragment_ledger_delete_contract(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL
);
REVOKE ALL ON public.divine_fragment_ledger_delete_contract FROM PUBLIC;
--> statement-breakpoint
-- 0267 body with two changes only: OLD is the transaction row on DELETE, and
-- DELETE returns OLD so a permitted delete actually happens.
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_shards_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;t public.ledger_transactions;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) OR TG_NAME<>'ordinary_crafting_shards_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_TRIGGER';END IF;
 IF TG_TABLE_NAME='ledger_transactions' THEN IF TG_OP='DELETE' THEN t:=OLD;ELSE t:=NEW;END IF;
 ELSE tid:=coalesce(NEW.txn_id,OLD.txn_id);SELECT * INTO t FROM public.ledger_transactions WHERE id=tid;END IF;
 IF t.type='ordinary.crafting.shards' OR t.idempotency_key LIKE 'ordinary-crafting:%' THEN
  IF TG_OP<>'INSERT' OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_crafting_jobs'::regclass)
   OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_OWNER' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 0267 body with one change only: the STRICT re-read becomes NOT FOUND handling.
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_shards_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;target uuid;t public.ledger_transactions;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) OR TG_NAME<>'ordinary_crafting_shards_complete' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_TRIGGER';END IF;
 tid:=CASE WHEN TG_TABLE_NAME='ledger_transactions' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'txn_id')::uuid END;
 SELECT * INTO t FROM public.ledger_transactions WHERE id=tid;
 IF NOT FOUND THEN
  -- Deleted again before this deferred check ran. The guard refuses deleting a
  -- crafting transaction, and the row as inserted still fails closed here.
  IF TG_TABLE_NAME='ledger_transactions' AND((to_jsonb(NEW)->>'type')='ordinary.crafting.shards' OR(to_jsonb(NEW)->>'idempotency_key') LIKE 'ordinary-crafting:%')
  THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_SHARDS_UNBOUND' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF t.type='ordinary.crafting.shards' OR t.idempotency_key LIKE 'ordinary-crafting:%' THEN
  SELECT job_id INTO target FROM public.ordinary_crafting_inputs WHERE shards_ledger_txn_id=tid AND kind='shards';
  IF target IS NULL THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_SHARDS_UNBOUND' USING ERRCODE='23514';END IF;
  PERFORM public.shardkeep_assert_ordinary_crafting_shards(target);
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- Catalog-only: no call back into the Divine projection or its validators.
CREATE FUNCTION public.shardkeep_ledger_delete_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'predecessor',(SELECT record FROM public.divine_fragment_crafting_runtime_contract WHERE singleton),
 'table',(SELECT jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'hasSubclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid,i.inhparent) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid))
  FROM pg_class c WHERE c.oid='public.divine_fragment_ledger_delete_contract'::regclass),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'acl',to_jsonb(p.proacl),'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND(left(p.proname,length('shardkeep_ledger_delete_'))='shardkeep_ledger_delete_'
    OR p.proname IN('shardkeep_ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_complete','shardkeep_divine_fragment_contract','shardkeep_crafting_runtime_sources_valid'))),
 'ledgerHooks',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname)
  FROM pg_trigger t WHERE t.tgfoid IN('public.shardkeep_ordinary_crafting_shards_guard()'::regprocedure,'public.shardkeep_ordinary_crafting_shards_complete()'::regprocedure)),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
  FROM pg_trigger t WHERE t.tgrelid='public.divine_fragment_ledger_delete_contract'::regclass AND NOT t.tgisinternal))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_ledger_delete_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.divine_fragment_ledger_delete_contract'::regclass)
 AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.divine_fragment_ledger_delete_contract'::regclass
  AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relhassubclass
  AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND x.grantee<>c.relowner)
  AND(SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['singleton','record']
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   AND(NOT a.attnotnull OR NOT a.attislocal OR a.attinhcount<>0 OR a.attidentity<>'' OR a.attgenerated<>''
    OR a.atttypid<>CASE a.attname WHEN 'singleton' THEN 'boolean'::regtype ELSE 'jsonb'::regtype END)))
 AND(SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_ledger_delete_'))='shardkeep_ledger_delete_')=4
 AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_ledger_delete_'))='shardkeep_ledger_delete_'
  AND(p.oid::regprocedure::text<>ALL(ARRAY['shardkeep_ledger_delete_contract()','shardkeep_ledger_delete_private_source()','shardkeep_ledger_delete_sources_valid()','shardkeep_ledger_delete_seal_guard()'])
   OR p.proowner<>current_user::regrole::oid OR p.prosecdef
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)))
 AND(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.divine_fragment_ledger_delete_contract'::regclass AND NOT t.tgisinternal)=2
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.divine_fragment_ledger_delete_contract'::regclass AND NOT t.tgisinternal
  AND(t.tgfoid::regprocedure::text<>'shardkeep_ledger_delete_seal_guard()' OR t.tgenabled<>'O' OR t.tgdeferrable OR t.tginitdeferred OR t.tgnargs<>0 OR t.tgqual IS NOT NULL
   OR NOT((t.tgname='ledger_delete_seal_guard' AND t.tgtype=31) OR(t.tgname='ledger_delete_seal_no_truncate' AND t.tgtype=34))))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_ledger_delete_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.shardkeep_ledger_delete_private_source()
 AND(SELECT count(*) FROM public.divine_fragment_ledger_delete_contract)=1
 AND(SELECT record FROM public.divine_fragment_ledger_delete_contract WHERE singleton)
 IS NOT DISTINCT FROM public.shardkeep_ledger_delete_contract()
$$;
CREATE FUNCTION public.shardkeep_ledger_delete_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_RELID<>'public.divine_fragment_ledger_delete_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'ledger_delete_seal_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.divine_fragment_ledger_delete_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'LEDGER_DELETE_SEAL_IMMUTABLE';END IF;
 IF NOT public.shardkeep_ledger_delete_private_source() OR NEW.record IS DISTINCT FROM public.shardkeep_ledger_delete_contract()
 THEN RAISE EXCEPTION 'LEDGER_DELETE_SEAL_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_delete_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.divine_fragment_ledger_delete_contract
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ledger_delete_seal_guard();
CREATE TRIGGER ledger_delete_seal_no_truncate BEFORE TRUNCATE ON public.divine_fragment_ledger_delete_contract
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_ledger_delete_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_ledger_delete_contract(),public.shardkeep_ledger_delete_private_source(),public.shardkeep_ledger_delete_sources_valid(),public.shardkeep_ledger_delete_seal_guard() FROM PUBLIC;
--> statement-breakpoint
-- The 0298 checks, plus the new seal. Only the two replaced definition leaves
-- (the Divine projection's and this validator's own) are read from the
-- immutable 0298 record; the new seal pins their real current definitions.
CREATE OR REPLACE FUNCTION public.shardkeep_crafting_runtime_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.shardkeep_crafting_runtime_private_source()
 AND public.shardkeep_crafting_runtime_acl_valid()
 AND(SELECT count(*) FROM public.divine_fragment_crafting_runtime_contract)=1
 AND public.shardkeep_ledger_delete_sources_valid()
 AND(SELECT record FROM public.divine_fragment_crafting_runtime_contract WHERE singleton)
 IS NOT DISTINCT FROM(SELECT jsonb_set(jsonb_set(public.shardkeep_crafting_runtime_contract(),
   '{functions,shardkeep_divine_fragment_contract(),definition}',
   sealed.record#>'{functions,shardkeep_divine_fragment_contract(),definition}',false),
   '{functions,shardkeep_crafting_runtime_sources_valid(),definition}',
   sealed.record#>'{functions,shardkeep_crafting_runtime_sources_valid(),definition}',false)
  FROM public.divine_fragment_crafting_runtime_contract sealed WHERE sealed.singleton)
$$;
--> statement-breakpoint
-- The verbatim 0298 projection. Two more exact predecessor leaves, the two
-- hooks' 0267 definitions, are projected from the immutable 0279 record; the
-- new seal independently pins their real current definitions.
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH actual AS (

 SELECT jsonb_build_object('boundCosmeticTables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'hasSubclass',c.relhassubclass,'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid,i.inhparent) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid))) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract'])),'gemsZeroTables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity)) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['mining_gems_zero_openings','mining_gems_zero_contract','divine_fragment_gems_zero_contract'])),'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',public.shardkeep_vehicle_client_ordinary_acl(c.relname,c.relowner,c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,coalesce(to_jsonb(a.attacl),'[]'::jsonb)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract','divine_fragment_gems_zero_contract','mining_gems_zero_openings','mining_gems_zero_contract','divine_fragment_seeker_absence_contract','divine_fragment_existing_wallet_contract','mining_existing_wallet_baselines','mining_existing_wallet_contract','vehicle_issuance_acquisitions','vehicle_mint_registry','divine_fragment_vehicle_client_contract','vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals','vehicle_issuance_originals','divine_fragment_vehicle_material_contract','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','divine_fragment_enrolled_seeker_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',CASE WHEN p.proname IN('shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence','shardkeep_finish_starter_equipment') THEN NULL WHEN p.proname IN('shardkeep_mining_settlement_guard','shardkeep_mining_settlement_complete') THEN (SELECT jsonb_agg(jsonb_build_array(x.grantor,x.grantee,x.privilege_type,x.is_grantable) ORDER BY x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) ELSE to_jsonb(p.proacl) END,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_bound_cosmetic_return_contract','shardkeep_bound_cosmetic_return_sources_valid','shardkeep_bound_cosmetic_return_seal_guard','shardkeep_advanced_return_fingerprint','shardkeep_starter_return_fingerprint','shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence','shardkeep_finish_starter_equipment','shardkeep_bound_cosmetic_recipe','shardkeep_bound_cosmetic_appearance','shardkeep_bound_cosmetic_blueprint_source','shardkeep_bound_cosmetic_guard','shardkeep_bound_cosmetic_debit','shardkeep_bound_cosmetic_blueprint_complete','shardkeep_bound_cosmetic_workshop_guard','shardkeep_bound_cosmetics_seal_guard','shardkeep_mining_gems_zero_publication_seal_guard','shardkeep_mining_gems_zero_ledger','shardkeep_mining_gems_zero_guard','shardkeep_mining_gems_zero_contract','shardkeep_mining_gems_zero_sources_valid','shardkeep_mining_gems_zero_seal_guard','shardkeep_mining_seeker_absence_publication_seal_guard','shardkeep_mining_existing_wallet_publication_seal_guard','shardkeep_mining_existing_wallet_guard','shardkeep_mining_existing_wallet_contract','shardkeep_mining_existing_wallet_sources_valid','shardkeep_mining_existing_wallet_seal_guard','shardkeep_vehicle_client_ordinary_acl','shardkeep_vehicle_client_seal_guard','shardkeep_vehicle_issuance_no_truncate','shardkeep_vehicle_private_guard','shardkeep_vehicle_material_hash','shardkeep_vehicle_material_guard','shardkeep_vehicle_material_effect','shardkeep_vehicle_material_complete','shardkeep_vehicle_material_no_truncate','shardkeep_vehicle_material_seal_guard','shardkeep_vehicle_issuance_guard','shardkeep_assert_ordinary_crafting_shards','shardkeep_ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_guard','shardkeep_ordinary_crafting_proof','shardkeep_ordinary_kits_seal_guard','shardkeep_mining_resource_kits_seal_guard','shardkeep_mining_enrolled_seeker_seal_guard','shardkeep_mining_resource_day_policy','shardkeep_mining_resource_cutover_guard','shardkeep_mining_resource_epoch_day_guard','shardkeep_mining_resource_prior_decided','divine_fragment_policy','shardkeep_mining_contribution_guard','shardkeep_mining_resource_canonical','shardkeep_mining_resource_originals','shardkeep_mining_publication_attempt_guard','shardkeep_mining_settlement_guard','shardkeep_mining_entitlement_guard','shardkeep_mining_entitlement_complete','shardkeep_mining_settlement_complete','shardkeep_mining_resource_publication_seal_guard','shardkeep_mining_seeker_publication_seal_guard','shardkeep_mining_resource_publication_source_guard','shardkeep_mining_contribution_effect','shardkeep_mining_pending_stock_guard','shardkeep_mining_contribution_complete','shardkeep_assert_mining_contribution_money','shardkeep_mining_contribution_money_guard','shardkeep_mining_contribution_epoch_guard','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard','divine_fragment_source_event','divine_fragment_clan_policy','shardkeep_keep_equipment_market_guard','shardkeep_keep_equipment_market_stock','shardkeep_keep_equipment_payment_guard','shardkeep_keep_equipment_payment_effect','shardkeep_keep_equipment_release_guard','shardkeep_keep_equipment_release_effect','shardkeep_keep_equipment_payment_release_guard','shardkeep_claim_payment_signature','shardkeep_payment_signature_guard'])),
 'ingredientLedgerTriggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) AND t.tgname IN('ordinary_crafting_shards_guard','ordinary_crafting_shards_complete')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract','divine_fragment_gems_zero_contract','mining_gems_zero_openings','mining_gems_zero_contract','divine_fragment_seeker_absence_contract','divine_fragment_existing_wallet_contract','mining_existing_wallet_baselines','mining_existing_wallet_contract','vehicle_issuance_acquisitions','vehicle_mint_registry','divine_fragment_vehicle_client_contract','vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals','vehicle_issuance_originals','divine_fragment_vehicle_material_contract','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','divine_fragment_enrolled_seeker_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])))

 ), original AS (
  SELECT record FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton
 )
 SELECT CASE WHEN public.shardkeep_crafting_runtime_sources_valid() THEN
  jsonb_set(jsonb_set(jsonb_set(jsonb_set(actual.jsonb_build_object,
   '{functions,shardkeep_assert_ordinary_crafting_shards(uuid),acl}',
   original.record#>'{functions,shardkeep_assert_ordinary_crafting_shards(uuid),acl}',false),
   '{functions,shardkeep_divine_fragment_contract(),definition}',
   original.record#>'{functions,shardkeep_divine_fragment_contract(),definition}',false),
   '{functions,shardkeep_ordinary_crafting_shards_guard(),definition}',
   original.record#>'{functions,shardkeep_ordinary_crafting_shards_guard(),definition}',false),
   '{functions,shardkeep_ordinary_crafting_shards_complete(),definition}',
   original.record#>'{functions,shardkeep_ordinary_crafting_shards_complete(),definition}',false)
  ELSE NULL END
 FROM actual CROSS JOIN original
$$;
--> statement-breakpoint
INSERT INTO public.divine_fragment_ledger_delete_contract(record) SELECT public.shardkeep_ledger_delete_contract();
SELECT public.shardkeep_divine_fragment_source();
DO $$ BEGIN
 IF NOT public.shardkeep_ledger_delete_sources_valid()
 OR NOT public.shardkeep_crafting_runtime_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 OR NOT public.shardkeep_raid_starter_sources_valid()
 OR NOT public.shardkeep_raid_advanced_sources_valid()
 OR NOT public.shardkeep_service_activity_sources_valid()
 OR NOT public.shardkeep_current_advanced_sources_valid()
 OR NOT public.shardkeep_advanced_identity_sources_valid()
 OR NOT public.shardkeep_retirement_coverage_sources_valid()
 THEN RAISE EXCEPTION 'LEDGER_DELETE_SUCCESSOR_SOURCE';END IF;
END $$;
