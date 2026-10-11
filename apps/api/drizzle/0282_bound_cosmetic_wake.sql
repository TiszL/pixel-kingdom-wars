-- Private prospective Aurora Wake custody. No routes, spending or renderer admission.
-- Capture the original actor at INSERT; never infer a historical choice from today.
SET LOCAL lock_timeout='10s';
DO $$BEGIN
 IF NOT public.shardkeep_bound_cosmetic_return_sources_valid()
 OR NOT public.shardkeep_bound_cosmetic_visual_sources_valid()
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PREDECESSOR';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
END $$;
CREATE TABLE public.bound_cosmetic_wake_preferences(
 wallet text PRIMARY KEY REFERENCES public.players(wallet),enabled boolean NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL CHECK(isfinite(updated_at))
);
CREATE TABLE public.bound_cosmetic_starter_wakes(
 expedition_id uuid PRIMARY KEY REFERENCES public.starter_expeditions(id),visual jsonb NOT NULL,selection_record jsonb NOT NULL
);
CREATE TABLE public.bound_cosmetic_advanced_wakes(
 expedition_id uuid PRIMARY KEY REFERENCES public.advanced_expeditions(id),visual jsonb NOT NULL,selection_record jsonb NOT NULL
);
REVOKE ALL ON public.bound_cosmetic_wake_preferences,public.bound_cosmetic_starter_wakes,public.bound_cosmetic_advanced_wakes FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_selection(actor text,at_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pref public.bound_cosmetic_wake_preferences%ROWTYPE;job public.bound_cosmetic_jobs%ROWTYPE;completed timestamptz;
 unavailable jsonb:=jsonb_build_object('state','unavailable','visual',NULL);record jsonb;
BEGIN
 record:=jsonb_build_object('actorWallet',actor,'departedAt',at_time,'preferenceRevision',NULL,'jobId',NULL,'completedAt',NULL,'visual',unavailable);
 IF actor IS NULL OR at_time IS NULL OR NOT isfinite(at_time) OR at_time>clock_timestamp()
 OR to_regprocedure('public.shardkeep_bound_cosmetic_wake_sources_valid()') IS NULL THEN RETURN record;END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_sources_valid() THEN RETURN record;END IF;
 SELECT * INTO pref FROM public.bound_cosmetic_wake_preferences WHERE wallet=actor;
 IF pref.wallet IS NOT NULL AND pref.updated_at>at_time THEN RETURN record;END IF;
 record:=jsonb_set(record,'{preferenceRevision}',to_jsonb(coalesce(pref.revision,0)::text));
 IF NOT coalesce(pref.enabled,false) THEN
  RETURN jsonb_set(record,'{visual}',jsonb_build_object('state','available','visual',jsonb_build_object('version',1,'wake',NULL)));
 END IF;
 SELECT * INTO job FROM public.bound_cosmetic_jobs WHERE actor_wallet=actor AND output_id='aurora_wake';
 SELECT completed_at INTO completed FROM public.bound_cosmetic_completions WHERE job_id=job.id;
 IF job.id IS NULL OR completed IS NULL OR completed>at_time OR completed<job.ready_at OR job.started_at>at_time
 OR job.recipe_snapshot IS DISTINCT FROM public.shardkeep_bound_cosmetic_recipe('craft_aurora_wake_v1')
 OR job.appearance_snapshot IS DISTINCT FROM public.shardkeep_bound_cosmetic_appearance('aurora_wake') THEN RETURN record;END IF;
 RETURN record||jsonb_build_object('jobId',job.id,'completedAt',completed,'visual',jsonb_build_object('state','available','visual',jsonb_build_object('version',1,'wake',job.appearance_snapshot)));
END $$;
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_preference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.bound_cosmetic_jobs%ROWTYPE;completion timestamptz;blueprint public.bound_cosmetic_blueprints%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.bound_cosmetic_wake_preferences'::regclass OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'bound_cosmetic_wake_preference_guard' OR TG_OP NOT IN('INSERT','UPDATE')
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PREFERENCE_OWNER';END IF;
 IF NEW.updated_at IS NULL OR NOT isfinite(NEW.updated_at) OR NEW.updated_at>clock_timestamp()
 OR (TG_OP='INSERT' AND NEW.revision IS DISTINCT FROM 1)
 OR (TG_OP='UPDATE' AND(NEW.wallet IS DISTINCT FROM OLD.wallet OR OLD.revision=9223372036854775807
  OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at))
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PREFERENCE_CHANGED';END IF;
 PERFORM wallet FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_ACCOUNT';END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_sources_valid() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_SOURCE';END IF;
 IF NEW.enabled THEN
  SELECT * INTO job FROM public.bound_cosmetic_jobs WHERE actor_wallet=NEW.wallet AND output_id='aurora_wake';
  SELECT completed_at INTO completion FROM public.bound_cosmetic_completions WHERE job_id=job.id;
  IF job.id IS NULL OR completion IS NULL OR completion>NEW.updated_at OR completion<job.ready_at OR job.started_at>NEW.updated_at
   OR job.recipe_snapshot IS DISTINCT FROM public.shardkeep_bound_cosmetic_recipe('craft_aurora_wake_v1')
   OR job.appearance_snapshot IS DISTINCT FROM public.shardkeep_bound_cosmetic_appearance('aurora_wake')
  THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_NOT_OWNED';END IF;
  SELECT * INTO STRICT blueprint FROM public.bound_cosmetic_blueprints WHERE wallet=NEW.wallet AND blueprint_id=job.blueprint_id;
  IF blueprint.granted_at>job.started_at THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_NOT_OWNED';END IF;
  PERFORM public.shardkeep_bound_cosmetic_blueprint_source(blueprint.source_job_id,NEW.wallet,job.started_at);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bound_cosmetic_wake_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_wake_preferences FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_preference_guard();
CREATE TRIGGER bound_cosmetic_wake_preference_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_wake_preferences FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_preference_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_preference(actor text,wanted boolean,expected_revision bigint,at_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pref public.bound_cosmetic_wake_preferences%ROWTYPE;selection jsonb;
BEGIN
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.bound_cosmetic_wake_preferences'::regclass)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PREFERENCE_OWNER';END IF;
 IF actor IS NULL OR wanted IS NULL OR expected_revision IS NULL OR expected_revision<0 OR expected_revision>=9223372036854775807
 OR at_time IS NULL OR NOT isfinite(at_time) OR at_time>clock_timestamp() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_PREFERENCE_INPUT';END IF;
 PERFORM wallet FROM public.players WHERE wallet=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_ACCOUNT';END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_sources_valid() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_SOURCE';END IF;
 SELECT * INTO pref FROM public.bound_cosmetic_wake_preferences WHERE wallet=actor;
 -- Only the exact already-applied CAS is recoverable. Never invert a stale choice.
 IF pref.revision=expected_revision+1 AND pref.enabled=wanted THEN
  selection:=public.shardkeep_bound_cosmetic_wake_selection(actor,clock_timestamp());
  RETURN jsonb_build_object('enabled',pref.enabled,'revision',pref.revision::text,'visual',selection->'visual');
 END IF;
 IF coalesce(pref.revision,0)<>expected_revision THEN RAISE EXCEPTION 'BOUND_COSMETIC_PREFERENCE_CHANGED';END IF;
 IF pref.wallet IS NULL THEN
  INSERT INTO public.bound_cosmetic_wake_preferences(wallet,enabled,revision,updated_at) VALUES(actor,wanted,1,at_time);
 ELSE
  UPDATE public.bound_cosmetic_wake_preferences SET enabled=wanted,revision=expected_revision+1,updated_at=at_time WHERE wallet=actor;
 END IF;
 selection:=public.shardkeep_bound_cosmetic_wake_selection(actor,at_time);
 RETURN jsonb_build_object('enabled',wanted,'revision',(expected_revision+1)::text,'visual',selection->'visual');
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_wake_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text;departed timestamptz;created_xid numeric;current_xid numeric;expected jsonb;
BEGIN
 IF TG_RELID NOT IN('public.bound_cosmetic_starter_wakes'::regclass,'public.bound_cosmetic_advanced_wakes'::regclass)
 OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'bound_cosmetic_wake_guard' OR pg_trigger_depth()<>2
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_IMMUTABLE';END IF;
 IF TG_RELID='public.bound_cosmetic_starter_wakes'::regclass THEN
  SELECT actor_wallet,departed_at,xmin::text::numeric INTO actor,departed,created_xid FROM public.starter_expeditions WHERE id=NEW.expedition_id;
 ELSE
  SELECT actor_wallet,departed_at,xmin::text::numeric INTO actor,departed,created_xid FROM public.advanced_expeditions WHERE id=NEW.expedition_id;
 END IF;
 -- A visible uncommitted parent belongs to this transaction, including an
 -- enclosing savepoint. Comparing xmin to the top-level xid rejects real
 -- subtransactions. Expand the 32-bit xmin around the current xid epoch.
 IF created_xid IS NULL THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_IMMUTABLE';END IF;
 current_xid:=pg_current_xact_id()::text::numeric;
 created_xid:=created_xid+trunc(current_xid/4294967296)*4294967296;
 IF created_xid-current_xid>2147483648 THEN created_xid:=created_xid-4294967296;
 ELSIF current_xid-created_xid>2147483648 THEN created_xid:=created_xid+4294967296;END IF;
 IF pg_xact_status(created_xid::text::xid8) IS DISTINCT FROM 'in progress' THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_IMMUTABLE';END IF;
 PERFORM wallet FROM public.players WHERE wallet=actor FOR UPDATE;
 expected:=public.shardkeep_bound_cosmetic_wake_selection(actor,departed);
 IF NEW.selection_record IS DISTINCT FROM expected OR NEW.visual IS DISTINCT FROM expected->'visual'
 THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bound_cosmetic_wake_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_starter_wakes FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_guard();
CREATE TRIGGER bound_cosmetic_wake_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_starter_wakes FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_guard();
CREATE TRIGGER bound_cosmetic_wake_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bound_cosmetic_advanced_wakes FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_guard();
CREATE TRIGGER bound_cosmetic_wake_no_truncate BEFORE TRUNCATE ON public.bound_cosmetic_advanced_wakes FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_bound_cosmetic_wake_guard();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_starter_wake_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selection jsonb;
BEGIN
 IF TG_RELID<>'public.starter_expeditions'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'bound_cosmetic_starter_wake_capture' OR pg_trigger_depth()<>1 OR current_setting('session_replication_role')<>'origin'
 OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_CAPTURE';END IF;
 PERFORM wallet FROM public.players WHERE wallet=NEW.actor_wallet FOR UPDATE;
 selection:=public.shardkeep_bound_cosmetic_wake_selection(NEW.actor_wallet,NEW.departed_at);
 INSERT INTO public.bound_cosmetic_starter_wakes(expedition_id,visual,selection_record) VALUES(NEW.id,selection->'visual',selection);
 RETURN NULL;
END $$;
CREATE FUNCTION public.shardkeep_bound_cosmetic_advanced_wake_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selection jsonb;
BEGIN
 IF TG_RELID<>'public.advanced_expeditions'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'bound_cosmetic_advanced_wake_capture' OR pg_trigger_depth()<>1 OR current_setting('session_replication_role')<>'origin'
 OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_CAPTURE';END IF;
 PERFORM wallet FROM public.players WHERE wallet=NEW.actor_wallet FOR UPDATE;
 selection:=public.shardkeep_bound_cosmetic_wake_selection(NEW.actor_wallet,NEW.departed_at);
 INSERT INTO public.bound_cosmetic_advanced_wakes(expedition_id,visual,selection_record) VALUES(NEW.id,selection->'visual',selection);
 RETURN NULL;
END $$;
CREATE TRIGGER bound_cosmetic_starter_wake_capture AFTER INSERT ON public.starter_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_starter_wake_capture();
CREATE TRIGGER bound_cosmetic_advanced_wake_capture AFTER INSERT ON public.advanced_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_bound_cosmetic_advanced_wake_capture();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_bound_cosmetic_starter_wake(wanted uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original jsonb;
BEGIN
 SELECT visual INTO original FROM public.bound_cosmetic_starter_wakes WHERE expedition_id=wanted;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_sources_valid() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_SOURCE';END IF;
 RETURN original;
END $$;
CREATE FUNCTION public.shardkeep_bound_cosmetic_advanced_wake(wanted uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original jsonb;
BEGIN
 SELECT visual INTO original FROM public.bound_cosmetic_advanced_wakes WHERE expedition_id=wanted;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF NOT public.shardkeep_bound_cosmetic_wake_sources_valid() THEN RAISE EXCEPTION 'BOUND_COSMETIC_WAKE_SOURCE';END IF;
 RETURN original;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_bound_cosmetic_wake_selection(text,timestamptz),public.shardkeep_bound_cosmetic_wake_preference_guard(),
 public.shardkeep_bound_cosmetic_wake_preference(text,boolean,bigint,timestamptz),public.shardkeep_bound_cosmetic_wake_guard(),
 public.shardkeep_bound_cosmetic_starter_wake_capture(),public.shardkeep_bound_cosmetic_advanced_wake_capture(),
 public.shardkeep_bound_cosmetic_starter_wake(uuid),public.shardkeep_bound_cosmetic_advanced_wake(uuid) FROM PUBLIC;
