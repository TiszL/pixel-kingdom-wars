-- Additive journal only. No cutover, account changes or production authority.
CREATE TABLE IF NOT EXISTS public.keep_custody_journal (
  id uuid PRIMARY KEY,
  operation text NOT NULL UNIQUE,
  scope text NOT NULL,
  subcommand text NOT NULL,
  dry_run boolean NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  operator_name text NOT NULL,
  database_name text NOT NULL,
  request jsonb NOT NULL,
  receipts jsonb NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.keep_custody_journal FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_journal_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_IMMUTABLE' USING ERRCODE='P0001'; END IF;
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
    OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_cutover_state'::regclass)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_OWNER_REQUIRED' USING ERRCODE='P0001'; END IF;
  -- No production command is admitted by this initial implementation. Custom
  -- GUCs and broad runtime DML grants do not confer journal authority.
  IF current_database() !~ '^shardkeep_custody_apply_[0-9a-f]{32}_test$'
    OR NEW.database_name<>current_database() OR NEW.operator_name<>current_user
    OR NEW.scope<>'fixture' OR NEW.subcommand<>'retire-l1' OR NEW.dry_run
    OR NEW.operation<>'fixture:l1-retirement'
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed'
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_custody_journal_immutable ON public.keep_custody_journal;
CREATE TRIGGER keep_custody_journal_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.keep_custody_journal
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_journal_guard();
DROP TRIGGER IF EXISTS keep_custody_journal_no_truncate ON public.keep_custody_journal;
CREATE TRIGGER keep_custody_journal_no_truncate BEFORE TRUNCATE ON public.keep_custody_journal
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_custody_journal_guard();
