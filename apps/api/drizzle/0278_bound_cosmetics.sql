-- Private, account-bound cosmetic custody. No HTTP admission or production role grants.
-- Generated v1 recipe and art identities are frozen below; numbers originate in
-- PHASE_E_BOUND_COSMETICS, ordinary source recipes in PHASE_E_ORDINARY_CRAFTING.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
CREATE TABLE public.bound_cosmetic_blueprints(
 wallet text NOT NULL REFERENCES public.players(wallet),
 blueprint_id text NOT NULL CHECK(blueprint_id='architect_blueprint_artisan_finishes_v1'),
 source_job_id uuid NOT NULL REFERENCES public.ordinary_crafting_jobs(id),
 granted_at timestamptz NOT NULL CHECK(isfinite(granted_at)),PRIMARY KEY(wallet,blueprint_id));
CREATE TABLE public.bound_cosmetic_jobs(
 id uuid PRIMARY KEY,actor_wallet text NOT NULL REFERENCES public.players(wallet),base_id uuid NOT NULL REFERENCES public.bases(id),
 output_id text NOT NULL,recipe_snapshot jsonb NOT NULL,appearance_snapshot jsonb NOT NULL,blueprint_id text NOT NULL,
 workshop_id uuid NOT NULL,workshop_completed_job_id uuid NOT NULL,facility_id uuid NOT NULL,facility_completed_job_id uuid NOT NULL,
 started_at timestamptz NOT NULL,ready_at timestamptz NOT NULL,
 UNIQUE(actor_wallet,output_id),FOREIGN KEY(actor_wallet,blueprint_id) REFERENCES public.bound_cosmetic_blueprints(wallet,blueprint_id),
 CHECK(isfinite(started_at) AND isfinite(ready_at) AND ready_at>started_at));
CREATE INDEX bound_cosmetic_jobs_due ON public.bound_cosmetic_jobs(base_id,ready_at,id);
-- Joining this receipt to its immutable original job IS the original actor's
-- account entitlement. Deliberately no player FK here: completion may hold a
-- base lock and must never acquire the reverse base -> player FK lock.
CREATE TABLE public.bound_cosmetic_completions(job_id uuid PRIMARY KEY REFERENCES public.bound_cosmetic_jobs(id),
 completed_at timestamptz NOT NULL CHECK(isfinite(completed_at)));
REVOKE ALL ON public.bound_cosmetic_blueprints,public.bound_cosmetic_jobs,public.bound_cosmetic_completions FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_recipe(recipe_id text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT '{"craft_artisan_market_awning_t1_v1":{"recipeId":"craft_artisan_market_awning_t1_v1","recipeVersion":1,"outputId":"artisan_market_awning_t1","quantity":"1","durationSec":300,"inputs":[{"itemId":"heartwood_beams","quantity":"2"},{"itemId":"thornsilk","quantity":"2"},{"itemId":"crownsteel","quantity":"1"}],"requiredFacility":{"type":"market","level":1},"blueprintId":"architect_blueprint_artisan_finishes_v1"},"craft_artisan_market_awning_t2_v1":{"recipeId":"craft_artisan_market_awning_t2_v1","recipeVersion":1,"outputId":"artisan_market_awning_t2","quantity":"1","durationSec":600,"inputs":[{"itemId":"heartwood_beams","quantity":"4"},{"itemId":"thornsilk","quantity":"4"},{"itemId":"crownsteel","quantity":"2"}],"requiredFacility":{"type":"market","level":6},"blueprintId":"architect_blueprint_artisan_finishes_v1"},"craft_artisan_market_awning_t3_v1":{"recipeId":"craft_artisan_market_awning_t3_v1","recipeVersion":1,"outputId":"artisan_market_awning_t3","quantity":"1","durationSec":900,"inputs":[{"itemId":"heartwood_beams","quantity":"8"},{"itemId":"thornsilk","quantity":"8"},{"itemId":"crownsteel","quantity":"4"}],"requiredFacility":{"type":"market","level":11},"blueprintId":"architect_blueprint_artisan_finishes_v1"},"craft_artisan_market_awning_t4_v1":{"recipeId":"craft_artisan_market_awning_t4_v1","recipeVersion":1,"outputId":"artisan_market_awning_t4","quantity":"1","durationSec":1200,"inputs":[{"itemId":"heartwood_beams","quantity":"16"},{"itemId":"thornsilk","quantity":"16"},{"itemId":"crownsteel","quantity":"8"}],"requiredFacility":{"type":"market","level":16},"blueprintId":"architect_blueprint_artisan_finishes_v1"},"craft_aurora_wake_v1":{"recipeId":"craft_aurora_wake_v1","recipeVersion":1,"outputId":"aurora_wake","quantity":"1","durationSec":600,"inputs":[{"itemId":"prismstone_lens","quantity":"4"},{"itemId":"frostglass","quantity":"4"},{"itemId":"thornsilk","quantity":"4"}],"requiredFacility":{"type":"lodge","level":1},"blueprintId":"architect_blueprint_artisan_finishes_v1"}}'::jsonb->recipe_id
$$;
CREATE FUNCTION public.shardkeep_bound_cosmetic_appearance(output_id text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT '{"artisan_market_awning_t1":{"version":1,"outputId":"artisan_market_awning_t1","sourceId":"artisan-market-t1","sourceManifestSha256":"b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394","sourceIndexSha256":"04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181","bindingSha256":"eb0f98c1eeb2dd4657fc2f2144c2f387e7fc763a9c9e95c6c77598e5458acea5"},"artisan_market_awning_t2":{"version":1,"outputId":"artisan_market_awning_t2","sourceId":"artisan-market-t2","sourceManifestSha256":"b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394","sourceIndexSha256":"04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181","bindingSha256":"805ddc70f1794a2625aeaefea705e71b5d92d73127c976b7d665c71f70c131e2"},"artisan_market_awning_t3":{"version":1,"outputId":"artisan_market_awning_t3","sourceId":"artisan-market-t3","sourceManifestSha256":"b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394","sourceIndexSha256":"04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181","bindingSha256":"0e2d687e929e2505170f039a5902229a1be22e6c7a8adaff1c90bfa0bf4bde88"},"artisan_market_awning_t4":{"version":1,"outputId":"artisan_market_awning_t4","sourceId":"artisan-market-t4","sourceManifestSha256":"b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394","sourceIndexSha256":"04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181","bindingSha256":"38a533ed017a858e5862d1c6e27e52f2e80787ccc52518bc5c51c46dc968537a"},"aurora_wake":{"version":1,"outputId":"aurora_wake","sourceId":"auroraWake","sourceManifestSha256":"b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394","sourceIndexSha256":"04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181","bindingSha256":"f061211842f342a719bbf1ebe09ac2e085043c43f64f85bbc55582ec82d2a094"}}'::jsonb->output_id
$$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_recipe(text),public.shardkeep_bound_cosmetic_appearance(text) FROM PUBLIC;
--> statement-breakpoint
-- Revalidate the exact original refine, complete receipt, and raw reserve /
-- consume proofs. A current stock balance or current base owner earns nothing.
CREATE FUNCTION public.shardkeep_bound_cosmetic_blueprint_source(target uuid,actor text,at_time timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.ordinary_crafting_jobs%ROWTYPE;i public.ordinary_crafting_inputs%ROWTYPE;
 r public.resource_stock_operations%ROWTYPE;c public.resource_stock_operations%ROWTYPE;
 terminal public.ordinary_crafting_completions%ROWTYPE;unit jsonb;expected jsonb;
BEGIN
 SELECT * INTO STRICT j FROM public.ordinary_crafting_jobs WHERE id=target;
 unit:='{"refine_frostglass":{"recipeVersion":1,"recipeId":"refine_frostglass","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"frost_quartz","quantity":"10"}],"output":{"itemId":"frostglass","quantity":"1"}},"refine_heartwood_beams":{"recipeVersion":1,"recipeId":"refine_heartwood_beams","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"heartwood_logs","quantity":"10"}],"output":{"itemId":"heartwood_beams","quantity":"1"}},"refine_sunstone_blocks":{"recipeVersion":1,"recipeId":"refine_sunstone_blocks","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"sunstone_rubble","quantity":"10"}],"output":{"itemId":"sunstone_blocks","quantity":"1"}},"refine_crownsteel":{"recipeVersion":1,"recipeId":"refine_crownsteel","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"crown_iron_ore","quantity":"10"}],"output":{"itemId":"crownsteel","quantity":"1"}},"refine_prismstone_lens":{"recipeVersion":1,"recipeId":"refine_prismstone_lens","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"rough_prism","quantity":"10"}],"output":{"itemId":"prismstone_lens","quantity":"1"}},"refine_stormalloy":{"recipeVersion":1,"recipeId":"refine_stormalloy","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"storm_ore","quantity":"10"}],"output":{"itemId":"stormalloy","quantity":"1"}},"refine_thornsilk":{"recipeVersion":1,"recipeId":"refine_thornsilk","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"thorn_fibre","quantity":"10"}],"output":{"itemId":"thornsilk","quantity":"1"}},"refine_embercore":{"recipeVersion":1,"recipeId":"refine_embercore","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"ember_nodules","quantity":"10"}],"output":{"itemId":"embercore","quantity":"1"}}}'::jsonb->j.recipe_id;
 IF unit IS NULL OR j.actor_wallet IS DISTINCT FROM actor OR j.recipe_version NOT IN(1,2)
  OR j.quantity NOT BETWEEN 1 AND 10 OR j.completed_at IS NULL
  OR NOT isfinite(j.started_at) OR NOT isfinite(j.ready_at) OR NOT isfinite(j.completed_at)
  OR j.completed_at<j.ready_at OR j.completed_at>at_time THEN RAISE EXCEPTION 'BOUND_COSMETIC_BLUEPRINT_SOURCE';END IF;
 expected:=unit||jsonb_build_object('recipeVersion',j.recipe_version,'quantity',j.quantity,
  'durationSec',(unit->>'durationSec')::bigint*j.quantity,
  'output',(unit->'output')||jsonb_build_object('quantity',((unit->'output'->>'quantity')::bigint*j.quantity)::text),
  'inputs',(SELECT jsonb_agg(value||jsonb_build_object('quantity',((value->>'quantity')::bigint*j.quantity)::text) ORDER BY ord)
   FROM jsonb_array_elements(unit->'inputs') WITH ORDINALITY x(value,ord)));
 IF j.recipe_snapshot IS DISTINCT FROM expected OR j.output_item_id IS DISTINCT FROM expected->'output'->>'itemId'
  OR j.output_quantity IS DISTINCT FROM (expected->'output'->>'quantity')::bigint
  OR j.ready_at-j.started_at IS DISTINCT FROM (expected->>'durationSec')::bigint*interval '1 second'
  OR (SELECT count(*) FROM public.ordinary_crafting_inputs WHERE job_id=target)<>1 THEN RAISE EXCEPTION 'BOUND_COSMETIC_BLUEPRINT_SOURCE';END IF;
 SELECT * INTO STRICT i FROM public.ordinary_crafting_inputs WHERE job_id=target AND position=0;
 SELECT * INTO STRICT r FROM public.resource_stock_operations WHERE id=i.reserve_operation_id;
 SELECT * INTO STRICT c FROM public.resource_stock_operations WHERE id=i.consume_operation_id;
 SELECT * INTO STRICT terminal FROM public.ordinary_crafting_completions WHERE job_id=target;
 IF (i.kind='raw' AND i.item_id=expected->'inputs'->0->>'itemId' AND i.quantity=(expected->'inputs'->0->>'quantity')::bigint
  AND i.shards_ledger_txn_id IS NULL AND r.kind='reserve' AND c.kind='consume' AND c.reservation_id=r.id
  AND r.base_id=j.base_id AND c.base_id=j.base_id AND r.custody_wallet=actor AND c.custody_wallet=actor
  AND r.resource_id=i.item_id AND c.resource_id=i.item_id AND r.quantity=i.quantity AND c.quantity=i.quantity
  AND terminal.completed_at=j.completed_at) IS NOT TRUE THEN RAISE EXCEPTION 'BOUND_COSMETIC_BLUEPRINT_SOURCE';END IF;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_blueprint_source(uuid,text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE recipe jsonb;appearance jsonb;custody text;j public.bound_cosmetic_jobs%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.bound_cosmetic_blueprints'::regclass,'public.bound_cosmetic_jobs'::regclass,'public.bound_cosmetic_completions'::regclass)
  OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_OWNER' USING ERRCODE='42501';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BOUND_COSMETIC_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='bound_cosmetic_blueprints' THEN
  PERFORM wallet FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
  PERFORM public.shardkeep_bound_cosmetic_blueprint_source(NEW.source_job_id,NEW.wallet,NEW.granted_at);
 ELSIF TG_TABLE_NAME='bound_cosmetic_jobs' THEN
  -- Consistent admission order: original actor, then stable base. Permanent
  -- uniqueness also rejects conflict-suppressed retries BEFORE a second debit.
  PERFORM wallet FROM public.players WHERE wallet=NEW.actor_wallet FOR UPDATE;
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=NEW.base_id AND status='active' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.bound_cosmetic_jobs WHERE id=NEW.id OR(actor_wallet=NEW.actor_wallet AND output_id=NEW.output_id))
   THEN RAISE EXCEPTION 'BOUND_COSMETIC_DUPLICATE';END IF;
  recipe:=public.shardkeep_bound_cosmetic_recipe(NEW.recipe_snapshot->>'recipeId');
  appearance:=public.shardkeep_bound_cosmetic_appearance(NEW.output_id);
  IF (recipe IS NOT NULL AND appearance IS NOT NULL AND NEW.recipe_snapshot=recipe AND NEW.appearance_snapshot=appearance
   AND NEW.output_id=recipe->>'outputId' AND NEW.blueprint_id=recipe->>'blueprintId'
   AND NEW.ready_at-NEW.started_at=(recipe->>'durationSec')::bigint*interval '1 second'
   AND custody=NEW.actor_wallet
   AND EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=NEW.base_id AND wallet=NEW.actor_wallet AND active)
   AND EXISTS(SELECT 1 FROM public.bound_cosmetic_blueprints WHERE wallet=NEW.actor_wallet AND blueprint_id=NEW.blueprint_id AND granted_at<=NEW.started_at)
   AND EXISTS(SELECT 1 FROM public.buildings b JOIN public.builder_jobs proof ON proof.id=NEW.workshop_completed_job_id
    WHERE b.id=NEW.workshop_id AND b.base_id=NEW.base_id AND b.type='workshop' AND b.level>=1
     AND proof.building_id=b.id AND proof.base_id=b.base_id AND proof.kind='build' AND proof.cancelled_at IS NULL AND proof.completed_at<=NEW.started_at)
   AND NOT EXISTS(SELECT 1 FROM public.builder_jobs WHERE building_id=NEW.workshop_id AND kind='build' AND completed_at IS NULL)
   AND EXISTS(SELECT 1 FROM public.buildings b JOIN public.builder_jobs proof ON proof.id=NEW.facility_completed_job_id
    WHERE b.id=NEW.facility_id AND b.base_id=NEW.base_id AND b.type::text=recipe->'requiredFacility'->>'type'
     AND b.level>=(recipe->'requiredFacility'->>'level')::integer AND proof.building_id=b.id AND proof.base_id=b.base_id
     AND proof.kind='build' AND proof.cancelled_at IS NULL AND proof.completed_at<=NEW.started_at)
   AND NOT EXISTS(SELECT 1 FROM public.builder_jobs WHERE building_id=NEW.facility_id AND kind='build' AND completed_at IS NULL)) IS NOT TRUE
   THEN RAISE EXCEPTION 'BOUND_COSMETIC_ADMISSION';END IF;
 ELSE
  SELECT * INTO STRICT j FROM public.bound_cosmetic_jobs WHERE id=NEW.job_id;
  PERFORM id FROM public.bases WHERE id=j.base_id FOR UPDATE;
  IF NOT isfinite(NEW.completed_at) OR NEW.completed_at<j.ready_at THEN RAISE EXCEPTION 'BOUND_COSMETIC_COMPLETION';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_guard() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions'] LOOP
  EXECUTE format('CREATE TRIGGER bound_cosmetic_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_guard()',t);
  EXECUTE format('CREATE TRIGGER bound_cosmetic_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_guard()',t);
 END LOOP;
END $$;
--> statement-breakpoint
-- AFTER INSERT is essential: a competing global UUID with ON CONFLICT DO
-- NOTHING must not retain a BEFORE-trigger debit for a row never inserted.
CREATE FUNCTION public.shardkeep_bound_cosmetic_debit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ingredient jsonb;n bigint;
BEGIN
 IF TG_RELID<>'public.bound_cosmetic_jobs'::regclass OR TG_NAME<>'bound_cosmetic_debit' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
  OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  OR NEW.recipe_snapshot IS DISTINCT FROM public.shardkeep_bound_cosmetic_recipe(NEW.recipe_snapshot->>'recipeId')
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_DEBIT_SOURCE';END IF;
 FOR ingredient IN SELECT value FROM jsonb_array_elements(NEW.recipe_snapshot->'inputs') LOOP
  n:=(ingredient->>'quantity')::bigint;
  UPDATE public.crafting_stocks SET available=available-n WHERE base_id=NEW.base_id AND item_id=ingredient->>'itemId' AND available>=n;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOUND_COSMETIC_MATERIALS';END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_debit() FROM PUBLIC;
CREATE TRIGGER bound_cosmetic_debit AFTER INSERT ON public.bound_cosmetic_jobs FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_debit();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_blueprint_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM public.shardkeep_bound_cosmetic_blueprint_source(NEW.source_job_id,NEW.wallet,NEW.granted_at);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_blueprint_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER bound_cosmetic_blueprint_complete AFTER INSERT ON public.bound_cosmetic_blueprints
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_blueprint_complete();
--> statement-breakpoint
-- Additive guards share the same base-row serialization with all accepted
-- Workshop writers; no original guard/function/history is replaced.
CREATE FUNCTION public.shardkeep_bound_cosmetic_workshop_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN('public.ordinary_crafting_jobs'::regclass,'public.ordinary_equipment_jobs'::regclass,'public.bound_cosmetic_jobs'::regclass)
  OR TG_NAME<>'bound_cosmetic_workshop_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
  OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'BOUND_COSMETIC_WORKSHOP_TRIGGER';END IF;
 PERFORM id FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.ordinary_crafting_jobs WHERE base_id=NEW.base_id AND completed_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.ordinary_equipment_jobs j WHERE j.base_id=NEW.base_id AND NOT EXISTS(SELECT 1 FROM public.ordinary_equipment_completions c WHERE c.job_id=j.id))
  OR EXISTS(SELECT 1 FROM public.bound_cosmetic_jobs j WHERE j.base_id=NEW.base_id AND NOT EXISTS(SELECT 1 FROM public.bound_cosmetic_completions c WHERE c.job_id=j.id))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WORKSHOP_BUSY';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_workshop_guard() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ordinary_crafting_jobs','ordinary_equipment_jobs','bound_cosmetic_jobs'] LOOP
  EXECUTE format('CREATE TRIGGER bound_cosmetic_workshop_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_workshop_guard()',t);
 END LOOP;
END $$;
