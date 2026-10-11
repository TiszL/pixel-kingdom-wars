-- K-148: no retrospective allocations. Only a newly admitted first base can
-- accept this obligation; its reward is backed later if the budget is empty.
SET lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE welcome_gems_obligations (
  wallet text PRIMARY KEY REFERENCES players(wallet),
  gems bigint NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT welcome_gems_obligations_positive_ck CHECK (gems > 0)
);
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_guard_welcome_gems_obligation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'welcome Gems obligation is immutable'; END IF;
  NEW.accepted_at := statement_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_welcome_gems_obligation() FROM PUBLIC;
CREATE TRIGGER welcome_gems_obligation_guard BEFORE INSERT OR UPDATE OR DELETE
ON welcome_gems_obligations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_welcome_gems_obligation();
--> statement-breakpoint
SET lock_timeout = '0';
