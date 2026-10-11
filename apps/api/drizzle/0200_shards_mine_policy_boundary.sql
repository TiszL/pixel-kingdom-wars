-- D-153 / B4bs: dark Mine-only policy provenance. No activation or backfill.
-- Future activation is an owner operation with gameplay sessions drained. The
-- effective instant must be prospective; request time never chooses tax start.
CREATE TABLE IF NOT EXISTS public.shards_mine_policy_boundary (
 id integer PRIMARY KEY CHECK(id=1),version integer NOT NULL CHECK(version=1),
 policy_version integer NOT NULL CHECK(policy_version=1),tax_table_version integer NOT NULL CHECK(tax_table_version=1),
 effective_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(isfinite(effective_at) AND isfinite(recorded_at) AND effective_at>=recorded_at),
 CHECK(effective_at=date_trunc('milliseconds',effective_at))
);
REVOKE ALL ON public.shards_mine_policy_boundary FROM PUBLIC;
-- Only global versions/times are public. Normal Mine lifecycle reads remain
-- compatible with existing runtime roles; activation and all history stay private.
GRANT SELECT ON public.shards_mine_policy_boundary TO PUBLIC;
ALTER TABLE public.shards_mine_eras
 ADD COLUMN IF NOT EXISTS policy_boundary_id integer REFERENCES public.shards_mine_policy_boundary(id),
 ADD COLUMN IF NOT EXISTS initialization_kind text,
 ADD COLUMN IF NOT EXISTS source_state_version integer,
 ADD COLUMN IF NOT EXISTS source_anchor_at timestamptz,
 ADD COLUMN IF NOT EXISTS build_job_id uuid REFERENCES public.builder_jobs(id),
 ADD COLUMN IF NOT EXISTS production_started_at timestamptz;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.shards_mine_eras'::regclass AND conname='shards_mine_eras_policy_provenance_ck') THEN
  ALTER TABLE public.shards_mine_eras ADD CONSTRAINT shards_mine_eras_policy_provenance_ck CHECK (
   num_nonnulls(policy_boundary_id,initialization_kind,source_state_version,source_anchor_at,build_job_id,production_started_at)=0 OR
   (policy_boundary_id IS NOT NULL AND initialization_kind IS NOT NULL AND source_state_version IS NOT NULL AND source_state_version>=0
    AND source_anchor_at IS NOT NULL AND isfinite(source_anchor_at) AND
    ((initialization_kind='locked_pre_policy_state' AND build_job_id IS NULL AND production_started_at IS NULL) OR
     (initialization_kind='fresh_scheduled_build' AND build_job_id IS NOT NULL AND production_started_at IS NOT NULL AND isfinite(production_started_at))))
  );
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_mine_policy_boundary_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'SHARDS_MINE_POLICY_OWNER_REQUIRED' USING ERRCODE='42501';
 END IF;
 -- An old repeatable-read snapshot must not hide an era or policy singleton.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_ISOLATION';END IF;
 LOCK TABLE public.shards_mine_eras IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE public.raid_loot_reservations IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.shards_mine_eras) THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_EXISTING_ERAS';END IF;
 IF EXISTS(SELECT 1 FROM public.raid_loot_reservations WHERE state='reserved' AND mine_reserved_shards>0) THEN
  RAISE EXCEPTION 'SHARDS_MINE_POLICY_UNMANAGED_RAID';
 END IF;
 NEW.recorded_at:=clock_timestamp();
 IF NOT isfinite(NEW.effective_at) OR NEW.effective_at<NEW.recorded_at
  OR NEW.effective_at<>date_trunc('milliseconds',NEW.effective_at) THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_BOUNDARY';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_mine_policy_boundary_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_mine_policy_era_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE policy public.shards_mine_policy_boundary%ROWTYPE;source public.mine_accrual_states%ROWTYPE;
 mine public.buildings%ROWTYPE;job public.builder_jobs%ROWTYPE;
BEGIN
 -- This restriction is only at era creation. Existing gameplay and immutable
 -- receipts retain their prior transaction contracts and are never rewritten.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_ISOLATION';END IF;
 SELECT * INTO policy FROM public.shards_mine_policy_boundary WHERE id=1;
 IF NOT FOUND THEN
  IF num_nonnulls(NEW.policy_boundary_id,NEW.initialization_kind,NEW.source_state_version,NEW.source_anchor_at,NEW.build_job_id,NEW.production_started_at)<>0 THEN
   RAISE EXCEPTION 'SHARDS_MINE_POLICY_MISSING';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.policy_boundary_id IS DISTINCT FROM policy.id OR NEW.initialization_kind IS NULL OR NEW.source_state_version IS NULL
  OR NEW.source_anchor_at IS NULL OR NOT isfinite(NEW.source_anchor_at) OR NEW.source_anchor_at>NEW.admitted_at THEN
  RAISE EXCEPTION 'SHARDS_MINE_POLICY_PROVENANCE';
 END IF;
 -- Ordinary lazy completion can own these rows in the opposite order. Refuse
 -- contention instead of waiting while the caller owns base/state locks.
 SELECT * INTO mine FROM public.buildings WHERE id=NEW.mine_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR mine.type<>'mine' OR mine.base_id IS DISTINCT FROM NEW.base_id THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_MINE';END IF;
 SELECT * INTO source FROM public.mine_accrual_states WHERE mine_building_id=NEW.mine_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR source.version IS DISTINCT FROM NEW.source_state_version OR source.last_accrual_at IS DISTINCT FROM NEW.source_anchor_at
  OR source.accrued_shards IS DISTINCT FROM NEW.legacy_gross THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_SOURCE';END IF;
 IF EXISTS(SELECT 1 FROM public.raid_mine_loot_reservations r JOIN public.raid_loot_reservations h ON h.raid_id=r.raid_id
  WHERE r.mine_building_id=NEW.mine_id AND h.state='reserved' AND r.frozen_shards>0) THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_UNMANAGED_RAID';END IF;
 IF NEW.initialization_kind='locked_pre_policy_state' THEN
  IF NEW.build_job_id IS NOT NULL OR NEW.production_started_at IS NOT NULL
   OR (NEW.legacy_gross>0 AND NEW.source_anchor_at>=policy.effective_at) THEN RAISE EXCEPTION 'SHARDS_MINE_POLICY_LEGACY';END IF;
 ELSIF NEW.initialization_kind='fresh_scheduled_build' THEN
  SELECT * INTO job FROM public.builder_jobs WHERE id=NEW.build_job_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR job.kind<>'build' OR job.building_id IS DISTINCT FROM NEW.mine_id OR job.base_id IS DISTINCT FROM NEW.base_id
   OR job.cancelled_at IS NOT NULL OR job.finishes_at>NEW.admitted_at OR NEW.production_started_at IS DISTINCT FROM job.finishes_at
   OR NEW.source_anchor_at IS DISTINCT FROM job.finishes_at OR NEW.source_state_version<>0 OR NEW.legacy_gross<>0 THEN
   RAISE EXCEPTION 'SHARDS_MINE_POLICY_BUILD';
  END IF;
  -- SQL proves the zero opening and exact scheduled job. The internal service
  -- additionally requires its actual INSERT RETURNING result, not caller claims.
 ELSE RAISE EXCEPTION 'SHARDS_MINE_POLICY_PROVENANCE';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_mine_policy_era_guard() FROM PUBLIC;
--> statement-breakpoint
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_policy_boundary'::regclass AND tgname='shards_mine_policy_boundary_guard') THEN
  CREATE TRIGGER shards_mine_policy_boundary_guard BEFORE INSERT OR UPDATE OR DELETE ON public.shards_mine_policy_boundary FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_mine_policy_boundary_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_policy_boundary'::regclass AND tgname='shards_mine_policy_boundary_no_truncate') THEN
  CREATE TRIGGER shards_mine_policy_boundary_no_truncate BEFORE TRUNCATE ON public.shards_mine_policy_boundary FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_mine_policy_boundary_guard();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_mine_eras'::regclass AND tgname='shards_mine_eras_policy_guard') THEN
  CREATE TRIGGER shards_mine_eras_policy_guard BEFORE INSERT ON public.shards_mine_eras FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_mine_policy_era_guard();
 END IF;
END $$;
