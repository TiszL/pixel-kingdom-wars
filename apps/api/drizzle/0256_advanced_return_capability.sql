-- S5 HELD: existing accepted advanced obligations at a caller's atomic boundary.
-- Derive rewards from owner-admitted immutable originals, never caller amounts or
-- today's catalogue. Owner TS readers retain their fuller frozen-policy audit.
SET LOCAL lock_timeout='10s';
ALTER FUNCTION public.shardkeep_advanced_expedition_complete() SECURITY DEFINER;
ALTER FUNCTION public.shardkeep_equipment_trip_proof_v2() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.shardkeep_advanced_expedition_complete(),public.shardkeep_equipment_trip_proof_v2() FROM PUBLIC;
CREATE TABLE IF NOT EXISTS public.advanced_return_capability_seal (
 singleton boolean PRIMARY KEY CHECK(singleton), source_sha256 text NOT NULL CHECK(source_sha256~'^[0-9a-f]{64}$')
);
REVOKE ALL ON public.advanced_return_capability_seal FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_advanced_return_fingerprint() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH relations AS (
  SELECT c.oid,c.relname,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND (c.relname IN('advanced_vehicle_installations','advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies',
   'ordinary_equipment_jobs','ordinary_equipment_completions','ordinary_equipment_stocks','ordinary_equipment_reservations','ordinary_equipment_releases','ordinary_equipment_secondary_outputs','ordinary_equipment_secondary_returns','ordinary_equipment_secondary_entries',
   'expedition_term_snapshots','resource_stock_operations','resource_stock_entries','resource_stocks'))
 ), functions AS (
  SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proacl,p.prolang,p.prorettype,p.proargtypes::text args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.oid IN(SELECT t.tgfoid FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal)
   OR p.proname IN('shardkeep_vehicle_lifecycle','shardkeep_vehicle_service_state_v214','shardkeep_vehicle_service_effect_v214','shardkeep_vehicle_service_proof_valid_v214','shardkeep_advanced_return_fingerprint','shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence'))
 )
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'relations',(SELECT jsonb_agg(jsonb_build_object('name',relname,'owner',relowner) ORDER BY relname) FROM relations),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc,'owner',proowner,'definer',prosecdef,'config',proconfig,'language',prolang,'returns',prorettype,'args',args,
   'acl',CASE WHEN proname IN('shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle','shardkeep_starter_equipment_evidence') THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_array(a.grantor,a.grantee,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a) END) ORDER BY proname,args) FROM functions),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,'function',t.tgfoid,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initial',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(r.relname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN relations r ON r.oid=c.conrelid)
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION public.shardkeep_advanced_return_fingerprint() FROM PUBLIC;
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
 IF public.shardkeep_advanced_return_fingerprint() IS DISTINCT FROM (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton) THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
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
REVOKE ALL ON FUNCTION public.shardkeep_settle_advanced_returns(uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
-- Ordinary crafting always drains gear completions at these same boundaries.
-- Keep that dependency count-only rather than reopening its private source rows.
CREATE OR REPLACE FUNCTION public.shardkeep_settle_due_equipment(wanted uuid, cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE custody text;job public.ordinary_equipment_jobs%ROWTYPE;counted integer:=0;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'EQUIPMENT_READ_COMMITTED';END IF;
 IF wanted IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff) THEN RAISE EXCEPTION 'EQUIPMENT_COMPLETION_CLOCK';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass)
 OR current_setting('session_replication_role')<>'origin'
 OR public.shardkeep_advanced_return_fingerprint() IS DISTINCT FROM (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton)
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
REVOKE ALL ON FUNCTION public.shardkeep_settle_due_equipment(uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
-- Shared Workshop admission needs only an idle predicate, never job rows.
CREATE OR REPLACE FUNCTION public.shardkeep_equipment_idle(wanted uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'EQUIPMENT_READ_COMMITTED';END IF;
 IF wanted IS NULL OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass)
 OR current_setting('session_replication_role')<>'origin'
 OR public.shardkeep_advanced_return_fingerprint() IS DISTINCT FROM (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton)
 THEN RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';END IF;
 PERFORM id FROM public.bases WHERE id=wanted FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_BASE_MISSING';END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.ordinary_equipment_jobs j LEFT JOIN public.ordinary_equipment_completions c ON c.job_id=j.id WHERE j.base_id=wanted AND c.job_id IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_equipment_idle(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Saved starter originals were already readable by ordinary roles. Reveal only
-- their exact attested fitting/companion proof, never private stock or jobs.
CREATE OR REPLACE FUNCTION public.shardkeep_starter_equipment_evidence(wanted uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE trip public.starter_expeditions%ROWTYPE;held public.ordinary_equipment_reservations%ROWTYPE;
 companion public.ordinary_equipment_secondary_outputs%ROWTYPE;released public.ordinary_equipment_releases%ROWTYPE;
 terminal public.starter_expedition_returns%ROWTYPE;secondary public.ordinary_equipment_secondary_returns%ROWTYPE;
 entries jsonb;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_equipment_jobs'::regclass)
 OR current_setting('session_replication_role')<>'origin'
 OR public.shardkeep_advanced_return_fingerprint() IS DISTINCT FROM (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton)
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
REVOKE ALL ON FUNCTION public.shardkeep_starter_equipment_evidence(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE role_name text;BEGIN
 FOREACH role_name IN ARRAY ARRAY['shardkeep_api_runtime','shardkeep_worker_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.shardkeep_advanced_expedition_complete(),public.shardkeep_equipment_trip_proof_v2(),public.shardkeep_advanced_return_fingerprint() FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON public.advanced_return_capability_seal FROM %I',role_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.shardkeep_settle_advanced_returns(uuid,timestamptz),public.shardkeep_settle_due_equipment(uuid,timestamptz),public.shardkeep_equipment_idle(uuid),public.shardkeep_starter_equipment_evidence(uuid) TO %I',role_name);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.advanced_return_capability_seal) THEN
  INSERT INTO public.advanced_return_capability_seal VALUES(true,public.shardkeep_advanced_return_fingerprint());
 ELSIF (SELECT source_sha256 FROM public.advanced_return_capability_seal WHERE singleton) IS DISTINCT FROM public.shardkeep_advanced_return_fingerprint() THEN
  RAISE EXCEPTION 'ADVANCED_RETURN_SOURCE_CHANGED';
 END IF;
END $$;
