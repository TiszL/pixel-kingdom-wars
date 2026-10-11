-- K-153: immutable chain identity gains one write-once reserve binding. Existing
-- deployments stay unbound/dark; serving startup proves the token account before
-- the only allowed null -> pair transition. No migration selects a destination.
SET lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE economy_chain_identity
  ADD COLUMN gems_reserve_owner text,
  ADD COLUMN gems_reserve_ata text,
  ADD CONSTRAINT economy_chain_identity_gems_reserve_ck CHECK (
    (gems_reserve_owner IS NULL AND gems_reserve_ata IS NULL) OR
    (gems_reserve_owner IS NOT NULL AND gems_reserve_ata IS NOT NULL
      AND gems_reserve_owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND gems_reserve_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_guard_economy_chain_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.bound_at := statement_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.gems_reserve_owner IS NULL AND OLD.gems_reserve_ata IS NULL
     AND NEW.gems_reserve_owner IS NOT NULL AND NEW.gems_reserve_ata IS NOT NULL
     AND NEW.singleton IS NOT DISTINCT FROM OLD.singleton
     AND NEW.cluster IS NOT DISTINCT FROM OLD.cluster
     AND NEW.keep_mint IS NOT DISTINCT FROM OLD.keep_mint
     AND NEW.core_program IS NOT DISTINCT FROM OLD.core_program
     AND NEW.config_pda IS NOT DISTINCT FROM OLD.config_pda
     AND NEW.bound_at IS NOT DISTINCT FROM OLD.bound_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'database economy chain identity is immutable';
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_economy_chain_identity() FROM PUBLIC;
--> statement-breakpoint
-- Preserve existing isolated-role installs without broad UPDATE permission.
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['shardkeep_api_runtime', 'shardkeep_worker_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('GRANT UPDATE (gems_reserve_owner, gems_reserve_ata) ON public.economy_chain_identity TO %I', runtime_role);
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
SET lock_timeout = '0';
