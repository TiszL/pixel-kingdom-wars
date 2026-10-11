-- Additive bound-cosmetic source identity after 0278. Existing Divine/mining
-- seals and historical publication policies remain immutable and unchanged.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
-- 0278 adds precisely one trigger to the predecessor's sealed relations. Do
-- not bless an unrelated changed source while extending the accepted contract.
DO $$ DECLARE actual jsonb;previous jsonb;BEGIN
 SELECT record INTO STRICT previous FROM public.divine_fragment_gems_zero_contract WHERE singleton;
 actual:=public.shardkeep_divine_fragment_contract();
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.ordinary_crafting_jobs'::regclass
  AND t.tgname='bound_cosmetic_workshop_guard' AND t.tgtype=7 AND t.tgenabled='O'
  AND t.tgfoid='public.shardkeep_bound_cosmetic_workshop_guard()'::regprocedure
  AND NOT t.tgisinternal AND NOT t.tgdeferrable AND t.tgnargs=0 AND t.tgqual IS NULL)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREDECESSOR_SOURCE';END IF;
 actual:=jsonb_set(actual,'{triggers}',(SELECT jsonb_agg(value ORDER BY ord) FROM jsonb_array_elements(actual->'triggers') WITH ORDINALITY e(value,ord)
  WHERE NOT(value->>0='ordinary_crafting_jobs' AND value->>1='bound_cosmetic_workshop_guard')));
 IF actual IS DISTINCT FROM previous THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREDECESSOR_SOURCE';END IF;
END $$;

--> statement-breakpoint
-- The accepted return capabilities also seal the equipment trigger/function
-- identity. Reproduce their exact predecessor projections, omitting only the
-- new queue trigger, before admitting the successor. Old seal rows stay intact.
DO $$ DECLARE prior_advanced text;prior_starter text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.ordinary_equipment_jobs'::regclass
  AND t.tgname='bound_cosmetic_workshop_guard' AND t.tgtype=7 AND t.tgenabled='O'
  AND t.tgfoid='public.shardkeep_bound_cosmetic_workshop_guard()'::regprocedure
  AND NOT t.tgisinternal AND NOT t.tgdeferrable AND t.tgnargs=0 AND t.tgqual IS NULL)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_RETURN_PREDECESSOR';END IF;
 prior_advanced:=(WITH relations AS (
  SELECT c.oid,c.relname,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND (c.relname IN('advanced_vehicle_installations','advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies',
   'ordinary_equipment_jobs','ordinary_equipment_completions','ordinary_equipment_stocks','ordinary_equipment_reservations','ordinary_equipment_releases','ordinary_equipment_secondary_outputs','ordinary_equipment_secondary_returns','ordinary_equipment_secondary_entries',
   'expedition_term_snapshots','resource_stock_operations','resource_stock_entries','resource_stocks'))
 ), functions AS (
  SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prolang,p.prorettype,p.proargtypes::text args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.oid IN(SELECT t.tgfoid FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(r.relname='ordinary_equipment_jobs' AND t.tgname='bound_cosmetic_workshop_guard'))
   OR p.proname IN('shardkeep_vehicle_lifecycle','shardkeep_vehicle_service_state_v214','shardkeep_vehicle_service_effect_v214','shardkeep_vehicle_service_proof_valid_v214','shardkeep_advanced_return_fingerprint','shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence'))
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'relations',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner) ORDER BY relname) FROM relations),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc,'owner',proowner,'definer',prosecdef,'config',proconfig,'language',prolang,'returns',prorettype,'args',args,
   'acl',CASE WHEN proname IN('shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence') THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a) END) ORDER BY proname,args) FROM functions),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,'function',t.tgfoid,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initial',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT(r.relname='ordinary_equipment_jobs' AND t.tgname='bound_cosmetic_workshop_guard')),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(r.relname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid)
 )::text,'UTF8')),'hex'));
 IF prior_advanced IS DISTINCT FROM (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_RETURN_PREDECESSOR';END IF;
 prior_starter:=(WITH relations AS (
  SELECT c.oid,c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN('starter_expeditions','starter_expedition_inflight','starter_expedition_returns','starter_expedition_entries','fleet_installations')
 ), functions AS (
  SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prolang,p.prorettype,p.proargtypes::text args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.oid IN(SELECT t.tgfoid FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal)
   OR p.proname IN('shardkeep_starter_return_fingerprint','shardkeep_finish_starter_equipment'))
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'advanced',prior_advanced,
  'relations',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner) ORDER BY relname) FROM relations),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc,'owner',proowner,'definer',prosecdef,'config',proconfig,'language',prolang,'returns',prorettype,'args',args,
   'acl',CASE WHEN proname='shardkeep_finish_starter_equipment' THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a) END) ORDER BY proname,args) FROM functions),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,'function',t.tgfoid,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initial',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(r.relname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid)
 )::text,'UTF8')),'hex'));
 IF prior_starter IS DISTINCT FROM (SELECT source_sha256 FROM public.ordinary_equipment_starter_return_seal WHERE singleton)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_RETURN_PREDECESSOR';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.bound_cosmetic_return_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.bound_cosmetic_return_contract FROM PUBLIC;

--> statement-breakpoint
CREATE TABLE public.divine_fragment_bound_cosmetics_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.divine_fragment_bound_cosmetics_contract FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('boundCosmeticTables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'hasSubclass',c.relhassubclass,'inheritance',(SELECT jsonb_agg(jsonb_build_array(i.inhrelid,i.inhparent) ORDER BY i.inhrelid,i.inhparent) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid))) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract'])),'gemsZeroTables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity)) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['mining_gems_zero_openings','mining_gems_zero_contract','divine_fragment_gems_zero_contract'])),'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',public.shardkeep_vehicle_client_ordinary_acl(c.relname,c.relowner,c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,coalesce(to_jsonb(a.attacl),'[]'::jsonb)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract','divine_fragment_gems_zero_contract','mining_gems_zero_openings','mining_gems_zero_contract','divine_fragment_seeker_absence_contract','divine_fragment_existing_wallet_contract','mining_existing_wallet_baselines','mining_existing_wallet_contract','vehicle_issuance_acquisitions','vehicle_mint_registry','divine_fragment_vehicle_client_contract','vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals','vehicle_issuance_originals','divine_fragment_vehicle_material_contract','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','divine_fragment_enrolled_seeker_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',CASE WHEN p.proname IN('shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence','shardkeep_finish_starter_equipment') THEN NULL WHEN p.proname IN('shardkeep_mining_settlement_guard','shardkeep_mining_settlement_complete') THEN (SELECT jsonb_agg(jsonb_build_array(x.grantor,x.grantee,x.privilege_type,x.is_grantable) ORDER BY x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) ELSE to_jsonb(p.proacl) END,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_bound_cosmetic_return_contract','shardkeep_bound_cosmetic_return_sources_valid','shardkeep_bound_cosmetic_return_seal_guard','shardkeep_advanced_return_fingerprint','shardkeep_starter_return_fingerprint','shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence','shardkeep_finish_starter_equipment','shardkeep_bound_cosmetic_recipe','shardkeep_bound_cosmetic_appearance','shardkeep_bound_cosmetic_blueprint_source','shardkeep_bound_cosmetic_guard','shardkeep_bound_cosmetic_debit','shardkeep_bound_cosmetic_blueprint_complete','shardkeep_bound_cosmetic_workshop_guard','shardkeep_bound_cosmetics_seal_guard','shardkeep_mining_gems_zero_publication_seal_guard','shardkeep_mining_gems_zero_ledger','shardkeep_mining_gems_zero_guard','shardkeep_mining_gems_zero_contract','shardkeep_mining_gems_zero_sources_valid','shardkeep_mining_gems_zero_seal_guard','shardkeep_mining_seeker_absence_publication_seal_guard','shardkeep_mining_existing_wallet_publication_seal_guard','shardkeep_mining_existing_wallet_guard','shardkeep_mining_existing_wallet_contract','shardkeep_mining_existing_wallet_sources_valid','shardkeep_mining_existing_wallet_seal_guard','shardkeep_vehicle_client_ordinary_acl','shardkeep_vehicle_client_seal_guard','shardkeep_vehicle_issuance_no_truncate','shardkeep_vehicle_private_guard','shardkeep_vehicle_material_hash','shardkeep_vehicle_material_guard','shardkeep_vehicle_material_effect','shardkeep_vehicle_material_complete','shardkeep_vehicle_material_no_truncate','shardkeep_vehicle_material_seal_guard','shardkeep_vehicle_issuance_guard','shardkeep_assert_ordinary_crafting_shards','shardkeep_ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_guard','shardkeep_ordinary_crafting_proof','shardkeep_ordinary_kits_seal_guard','shardkeep_mining_resource_kits_seal_guard','shardkeep_mining_enrolled_seeker_seal_guard','shardkeep_mining_resource_day_policy','shardkeep_mining_resource_cutover_guard','shardkeep_mining_resource_epoch_day_guard','shardkeep_mining_resource_prior_decided','divine_fragment_policy','shardkeep_mining_contribution_guard','shardkeep_mining_resource_canonical','shardkeep_mining_resource_originals','shardkeep_mining_publication_attempt_guard','shardkeep_mining_settlement_guard','shardkeep_mining_entitlement_guard','shardkeep_mining_entitlement_complete','shardkeep_mining_settlement_complete','shardkeep_mining_resource_publication_seal_guard','shardkeep_mining_seeker_publication_seal_guard','shardkeep_mining_resource_publication_source_guard','shardkeep_mining_contribution_effect','shardkeep_mining_pending_stock_guard','shardkeep_mining_contribution_complete','shardkeep_assert_mining_contribution_money','shardkeep_mining_contribution_money_guard','shardkeep_mining_contribution_epoch_guard','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard','divine_fragment_source_event','divine_fragment_clan_policy','shardkeep_keep_equipment_market_guard','shardkeep_keep_equipment_market_stock','shardkeep_keep_equipment_payment_guard','shardkeep_keep_equipment_payment_effect','shardkeep_keep_equipment_release_guard','shardkeep_keep_equipment_release_effect','shardkeep_keep_equipment_payment_release_guard','shardkeep_claim_payment_signature','shardkeep_payment_signature_guard'])),
 'ingredientLedgerTriggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) AND t.tgname IN('ordinary_crafting_shards_guard','ordinary_crafting_shards_complete')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract','divine_fragment_gems_zero_contract','mining_gems_zero_openings','mining_gems_zero_contract','divine_fragment_seeker_absence_contract','divine_fragment_existing_wallet_contract','mining_existing_wallet_baselines','mining_existing_wallet_contract','vehicle_issuance_acquisitions','vehicle_mint_registry','divine_fragment_vehicle_client_contract','vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals','vehicle_issuance_originals','divine_fragment_vehicle_material_contract','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','divine_fragment_enrolled_seeker_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])))
$$;


--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_return_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('advanced',public.shardkeep_advanced_return_fingerprint(),
 'starter',public.shardkeep_starter_return_fingerprint(),
 'predecessors',jsonb_build_object('advanced',(SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton),'starter',(SELECT source_sha256 FROM public.ordinary_equipment_starter_return_seal WHERE singleton)),
 'sources',public.shardkeep_divine_fragment_contract())
$$;
CREATE FUNCTION public.shardkeep_bound_cosmetic_return_sources_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.bound_cosmetic_return_contract'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,15)='bound_cosmetic_' AND c.relkind='r'
  AND session_user<>current_user AND (has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND (SELECT record FROM public.bound_cosmetic_return_contract WHERE singleton) IS NOT DISTINCT FROM public.shardkeep_bound_cosmetic_return_contract()
$$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_return_contract(),public.shardkeep_bound_cosmetic_return_sources_valid() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_settle_advanced_returns(wanted uuid, cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE home public.bases%ROWTYPE;trip public.advanced_expeditions%ROWTYPE;term public.expedition_term_snapshots%ROWTYPE;
 inst public.advanced_vehicle_installations%ROWTYPE;flight public.advanced_expedition_inflight%ROWTYPE;inventory public.resource_stocks%ROWTYPE;
 companion public.ordinary_equipment_secondary_outputs%ROWTYPE;held public.ordinary_equipment_reservations%ROWTYPE;
 supply record;op record;part jsonb;resource text;rid uuid;counted integer:=0;lifecycle record;
BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ADVANCED_READ_COMMITTED';END IF;
 IF wanted IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff) THEN RAISE EXCEPTION 'ADVANCED_RETURN_CLOCK';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.advanced_expeditions'::regclass)
 OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN('public.advanced_vehicle_installations'::regclass,'public.ordinary_equipment_jobs'::regclass,'public.advanced_return_capability_seal'::regclass) AND relowner<>current_user::regrole::oid)
 THEN RAISE EXCEPTION 'ADVANCED_RETURN_OWNER' USING ERRCODE='42501';END IF;
 IF session_user<>current_user AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND (left(c.relname,9)='advanced_' OR left(c.relname,19)='ordinary_equipment_') AND c.relkind='r'
  AND (has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 THEN RAISE EXCEPTION 'ADVANCED_RETURN_PRIVATE_GRANTS' USING ERRCODE='42501';END IF;
 IF NOT public.shardkeep_bound_cosmetic_return_sources_valid() THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
 SELECT * INTO STRICT home FROM public.bases WHERE id=wanted FOR UPDATE;
 -- No accepted obligation means no mutation. This preserves ordinary callers
 -- whose injected event clock is irrelevant to an absent advanced source.
 IF NOT EXISTS(SELECT 1 FROM public.advanced_expeditions e LEFT JOIN public.advanced_expedition_returns r ON r.expedition_id=e.id WHERE e.base_id=wanted AND r.id IS NULL) THEN RETURN 0;END IF;
 IF cutoff>clock_timestamp() THEN RAISE EXCEPTION 'ADVANCED_RETURN_CLOCK';END IF;
 FOR trip IN SELECT e.* FROM public.advanced_expeditions e LEFT JOIN public.advanced_expedition_returns r ON r.expedition_id=e.id
  WHERE e.base_id=wanted AND e.returns_at<=cutoff AND r.id IS NULL ORDER BY e.returns_at,e.id LOOP
  SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=trip.term_id AND snapshot_hash=trip.term_hash;
  IF (term.snapshot_hash=encode(sha256(convert_to(term.canonical,'UTF8')),'hex') AND term.snapshot=term.canonical::jsonb
   AND term.snapshot->>'termId'=term.term_id::text AND term.snapshot#>>'{source,genesisHash}'=term.genesis_hash
   AND term.snapshot#>>'{source,programId}'=term.program_id AND term.snapshot#>>'{source,auctionConfig}'=term.auction_config
   AND term.snapshot#>>'{source,round}'=term.round AND (term.snapshot->>'startsAt')::timestamptz=term.starts_at
   AND (term.snapshot->>'endsAt')::timestamptz=term.ends_at AND term.starts_at<=trip.departed_at AND trip.departed_at<term.ends_at
   AND trip.finality->>'commitment'='finalized' AND (trip.finality->>'observedAt')::timestamptz<=trip.departed_at
   AND (trip.finality->>'contextSlot')::numeric>=0 AND (trip.finality->>'contextSlot')::numeric<=18446744073709551615
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(term.snapshot->'spots') s WHERE (s->>'settlementSlot')::numeric>(trip.finality->>'contextSlot')::numeric)) IS NOT TRUE THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_TERM';END IF;
  IF (trip.home_evidence->>'baseId'=trip.base_id::text AND trip.home_evidence->>'custodyWallet'=trip.actor_wallet
   AND trip.route_snapshot->>'routeId'=trip.route_id AND (trip.route_snapshot->>'policyVersion')::integer=trip.policy_version
   AND trip.route_snapshot->>'resourceId'=trip.resource_id AND (trip.route_snapshot->>'grossQuantity')::bigint=trip.gross
   AND (trip.route_snapshot->>'netQuantity')::bigint=trip.net AND (trip.route_snapshot->>'islandPoolQuantity')::bigint=trip.tax
   AND trip.gross>0 AND trip.net>=0 AND trip.tax>=0 AND trip.gross::numeric=trip.net::numeric+trip.tax::numeric
   AND trip.returns_at-trip.departed_at=(trip.route_snapshot->>'durationSec')::bigint*interval '1 second'
   AND ((trip.route_snapshot->>'accessRequirement'='home' AND trip.route_snapshot->>'realmId'=trip.home_evidence->>'realmId' AND trip.access_evidence IS NULL)
    OR (trip.route_snapshot->>'accessRequirement'='paid_realm' AND trip.access_evidence->>'wallet'=trip.actor_wallet
     AND (ARRAY['frostveil','elderwood','sunscar','crownlands','seeker-reach','stormcairn','thornwake','cinderfall'])[(trip.access_evidence->>'realm')::integer+1]=trip.route_snapshot->>'realmId'
     AND trip.access_evidence#>>'{finality,commitment}'='finalized' AND (trip.access_evidence#>>'{finality,observedAt}')::timestamptz<=trip.departed_at
     AND (trip.access_evidence#>>'{finality,chainUnixTimestamp}')::numeric<=extract(epoch from trip.departed_at)
     AND extract(epoch from trip.departed_at)<(trip.access_evidence->>'expiresAt')::numeric
     AND trip.access_evidence#>>'{source,genesisHash}'=term.genesis_hash AND trip.access_evidence#>>'{source,programId}'=term.program_id))) IS NOT TRUE THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_SOURCE';END IF;
  SELECT * INTO STRICT inst FROM public.advanced_vehicle_installations WHERE reservation_id=trip.installation_id FOR UPDATE;
  SELECT * INTO STRICT lifecycle FROM public.shardkeep_vehicle_lifecycle(trip.installation_id);
  SELECT * INTO STRICT flight FROM public.advanced_expedition_inflight WHERE expedition_id=trip.id FOR UPDATE;
  IF inst.base_id<>wanted OR flight.base_id<>wanted OR flight.installation_id<>trip.installation_id
   OR lifecycle.completed_total<>trip.completed_before OR NOT lifecycle.away OR lifecycle.pending_intent_id IS NOT NULL
   OR trip.route_snapshot->>'family' IS DISTINCT FROM inst.family OR (trip.route_snapshot->>'tier')::integer IS DISTINCT FROM lifecycle.tier
  THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_FLIGHT';END IF;
  IF jsonb_typeof(trip.route_snapshot->'supplies') IS DISTINCT FROM 'array'
   OR (SELECT count(*) FROM public.advanced_expedition_supplies WHERE expedition_id=trip.id)<>jsonb_array_length(trip.route_snapshot->'supplies')
   OR jsonb_array_length(trip.route_snapshot->'supplies')<>(SELECT count(DISTINCT s->>'resourceId') FROM jsonb_array_elements(trip.route_snapshot->'supplies') s)
  THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_SUPPLIES';END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(trip.route_snapshot->'supplies') LOOP
   SELECT * INTO STRICT supply FROM public.advanced_expedition_supplies WHERE expedition_id=trip.id AND resource_id=part->>'resourceId';
   FOR op IN SELECT * FROM public.resource_stock_operations WHERE id IN(supply.reserve_id,supply.consume_id) LOOP
    IF op.base_id<>wanted OR op.custody_wallet<>trip.actor_wallet OR op.resource_id<>supply.resource_id OR op.quantity<>(part->>'quantity')::bigint OR op.quantity<=0 OR op.effective_quantity IS NOT NULL
     OR (op.id=supply.reserve_id AND (op.kind<>'reserve' OR op.reservation_id IS NOT NULL))
     OR (op.id=supply.consume_id AND (op.kind<>'consume' OR op.reservation_id IS DISTINCT FROM supply.reserve_id))
     OR (SELECT count(*) FROM public.resource_stock_entries WHERE operation_id=op.id)<>2
     OR NOT EXISTS(SELECT 1 FROM public.resource_stock_entries WHERE operation_id=op.id AND bucket=CASE op.kind WHEN 'reserve' THEN 'available' ELSE 'reserved' END AND delta=-op.quantity)
     OR NOT EXISTS(SELECT 1 FROM public.resource_stock_entries WHERE operation_id=op.id AND bucket=CASE op.kind WHEN 'reserve' THEN 'reserved' ELSE 'consumed' END AND delta=op.quantity)
    THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_SUPPLY_PROOF';END IF;
   END LOOP;
   IF (SELECT count(*) FROM public.resource_stock_operations WHERE id IN(supply.reserve_id,supply.consume_id))<>2
    OR EXISTS(SELECT 1 FROM public.raw_raid_reservation_debits WHERE reservation_id=supply.reserve_id) THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_SUPPLY_PROOF';END IF;
  END LOOP;
  SELECT * INTO held FROM public.ordinary_equipment_reservations WHERE trip_kind='advanced' AND expedition_id=trip.id;
  SELECT * INTO companion FROM public.ordinary_equipment_secondary_outputs WHERE trip_kind='advanced' AND expedition_id=trip.id;
  IF trip.route_snapshot ? 'fitting' THEN
   IF held.expedition_id IS NULL OR held.base_id<>wanted OR held.fitting_snapshot IS DISTINCT FROM trip.route_snapshot->'fitting' THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_FITTING';END IF;
  ELSIF held.expedition_id IS NOT NULL OR companion.expedition_id IS NOT NULL THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_FITTING';END IF;
  IF trip.route_snapshot ? 'secondaryOutput' THEN
   IF companion.expedition_id IS NULL OR companion.base_id<>wanted OR companion.term_id<>trip.term_id OR companion.term_hash<>trip.term_hash
    OR trip.route_snapshot->'secondaryOutput' IS DISTINCT FROM jsonb_build_object('resourceId',companion.resource_id,'grossQuantity',companion.gross::text,'netQuantity',companion.net::text,'islandPoolQuantity',companion.tax::text)
   THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_SECONDARY';END IF;
  ELSIF companion.expedition_id IS NOT NULL THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_SECONDARY';END IF;
  -- Preserve primary/secondary stock ordering. The Lens return trigger alone
  -- applies secondary credit; the function must never double-increment it.
  FOR resource IN SELECT DISTINCT x FROM unnest(ARRAY[trip.resource_id,companion.resource_id]) x WHERE x IS NOT NULL ORDER BY x LOOP
   INSERT INTO public.resource_stocks(base_id,resource_id) VALUES(wanted,resource) ON CONFLICT DO NOTHING;
   PERFORM resource_id FROM public.resource_stocks WHERE base_id=wanted AND resource_id=resource FOR UPDATE;
  END LOOP;
  SELECT * INTO STRICT inventory FROM public.resource_stocks WHERE base_id=wanted AND resource_id=trip.resource_id;
  IF inventory.available::numeric+inventory.reserved::numeric+trip.net::numeric>9223372036854775807 THEN RAISE EXCEPTION 'ADVANCED_RETURN_OVERFLOW';END IF;
  INSERT INTO public.advanced_expedition_returns(expedition_id,custody_wallet,returned_at) VALUES(trip.id,home.owner_wallet,cutoff) RETURNING id INTO rid;
  INSERT INTO public.advanced_expedition_entries(return_id,bucket,delta) VALUES(rid,'issued',-trip.gross),(rid,'base_stock',trip.net),(rid,'island_pool',trip.tax);
  UPDATE public.resource_stocks SET available=available+trip.net WHERE base_id=wanted AND resource_id=trip.resource_id;
  DELETE FROM public.advanced_expedition_inflight WHERE expedition_id=trip.id AND installation_id=trip.installation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADVANCED_ORIGINAL_FLIGHT';END IF;
  IF companion.expedition_id IS NOT NULL THEN
   INSERT INTO public.ordinary_equipment_secondary_returns(trip_kind,expedition_id,return_id) VALUES('advanced',trip.id,rid);
   INSERT INTO public.ordinary_equipment_secondary_entries(trip_kind,expedition_id,bucket,delta) VALUES('advanced',trip.id,'issued',-companion.gross),('advanced',trip.id,'base_stock',companion.net),('advanced',trip.id,'island_pool',companion.tax);
  END IF;
  IF held.expedition_id IS NOT NULL THEN INSERT INTO public.ordinary_equipment_releases(trip_kind,expedition_id,base_id,return_id) VALUES('advanced',trip.id,wanted,rid);END IF;
  counted:=counted+1;
 END LOOP;
 RETURN counted;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_settle_due_equipment(wanted uuid, cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE custody text;job public.ordinary_equipment_jobs%ROWTYPE;counted integer:=0;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'EQUIPMENT_READ_COMMITTED';END IF;
 IF wanted IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff) THEN RAISE EXCEPTION 'EQUIPMENT_COMPLETION_CLOCK';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass)
 OR current_setting('session_replication_role')<>'origin'
 OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
 SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=wanted FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.ordinary_equipment_jobs j LEFT JOIN public.ordinary_equipment_completions c ON c.job_id=j.id WHERE j.base_id=wanted AND c.job_id IS NULL) THEN RETURN 0;END IF;
 IF cutoff>clock_timestamp() THEN RAISE EXCEPTION 'EQUIPMENT_COMPLETION_CLOCK';END IF;
 FOR job IN SELECT j.* FROM public.ordinary_equipment_jobs j LEFT JOIN public.ordinary_equipment_completions c ON c.job_id=j.id
  WHERE j.base_id=wanted AND c.job_id IS NULL AND j.ready_at<=cutoff ORDER BY j.ready_at,j.id FOR UPDATE OF j LOOP
  INSERT INTO public.ordinary_equipment_completions(job_id,custody_wallet,completed_at) VALUES(job.id,custody,cutoff);
  counted:=counted+1;
 END LOOP;
 RETURN counted;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_idle(wanted uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'EQUIPMENT_READ_COMMITTED';END IF;
 IF wanted IS NULL OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass)
 OR current_setting('session_replication_role')<>'origin'
 OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
 PERFORM id FROM public.bases WHERE id=wanted FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_BASE_MISSING';END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.ordinary_equipment_jobs j LEFT JOIN public.ordinary_equipment_completions c ON c.job_id=j.id WHERE j.base_id=wanted AND c.job_id IS NULL);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_equipment_evidence(wanted uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE trip public.starter_expeditions%ROWTYPE;held public.ordinary_equipment_reservations%ROWTYPE;
 companion public.ordinary_equipment_secondary_outputs%ROWTYPE;released public.ordinary_equipment_releases%ROWTYPE;
 terminal public.starter_expedition_returns%ROWTYPE;secondary public.ordinary_equipment_secondary_returns%ROWTYPE;
 entries jsonb;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass)
 OR current_setting('session_replication_role')<>'origin'
 OR NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
 SELECT * INTO STRICT trip FROM public.starter_expeditions WHERE id=wanted;
 SELECT * INTO held FROM public.ordinary_equipment_reservations WHERE trip_kind='starter' AND expedition_id=wanted;
 IF NOT(trip.route_snapshot ? 'fitting') OR held.expedition_id IS NULL OR held.base_id<>trip.base_id
 OR held.fitting_snapshot IS DISTINCT FROM trip.route_snapshot->'fitting' THEN RAISE EXCEPTION 'STARTER_ORIGINAL_FITTING';END IF;
 SELECT * INTO companion FROM public.ordinary_equipment_secondary_outputs WHERE trip_kind='starter' AND expedition_id=wanted;
 IF trip.route_snapshot ? 'secondaryOutput' THEN
  IF companion.expedition_id IS NULL OR companion.base_id<>trip.base_id OR companion.term_id<>trip.term_id OR companion.term_hash<>trip.term_hash
   OR trip.route_snapshot->'secondaryOutput' IS DISTINCT FROM jsonb_build_object('resourceId',companion.resource_id,'grossQuantity',companion.gross::text,'netQuantity',companion.net::text,'islandPoolQuantity',companion.tax::text)
  THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SECONDARY';END IF;
 ELSIF companion.expedition_id IS NOT NULL THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SECONDARY';END IF;
 SELECT * INTO terminal FROM public.starter_expedition_returns WHERE expedition_id=wanted;
 SELECT * INTO released FROM public.ordinary_equipment_releases WHERE trip_kind='starter' AND expedition_id=wanted;
 SELECT * INTO secondary FROM public.ordinary_equipment_secondary_returns WHERE trip_kind='starter' AND expedition_id=wanted;
 SELECT coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'delta',delta::text) ORDER BY bucket),'[]'::jsonb) INTO entries FROM public.ordinary_equipment_secondary_entries WHERE trip_kind='starter' AND expedition_id=wanted;
 IF terminal.id IS NULL THEN
  IF released.expedition_id IS NOT NULL OR secondary.expedition_id IS NOT NULL OR jsonb_array_length(entries)<>0 THEN RAISE EXCEPTION 'STARTER_ORIGINAL_TERMINAL';END IF;
 ELSE
  IF released.return_id IS DISTINCT FROM terminal.id OR released.base_id IS DISTINCT FROM trip.base_id THEN RAISE EXCEPTION 'STARTER_ORIGINAL_RELEASE';END IF;
  IF companion.expedition_id IS NOT NULL THEN
   IF secondary.return_id IS DISTINCT FROM terminal.id OR secondary.stock_after::numeric-secondary.stock_before::numeric<>companion.net
    OR jsonb_array_length(entries)<>3 OR NOT(entries @> jsonb_build_array(jsonb_build_object('bucket','issued','delta',(-companion.gross)::text),jsonb_build_object('bucket','base_stock','delta',companion.net::text),jsonb_build_object('bucket','island_pool','delta',companion.tax::text)))
   THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SECONDARY_RETURN';END IF;
  ELSIF secondary.expedition_id IS NOT NULL OR jsonb_array_length(entries)<>0 THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SECONDARY_RETURN';END IF;
 END IF;
 RETURN jsonb_build_object('reservation',jsonb_build_object('base_id',held.base_id,'fitting_snapshot',held.fitting_snapshot),
  'release',CASE WHEN released.expedition_id IS NULL THEN NULL ELSE jsonb_build_object('return_id',released.return_id) END,
  'secondary',CASE WHEN companion.expedition_id IS NULL THEN NULL ELSE jsonb_build_object('base_id',companion.base_id,'term_id',companion.term_id,'term_hash',companion.term_hash,'resource_id',companion.resource_id,'gross',companion.gross::text,'net',companion.net::text,'tax',companion.tax::text) END,
  'secondaryReturn',CASE WHEN secondary.expedition_id IS NULL THEN NULL ELSE jsonb_build_object('return_id',secondary.return_id,'stock_before',secondary.stock_before::text,'stock_after',secondary.stock_after::text) END,'entries',entries);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_finish_starter_equipment(wanted uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE trip public.starter_expeditions%ROWTYPE;held public.ordinary_equipment_reservations%ROWTYPE;
 companion public.ordinary_equipment_secondary_outputs%ROWTYPE;terminal public.starter_expedition_returns%ROWTYPE;
 term public.expedition_term_snapshots%ROWTYPE;custody text;resource text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'STARTER_RETURN_READ_COMMITTED';END IF;
 IF wanted IS NULL OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN('public.ordinary_equipment_jobs'::regclass,'public.ordinary_equipment_starter_return_seal'::regclass,'public.starter_expeditions'::regclass) AND relowner<>current_user::regrole::oid)
 THEN RAISE EXCEPTION 'STARTER_RETURN_SOURCE_CHANGED';END IF;
 IF session_user<>current_user AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND left(c.relname,19)='ordinary_equipment_' AND c.relkind='r'
  AND (has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 THEN RAISE EXCEPTION 'STARTER_RETURN_PRIVATE_GRANTS' USING ERRCODE='42501';END IF;
 IF NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 THEN RAISE EXCEPTION 'STARTER_RETURN_SOURCE_CHANGED';END IF;
 SELECT * INTO STRICT trip FROM public.starter_expeditions WHERE id=wanted;
 SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=trip.base_id FOR UPDATE;
 SELECT * INTO STRICT held FROM public.ordinary_equipment_reservations WHERE trip_kind='starter' AND expedition_id=wanted;
 IF held.base_id<>trip.base_id OR held.fitting_snapshot IS DISTINCT FROM trip.route_snapshot->'fitting'
 OR (held.fitting_snapshot->>'itemId' IN('route_compass','survey_lens') AND held.fitting_snapshot->>'policyVersion'='1') IS NOT TRUE
 THEN RAISE EXCEPTION 'STARTER_ORIGINAL_FITTING';END IF;
 SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=trip.term_id AND snapshot_hash=trip.term_hash;
 IF (term.snapshot_hash=encode(sha256(convert_to(term.canonical,'UTF8')),'hex') AND term.snapshot=term.canonical::jsonb
  AND term.snapshot->>'termId'=term.term_id::text AND term.snapshot#>>'{source,genesisHash}'=term.genesis_hash
  AND term.snapshot#>>'{source,programId}'=term.program_id AND term.snapshot#>>'{source,auctionConfig}'=term.auction_config
  AND term.snapshot#>>'{source,round}'=term.round AND (term.snapshot->>'startsAt')::timestamptz=term.starts_at
  AND (term.snapshot->>'endsAt')::timestamptz=term.ends_at AND term.starts_at<=trip.departed_at AND trip.departed_at<term.ends_at
  AND trip.finality->>'commitment'='finalized' AND (trip.finality->>'observedAt')::timestamptz<=trip.departed_at
  AND trip.home_evidence->>'baseId'=trip.base_id::text AND trip.home_evidence->>'custodyWallet'=trip.actor_wallet
  AND trip.route_snapshot->>'routeId'=trip.route_id AND (trip.route_snapshot->>'routeCatalogueVersion')::integer=trip.route_version
  AND (trip.route_snapshot->>'rewardTableVersion')::integer=trip.reward_version AND trip.route_snapshot->>'resourceId'=trip.resource_id
  AND (trip.route_snapshot->>'grossQuantity')::bigint=trip.gross AND (trip.route_snapshot->>'netQuantity')::bigint=trip.net
  AND (trip.route_snapshot->>'islandPoolQuantity')::bigint=trip.tax AND trip.gross>0 AND trip.net>=0 AND trip.tax>=0
  AND trip.gross::numeric=trip.net::numeric+trip.tax::numeric AND trip.returns_at-trip.departed_at=(trip.route_snapshot->>'durationSec')::bigint*interval '1 second') IS NOT TRUE
 THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SOURCE';END IF;
 SELECT * INTO STRICT terminal FROM public.starter_expedition_returns WHERE expedition_id=wanted;
 IF NOT isfinite(terminal.returned_at) OR terminal.returned_at<trip.returns_at OR terminal.returned_at>clock_timestamp() THEN RAISE EXCEPTION 'STARTER_RETURN_CLOCK';END IF;
 IF EXISTS(SELECT 1 FROM public.starter_expedition_inflight WHERE expedition_id=wanted)
 OR NOT EXISTS(SELECT 1 FROM public.fleet_installations WHERE id=trip.installation_id AND base_id=trip.base_id AND family='starter')
 OR (SELECT count(*) FROM public.starter_expedition_entries WHERE return_id=terminal.id)<>3
 OR NOT EXISTS(SELECT 1 FROM public.starter_expedition_entries WHERE return_id=terminal.id AND bucket='issued' AND delta=-trip.gross)
 OR NOT EXISTS(SELECT 1 FROM public.starter_expedition_entries WHERE return_id=terminal.id AND bucket='base_stock' AND delta=trip.net)
 OR NOT EXISTS(SELECT 1 FROM public.starter_expedition_entries WHERE return_id=terminal.id AND bucket='island_pool' AND delta=trip.tax)
 THEN RAISE EXCEPTION 'STARTER_ORIGINAL_PRIMARY_RETURN';END IF;
 -- An already complete immutable original is replayable after later custody changes.
 IF EXISTS(SELECT 1 FROM public.ordinary_equipment_releases WHERE trip_kind='starter' AND expedition_id=wanted) THEN
  PERFORM public.shardkeep_starter_equipment_evidence(wanted);RETURN 0;
 END IF;
 IF terminal.custody_wallet<>custody THEN RAISE EXCEPTION 'STARTER_RETURN_CUSTODY';END IF;
 SELECT * INTO companion FROM public.ordinary_equipment_secondary_outputs WHERE trip_kind='starter' AND expedition_id=wanted;
 IF held.fitting_snapshot->>'itemId'='survey_lens' THEN
  IF companion.expedition_id IS NULL OR companion.base_id<>trip.base_id OR companion.term_id<>trip.term_id OR companion.term_hash<>trip.term_hash
   OR companion.resource_id=trip.resource_id OR held.fitting_snapshot->>'resourceId' IS DISTINCT FROM companion.resource_id
   OR trip.route_snapshot->'secondaryOutput' IS DISTINCT FROM jsonb_build_object('resourceId',companion.resource_id,'grossQuantity',companion.gross::text,'netQuantity',companion.net::text,'islandPoolQuantity',companion.tax::text)
  THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SECONDARY';END IF;
 ELSIF companion.expedition_id IS NOT NULL OR trip.route_snapshot ? 'secondaryOutput' THEN RAISE EXCEPTION 'STARTER_ORIGINAL_SECONDARY';END IF;
 IF EXISTS(SELECT 1 FROM public.ordinary_equipment_secondary_returns WHERE trip_kind='starter' AND expedition_id=wanted)
 OR EXISTS(SELECT 1 FROM public.ordinary_equipment_secondary_entries WHERE trip_kind='starter' AND expedition_id=wanted) THEN RAISE EXCEPTION 'STARTER_ORIGINAL_PARTIAL_RETURN';END IF;
 -- Same sorted base-local stock order as the ordinary TS primary settlement.
 FOR resource IN SELECT x FROM unnest(ARRAY[trip.resource_id,companion.resource_id]) x WHERE x IS NOT NULL ORDER BY x LOOP
  INSERT INTO public.resource_stocks(base_id,resource_id) VALUES(trip.base_id,resource) ON CONFLICT DO NOTHING;
  PERFORM resource_id FROM public.resource_stocks WHERE base_id=trip.base_id AND resource_id=resource FOR UPDATE;
 END LOOP;
 IF companion.expedition_id IS NOT NULL THEN
  INSERT INTO public.ordinary_equipment_secondary_returns(trip_kind,expedition_id,return_id) VALUES('starter',wanted,terminal.id);
  INSERT INTO public.ordinary_equipment_secondary_entries(trip_kind,expedition_id,bucket,delta) VALUES
   ('starter',wanted,'issued',-companion.gross),('starter',wanted,'base_stock',companion.net),('starter',wanted,'island_pool',companion.tax);
 END IF;
 INSERT INTO public.ordinary_equipment_releases(trip_kind,expedition_id,base_id,return_id) VALUES('starter',wanted,trip.base_id,terminal.id);
 PERFORM public.shardkeep_starter_equipment_evidence(wanted);
 RETURN 1;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_return_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.bound_cosmetic_return_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'bound_cosmetic_return_contract_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM public.bound_cosmetic_return_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_RETURN_SEAL_IMMUTABLE';END IF;
 IF NEW.record IS DISTINCT FROM public.shardkeep_bound_cosmetic_return_contract() THEN RAISE EXCEPTION 'BOUND_COSMETIC_RETURN_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER bound_cosmetic_return_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_return_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_return_seal_guard();
CREATE TRIGGER bound_cosmetic_return_contract_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_return_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_return_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_return_seal_guard() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_fragment_bound_cosmetics_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetics_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.divine_fragment_bound_cosmetics_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'divine_fragment_bound_cosmetics_contract_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM public.divine_fragment_bound_cosmetics_contract) OR NEW.singleton IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_SEAL_IMMUTABLE';END IF;
 IF NEW.record IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'BOUND_COSMETIC_SEAL_IMMUTABLE';END IF;
 -- New private dependencies must start private and ordinary permanent tables;
 -- the snapshot then detects later ownership, column ACL and shape changes.
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  AND c.relname=ANY(ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal','divine_fragment_bound_cosmetics_contract'])
  AND (c.relkind<>'r' OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhassubclass
   OR c.relowner<>current_user::regrole::oid
   OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped AND a.grantee<>c.relowner)))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_SEAL_PRIVATE_SOURCE';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  AND p.proname=ANY(ARRAY['shardkeep_bound_cosmetic_return_contract','shardkeep_bound_cosmetic_return_sources_valid','shardkeep_bound_cosmetic_return_seal_guard','shardkeep_bound_cosmetic_recipe','shardkeep_bound_cosmetic_appearance','shardkeep_bound_cosmetic_blueprint_source','shardkeep_bound_cosmetic_guard','shardkeep_bound_cosmetic_debit','shardkeep_bound_cosmetic_blueprint_complete','shardkeep_bound_cosmetic_workshop_guard','shardkeep_bound_cosmetics_seal_guard'])
  AND (p.proowner<>current_user::regrole::oid OR p.prosecdef IS DISTINCT FROM (p.proname='shardkeep_bound_cosmetic_workshop_guard')
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_SEAL_PRIVATE_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER divine_fragment_bound_cosmetics_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.divine_fragment_bound_cosmetics_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetics_seal_guard();
CREATE TRIGGER divine_fragment_bound_cosmetics_contract_no_truncate BEFORE TRUNCATE ON public.divine_fragment_bound_cosmetics_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetics_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetics_seal_guard() FROM PUBLIC;
INSERT INTO public.bound_cosmetic_return_contract(record) SELECT public.shardkeep_bound_cosmetic_return_contract();
INSERT INTO public.divine_fragment_bound_cosmetics_contract(record) SELECT public.shardkeep_divine_fragment_contract();
SELECT public.shardkeep_divine_fragment_source();
SELECT public.shardkeep_bound_cosmetic_return_sources_valid();
