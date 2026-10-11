-- D153.19/v1: immutable seven-day original 100-spot term snapshots. Shapes and
-- hashes are integrity only; this migration creates no auction authority.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS expedition_term_snapshots (
  term_id uuid PRIMARY KEY,
  snapshot_hash text NOT NULL,
  canonical text NOT NULL,
  snapshot jsonb NOT NULL,
  genesis_hash text NOT NULL,
  program_id text NOT NULL,
  auction_config text NOT NULL,
  round text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expedition_term_source_round_uq UNIQUE(genesis_hash,program_id,auction_config,round),
  CONSTRAINT expedition_term_hash_ck CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'
    AND snapshot_hash = encode(sha256(convert_to(canonical,'UTF8')),'hex')),
  -- Technical UTF8 storage bound, not a game allowance. Full codec validates all fields.
  CONSTRAINT expedition_term_size_ck CHECK (octet_length(canonical) BETWEEN 1 AND 131072),
  CONSTRAINT expedition_term_interval_ck CHECK (ends_at - starts_at = interval '7 days'),
  CONSTRAINT expedition_term_round_ck CHECK (round ~ '^(0|[1-9][0-9]{0,19})$' AND round::numeric <= 18446744073709551615),
  CONSTRAINT expedition_term_snapshot_ck CHECK ((snapshot = canonical::jsonb AND jsonb_typeof(snapshot) = 'object'
    AND snapshot->>'version' = '1' AND snapshot->>'termId' = term_id::text
    AND (snapshot->>'startsAt')::timestamptz = starts_at AND (snapshot->>'endsAt')::timestamptz = ends_at
    AND snapshot->'source'->>'kind' = 'solana_auction_round'
    AND snapshot->'source'->>'genesisHash' = genesis_hash AND snapshot->'source'->>'programId' = program_id
    AND snapshot->'source'->>'auctionConfig' = auction_config AND snapshot->'source'->>'round' = round
    AND jsonb_typeof(snapshot->'spots') = 'array' AND jsonb_array_length(snapshot->'spots') = 100) IS TRUE)
);
CREATE INDEX IF NOT EXISTS expedition_term_interval_idx ON expedition_term_snapshots(genesis_hash,program_id,auction_config,starts_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_expedition_term_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'original expedition terms are immutable' USING ERRCODE='23514';
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_expedition_term_immutable() FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.expedition_term_snapshots'::regclass AND tgname = 'expedition_term_immutable') THEN
    CREATE TRIGGER expedition_term_immutable BEFORE UPDATE OR DELETE ON expedition_term_snapshots
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_expedition_term_immutable();
  END IF;
END;
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.expedition_term_snapshots'::regclass AND tgname = 'expedition_term_retained') THEN
    CREATE TRIGGER expedition_term_retained BEFORE TRUNCATE ON expedition_term_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_expedition_term_immutable();
  END IF;
END;
$migration$;
