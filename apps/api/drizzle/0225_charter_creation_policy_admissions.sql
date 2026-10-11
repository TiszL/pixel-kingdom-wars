-- D153.164 private prospective policy records, S5-held with B6l/B6n/B6o.
-- SQL proves original backing, immutability and exact candidate pairing. RPC
-- trust, current signer policy, constants and process time remain application
-- inputs; a retained record is never independent finality/signing authority.
-- No public source hook, money movement, historical adoption or backfill.
CREATE TABLE IF NOT EXISTS public.charter_creation_policy_admissions (
 id uuid PRIMARY KEY,
 reservation_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_permit_heads(reservation_id),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=65536),
 recorded_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_policy_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.charter_creation_policy_admissions'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_OWNER' USING ERRCODE='42501';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_policy_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE item record;owner_id oid;
BEGIN
 PERFORM public.shardkeep_charter_policy_owner();
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_creation_policy_admissions'::regclass;
 IF current_setting('session_replication_role')<>'origin' OR EXISTS(
  SELECT 1 FROM pg_class WHERE oid IN('public.charter_creation_reservations'::regclass,
   'public.charter_creation_permit_heads'::regclass,'public.charter_creation_permit_messages'::regclass) AND relowner<>owner_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_HELD';END IF;
 FOR item IN SELECT * FROM(VALUES('_guard','private',31,false),('_no_truncate','private',34,false),
  ('_complete','complete',5,true)) x(suffix,fn,typ,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE t.tgrelid='public.charter_creation_policy_admissions'::regclass
   AND t.tgname='charter_creation_policy_admissions'||item.suffix AND t.tgtype=item.typ AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname='shardkeep_charter_policy_'||item.fn AND p.pronargs=0 AND p.proowner=owner_id
   AND NOT p.prosecdef AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT item.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
     AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_HELD';END IF;
 END LOOP;
 FOR item IN SELECT * FROM(VALUES('owner()'),('hooks()'),('valid(jsonb,jsonb)'),('read(text,uuid)')) x(signature) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.shardkeep_charter_policy_'||item.signature)
   AND p.proowner=owner_id AND NOT p.prosecdef
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_HELD';END IF;
 END LOOP;
 PERFORM public.shardkeep_charter_permit_hooks();PERFORM public.shardkeep_charter_creation_hooks();
END $$;

-- One canonical hex representation. Never infer SQL/JS JSON serializer parity
-- for the B6n preimage; compare its exact already-retained protected bytes.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_policy_valid(v jsonb,inventory jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE c jsonb;candidate jsonb;policy jsonb;observation jsonb;timing jsonb;bytes bytea;expiry numeric;i integer;flag text;
BEGIN
 PERFORM public.shardkeep_charter_policy_owner();
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR octet_length(v::text)>65536 THEN RETURN false;END IF;
 IF v-ARRAY['version','id','original','admission','candidate','policy','timing','transactionProofVerified',
  'signingAuthorized','mintAuthorized','paymentAuthorized','activationAuthorized','refundAuthorized','reservationReleaseAuthorized']<>'{}'::jsonb
 OR NOT(v ?& ARRAY['version','id','original','admission','candidate','policy','timing','transactionProofVerified',
  'signingAuthorized','mintAuthorized','paymentAuthorized','activationAuthorized','refundAuthorized','reservationReleaseAuthorized'])
 OR v->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(v->'id') IS DISTINCT FROM 'string'
 OR (v->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RETURN false;END IF;
 FOREACH flag IN ARRAY ARRAY['transactionProofVerified','signingAuthorized','mintAuthorized','paymentAuthorized',
  'activationAuthorized','refundAuthorized','reservationReleaseAuthorized'] LOOP
  IF v->flag IS DISTINCT FROM 'false'::jsonb THEN RETURN false;END IF;
 END LOOP;
 c:=inventory->'reservation'->'consent';candidate:=v->'candidate';policy:=v->'policy';timing:=v->'timing';observation:=policy->'observation';
 IF c IS NULL OR v->'original' IS DISTINCT FROM jsonb_build_object('consent',c,
  'reserveTransactionId',inventory->'reservation'->'reserveTransactionId')
 OR v->'admission' IS DISTINCT FROM inventory->'admission'
 OR jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR candidate-ARRAY['messageHex','messageSha256','permitId','expiry']<>'{}'::jsonb
 OR NOT(candidate ?& ARRAY['messageHex','messageSha256','permitId','expiry'])
 OR jsonb_typeof(candidate->'messageHex') IS DISTINCT FROM 'string' OR length(candidate->>'messageHex') IS DISTINCT FROM 322
 OR (candidate->>'messageHex') !~ '^[0-9a-f]+$'
 OR jsonb_typeof(candidate->'messageSha256') IS DISTINCT FROM 'string' OR (candidate->>'messageSha256') !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(candidate->'permitId') IS DISTINCT FROM 'string' OR (candidate->>'permitId') !~ '^[0-9a-f]{32}$'
 OR jsonb_typeof(candidate->'expiry') IS DISTINCT FROM 'string' OR length(candidate->>'expiry')>19
 OR (candidate->>'expiry') !~ '^[1-9][0-9]*$'
 THEN RETURN false;END IF;
 bytes:=decode(candidate->>'messageHex','hex');expiry:=0;
 FOR i IN 0..7 LOOP expiry:=expiry+get_byte(bytes,121+i)::numeric*power(256::numeric,i);END LOOP;
 IF expiry>9223372036854775807 OR expiry IS DISTINCT FROM (candidate->>'expiry')::numeric
 OR substring(bytes FROM 1 FOR 8)<>convert_to('SKPERMT2','UTF8') OR get_byte(bytes,72)<>5
 OR encode(substring(bytes FROM 74 FOR 16),'hex') IS DISTINCT FROM candidate->>'permitId'
 OR encode(sha256(bytes),'hex') IS DISTINCT FROM candidate->>'messageSha256'
 OR (inventory->'message'<>'null'::jsonb AND inventory->'message' IS DISTINCT FROM
  jsonb_build_object('messageHex',candidate->'messageHex','messageSha256',candidate->'messageSha256'))
 THEN RETURN false;END IF;
 IF jsonb_typeof(policy) IS DISTINCT FROM 'object' OR policy-ARRAY['version','currentSigner','observation']<>'{}'::jsonb
 OR NOT(policy ?& ARRAY['version','currentSigner','observation']) OR policy->'version' IS DISTINCT FROM '1'::jsonb
 OR jsonb_typeof(policy->'currentSigner') IS DISTINCT FROM 'string' OR length(policy->>'currentSigner') NOT BETWEEN 32 AND 44
 OR jsonb_typeof(observation) IS DISTINCT FROM 'object' OR observation->'version' IS DISTINCT FROM '1'::jsonb
 OR observation->'domain' IS DISTINCT FROM jsonb_build_object('genesisHash',c->'chain'->'genesisHash',
  'economyProgram',c->'chain'->'economyProgram','craftProgram',c->'chain'->'craftProgram')
 OR observation->>'expectedCurrentSigner' IS DISTINCT FROM policy->>'currentSigner'
 OR observation->'authority'->>'currentPolicyKey' IS DISTINCT FROM policy->>'currentSigner'
 OR observation->'authority'->'admissionPaused' IS DISTINCT FROM 'false'::jsonb
 OR observation->'craftControl'->'admissionPaused' IS DISTINCT FROM 'false'::jsonb
 OR observation->'craftControl'->>'address' IS DISTINCT FROM c->'chain'->>'craftControl'
 OR observation->'currentSignerObserved' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(observation->'unixTimestamp') IS DISTINCT FROM 'string' OR length(observation->>'unixTimestamp')>19
 OR (observation->>'unixTimestamp') !~ '^[1-9][0-9]*$' OR (observation->>'unixTimestamp')::numeric>=expiry
 THEN RETURN false;END IF;
 FOREACH flag IN ARRAY ARRAY['transactionProofVerified','signingAuthorized','mintAuthorized','paymentAuthorized',
  'activationAuthorized','refundAuthorized','reservationReleaseAuthorized'] LOOP
  IF observation->flag IS DISTINCT FROM 'false'::jsonb THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(timing) IS DISTINCT FROM 'object' OR timing-ARRAY['startedMs','recordSampleMs','elapsedMs']<>'{}'::jsonb
 OR NOT(timing ?& ARRAY['startedMs','recordSampleMs','elapsedMs'])
 OR jsonb_typeof(timing->'startedMs') IS DISTINCT FROM 'number' OR jsonb_typeof(timing->'recordSampleMs') IS DISTINCT FROM 'number'
 OR jsonb_typeof(timing->'elapsedMs') IS DISTINCT FROM 'number' OR (timing->>'startedMs')::numeric<0
 OR (timing->>'elapsedMs')::numeric<0 OR (timing->>'recordSampleMs')::numeric<(timing->>'startedMs')::numeric
 THEN RETURN false;END IF;
 -- JS full-precision subtraction is revalidated by every TS read; decimal
 -- SQL arithmetic is not substituted for IEEE754 elapsed-time arithmetic.
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_policy_read(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;a public.charter_creation_policy_admissions%ROWTYPE;inventory jsonb;
BEGIN
 PERFORM public.shardkeep_charter_policy_owner();PERFORM public.shardkeep_charter_policy_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE intent_id=intent FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.payer IS DISTINCT FROM w THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_PAYER';END IF;
 inventory:=public.shardkeep_charter_terminal_inventory(w,intent);
 -- Validate actual retained terminal effects without consulting today's clan,
 -- membership, money caches or custody. Bare candidates remain non-admitted.
 PERFORM public.shardkeep_charter_terminal_read(w,intent,false);
 SELECT * INTO a FROM public.charter_creation_policy_admissions WHERE reservation_id=r.id;
 IF FOUND THEN
  IF NOT isfinite(a.recorded_at) OR a.id::text IS DISTINCT FROM a.record->>'id'
  OR public.shardkeep_charter_policy_valid(a.record,inventory) IS NOT TRUE
  OR inventory->'message' IS NULL OR inventory->'message'='null'::jsonb
  THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_HELD';END IF;
 END IF;
 RETURN jsonb_build_object('record',a.record,'inventory',inventory);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_policy_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;inventory jsonb;
BEGIN
 PERFORM public.shardkeep_charter_policy_owner();
 IF TG_RELID<>'public.charter_creation_policy_admissions'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>('charter_creation_policy_admissions'||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END))
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT')
 OR (TG_OP<>'TRUNCATE' AND(TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE')))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_policy_hooks();
 -- These same reservation -> head locks also serialize bare B6n appends and
 -- B6o completion. No timestamp/xmin/depth value makes an old candidate new.
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=NEW.reservation_id FOR UPDATE;
 IF NOT FOUND OR r.state<>'reserved' THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_SOURCE';END IF;
 inventory:=public.shardkeep_charter_terminal_inventory(r.payer,r.intent_id);
 PERFORM public.shardkeep_charter_terminal_read(r.payer,r.intent_id,false);
 IF EXISTS(SELECT 1 FROM public.charter_creation_permit_messages WHERE reservation_id=r.id)
 OR EXISTS(SELECT 1 FROM public.charter_creation_policy_admissions WHERE reservation_id=r.id)
 OR NEW.id IS NULL OR NEW.id::text IS DISTINCT FROM NEW.record->>'id'
 OR public.shardkeep_charter_policy_valid(NEW.record,inventory) IS NOT TRUE
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_SOURCE';END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_policy_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_creation_policy_admissions%ROWTYPE;m public.charter_creation_permit_messages%ROWTYPE;
 r public.charter_creation_reservations%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_policy_owner();
 IF TG_RELID<>'public.charter_creation_policy_admissions'::regclass OR TG_NAME<>'charter_creation_policy_admissions_complete'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_policy_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=NEW.reservation_id FOR UPDATE;
 PERFORM reservation_id FROM public.charter_creation_permit_heads WHERE reservation_id=NEW.reservation_id FOR UPDATE;
 SELECT * INTO a FROM public.charter_creation_policy_admissions WHERE id=NEW.id;
 SELECT * INTO m FROM public.charter_creation_permit_messages WHERE reservation_id=NEW.reservation_id;
 IF a.id IS NULL OR r.id IS NULL OR m.reservation_id IS NULL OR to_jsonb(a) IS DISTINCT FROM to_jsonb(NEW)
 OR jsonb_typeof(a.record->'candidate'->'messageHex') IS DISTINCT FROM 'string'
 OR length(a.record->'candidate'->>'messageHex') IS DISTINCT FROM 322
 OR (a.record->'candidate'->>'messageHex') !~ '^[0-9a-f]+$'
 OR m.message_bytes IS DISTINCT FROM decode(a.record->'candidate'->>'messageHex','hex')
 OR m.message_sha256 IS DISTINCT FROM a.record->'candidate'->>'messageSha256'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_POLICY_PAIRING';END IF;
 PERFORM public.shardkeep_charter_policy_read(r.payer,r.intent_id);RETURN NULL;
END $$;
--> statement-breakpoint
DO $$DECLARE fn record;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_policy_admissions'::regclass
  AND tgname='charter_creation_policy_admissions_guard') THEN
  CREATE TRIGGER charter_creation_policy_admissions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.charter_creation_policy_admissions
   FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_policy_private();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_policy_admissions'::regclass
  AND tgname='charter_creation_policy_admissions_no_truncate') THEN
  CREATE TRIGGER charter_creation_policy_admissions_no_truncate BEFORE TRUNCATE ON public.charter_creation_policy_admissions
   FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_policy_private();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_policy_admissions'::regclass
  AND tgname='charter_creation_policy_admissions_complete') THEN
  CREATE CONSTRAINT TRIGGER charter_creation_policy_admissions_complete AFTER INSERT ON public.charter_creation_policy_admissions
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_policy_complete();END IF;
 REVOKE ALL ON public.charter_creation_policy_admissions FROM PUBLIC;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_policy_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
