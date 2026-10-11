-- S5 HELD: finish only the private equipment legs of an owner-admitted starter
-- trip after its existing same-transaction primary return. No caller quantities.
-- 0256 and all historical function/trigger attributes remain unchanged.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.ordinary_equipment_starter_return_seal(
 singleton boolean PRIMARY KEY CHECK(singleton),source_sha256 text NOT NULL CHECK(source_sha256~'^[0-9a-f]{64}$')
);
REVOKE ALL ON public.ordinary_equipment_starter_return_seal FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_return_fingerprint() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH relations AS (
  SELECT c.oid,c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN('starter_expeditions','starter_expedition_inflight','starter_expedition_returns','starter_expedition_entries','fleet_installations')
 ), functions AS (
  SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prolang,p.prorettype,p.proargtypes::text args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.oid IN(SELECT t.tgfoid FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal)
   OR p.proname IN('shardkeep_starter_return_fingerprint','shardkeep_finish_starter_equipment'))
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'advanced',public.shardkeep_advanced_return_fingerprint(),
  'relations',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner) ORDER BY relname) FROM relations),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc,'owner',proowner,'definer',prosecdef,'config',proconfig,'language',prolang,'returns',prorettype,'args',args,
   'acl',CASE WHEN proname='shardkeep_finish_starter_equipment' THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a) END) ORDER BY proname,args) FROM functions),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,'function',t.tgfoid,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initial',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(r.relname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid)
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_return_fingerprint() FROM PUBLIC;
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
 IF public.shardkeep_advanced_return_fingerprint() IS DISTINCT FROM (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton)
 OR public.shardkeep_starter_return_fingerprint() IS DISTINCT FROM (SELECT source_sha256 FROM public.ordinary_equipment_starter_return_seal WHERE singleton)
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
REVOKE ALL ON FUNCTION public.shardkeep_finish_starter_equipment(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE role_name text;BEGIN
 FOREACH role_name IN ARRAY ARRAY['shardkeep_api_runtime','shardkeep_worker_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.shardkeep_starter_return_fingerprint() FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON public.ordinary_equipment_starter_return_seal FROM %I',role_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.shardkeep_finish_starter_equipment(uuid) TO %I',role_name);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.ordinary_equipment_starter_return_seal) THEN
  INSERT INTO public.ordinary_equipment_starter_return_seal VALUES(true,public.shardkeep_starter_return_fingerprint());
 ELSIF (SELECT source_sha256 FROM public.ordinary_equipment_starter_return_seal WHERE singleton) IS DISTINCT FROM public.shardkeep_starter_return_fingerprint() THEN
  RAISE EXCEPTION 'STARTER_RETURN_SOURCE_CHANGED';
 END IF;
END $$;
