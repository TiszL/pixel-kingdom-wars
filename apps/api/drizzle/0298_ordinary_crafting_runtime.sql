-- Additive ordinary-crafting runtime capability with immutable predecessor seals.
-- The existing invoker proof remains unchanged. The sole capability extension
-- is owner-granted, non-delegable EXECUTE for the two named runtime groups.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
-- Reject a changed predecessor before creating or capturing a successor.
SELECT public.shardkeep_divine_fragment_source();
DO $$ BEGIN
 IF NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 OR NOT public.shardkeep_raid_starter_sources_valid()
 OR NOT public.shardkeep_raid_advanced_sources_valid()
 OR NOT public.shardkeep_service_activity_sources_valid()
 OR NOT public.shardkeep_current_advanced_sources_valid()
 OR NOT public.shardkeep_advanced_identity_sources_valid()
 THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_PREDECESSOR_SOURCE';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.shardkeep_assert_ordinary_crafting_shards(uuid)'::regprocedure
  AND NOT p.prosecdef AND p.proowner=current_user::regrole::oid
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
 THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_PREDECESSOR_ACL';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.divine_fragment_crafting_runtime_contract(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL
);
REVOKE ALL ON public.divine_fragment_crafting_runtime_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_crafting_runtime_acl_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH original AS (
  SELECT record#>'{functions,shardkeep_assert_ordinary_crafting_shards(uuid),acl}' acl
  FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton
 ), helper AS (
  SELECT p.oid,p.proowner,p.proacl FROM pg_proc p
  WHERE p.oid='public.shardkeep_assert_ordinary_crafting_shards(uuid)'::regprocedure
 ), accepted AS (
  SELECT a.* FROM original o CROSS JOIN LATERAL aclexplode(
   ARRAY(SELECT jsonb_array_elements_text(o.acl))::aclitem[]) a
 ), actual AS (
  SELECT a.*,h.proowner,r.rolname FROM helper h
  CROSS JOIN LATERAL aclexplode(coalesce(h.proacl,acldefault('f',h.proowner))) a
  LEFT JOIN pg_roles r ON r.oid=a.grantee
 )
 SELECT EXISTS(SELECT 1 FROM original WHERE jsonb_typeof(acl)='array')
 AND EXISTS(SELECT 1 FROM accepted)
 AND NOT EXISTS(SELECT 1 FROM accepted a,helper h WHERE a.grantee<>h.proowner OR a.grantor<>h.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 AND NOT EXISTS(SELECT 1 FROM actual a WHERE a.rolname IN('shardkeep_api_runtime','shardkeep_worker_runtime')
  AND(a.grantor<>a.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable))
 AND(SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable)
  ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable) FROM actual a
  WHERE a.rolname IS NULL OR a.rolname NOT IN('shardkeep_api_runtime','shardkeep_worker_runtime'))
 IS NOT DISTINCT FROM(SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable)
  ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable) FROM accepted a)
$$;
--> statement-breakpoint
-- Catalog-only: no call back into the Divine projection or its validators.
-- The actual replacement projection and all successor functions are sealed.
-- Only the helper ACL has a separately checked, finite extension above.
CREATE FUNCTION public.shardkeep_crafting_runtime_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
 'predecessor',(SELECT record FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton),
 'table',(SELECT jsonb_build_object('owner',c.relowner,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'hasSubclass',c.relhassubclass,
  'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid,i.inhparent) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl::text,a.attislocal,a.attinhcount,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
  'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid))
  FROM pg_class c WHERE c.oid='public.divine_fragment_crafting_runtime_contract'::regclass),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,
  'acl',CASE WHEN p.oid='public.shardkeep_assert_ordinary_crafting_shards(uuid)'::regprocedure
   THEN (SELECT record#>'{functions,shardkeep_assert_ordinary_crafting_shards(uuid),acl}' FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton)
   ELSE to_jsonb(p.proacl) END,'definition',pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND(left(p.proname,length('shardkeep_crafting_runtime_'))='shardkeep_crafting_runtime_'
    OR p.proname IN('shardkeep_divine_fragment_contract','shardkeep_assert_ordinary_crafting_shards'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
  FROM pg_trigger t WHERE t.tgrelid='public.divine_fragment_crafting_runtime_contract'::regclass AND NOT t.tgisinternal))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_crafting_runtime_private_source() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.divine_fragment_crafting_runtime_contract'::regclass)
 AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.divine_fragment_crafting_runtime_contract'::regclass
  AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relhassubclass
  AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND x.grantee<>c.relowner)
  AND(SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['singleton','record']
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   AND(NOT a.attnotnull OR NOT a.attislocal OR a.attinhcount<>0 OR a.attidentity<>'' OR a.attgenerated<>''
    OR a.atttypid<>CASE a.attname WHEN 'singleton' THEN 'boolean'::regtype ELSE 'jsonb'::regtype END)))
 AND(SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_crafting_runtime_'))='shardkeep_crafting_runtime_')=5
 AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,length('shardkeep_crafting_runtime_'))='shardkeep_crafting_runtime_'
  AND(p.oid::regprocedure::text<>ALL(ARRAY['shardkeep_crafting_runtime_acl_valid()','shardkeep_crafting_runtime_contract()','shardkeep_crafting_runtime_private_source()','shardkeep_crafting_runtime_sources_valid()','shardkeep_crafting_runtime_seal_guard()'])
   OR p.proowner<>current_user::regrole::oid OR p.prosecdef
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)))
 AND(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.divine_fragment_crafting_runtime_contract'::regclass AND NOT t.tgisinternal)=2
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.divine_fragment_crafting_runtime_contract'::regclass AND NOT t.tgisinternal
  AND(t.tgfoid::regprocedure::text<>'shardkeep_crafting_runtime_seal_guard()' OR t.tgenabled<>'O' OR t.tgdeferrable OR t.tginitdeferred OR t.tgnargs<>0 OR t.tgqual IS NOT NULL
   OR NOT((t.tgname='crafting_runtime_seal_guard' AND t.tgtype=31) OR(t.tgname='crafting_runtime_seal_no_truncate' AND t.tgtype=34))))
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_crafting_runtime_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.shardkeep_crafting_runtime_private_source()
 AND public.shardkeep_crafting_runtime_acl_valid()
 AND(SELECT count(*) FROM public.divine_fragment_crafting_runtime_contract)=1
 AND(SELECT record FROM public.divine_fragment_crafting_runtime_contract WHERE singleton)
 IS NOT DISTINCT FROM public.shardkeep_crafting_runtime_contract()
$$;
CREATE FUNCTION public.shardkeep_crafting_runtime_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_RELID<>'public.divine_fragment_crafting_runtime_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'crafting_runtime_seal_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 OR EXISTS(SELECT 1 FROM public.divine_fragment_crafting_runtime_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_SEAL_IMMUTABLE';END IF;
 IF NOT public.shardkeep_crafting_runtime_private_source() OR NOT public.shardkeep_crafting_runtime_acl_valid()
 OR NEW.record IS DISTINCT FROM public.shardkeep_crafting_runtime_contract()
 THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_SEAL_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crafting_runtime_seal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.divine_fragment_crafting_runtime_contract
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_crafting_runtime_seal_guard();
CREATE TRIGGER crafting_runtime_seal_no_truncate BEFORE TRUNCATE ON public.divine_fragment_crafting_runtime_contract
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_crafting_runtime_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_crafting_runtime_acl_valid(),public.shardkeep_crafting_runtime_contract(),public.shardkeep_crafting_runtime_private_source(),public.shardkeep_crafting_runtime_sources_valid(),public.shardkeep_crafting_runtime_seal_guard() FROM PUBLIC;
--> statement-breakpoint
-- Two exact predecessor leaves are projected from the immutable old record:
-- the helper ACL and this projection's old self-definition. The successor seal
-- independently checks the real current definitions and the finite ACL delta.
-- All other current catalog fields still flow through the verbatim 0279 query.
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
  jsonb_set(jsonb_set(actual.jsonb_build_object,
   '{functions,shardkeep_assert_ordinary_crafting_shards(uuid),acl}',
   original.record#>'{functions,shardkeep_assert_ordinary_crafting_shards(uuid),acl}',false),
   '{functions,shardkeep_divine_fragment_contract(),definition}',
   original.record#>'{functions,shardkeep_divine_fragment_contract(),definition}',false)
  ELSE NULL END
 FROM actual CROSS JOIN original
$$;
--> statement-breakpoint
INSERT INTO public.divine_fragment_crafting_runtime_contract(record) SELECT public.shardkeep_crafting_runtime_contract();
SELECT public.shardkeep_divine_fragment_source();
DO $$ BEGIN
 IF NOT public.shardkeep_crafting_runtime_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 OR NOT public.shardkeep_raid_starter_sources_valid()
 OR NOT public.shardkeep_raid_advanced_sources_valid()
 OR NOT public.shardkeep_service_activity_sources_valid()
 OR NOT public.shardkeep_current_advanced_sources_valid()
 OR NOT public.shardkeep_advanced_identity_sources_valid()
 THEN RAISE EXCEPTION 'CRAFTING_RUNTIME_SUCCESSOR_SOURCE';END IF;
END $$;
