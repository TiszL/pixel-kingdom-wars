-- Public proof projection, not a claimability decision or a grant on old tables.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS mining_claim_entitlement_headers (
 epoch_id uuid PRIMARY KEY REFERENCES mining_publication_settlements(epoch_id),
 genesis_hash text NOT NULL,program_id text NOT NULL,config_address text NOT NULL,keep_mint text NOT NULL,reserve_owner text NOT NULL,
 sequence numeric(20,0) NOT NULL CHECK(sequence=1),day numeric(20,0) NOT NULL CHECK(day>0 AND day<=18446744073709551615),
 root text NOT NULL CHECK(root~'^[0-9a-f]{64}$'),source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 total_cumulative numeric(20,0) NOT NULL CHECK(total_cumulative>0 AND total_cumulative<=18446744073709551615),
 leaf_count integer NOT NULL CHECK(leaf_count BETWEEN 1 AND 32),publication_signature text NOT NULL,
 publication_slot bigint NOT NULL CHECK(publication_slot>=0),projected_at timestamptz NOT NULL CHECK(isfinite(projected_at)),
 UNIQUE(genesis_hash,program_id,config_address,sequence)
);
CREATE TABLE IF NOT EXISTS mining_claim_entitlement_leaves (
 epoch_id uuid NOT NULL REFERENCES mining_claim_entitlement_headers(epoch_id),wallet text NOT NULL CHECK(length(wallet) BETWEEN 32 AND 44),
 leaf_index integer NOT NULL CHECK(leaf_index BETWEEN 0 AND 31),
 leaf_bytes bytea NOT NULL CHECK(octet_length(leaf_bytes)=65 AND get_byte(leaf_bytes,0)=2),
 proof_bytes bytea NOT NULL CHECK(octet_length(proof_bytes) BETWEEN 4 AND 660 AND (octet_length(proof_bytes)-4)%41=0),
 PRIMARY KEY(epoch_id,wallet),UNIQUE(epoch_id,leaf_index)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_entitlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.mining_publication_manifests%ROWTYPE; s public.mining_publication_settlements%ROWTYPE;
 h public.mining_claim_entitlement_headers%ROWTYPE; award jsonb; amount numeric:=0; i integer;
BEGIN
 IF TG_RELID NOT IN ('public.mining_claim_entitlement_headers'::regclass,'public.mining_claim_entitlement_leaves'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_TRIGGER_IDENTITY'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_IMMUTABLE'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
 SELECT * INTO STRICT s FROM public.mining_publication_settlements WHERE epoch_id=NEW.epoch_id;
 IF TG_TABLE_NAME='mining_claim_entitlement_headers' THEN
  IF EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)-'epoch_id') kv WHERE kv.value<>'null'::jsonb) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_DERIVED_FIELDS'; END IF;
  NEW.genesis_hash:=s.receipt->>'genesisHash';NEW.program_id:=m.publication->>'programId';NEW.config_address:=s.receipt->>'config';
  NEW.keep_mint:=m.publication->>'keepMint';NEW.reserve_owner:=m.publication->>'reserveOwner';NEW.sequence:=(m.publication->>'sequence')::numeric;
  NEW.day:=(m.publication->>'day')::numeric;NEW.root:=m.publication->>'root';NEW.source_hash:=m.source_hash;NEW.total_cumulative:=(m.publication->>'total')::numeric;
  NEW.leaf_count:=(m.publication->>'leafCount')::integer;NEW.publication_signature:=s.signature;NEW.publication_slot:=(s.receipt->>'slot')::bigint;NEW.projected_at:=clock_timestamp();
  IF s.receipt->>'sourceHash' IS DISTINCT FROM NEW.source_hash OR s.receipt->>'root' IS DISTINCT FROM NEW.root
   OR s.receipt->>'totalCumulative' IS DISTINCT FROM NEW.total_cumulative::text OR s.receipt->>'sequence' IS DISTINCT FROM '1'
   OR m.manifest_json::jsonb->>'scope' IS DISTINCT FROM 'initial-free-virgin-config-keep-only' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 ELSE
  SELECT * INTO STRICT h FROM public.mining_claim_entitlement_headers WHERE epoch_id=NEW.epoch_id;
  IF NEW.leaf_index>=h.leaf_count OR octet_length(NEW.leaf_bytes)<>65 OR octet_length(NEW.proof_bytes)<4 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  SELECT value INTO STRICT award FROM jsonb_array_elements(m.manifest_json::jsonb->'awards') WHERE value->>'wallet'=NEW.wallet AND (value->>'net')::numeric>0;
  FOR i IN 0..7 LOOP amount:=amount+get_byte(NEW.leaf_bytes,33+i)*power(256::numeric,i); END LOOP;
  IF amount<>(award->>'net')::numeric OR substring(NEW.leaf_bytes FROM 42 FOR 16)<>decode(repeat('00',16),'hex')
   OR substring(NEW.leaf_bytes FROM 58 FOR 8)<>decode('0100000000000000','hex') OR get_byte(NEW.proof_bytes,0)<>(octet_length(NEW.proof_bytes)-4)/41
   OR substring(NEW.proof_bytes FROM 2 FOR 3)<>decode('000000','hex') THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_entitlement_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.mining_claim_entitlement_headers%ROWTYPE; m public.mining_publication_manifests%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.mining_claim_entitlement_headers'::regclass,'public.mining_claim_entitlement_leaves'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_complete' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_TRIGGER_IDENTITY'; END IF;
 SELECT * INTO STRICT h FROM public.mining_claim_entitlement_headers WHERE epoch_id=NEW.epoch_id;
 SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
 IF (SELECT count(*) FROM public.mining_claim_entitlement_leaves WHERE epoch_id=NEW.epoch_id)<>h.leaf_count
  OR (SELECT count(*) FROM jsonb_array_elements(m.manifest_json::jsonb->'awards') a WHERE (a->>'net')::numeric>0)<>h.leaf_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.manifest_json::jsonb->'awards') a WHERE (a->>'net')::numeric>0
   AND NOT EXISTS(SELECT 1 FROM public.mining_claim_entitlement_leaves l WHERE l.epoch_id=NEW.epoch_id AND l.wallet=a->>'wallet')) THEN
  RAISE EXCEPTION 'MINING_ENTITLEMENT_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
DO $migration$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['mining_claim_entitlement_headers','mining_claim_entitlement_leaves'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND tgname=n||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_entitlement_guard()',n||'_immutable',n);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_entitlement_guard()',n||'_no_truncate',n);
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_entitlement_complete()',n||'_complete',n);
  END IF;
 END LOOP;
END $migration$;
REVOKE ALL ON mining_claim_entitlement_headers,mining_claim_entitlement_leaves FROM PUBLIC;
--> statement-breakpoint
-- Only the public proof projection needs the API runtime read grant.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN
  GRANT SELECT ON public.mining_claim_entitlement_headers,public.mining_claim_entitlement_leaves TO shardkeep_api_runtime;
 END IF;
END $$;
