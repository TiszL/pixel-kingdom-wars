-- Prospective advanced facts beside the unchanged starter/simulator contract.
SET LOCAL lock_timeout='10s';
CREATE TABLE public.raid_advanced_presentations(
 raid_id uuid PRIMARY KEY REFERENCES public.raids(id) ON DELETE RESTRICT,
 defender_base_id uuid NOT NULL,defender_wallet text NOT NULL,captured_at timestamptz NOT NULL,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 facts jsonb NOT NULL,source_record jsonb NOT NULL
);
REVOKE ALL ON public.raid_advanced_presentations FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_projection(target uuid,frozen jsonb,cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE berth_ids jsonb;current_ids jsonb;installed public.advanced_vehicle_installations%ROWTYPE;
 lifecycle record;active record;active_count bigint;pointer_count bigint;facts jsonb:='[]';bindings jsonb:='[]';
 result jsonb;binding jsonb;seen_families text[]:=ARRAY[]::text[];seen_berths uuid[]:=ARRAY[]::uuid[];
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.advanced_vehicle_installations'::regclass)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'RAID_ADVANCED_AUTHORITY';END IF;
 IF NOT isfinite(cutoff) OR jsonb_typeof(frozen)<>'object' OR jsonb_typeof(frozen->'buildings')<>'array'
 THEN RETURN jsonb_build_object('facts',NULL,'sourceRecord',NULL);END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'buildings') b WHERE jsonb_typeof(b)<>'object'
  OR jsonb_typeof(b->'id')<>'string' OR b->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 OR(SELECT count(*)<>count(DISTINCT b->>'id') FROM jsonb_array_elements(frozen->'buildings') b)
 THEN RETURN jsonb_build_object('facts',NULL,'sourceRecord',NULL);END IF;
 SELECT coalesce(jsonb_agg(b->>'id' ORDER BY b->>'id'),'[]'::jsonb) INTO berth_ids
 FROM jsonb_array_elements(frozen->'buildings') b WHERE b->>'type'='berth';
 SELECT coalesce(jsonb_agg(b.id::text ORDER BY b.id::text),'[]'::jsonb) INTO current_ids
 FROM public.buildings b WHERE b.base_id=target AND b.type='berth'
 AND NOT EXISTS(SELECT 1 FROM public.builder_jobs j WHERE j.building_id=b.id AND j.kind='build' AND j.completed_at IS NULL);
 IF berth_ids IS DISTINCT FROM current_ids OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'buildings') b
  LEFT JOIN public.buildings actual ON actual.id::text=b->>'id' AND actual.base_id=target
  WHERE b->>'type'='berth' AND(actual.id IS NULL OR actual.type<>'berth' OR b->'level' IS DISTINCT FROM to_jsonb(actual.level)
   OR b->'underConstruction'='true'::jsonb)) THEN RETURN jsonb_build_object('facts',NULL,'sourceRecord',NULL);END IF;

 IF EXISTS(SELECT 1 FROM public.vehicle_burn_consumptions c JOIN public.vehicle_activation_reservations r ON r.id=c.reservation_id
  LEFT JOIN public.advanced_vehicle_installations i ON i.reservation_id=r.id AND i.base_id=r.base_id WHERE r.base_id=target AND i.reservation_id IS NULL)
 THEN RAISE EXCEPTION 'RAID_ADVANCED_INSTALLATION_SOURCE';END IF;
 FOR installed IN SELECT * FROM public.advanced_vehicle_installations WHERE base_id=target ORDER BY reservation_id LOOP
  SELECT * INTO STRICT lifecycle FROM public.shardkeep_vehicle_lifecycle(installed.reservation_id);
  IF lifecycle.base_id<>target OR installed.family=ANY(seen_families) OR installed.berth_id=ANY(seen_berths)
   OR NOT berth_ids @> jsonb_build_array(installed.berth_id::text)
   OR NOT EXISTS(SELECT 1 FROM public.buildings b JOIN public.builder_jobs j ON j.building_id=b.id
    WHERE b.id=installed.berth_id AND b.base_id=target AND b.type='berth' AND b.level>=1
     AND j.id=installed.completed_build_job_id AND j.base_id=target AND j.kind='build'
     AND j.completed_at=installed.berth_completed_at AND j.cancelled_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.fleet_installations WHERE berth_id=installed.berth_id)
  THEN RAISE EXCEPTION 'RAID_ADVANCED_INSTALLATION_SOURCE';END IF;
  seen_families:=array_append(seen_families,installed.family);seen_berths:=array_append(seen_berths,installed.berth_id);
  IF installed.installed_at>cutoff OR installed.berth_completed_at>cutoff
   OR EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE id=installed.reservation_id AND reserved_at>cutoff)
   OR EXISTS(SELECT 1 FROM public.vehicle_burn_consumptions WHERE reservation_id=installed.reservation_id AND recorded_at>cutoff)
   OR EXISTS(SELECT 1 FROM public.vehicle_service_applications a JOIN public.vehicle_service_consumptions c ON c.intent_id=a.intent_id
    WHERE a.installation_id=installed.reservation_id AND(a.applied_at>cutoff OR c.recorded_at>cutoff))
   OR EXISTS(SELECT 1 FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id
    WHERE e.installation_id=installed.reservation_id AND r.returned_at>cutoff)
  THEN RAISE EXCEPTION 'RAID_ADVANCED_CUTOFF';END IF;
  IF EXISTS(SELECT 1 FROM public.vehicle_service_intents s LEFT JOIN public.vehicle_service_consumptions c ON c.intent_id=s.id
   LEFT JOIN public.vehicle_service_applications a ON a.intent_id=s.id WHERE s.installation_id=installed.reservation_id
    AND((c.intent_id IS NULL)<>(a.intent_id IS NULL))) THEN RAISE EXCEPTION 'RAID_ADVANCED_SERVICE_SOURCE';END IF;
  SELECT count(*) INTO active_count FROM public.advanced_expeditions e LEFT JOIN public.advanced_expedition_returns r ON r.expedition_id=e.id
   LEFT JOIN public.advanced_expedition_inflight f ON f.expedition_id=e.id WHERE e.installation_id=installed.reservation_id AND(r.id IS NULL OR f.expedition_id IS NOT NULL);
  SELECT count(*) INTO pointer_count FROM public.advanced_expedition_inflight WHERE installation_id=installed.reservation_id;
  IF active_count>1 OR pointer_count<>active_count OR lifecycle.away IS DISTINCT FROM(active_count=1)
  THEN RAISE EXCEPTION 'RAID_ADVANCED_FLIGHT_SOURCE';END IF;
  IF active_count=1 THEN
   SELECT e.*,f.installation_id pointer,f.base_id pointer_base,r.id returned INTO active FROM public.advanced_expeditions e
    LEFT JOIN public.advanced_expedition_returns r ON r.expedition_id=e.id LEFT JOIN public.advanced_expedition_inflight f ON f.expedition_id=e.id
    WHERE e.installation_id=installed.reservation_id AND(r.id IS NULL OR f.expedition_id IS NOT NULL);
   IF active.returned IS NOT NULL OR active.pointer IS DISTINCT FROM installed.reservation_id OR active.pointer_base IS DISTINCT FROM target
    OR active.base_id<>target OR active.departed_at>cutoff OR active.returns_at<=cutoff OR active.completed_before<>lifecycle.completed_total
    OR active.route_snapshot->>'family' IS DISTINCT FROM lifecycle.family OR active.route_snapshot->'tier' IS DISTINCT FROM to_jsonb(lifecycle.tier)
    OR jsonb_typeof(active.route_snapshot->'supplies') IS DISTINCT FROM 'array'
    OR(SELECT count(*) FROM public.advanced_expedition_supplies WHERE expedition_id=active.id)<>jsonb_array_length(active.route_snapshot->'supplies')
   THEN RAISE EXCEPTION 'RAID_ADVANCED_FLIGHT_SOURCE';END IF;
  END IF;
  facts:=facts||jsonb_build_array(jsonb_build_object('buildingId',installed.berth_id::text,'installation',jsonb_build_object(
   'family',lifecycle.family,'tier',lifecycle.tier,'away',lifecycle.away,'completedTotal',lifecycle.completed_total::text,'allowanceStart',lifecycle.allowance_start::text)));
  -- Bounded checkpoints bind originals without exposing chain consent or copying
  -- an unbounded trip history. Existing lifecycle remains the source authority.
  SELECT jsonb_build_object('installation',to_jsonb(installed),'reservation',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'),
   'burn',encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex'),'build',encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex'),
   'lifecycle',to_jsonb(lifecycle)-'pending_intent_id',
   'service',(SELECT to_jsonb(a) FROM public.vehicle_service_applications a WHERE a.installation_id=installed.reservation_id ORDER BY revision_after DESC LIMIT 1),
   'return',(SELECT to_jsonb(ret) FROM public.advanced_expedition_returns ret JOIN public.advanced_expeditions e ON e.id=ret.expedition_id WHERE e.installation_id=installed.reservation_id ORDER BY completed_total DESC LIMIT 1),
   'active',(SELECT encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex') FROM public.advanced_expeditions e LEFT JOIN public.advanced_expedition_returns ret ON ret.expedition_id=e.id WHERE e.installation_id=installed.reservation_id AND ret.id IS NULL)) INTO binding
   FROM public.vehicle_activation_reservations r JOIN public.vehicle_burn_consumptions c ON c.reservation_id=r.id
   JOIN public.builder_jobs j ON j.id=installed.completed_build_job_id WHERE r.id=installed.reservation_id;
  bindings:=bindings||jsonb_build_array(binding);
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.advanced_expeditions e LEFT JOIN public.advanced_vehicle_installations i ON i.reservation_id=e.installation_id
   WHERE e.base_id=target AND(i.base_id IS DISTINCT FROM target OR NOT i.berth_id=ANY(seen_berths)))
  OR EXISTS(SELECT 1 FROM public.advanced_expedition_inflight f LEFT JOIN public.advanced_vehicle_installations i ON i.reservation_id=f.installation_id
   WHERE f.base_id=target AND(i.base_id IS DISTINCT FROM target OR NOT i.berth_id=ANY(seen_berths)))
 THEN RAISE EXCEPTION 'RAID_ADVANCED_FLIGHT_SOURCE';END IF;
 SELECT jsonb_build_object('version',1,'berths',coalesce(jsonb_agg(jsonb_build_object('buildingId',b.value,
  'installation',coalesce((SELECT f->'installation' FROM jsonb_array_elements(facts) f WHERE f->>'buildingId'=b.value),'null'::jsonb)) ORDER BY b.value),'[]'::jsonb)) INTO result FROM jsonb_array_elements_text(berth_ids) b;
 RETURN jsonb_build_object('facts',result,'sourceRecord',bindings);
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_advanced_projection(uuid,jsonb,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_candidate(target uuid,frozen jsonb,cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE value jsonb;valid boolean;
BEGIN
 EXECUTE 'SELECT public.shardkeep_raid_starter_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RAISE EXCEPTION 'RAID_ADVANCED_SOURCE';END IF;
 PERFORM 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id AND s.wallet=b.owner_wallet AND s.active
  WHERE b.id=target AND b.status='active' FOR UPDATE OF b,s NOWAIT;
 IF NOT FOUND OR NOT isfinite(cutoff) OR cutoff>clock_timestamp() THEN RAISE EXCEPTION 'RAID_ADVANCED_CANDIDATE_SOURCE';END IF;
 value:=public.shardkeep_raid_advanced_projection(target,frozen,cutoff);
 RETURN jsonb_build_object('version',1,'facts',value->'facts','sourceSha256',encode(sha256(convert_to((value->'sourceRecord')::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.raid_advanced_presentations'::regclass OR TG_NAME<>'raid_advanced_guard'
  OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' OR pg_trigger_depth()<>2
  OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'RAID_ADVANCED_IMMUTABLE' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_advanced_guard() FROM PUBLIC;
CREATE TRIGGER raid_advanced_guard BEFORE INSERT OR UPDATE OR DELETE ON public.raid_advanced_presentations
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raid_advanced_guard();
CREATE TRIGGER raid_advanced_no_truncate BEFORE TRUNCATE ON public.raid_advanced_presentations
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_raid_advanced_guard();

--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owner_wallet text;valid boolean;captured jsonb;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raid_advanced_capture' OR TG_WHEN<>'AFTER'
  OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' OR pg_trigger_depth()<>1
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'RAID_ADVANCED_CAPTURE' USING ERRCODE='42501';END IF;
 -- Legacy wallet raids, generated camps and campaigns have no stable source.
 IF NEW.defender_base_id IS NULL OR NEW.defender_wallet IS NULL OR NEW.pve_camp_id IS NOT NULL OR NEW.campaign_stage IS NOT NULL
 THEN RETURN NULL;END IF;
 IF to_regprocedure('public.shardkeep_raid_advanced_sources_valid()') IS NULL THEN RAISE EXCEPTION 'RAID_ADVANCED_SOURCE';END IF;
 EXECUTE 'SELECT public.shardkeep_raid_starter_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RAISE EXCEPTION 'RAID_ADVANCED_SOURCE';END IF;
 SELECT b.owner_wallet INTO owner_wallet FROM public.bases b WHERE b.id=NEW.defender_base_id AND b.status='active' FOR UPDATE;
 IF owner_wallet IS DISTINCT FROM NEW.defender_wallet OR NOT EXISTS(SELECT 1 FROM public.base_slots s
  WHERE s.base_id=NEW.defender_base_id AND s.wallet=owner_wallet AND s.active)
  OR NOT isfinite(NEW.created_at) OR NEW.created_at>clock_timestamp()
 THEN RAISE EXCEPTION 'RAID_ADVANCED_CAPTURE_SOURCE';END IF;
 captured:=public.shardkeep_raid_advanced_projection(NEW.defender_base_id,NEW.snapshot,NEW.created_at);
 INSERT INTO public.raid_advanced_presentations(raid_id,defender_base_id,defender_wallet,captured_at,snapshot_sha256,facts,source_record)
 VALUES(NEW.id,NEW.defender_base_id,NEW.defender_wallet,NEW.created_at,encode(sha256(convert_to(NEW.snapshot::text,'UTF8')),'hex'),captured->'facts',captured->'sourceRecord');
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_advanced_capture() FROM PUBLIC;
CREATE TRIGGER raid_advanced_capture AFTER INSERT ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raid_advanced_capture();

--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_advanced_presentation(target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE captured public.raid_advanced_presentations%ROWTYPE;original public.raids%ROWTYPE;valid boolean;
BEGIN
 SELECT * INTO captured FROM public.raid_advanced_presentations WHERE raid_id=target;
 IF NOT FOUND THEN RETURN NULL;END IF;
 EXECUTE 'SELECT public.shardkeep_raid_starter_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RAISE EXCEPTION 'RAID_ADVANCED_SOURCE';END IF;
 SELECT * INTO original FROM public.raids WHERE id=target;
 IF NOT FOUND OR original.defender_base_id IS DISTINCT FROM captured.defender_base_id
  OR original.defender_wallet IS DISTINCT FROM captured.defender_wallet OR original.created_at IS DISTINCT FROM captured.captured_at
  OR encode(sha256(convert_to(original.snapshot::text,'UTF8')),'hex') IS DISTINCT FROM captured.snapshot_sha256
 THEN RAISE EXCEPTION 'RAID_ADVANCED_ORIGINAL_SOURCE';END IF;
 RETURN jsonb_build_object('version',1,'facts',captured.facts,'sourceSha256',encode(sha256(convert_to(captured.source_record::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_advanced_presentation(uuid) FROM PUBLIC;
