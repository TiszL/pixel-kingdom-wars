-- Current account preferences and prospective immutable raid presentation only.
-- No currency, public write capability, renderer admission or historical repair.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
CREATE TABLE public.bound_cosmetic_preferences(
 wallet text NOT NULL REFERENCES public.players(wallet),base_id uuid NOT NULL REFERENCES public.bases(id),
 awning_enabled boolean NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL CHECK(isfinite(updated_at)),PRIMARY KEY(wallet,base_id));
CREATE TABLE public.bound_cosmetic_raid_visuals(
 raid_id uuid PRIMARY KEY REFERENCES public.raids(id),visual jsonb NOT NULL);
REVOKE ALL ON public.bound_cosmetic_preferences,public.bound_cosmetic_raid_visuals FROM PUBLIC;
--> statement-breakpoint
-- Floor levels come from the already admitted v1 recipes. The upper limit is
-- generated from packages/shared/src/constants.ts STRUCTURES.market.maxLevel.
CREATE FUNCTION public.shardkeep_bound_cosmetic_market_awnings(target uuid,actor text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('buildingId',b.id,'appearance',j.appearance_snapshot) ORDER BY b.id),'[]'::jsonb)
 FROM public.buildings b
 CROSS JOIN LATERAL (
  SELECT recipe FROM (SELECT public.shardkeep_bound_cosmetic_recipe(id) recipe FROM unnest(ARRAY[
   'craft_artisan_market_awning_t1_v1','craft_artisan_market_awning_t2_v1',
   'craft_artisan_market_awning_t3_v1','craft_artisan_market_awning_t4_v1']) id) recipes
  WHERE (recipe->'requiredFacility'->>'level')::integer<=b.level
  ORDER BY (recipe->'requiredFacility'->>'level')::integer DESC LIMIT 1
 ) tier
 JOIN public.bound_cosmetic_jobs j ON j.actor_wallet=actor AND j.output_id=tier.recipe->>'outputId'
 JOIN public.bound_cosmetic_completions c ON c.job_id=j.id
 WHERE b.base_id=target AND b.type='market' AND b.level BETWEEN 1 AND 20
  AND j.appearance_snapshot=public.shardkeep_bound_cosmetic_appearance(j.output_id)
  AND EXISTS(SELECT 1 FROM public.builder_jobs proof WHERE proof.building_id=b.id AND proof.base_id=b.base_id
   AND proof.kind='build' AND proof.cancelled_at IS NULL AND proof.completed_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM public.builder_jobs pending WHERE pending.building_id=b.id AND pending.kind='build' AND pending.completed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_market_awnings(uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_preference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.bound_cosmetic_preferences'::regclass OR TG_WHEN<>'BEFORE'
  OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREFERENCE_OWNER' USING ERRCODE='42501';END IF;
 IF TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREFERENCE_IMMUTABLE';END IF;
 IF TG_NAME<>'bound_cosmetic_preference_guard' OR TG_LEVEL<>'ROW'
  OR (TG_OP='INSERT' AND NEW.revision<>1)
  OR (TG_OP='UPDATE' AND (NEW.wallet IS DISTINCT FROM OLD.wallet OR NEW.base_id IS DISTINCT FROM OLD.base_id
   OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at))
  OR NOT isfinite(NEW.updated_at)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREFERENCE_REVISION';END IF;
 PERFORM wallet FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
 PERFORM id FROM public.bases WHERE id=NEW.base_id AND owner_wallet=NEW.wallet AND status='active' FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=NEW.base_id AND wallet=NEW.wallet AND active)
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREFERENCE_AUTHORITY';END IF;
 IF NEW.awning_enabled AND jsonb_array_length(public.shardkeep_bound_cosmetic_market_awnings(NEW.base_id,NEW.wallet))=0
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREFERENCE_ENTITLEMENT';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_preference_guard() FROM PUBLIC;
CREATE TRIGGER bound_cosmetic_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_preferences
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_preference_guard();
CREATE TRIGGER bound_cosmetic_preference_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_preferences
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_preference_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_base_visual(target uuid,expected_wallet text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE valid boolean;awnings jsonb:='[]'::jsonb;
BEGIN
 IF to_regprocedure('public.shardkeep_bound_cosmetic_visual_sources_valid()') IS NULL
 THEN RETURN '{"state":"unavailable","visual":null}'::jsonb;END IF;
 EXECUTE 'SELECT public.shardkeep_bound_cosmetic_visual_sources_valid()' INTO valid;
 IF valid IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id
  WHERE b.id=target AND b.owner_wallet=expected_wallet AND b.status='active' AND s.wallet=expected_wallet AND s.active)
 THEN RETURN '{"state":"unavailable","visual":null}'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.bound_cosmetic_preferences WHERE wallet=expected_wallet AND base_id=target AND awning_enabled)
 THEN awnings:=public.shardkeep_bound_cosmetic_market_awnings(target,expected_wallet);END IF;
 RETURN jsonb_build_object('state','available','visual',jsonb_build_object('version',1,'marketAwnings',awnings));
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_base_visual(uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_raid_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Only the nested, owner-executing raids AFTER INSERT capability may write.
 -- No session variable or externally callable capture helper admits history.
 IF TG_RELID<>'public.bound_cosmetic_raid_visuals'::regclass OR TG_NAME<>'bound_cosmetic_raid_guard'
  OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' OR pg_trigger_depth()<>2
  OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_RAID_IMMUTABLE' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_raid_guard() FROM PUBLIC;
CREATE TRIGGER bound_cosmetic_raid_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_raid_visuals
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_raid_guard();
CREATE TRIGGER bound_cosmetic_raid_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_raid_visuals
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_raid_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_raid_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE captured jsonb:='{"state":"unavailable","visual":null}'::jsonb;awnings jsonb;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'bound_cosmetic_raid_capture' OR TG_WHEN<>'AFTER'
  OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' OR pg_trigger_depth()<>1
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_RAID_CAPTURE' USING ERRCODE='42501';END IF;
 IF NEW.defender_base_id IS NOT NULL AND NEW.defender_wallet IS NOT NULL
  AND jsonb_typeof(NEW.snapshot)='object' AND jsonb_typeof(NEW.snapshot->'buildings')='array'
 THEN
  captured:=public.shardkeep_bound_cosmetic_base_visual(NEW.defender_base_id,NEW.defender_wallet);
  IF captured->>'state'='available' THEN
   -- Snapshot rows are the original completed combat buildings. Intersect with
   -- current identity AND completed level; never add omitted construction.
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'buildings') b
    WHERE jsonb_typeof(b)<>'object' OR b->>'id' IS NULL)
    OR (SELECT count(*)<>count(DISTINCT b->>'id') FROM jsonb_array_elements(NEW.snapshot->'buildings') b)
   THEN captured:='{"state":"unavailable","visual":null}'::jsonb;
   ELSE
    SELECT coalesce(jsonb_agg(a ORDER BY a->>'buildingId'),'[]'::jsonb) INTO awnings
    FROM jsonb_array_elements(captured->'visual'->'marketAwnings') a
    JOIN jsonb_array_elements(NEW.snapshot->'buildings') b ON b->>'id'=a->>'buildingId'
    JOIN public.buildings current_building ON current_building.id::text=a->>'buildingId'
    WHERE b->>'type'='market' AND b->'level'=to_jsonb(current_building.level)
     AND NOT coalesce(b->'underConstruction'='true'::jsonb,false);
    captured:=jsonb_build_object('state','available','visual',jsonb_build_object('version',1,'marketAwnings',awnings));
   END IF;
  END IF;
 END IF;
 INSERT INTO public.bound_cosmetic_raid_visuals(raid_id,visual) VALUES(NEW.id,captured);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_raid_capture() FROM PUBLIC;
CREATE TRIGGER bound_cosmetic_raid_capture AFTER INSERT ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_raid_capture();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_raid_visual(target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE captured jsonb;valid boolean;
BEGIN
 SELECT visual INTO captured FROM public.bound_cosmetic_raid_visuals WHERE raid_id=target;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF to_regprocedure('public.shardkeep_bound_cosmetic_visual_sources_valid()') IS NULL
 THEN RETURN '{"state":"unavailable","visual":null}'::jsonb;END IF;
 EXECUTE 'SELECT public.shardkeep_bound_cosmetic_visual_sources_valid()' INTO valid;
 IF valid IS NOT TRUE THEN RETURN '{"state":"unavailable","visual":null}'::jsonb;END IF;
 RETURN captured;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_raid_visual(uuid) FROM PUBLIC;
