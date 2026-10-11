-- Prospective starter-only presentation. Never change simulator inputs or
-- reconstruct a historical raid from current fleet state.
SET LOCAL lock_timeout='10s';
CREATE TABLE public.raid_starter_presentations(
 raid_id uuid PRIMARY KEY REFERENCES public.raids(id) ON DELETE RESTRICT,
 defender_base_id uuid NOT NULL,
 defender_wallet text NOT NULL,
 captured_at timestamptz NOT NULL,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 presentation jsonb NOT NULL
);
REVOKE ALL ON public.raid_starter_presentations FROM PUBLIC;
--> statement-breakpoint
-- Internal structural closure only. The ordinary locked raid writer retains
-- readStarterExpedition's complete historical/equipment/economy proof and
-- compares this independently derived result before committing the raid.
CREATE FUNCTION public.shardkeep_raid_starter_projection(target uuid,frozen jsonb,cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE installed public.fleet_installations%ROWTYPE;active record;active_count bigint;pointer_count bigint;
 berth_ids jsonb;current_ids jsonb;presence text:='occupied';result jsonb;
BEGIN
 IF NOT isfinite(cutoff) OR jsonb_typeof(frozen)<>'object' OR jsonb_typeof(frozen->'buildings')<>'array'
 THEN RETURN 'null'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'buildings') b WHERE jsonb_typeof(b)<>'object'
  OR jsonb_typeof(b->'id')<>'string' OR b->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 OR(SELECT count(*)<>count(DISTINCT b->>'id') FROM jsonb_array_elements(frozen->'buildings') b)
 THEN RETURN 'null'::jsonb;END IF;
 SELECT coalesce(jsonb_agg(b->>'id' ORDER BY b->>'id'),'[]'::jsonb) INTO berth_ids
 FROM jsonb_array_elements(frozen->'buildings') b WHERE b->>'type'='berth';
 SELECT coalesce(jsonb_agg(b.id::text ORDER BY b.id::text),'[]'::jsonb) INTO current_ids
 FROM public.buildings b WHERE b.base_id=target AND b.type='berth'
 AND NOT EXISTS(SELECT 1 FROM public.builder_jobs j WHERE j.building_id=b.id AND j.kind='build' AND j.completed_at IS NULL);
 IF berth_ids IS DISTINCT FROM current_ids OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'buildings') b
  LEFT JOIN public.buildings actual ON actual.id::text=b->>'id' AND actual.base_id=target
  WHERE b->>'type'='berth' AND(actual.id IS NULL OR actual.type<>'berth' OR b->'level' IS DISTINCT FROM to_jsonb(actual.level)
   OR b->'underConstruction'='true'::jsonb)) THEN RETURN 'null'::jsonb;END IF;
 SELECT * INTO installed FROM public.fleet_installations WHERE base_id=target AND family='starter';
 IF FOUND THEN
  IF installed.created_at>cutoff OR installed.berth_completed_at>cutoff THEN RETURN 'null'::jsonb;END IF;
  IF NOT berth_ids @> jsonb_build_array(installed.berth_id::text) OR NOT EXISTS(SELECT 1 FROM public.buildings b JOIN public.builder_jobs j ON j.building_id=b.id
    WHERE b.id=installed.berth_id AND b.base_id=target AND b.type='berth' AND b.level>=1
     AND j.id=installed.completed_build_job_id AND j.base_id=target AND j.kind='build'
     AND j.completed_at=installed.berth_completed_at AND j.cancelled_at IS NULL)
   THEN RAISE EXCEPTION 'RAID_STARTER_INSTALLATION_SOURCE';END IF;
 END IF;
 SELECT count(*) INTO active_count FROM public.starter_expeditions e
 LEFT JOIN public.starter_expedition_inflight p ON p.expedition_id=e.id
 LEFT JOIN public.starter_expedition_returns r ON r.expedition_id=e.id
 WHERE e.base_id=target AND(r.expedition_id IS NULL OR p.expedition_id IS NOT NULL);
 SELECT count(*) INTO pointer_count FROM public.starter_expedition_inflight WHERE installation_id=installed.id;
 IF active_count>1 OR pointer_count<>active_count THEN RETURN 'null'::jsonb;END IF;
 IF active_count=1 THEN
  SELECT e.id,e.installation_id,e.departed_at,e.returns_at,p.installation_id pointer,r.expedition_id returned INTO active
  FROM public.starter_expeditions e LEFT JOIN public.starter_expedition_inflight p ON p.expedition_id=e.id
  LEFT JOIN public.starter_expedition_returns r ON r.expedition_id=e.id
  WHERE e.base_id=target AND(r.expedition_id IS NULL OR p.expedition_id IS NOT NULL);
  IF installed.id IS NULL OR active.returned IS NOT NULL OR active.installation_id<>installed.id OR active.pointer IS DISTINCT FROM installed.id
   OR active.departed_at>cutoff OR active.returns_at<=cutoff
   OR NOT EXISTS(SELECT 1 FROM public.starter_expedition_inflight WHERE installation_id=installed.id AND expedition_id=active.id)
   THEN RETURN 'null'::jsonb;END IF;
  presence:='away';
 END IF;
 SELECT jsonb_build_object('version',1,'berths',coalesce(jsonb_agg(jsonb_build_object('buildingId',b.value,
  'installation',CASE WHEN b.value=installed.berth_id::text THEN jsonb_build_object('family','starter','presence',presence) ELSE 'null'::jsonb END)
  ORDER BY b.value),'[]'::jsonb)) INTO result FROM jsonb_array_elements_text(berth_ids) b;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_starter_projection(uuid,jsonb,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_starter_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.raid_starter_presentations'::regclass OR TG_NAME<>'raid_starter_guard'
  OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' OR pg_trigger_depth()<>2
  OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'RAID_STARTER_IMMUTABLE' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_starter_guard() FROM PUBLIC;
CREATE TRIGGER raid_starter_guard BEFORE INSERT OR UPDATE OR DELETE ON public.raid_starter_presentations
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raid_starter_guard();
CREATE TRIGGER raid_starter_no_truncate BEFORE TRUNCATE ON public.raid_starter_presentations
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_raid_starter_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_raid_starter_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owner_wallet text;valid boolean;captured jsonb;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raid_starter_capture' OR TG_WHEN<>'AFTER'
  OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' OR pg_trigger_depth()<>1
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'RAID_STARTER_CAPTURE' USING ERRCODE='42501';END IF;
 -- Legacy wallet raids, generated camps and campaigns have no stable source.
 IF NEW.defender_base_id IS NULL OR NEW.defender_wallet IS NULL OR NEW.pve_camp_id IS NOT NULL OR NEW.campaign_stage IS NOT NULL
 THEN RETURN NULL;END IF;
 IF to_regprocedure('public.shardkeep_raid_starter_sources_valid()') IS NULL THEN RAISE EXCEPTION 'RAID_STARTER_SOURCE';END IF;
 EXECUTE 'SELECT public.shardkeep_raid_starter_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RAISE EXCEPTION 'RAID_STARTER_SOURCE';END IF;
 SELECT b.owner_wallet INTO owner_wallet FROM public.bases b WHERE b.id=NEW.defender_base_id AND b.status='active' FOR UPDATE;
 IF owner_wallet IS DISTINCT FROM NEW.defender_wallet OR NOT EXISTS(SELECT 1 FROM public.base_slots s
  WHERE s.base_id=NEW.defender_base_id AND s.wallet=owner_wallet AND s.active)
  OR NOT isfinite(NEW.created_at) OR NEW.created_at>clock_timestamp()
 THEN RAISE EXCEPTION 'RAID_STARTER_CAPTURE_SOURCE';END IF;
 captured:=public.shardkeep_raid_starter_projection(NEW.defender_base_id,NEW.snapshot,NEW.created_at);
 INSERT INTO public.raid_starter_presentations(raid_id,defender_base_id,defender_wallet,captured_at,snapshot_sha256,presentation)
 VALUES(NEW.id,NEW.defender_base_id,NEW.defender_wallet,NEW.created_at,encode(sha256(convert_to(NEW.snapshot::text,'UTF8')),'hex'),captured);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_starter_capture() FROM PUBLIC;
CREATE TRIGGER raid_starter_capture AFTER INSERT ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_raid_starter_capture();
--> statement-breakpoint
-- A wrapper preserves SQL NULL (legacy absence) versus captured JSON null
-- through PostgreSQL drivers. Public callers expose only its presentation.
CREATE FUNCTION public.shardkeep_raid_starter_presentation(target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE captured public.raid_starter_presentations%ROWTYPE;original public.raids%ROWTYPE;valid boolean;
BEGIN
 SELECT * INTO captured FROM public.raid_starter_presentations WHERE raid_id=target;
 IF NOT FOUND THEN RETURN NULL;END IF;
 EXECUTE 'SELECT public.shardkeep_raid_starter_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RAISE EXCEPTION 'RAID_STARTER_SOURCE';END IF;
 SELECT * INTO original FROM public.raids WHERE id=target;
 IF NOT FOUND OR original.defender_base_id IS DISTINCT FROM captured.defender_base_id
  OR original.defender_wallet IS DISTINCT FROM captured.defender_wallet OR original.created_at IS DISTINCT FROM captured.captured_at
  OR encode(sha256(convert_to(original.snapshot::text,'UTF8')),'hex') IS DISTINCT FROM captured.snapshot_sha256
 THEN RAISE EXCEPTION 'RAID_STARTER_ORIGINAL_SOURCE';END IF;
 RETURN jsonb_build_object('version',1,'presentation',captured.presentation);
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_raid_starter_presentation(uuid) FROM PUBLIC;
