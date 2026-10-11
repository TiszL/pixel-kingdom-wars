-- Prospective actual-INSERT origin and passive first-change observations only.
-- No backfill or earning/custody authority; existing-table hooks remain S5-held.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.shards_obstacle_base_origins (
 obligation_id uuid PRIMARY KEY REFERENCES public.shards_obstacle_obligations(id),
 original_obligation jsonb NOT NULL,original_base jsonb NOT NULL,
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$' AND tx_key::numeric<=18446744073709551615)
);
CREATE TABLE IF NOT EXISTS public.shards_obstacle_base_changes (
 obligation_id uuid PRIMARY KEY REFERENCES public.shards_obstacle_base_origins(obligation_id),
 before_base jsonb NOT NULL,after_base jsonb NOT NULL,
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$' AND tx_key::numeric<=18446744073709551615),
 CHECK(before_base IS DISTINCT FROM after_base)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_base_state(b public.bases) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('id',b.id,'owner_wallet',b.owner_wallet,'status',b.status,
  'land_paid_at',b.land_paid_at,'deed_asset_id',b.deed_asset_id,'deed_mint_asset_id',b.deed_mint_asset_id,'deed_minting_at',b.deed_minting_at)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_base_origin_valid(o public.shards_obstacle_base_origins) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h JOIN public.bases b ON b.id=h.base_id
  WHERE h.id=o.obligation_id AND o.original_obligation=to_jsonb(h)
  AND o.original_base=public.shardkeep_shards_obstacle_base_state(b)
  AND b.owner_wallet=h.wallet AND b.status='active' AND b.deed_asset_id IS NOT DISTINCT FROM h.deed_asset_id
  AND o.tx_key~'^[1-9][0-9]*$' AND o.tx_key::numeric<=18446744073709551615)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_base_witness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE o public.shards_obstacle_base_origins%ROWTYPE;
 before_row public.bases%ROWTYPE;after_row public.bases%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.shards_obstacle_base_origins'::regclass,'public.shards_obstacle_base_changes'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_IMMUTABLE';END IF;
 IF pg_trigger_depth()<2 OR current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_WITNESS_ORIGIN' USING ERRCODE='42501';END IF;
 IF TG_RELID='public.shards_obstacle_base_origins'::regclass THEN
  IF NOT public.shardkeep_shards_obstacle_base_origin_valid(NEW) THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_WITNESS_ORIGIN';END IF;
 ELSE
  SELECT * INTO STRICT o FROM public.shards_obstacle_base_origins WHERE obligation_id=NEW.obligation_id;
  SELECT * INTO before_row FROM jsonb_populate_record(NULL::public.bases,NEW.before_base);
  SELECT * INTO after_row FROM jsonb_populate_record(NULL::public.bases,NEW.after_base);
  IF NEW.before_base IS NOT DISTINCT FROM NEW.after_base
  OR NEW.before_base IS DISTINCT FROM public.shardkeep_shards_obstacle_base_state(before_row)
  OR NEW.after_base IS DISTINCT FROM public.shardkeep_shards_obstacle_base_state(after_row)
  OR before_row.id::text IS DISTINCT FROM o.original_base->>'id'
  OR after_row.id IS DISTINCT FROM before_row.id
  THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_WITNESS_ORIGIN';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_base_origin_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF TG_RELID<>'public.shards_obstacle_obligations'::regclass OR TG_NAME<>'shards_obstacle_obligations_base_origin'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_TRIGGER';END IF;
 -- The existing BEFORE capture guard owns all parent locks and versions. This
 -- hook observes those exact rows without acquiring any other parent locks.
 INSERT INTO public.shards_obstacle_base_origins(obligation_id,original_obligation,original_base,tx_key)
 SELECT NEW.id,to_jsonb(NEW),public.shardkeep_shards_obstacle_base_state(b),pg_current_xact_id()::text
 FROM public.bases b WHERE b.id=NEW.base_id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_base_origin_insert() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_base_change_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE before_state jsonb;after_state jsonb;
BEGIN
 IF TG_RELID<>'public.bases'::regclass OR TG_NAME<>'bases_shards_obstacle_base_change'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_BASE_TRIGGER';END IF;
 before_state:=public.shardkeep_shards_obstacle_base_state(OLD);after_state:=public.shardkeep_shards_obstacle_base_state(NEW);
 IF before_state IS NOT DISTINCT FROM after_state THEN RETURN NULL;END IF;
 INSERT INTO public.shards_obstacle_base_changes(obligation_id,before_base,after_base,tx_key)
 SELECT o.obligation_id,before_state,after_state,pg_current_xact_id()::text FROM public.shards_obstacle_obligations h
 JOIN public.shards_obstacle_base_origins o ON o.obligation_id=h.id
 WHERE h.base_id=OLD.id ON CONFLICT(obligation_id) DO NOTHING;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_base_change_update() FROM PUBLIC;
--> statement-breakpoint
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_obstacle_base_origins','shards_obstacle_base_changes'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_base_witness_guard()',t||'_immutable',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_obstacle_base_witness_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_obstacle_obligations'::regclass AND tgname='shards_obstacle_obligations_base_origin') THEN
  CREATE TRIGGER shards_obstacle_obligations_base_origin AFTER INSERT ON public.shards_obstacle_obligations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_base_origin_insert();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.bases'::regclass AND tgname='bases_shards_obstacle_base_change') THEN
  CREATE TRIGGER bases_shards_obstacle_base_change AFTER UPDATE ON public.bases FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_base_change_update();
 END IF;
END $$;
