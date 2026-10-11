-- Durable signing exclusivity and exact wire retention. No transport or signer.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_publication_signing_reservations (
 epoch_id uuid PRIMARY KEY REFERENCES mining_publication_manifests(epoch_id),
 attempt_key text NOT NULL,genesis_hash text NOT NULL,program_id text NOT NULL,config_address text NOT NULL,
 sequence numeric(20,0) NOT NULL CHECK(sequence>0 AND sequence<=18446744073709551615),
 signer text NOT NULL,intent_sha256 text NOT NULL CHECK(intent_sha256~'^[0-9a-f]{64}$'),
 backing jsonb NOT NULL CHECK(jsonb_typeof(backing)='object' AND octet_length(backing::text)<=65536),
 backing_sha256 text NOT NULL CHECK(backing_sha256~'^[0-9a-f]{64}$'),reserved_at timestamptz NOT NULL CHECK(isfinite(reserved_at)),
 UNIQUE(genesis_hash,program_id,config_address,sequence)
);
CREATE TABLE IF NOT EXISTS mining_publication_signed_wires (
 epoch_id uuid PRIMARY KEY REFERENCES mining_publication_signing_reservations(epoch_id),
 signature text NOT NULL UNIQUE CHECK(length(signature) BETWEEN 64 AND 88),
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 1 AND 1232),
 wire_sha256 text NOT NULL CHECK(wire_sha256~'^[0-9a-f]{64}$'),message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_outbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.mining_publication_manifests%ROWTYPE; a public.mining_publication_attempts%ROWTYPE;
 r public.mining_publication_signing_reservations%ROWTYPE; plan jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.mining_publication_signing_reservations'::regclass,'public.mining_publication_signed_wires'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_OUTBOX_TRIGGER_IDENTITY'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_OUTBOX_IMMUTABLE'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_OUTBOX_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_OUTBOX_READ_COMMITTED_REQUIRED'; END IF;
 PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
 SELECT * INTO STRICT a FROM public.mining_publication_attempts WHERE epoch_id=NEW.epoch_id;
 IF TG_TABLE_NAME='mining_publication_signing_reservations' THEN
  IF NEW.attempt_key IS NOT NULL OR NEW.genesis_hash IS NOT NULL OR NEW.program_id IS NOT NULL OR NEW.config_address IS NOT NULL
   OR NEW.sequence IS NOT NULL OR NEW.signer IS NOT NULL OR NEW.intent_sha256 IS NOT NULL OR NEW.backing_sha256 IS NOT NULL OR NEW.reserved_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_OUTBOX_DERIVED_FIELDS'; END IF;
  plan:=m.manifest_json::jsonb;
  NEW.attempt_key:=a.attempt_key;NEW.genesis_hash:=plan#>>'{funding,source,genesisHash}';NEW.program_id:=m.publication->>'programId';
  NEW.config_address:=plan#>>'{funding,config,address}';NEW.sequence:=(m.publication->>'sequence')::numeric;
  NEW.signer:=m.publication->>'signer';NEW.intent_sha256:=a.intent_sha256;NEW.reserved_at:=clock_timestamp();
  NEW.backing_sha256:=encode(sha256(convert_to(NEW.backing::text,'UTF8')),'hex');
  IF NEW.backing#>>'{source,genesisHash}' IS DISTINCT FROM NEW.genesis_hash OR NEW.backing#>>'{source,programId}' IS DISTINCT FROM NEW.program_id
   OR NEW.backing#>>'{config,address}' IS DISTINCT FROM NEW.config_address OR NEW.backing#>>'{config,publisher}' IS DISTINCT FROM NEW.signer
   OR ((NEW.backing#>>'{config,latestSequence}')::numeric+1=NEW.sequence) IS DISTINCT FROM true
   OR ((NEW.backing->>'slot')::bigint >= (m.publication->>'blockhashContextSlot')::bigint) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_OUTBOX_SOURCE_DRIFT'; END IF;
 ELSE
  SELECT * INTO STRICT r FROM public.mining_publication_signing_reservations WHERE epoch_id=NEW.epoch_id;
  IF NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_OUTBOX_DERIVED_FIELDS'; END IF;
  NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.message_sha256:=r.intent_sha256;NEW.accepted_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $migration$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['mining_publication_signing_reservations','mining_publication_signed_wires'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND tgname=n||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_outbox_guard()',n||'_immutable',n);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_outbox_guard()',n||'_no_truncate',n);
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_publication_signing_reservations,mining_publication_signed_wires FROM PUBLIC;
