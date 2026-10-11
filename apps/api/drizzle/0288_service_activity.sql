-- Current-only Workshop activity, not permission to act or a claimable output.
SET LOCAL lock_timeout='10s';
CREATE FUNCTION public.shardkeep_service_activity(actor text,target uuid,current_buildings jsonb,cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE valid boolean;actual jsonb;supplied jsonb;working uuid[]:=ARRAY[]::uuid[];
 pending_count integer:=0;j record;proof public.builder_jobs%ROWTYPE;workshop public.buildings%ROWTYPE;
 result jsonb;unavailable boolean:=false;
BEGIN
 IF actor IS NULL OR target IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.service_activity_contract'::regclass)
 THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_AUTHORITY';END IF;
 EXECUTE 'SELECT public.shardkeep_service_activity_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_SOURCE';END IF;
 -- The ordinary request already holds player -> base -> slot. These locks also
 -- make the narrow capability safe independently of caller-supplied JSON.
 PERFORM wallet FROM public.players WHERE wallet=actor FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_OWNER';END IF;
 PERFORM id FROM public.bases WHERE id=target AND owner_wallet=actor AND status='active' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_OWNER';END IF;
 PERFORM base_id FROM public.base_slots WHERE base_id=target AND wallet=actor AND active FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_OWNER';END IF;
 IF jsonb_typeof(current_buildings) IS DISTINCT FROM 'array' THEN unavailable:=true;current_buildings:='[]'::jsonb;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'type',b.type,'level',b.level,'underConstruction',EXISTS(
  SELECT 1 FROM public.builder_jobs p WHERE p.building_id=b.id AND p.kind='build' AND p.completed_at IS NULL)) ORDER BY b.id),'[]'::jsonb)
 INTO actual FROM public.buildings b WHERE b.base_id=target AND b.type IN('workshop','lodge','market','harvester');
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',b->'id','type',b->'type','level',b->'level',
  'underConstruction',coalesce(b->'underConstruction','false'::jsonb)) ORDER BY b->>'id'),'[]'::jsonb)
 INTO supplied FROM jsonb_array_elements(current_buildings) b WHERE b->>'type' IN('workshop','lodge','market','harvester');
 IF actual IS DISTINCT FROM supplied THEN unavailable:=true;END IF;
 -- Immutable source guards are the original admission authority. Do not claim
 -- this redacted current projection independently replays material consumption.
 IF EXISTS(SELECT 1 FROM public.ordinary_crafting_jobs o LEFT JOIN public.ordinary_crafting_completions c ON c.job_id=o.id
  WHERE o.base_id=target AND((o.completed_at IS NULL)<>(c.job_id IS NULL) OR(c.job_id IS NOT NULL AND(c.completed_at<>o.completed_at OR c.completed_at<o.ready_at))))
 THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_ORIGINAL';END IF;
 FOR j IN
  SELECT 'ordinary'::text kind,o.id,o.base_id,o.actor_wallet,o.workshop_id,o.workshop_completed_job_id,o.recipe_snapshot,o.started_at,o.ready_at
   FROM public.ordinary_crafting_jobs o WHERE o.base_id=target AND o.completed_at IS NULL
  UNION ALL SELECT 'equipment',o.id,o.base_id,o.actor_wallet,o.workshop_id,o.workshop_completed_job_id,o.recipe_snapshot,o.started_at,o.ready_at
   FROM public.ordinary_equipment_jobs o WHERE o.base_id=target AND NOT EXISTS(SELECT 1 FROM public.ordinary_equipment_completions c WHERE c.job_id=o.id)
  UNION ALL SELECT 'cosmetic',o.id,o.base_id,o.actor_wallet,o.workshop_id,o.workshop_completed_job_id,o.recipe_snapshot,o.started_at,o.ready_at
   FROM public.bound_cosmetic_jobs o WHERE o.base_id=target AND NOT EXISTS(SELECT 1 FROM public.bound_cosmetic_completions c WHERE c.job_id=o.id)
 LOOP
  pending_count:=pending_count+1;
  SELECT * INTO proof FROM public.builder_jobs WHERE id=j.workshop_completed_job_id;
  IF NOT FOUND OR proof.base_id<>target OR proof.building_id IS DISTINCT FROM j.workshop_id OR proof.kind<>'build'
   OR proof.completed_at IS NULL OR proof.cancelled_at IS NOT NULL OR proof.completed_at>j.started_at
   OR NOT isfinite(j.started_at) OR NOT isfinite(j.ready_at) OR j.ready_at<=j.started_at
   OR jsonb_typeof(j.recipe_snapshot) IS DISTINCT FROM 'object'
   OR jsonb_typeof(j.recipe_snapshot->'durationSec') IS DISTINCT FROM 'number'
   OR(j.recipe_snapshot->>'durationSec'~'^[1-9][0-9]*$') IS DISTINCT FROM true
   OR j.ready_at-j.started_at IS DISTINCT FROM(j.recipe_snapshot->>'durationSec')::bigint*interval '1 second'
  THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_ORIGINAL';END IF;
  IF j.kind='cosmetic' THEN
   IF j.recipe_snapshot IS DISTINCT FROM public.shardkeep_bound_cosmetic_recipe(j.recipe_snapshot->>'recipeId')
    OR NOT EXISTS(SELECT 1 FROM public.bound_cosmetic_jobs c JOIN public.bound_cosmetic_blueprints b
     ON b.wallet=c.actor_wallet AND b.blueprint_id=c.blueprint_id WHERE c.id=j.id AND b.granted_at<=c.started_at
      AND c.output_id=c.recipe_snapshot->>'outputId' AND c.appearance_snapshot=public.shardkeep_bound_cosmetic_appearance(c.output_id))
   THEN RAISE EXCEPTION 'SERVICE_ACTIVITY_ORIGINAL';END IF;
  END IF;
  SELECT * INTO workshop FROM public.buildings WHERE id=j.workshop_id AND base_id=target AND type='workshop';
  IF NOT FOUND OR workshop.level<1 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual) b WHERE b->>'id'=j.workshop_id::text AND b->'underConstruction'='false'::jsonb)
   OR j.started_at>cutoff OR j.ready_at<=cutoff THEN unavailable:=true;
  ELSE working:=array_append(working,j.workshop_id);END IF;
 END LOOP;
 IF unavailable THEN RETURN 'null'::jsonb;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('buildingId',b->'id','state',CASE WHEN b->>'type'='workshop' AND (b->>'id')::uuid=ANY(working) THEN 'working' ELSE 'idle' END) ORDER BY b->>'id'),'[]'::jsonb)
 INTO result FROM jsonb_array_elements(actual) b;
 RETURN jsonb_build_object('version',1,'services',result,'pendingCount',pending_count);
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_service_activity(text,uuid,jsonb,timestamptz) FROM PUBLIC;
