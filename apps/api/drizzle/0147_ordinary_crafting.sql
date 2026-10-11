-- GENERATED immutable D153.27/v1 recipe projection from shared constants and
-- phaseEOrdinaryCrafting. Future versions append; never rewrite this migration.
-- Protected conversion inventory is separate from raw loot and legacy items.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS crafting_stocks (
 base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT, item_id text NOT NULL,
 available bigint NOT NULL DEFAULT 0, pending_output bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(base_id,item_id), CHECK(item_id IN ('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit')),
 CONSTRAINT crafting_stock_bounds_ck CHECK(available>=0 AND pending_output>=0 AND available::numeric+pending_output::numeric<=9223372036854775807)
);
CREATE TABLE IF NOT EXISTS ordinary_crafting_jobs (
 id uuid PRIMARY KEY, actor_wallet text NOT NULL REFERENCES players(wallet), base_id uuid NOT NULL REFERENCES bases(id) ON DELETE RESTRICT,
 recipe_id text NOT NULL, recipe_version integer NOT NULL, quantity integer NOT NULL, recipe_snapshot jsonb NOT NULL,
 output_item_id text NOT NULL, output_quantity bigint NOT NULL, workshop_id uuid NOT NULL, workshop_completed_job_id uuid NOT NULL,
 started_at timestamptz NOT NULL, ready_at timestamptz NOT NULL, completed_at timestamptz,
 CONSTRAINT ordinary_crafting_job_bounds_ck CHECK(recipe_version>0 AND quantity>0 AND output_quantity>0 AND ready_at>started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ordinary_crafting_one_pending_uq ON ordinary_crafting_jobs(base_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS ordinary_crafting_due_idx ON ordinary_crafting_jobs(base_id,ready_at,id);
CREATE TABLE IF NOT EXISTS ordinary_crafting_inputs (
 job_id uuid NOT NULL REFERENCES ordinary_crafting_jobs(id), position integer NOT NULL, kind text NOT NULL, item_id text NOT NULL, quantity bigint NOT NULL,
 reserve_operation_id uuid UNIQUE REFERENCES resource_stock_operations(id), consume_operation_id uuid UNIQUE REFERENCES resource_stock_operations(id),
 PRIMARY KEY(job_id,position), CONSTRAINT ordinary_crafting_input_ck CHECK(position>=0 AND quantity>0 AND
 ((kind='raw' AND reserve_operation_id IS NOT NULL AND consume_operation_id IS NOT NULL AND reserve_operation_id<>consume_operation_id)
 OR(kind='crafting' AND reserve_operation_id IS NULL AND consume_operation_id IS NULL)))
);
CREATE TABLE IF NOT EXISTS ordinary_crafting_completions (
 job_id uuid PRIMARY KEY REFERENCES ordinary_crafting_jobs(id), custody_wallet text NOT NULL, completed_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit jsonb; expected jsonb; job public.ordinary_crafting_jobs%ROWTYPE; custody text;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'ordinary crafting history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='ordinary_crafting_jobs' AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
    AND to_jsonb(OLD)-'completed_at'=to_jsonb(NEW)-'completed_at' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ordinary crafting history is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='ordinary_crafting_jobs' THEN
  unit := '{"refine_frostglass":{"recipeVersion":1,"recipeId":"refine_frostglass","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"frost_quartz","quantity":"10"}],"output":{"itemId":"frostglass","quantity":"1"}},"refine_heartwood_beams":{"recipeVersion":1,"recipeId":"refine_heartwood_beams","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"heartwood_logs","quantity":"10"}],"output":{"itemId":"heartwood_beams","quantity":"1"}},"refine_sunstone_blocks":{"recipeVersion":1,"recipeId":"refine_sunstone_blocks","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"sunstone_rubble","quantity":"10"}],"output":{"itemId":"sunstone_blocks","quantity":"1"}},"refine_crownsteel":{"recipeVersion":1,"recipeId":"refine_crownsteel","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"crown_iron_ore","quantity":"10"}],"output":{"itemId":"crownsteel","quantity":"1"}},"refine_prismstone_lens":{"recipeVersion":1,"recipeId":"refine_prismstone_lens","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"rough_prism","quantity":"10"}],"output":{"itemId":"prismstone_lens","quantity":"1"}},"refine_stormalloy":{"recipeVersion":1,"recipeId":"refine_stormalloy","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"storm_ore","quantity":"10"}],"output":{"itemId":"stormalloy","quantity":"1"}},"refine_thornsilk":{"recipeVersion":1,"recipeId":"refine_thornsilk","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"thorn_fibre","quantity":"10"}],"output":{"itemId":"thornsilk","quantity":"1"}},"refine_embercore":{"recipeVersion":1,"recipeId":"refine_embercore","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"ember_nodules","quantity":"10"}],"output":{"itemId":"embercore","quantity":"1"}},"craft_navigation_kit":{"recipeVersion":1,"recipeId":"craft_navigation_kit","quantity":1,"durationSec":120,"inputs":[{"kind":"crafting","itemId":"prismstone_lens","quantity":"1"},{"kind":"crafting","itemId":"frostglass","quantity":"1"}],"output":{"itemId":"navigation_kit","quantity":"1"}}}'::jsonb -> NEW.recipe_id;
  IF unit IS NULL OR NEW.recipe_version<>1 OR NEW.quantity NOT BETWEEN 1 AND 10 OR NEW.completed_at IS NOT NULL THEN
   RAISE EXCEPTION 'unsupported ordinary recipe' USING ERRCODE='23514'; END IF;
  SELECT unit || jsonb_build_object('quantity',NEW.quantity,'durationSec',(unit->>'durationSec')::bigint*NEW.quantity,
   'output',(unit->'output')||jsonb_build_object('quantity',((unit->'output'->>'quantity')::bigint*NEW.quantity)::text),
   'inputs',(SELECT jsonb_agg(value||jsonb_build_object('quantity',((value->>'quantity')::bigint*NEW.quantity)::text) ORDER BY ord)
     FROM jsonb_array_elements(unit->'inputs') WITH ORDINALITY x(value,ord))) INTO expected;
  IF (NEW.recipe_snapshot=expected AND NEW.output_item_id=expected->'output'->>'itemId'
   AND NEW.output_quantity=(expected->'output'->>'quantity')::bigint
   AND NEW.ready_at-NEW.started_at=(expected->>'durationSec')::bigint*interval '1 second'
   AND isfinite(NEW.started_at) AND isfinite(NEW.ready_at)) IS NOT TRUE THEN
   RAISE EXCEPTION 'ordinary recipe identity mismatch' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='ordinary_crafting_completions' THEN
  SELECT * INTO STRICT job FROM public.ordinary_crafting_jobs WHERE id=NEW.job_id;
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=job.base_id FOR UPDATE;
  IF NEW.custody_wallet IS DISTINCT FROM custody OR NOT isfinite(NEW.completed_at) OR NEW.completed_at<job.ready_at THEN
   RAISE EXCEPTION 'ordinary completion custody or time mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_ordinary_crafting_guard() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_jobs'::regclass AND tgname = 'ordinary_crafting_jobs_guard') THEN
    CREATE TRIGGER ordinary_crafting_jobs_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_crafting_jobs FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_jobs'::regclass AND tgname = 'ordinary_crafting_jobs_no_truncate') THEN
    CREATE TRIGGER ordinary_crafting_jobs_no_truncate BEFORE TRUNCATE ON ordinary_crafting_jobs FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_ordinary_crafting_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_inputs'::regclass AND tgname = 'ordinary_crafting_inputs_guard') THEN
    CREATE TRIGGER ordinary_crafting_inputs_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_crafting_inputs FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_inputs'::regclass AND tgname = 'ordinary_crafting_inputs_no_truncate') THEN
    CREATE TRIGGER ordinary_crafting_inputs_no_truncate BEFORE TRUNCATE ON ordinary_crafting_inputs FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_ordinary_crafting_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_completions'::regclass AND tgname = 'ordinary_crafting_completions_guard') THEN
    CREATE TRIGGER ordinary_crafting_completions_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_crafting_completions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_guard();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_completions'::regclass AND tgname = 'ordinary_crafting_completions_no_truncate') THEN
    CREATE TRIGGER ordinary_crafting_completions_no_truncate BEFORE TRUNCATE ON ordinary_crafting_completions FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_ordinary_crafting_guard();
  END IF;
END;
$migration$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE jid uuid; job public.ordinary_crafting_jobs%ROWTYPE; input public.ordinary_crafting_inputs%ROWTYPE;
 expected jsonb; r public.resource_stock_operations%ROWTYPE; c public.resource_stock_operations%ROWTYPE;
 terminal public.ordinary_crafting_completions%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='ordinary_crafting_jobs' THEN jid:=NEW.id; ELSE jid:=NEW.job_id; END IF;
 SELECT * INTO STRICT job FROM public.ordinary_crafting_jobs WHERE id=jid;
 IF (SELECT count(*) FROM public.ordinary_crafting_inputs WHERE job_id=jid)<>jsonb_array_length(job.recipe_snapshot->'inputs') THEN
  RAISE EXCEPTION 'ordinary job requires every input proof' USING ERRCODE='23514'; END IF;
 FOR input IN SELECT * FROM public.ordinary_crafting_inputs WHERE job_id=jid ORDER BY position LOOP
  expected:=job.recipe_snapshot->'inputs'->input.position;
  IF (input.kind=expected->>'kind' AND input.item_id=expected->>'itemId' AND input.quantity=(expected->>'quantity')::bigint) IS NOT TRUE THEN
   RAISE EXCEPTION 'ordinary input differs from original recipe' USING ERRCODE='23514'; END IF;
  IF input.kind='raw' THEN
   SELECT * INTO STRICT r FROM public.resource_stock_operations WHERE id=input.reserve_operation_id;
   SELECT * INTO STRICT c FROM public.resource_stock_operations WHERE id=input.consume_operation_id;
   IF (r.kind='reserve' AND c.kind='consume' AND c.reservation_id=r.id
    AND r.base_id=job.base_id AND c.base_id=job.base_id AND r.custody_wallet=job.actor_wallet AND c.custody_wallet=job.actor_wallet
    AND r.resource_id=input.item_id AND c.resource_id=input.item_id AND r.quantity=input.quantity AND c.quantity=input.quantity) IS NOT TRUE THEN
    RAISE EXCEPTION 'ordinary job requires exact raw consumption' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 SELECT * INTO terminal FROM public.ordinary_crafting_completions WHERE job_id=jid;
 IF (job.completed_at IS NULL) IS DISTINCT FROM (terminal.job_id IS NULL)
  OR (terminal.job_id IS NOT NULL AND terminal.completed_at IS DISTINCT FROM job.completed_at) THEN
  RAISE EXCEPTION 'ordinary completion requires original terminal proof' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_ordinary_crafting_proof() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_jobs'::regclass AND tgname = 'ordinary_crafting_jobs_proof') THEN
    CREATE CONSTRAINT TRIGGER ordinary_crafting_jobs_proof AFTER INSERT OR UPDATE ON ordinary_crafting_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_proof();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_inputs'::regclass AND tgname = 'ordinary_crafting_inputs_proof') THEN
    CREATE CONSTRAINT TRIGGER ordinary_crafting_inputs_proof AFTER INSERT OR UPDATE ON ordinary_crafting_inputs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_proof();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ordinary_crafting_completions'::regclass AND tgname = 'ordinary_crafting_completions_proof') THEN
    CREATE CONSTRAINT TRIGGER ordinary_crafting_completions_proof AFTER INSERT OR UPDATE ON ordinary_crafting_completions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_proof();
  END IF;
END;
$migration$;
