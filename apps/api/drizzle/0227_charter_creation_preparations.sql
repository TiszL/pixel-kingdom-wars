-- D153.166 private original-only issuance/preparation, S5-held. API/DB is the
-- trusted entitlement authority; SQL cannot prove RPC, fees, Ed25519 or a
-- process clock. An immutable attempt may remain uncertain forever. Neither
-- row grants a public signing capability. No money/source hooks or backfill.
CREATE TABLE IF NOT EXISTS public.charter_creation_issuance_attempts (
 id uuid PRIMARY KEY,
 reservation_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_policy_admissions(reservation_id),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=196608),
 recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_creation_preparations (
 attempt_id uuid PRIMARY KEY REFERENCES public.charter_creation_issuance_attempts(id),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=16384),
 recorded_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.charter_creation_issuance_attempts'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_OWNER' USING ERRCODE='42501';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE item record;owner_id oid;
BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_creation_issuance_attempts'::regclass;
 IF current_setting('session_replication_role')<>'origin' OR EXISTS(SELECT 1 FROM pg_class
  WHERE oid IN('public.charter_creation_preparations'::regclass,'public.charter_creation_policy_admissions'::regclass)
  AND relowner<>owner_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_HELD';END IF;
 FOR item IN SELECT * FROM(VALUES('charter_creation_issuance_attempts'),('charter_creation_preparations')) tabs(tab)
 CROSS JOIN(VALUES('_guard','private',31,false),('_no_truncate','private',34,false),('_complete','complete',5,true)) funcs(suffix,fn,typ,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE t.tgrelid=('public.'||item.tab)::regclass AND t.tgname=item.tab||item.suffix AND t.tgtype=item.typ
   AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname='shardkeep_charter_preparation_'||item.fn AND p.pronargs=0
   AND p.proowner=owner_id AND NOT p.prosecdef AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT item.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_HELD';END IF;
 END LOOP;
 FOR item IN SELECT * FROM(VALUES('owner()'),('hooks()'),('valid(jsonb,jsonb)'),('artifact(jsonb)'),
  ('current(jsonb)'),('read(text,uuid)')) x(signature) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.shardkeep_charter_preparation_'||item.signature)
   AND p.proowner=owner_id AND NOT p.prosecdef
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_HELD';END IF;
 END LOOP;
 PERFORM public.shardkeep_charter_policy_hooks();
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_valid(v jsonb,policy jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a jsonb;q jsonb;c jsonb;input jsonb;timing jsonb;
BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR octet_length(v::text)>196608
 OR v-ARRAY['version','admission','attempt','timing']<>'{}'::jsonb OR NOT(v ?& ARRAY['version','admission','attempt','timing'])
 OR v->'version' IS DISTINCT FROM '1'::jsonb OR v->'admission' IS DISTINCT FROM policy OR policy IS NULL OR policy='null'::jsonb
 THEN RETURN false;END IF;
 a:=v->'attempt';q:=a->'quote';input:=q->'packetInput';c:=policy->'original'->'consent';timing:=v->'timing';
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR a-ARRAY['id','policySigner','candidateHex','quote']<>'{}'::jsonb
 OR NOT(a ?& ARRAY['id','policySigner','candidateHex','quote']) OR jsonb_typeof(a->'id') IS DISTINCT FROM 'string'
 OR (a->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR a->'policySigner' IS DISTINCT FROM policy->'policy'->'currentSigner'
 OR a->'candidateHex' IS DISTINCT FROM policy->'candidate'->'messageHex'
 OR jsonb_typeof(q) IS DISTINCT FROM 'object' OR q->'version' IS DISTINCT FROM '1'::jsonb
 OR q->'signingAuthorized' IS DISTINCT FROM 'false'::jsonb OR q->'mintAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR q->'paymentAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR input->'candidateHex' IS DISTINCT FROM a->'candidateHex' OR input->'policySigner' IS DISTINCT FROM a->'policySigner'
 OR input->'original' IS DISTINCT FROM jsonb_build_object('creationIntentId',c->'creationIntentId','clanId',c->'clanId',
  'payer',c->'payer','metadata',c->'metadata','chain',c->'chain','admissionCommitment',policy->'admission'->'commitment')
 OR q->'observation'->'expectedCurrentSigner' IS DISTINCT FROM a->'policySigner'
 OR q->'observation'->'authority'->'currentPolicyKey' IS DISTINCT FROM a->'policySigner'
 OR q->'observation'->'authority'->'admissionPaused' IS DISTINCT FROM 'false'::jsonb
 OR q->'observation'->'craftControl'->'admissionPaused' IS DISTINCT FROM 'false'::jsonb
 THEN RETURN false;END IF;
 IF jsonb_typeof(timing) IS DISTINCT FROM 'object' OR timing-ARRAY['startedMs','recordSampleMs','elapsedMs']<>'{}'::jsonb
 OR NOT(timing ?& ARRAY['startedMs','recordSampleMs','elapsedMs']) OR jsonb_typeof(timing->'startedMs') IS DISTINCT FROM 'number'
 OR jsonb_typeof(timing->'recordSampleMs') IS DISTINCT FROM 'number' OR jsonb_typeof(timing->'elapsedMs') IS DISTINCT FROM 'number'
 OR (timing->>'startedMs')::numeric<0 OR (timing->>'recordSampleMs')::numeric<(timing->>'startedMs')::numeric
 OR (timing->>'elapsedMs')::numeric<0 THEN RETURN false;END IF;
 -- Exact packet/observation/cost/crypto and IEEE754 time checks are repeated by
 -- the TS reader. Retained assertions are consistency data, not RPC authority.
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_artifact(v jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();
 RETURN coalesce(jsonb_typeof(v)='object' AND octet_length(v::text)<=16384
  AND v-ARRAY['policySignatureHex','packet']='{}'::jsonb AND v ?& ARRAY['policySignatureHex','packet']
  AND jsonb_typeof(v->'policySignatureHex')='string' AND length(v->>'policySignatureHex')=128
  AND (v->>'policySignatureHex')~'^[0-9a-f]+$' AND jsonb_typeof(v->'packet')='object'
  AND v->'packet'->'version'='1'::jsonb AND v->'packet'->'signingAuthorized'='false'::jsonb
  AND v->'packet'->'relayAuthorized'='false'::jsonb AND v->'packet'->'mintAuthorized'='false'::jsonb,false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_current(policy jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE c jsonb;bid uuid;b public.bases%ROWTYPE;proof jsonb;freshness integer;r public.charter_creation_reservations%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();
 c:=policy->'original'->'consent';bid:=(c->'funding'->>'baseId')::uuid;
 -- Facade already holds player -> base -> slot/raid. Direct owner writes may
 -- hold reservation first; NOWAIT prevents that alternative call from creating
 -- a reservation -> base wait cycle with normal gameplay/terminal writers.
 SELECT * INTO b FROM public.bases WHERE id=bid FOR UPDATE NOWAIT;
 IF NOT FOUND OR b.owner_wallet IS DISTINCT FROM c->>'payer' OR b.status<>'active' OR b.land_paid_at IS NULL
 OR b.deed_asset_id IS DISTINCT FROM c->'funding'->>'deedAssetId' THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 PERFORM base_id FROM public.base_slots WHERE base_id=bid AND wallet=c->>'payer' AND active FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 PERFORM base_id FROM public.base_raid_locks WHERE base_id=bid FOR UPDATE NOWAIT;
 IF FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 SELECT freshness_ms INTO freshness FROM public.charter_custody_sources WHERE base_id=bid;
 IF freshness IS NULL OR freshness<=0 THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 proof:=public.shardkeep_charter_custody_read(bid,freshness);
 IF proof IS NULL OR proof->>'authority' IS DISTINCT FROM 'current' OR proof->>'baseId' IS DISTINCT FROM bid::text
 OR proof->>'deedAssetId' IS DISTINCT FROM c->'funding'->>'deedAssetId' OR proof->>'ownerWallet' IS DISTINCT FROM c->>'payer'
 OR proof->>'id' IS DISTINCT FROM c->'funding'->'ownershipEpoch'->>'id'
 OR proof->>'evidenceCommitment' IS DISTINCT FROM c->'funding'->'ownershipEpoch'->>'evidenceCommitment'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=(c->>'reservationId')::uuid;
 IF NOT FOUND OR r.state<>'reserved' OR EXISTS(SELECT 1 FROM public.charter_creation_terminals WHERE reservation_id=r.id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_read(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source jsonb;a public.charter_creation_issuance_attempts%ROWTYPE;p public.charter_creation_preparations%ROWTYPE;rid uuid;
BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();PERFORM public.shardkeep_charter_preparation_hooks();
 -- Established reservation -> head order, including immutable terminal effects.
 source:=public.shardkeep_charter_policy_read(w,intent);
 IF source IS NULL THEN RETURN NULL;END IF;
 rid:=(source->'inventory'->'reservation'->'consent'->>'reservationId')::uuid;
 SELECT * INTO a FROM public.charter_creation_issuance_attempts WHERE reservation_id=rid FOR UPDATE;
 IF FOUND THEN
  IF NOT isfinite(a.recorded_at) OR a.id::text IS DISTINCT FROM a.record->'attempt'->>'id'
  OR public.shardkeep_charter_preparation_valid(a.record,source->'record') IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_HELD';END IF;
  SELECT * INTO p FROM public.charter_creation_preparations WHERE attempt_id=a.id;
  IF FOUND AND(NOT isfinite(p.recorded_at) OR public.shardkeep_charter_preparation_artifact(p.record) IS NOT TRUE)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_HELD';END IF;
 END IF;
 RETURN jsonb_build_object('policy',source->'record','state',source->'inventory'->'reservation'->'state','attempt',a.record,'preparation',p.record);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_creation_issuance_attempts%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;source jsonb;rid uuid;
BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();
 IF TG_RELID NOT IN('public.charter_creation_issuance_attempts'::regclass,'public.charter_creation_preparations'::regclass)
 OR TG_WHEN<>'BEFORE' OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END))
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND(TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE')))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_preparation_hooks();
 IF TG_TABLE_NAME='charter_creation_issuance_attempts' THEN rid:=NEW.reservation_id;
 ELSE SELECT reservation_id INTO rid FROM public.charter_creation_issuance_attempts WHERE id=NEW.attempt_id;END IF;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 source:=public.shardkeep_charter_policy_read(r.payer,r.intent_id);
 IF TG_TABLE_NAME='charter_creation_issuance_attempts' THEN
  IF NEW.id IS NULL OR NEW.id::text IS DISTINCT FROM NEW.record->'attempt'->>'id'
  OR EXISTS(SELECT 1 FROM public.charter_creation_issuance_attempts WHERE reservation_id=rid)
  OR public.shardkeep_charter_preparation_valid(NEW.record,source->'record') IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
  PERFORM public.shardkeep_charter_preparation_current(source->'record');
 ELSE
  SELECT * INTO a FROM public.charter_creation_issuance_attempts WHERE id=NEW.attempt_id FOR UPDATE;
  IF NOT FOUND OR public.shardkeep_charter_preparation_valid(a.record,source->'record') IS NOT TRUE
  OR public.shardkeep_charter_preparation_artifact(NEW.record) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.charter_creation_preparations WHERE attempt_id=a.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
  -- Exact issued receipt retention remains allowed after expiry/terminal. The
  -- API verifies its original signature/packet, without any new issuer call.
 END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_preparation_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_creation_issuance_attempts%ROWTYPE;p public.charter_creation_preparations%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_preparation_owner();
 IF TG_RELID NOT IN('public.charter_creation_issuance_attempts'::regclass,'public.charter_creation_preparations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||'_complete') OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_preparation_hooks();
 IF TG_TABLE_NAME='charter_creation_issuance_attempts' THEN
  SELECT * INTO a FROM public.charter_creation_issuance_attempts WHERE id=NEW.id;
  IF a.id IS NULL OR to_jsonb(a) IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
  PERFORM public.shardkeep_charter_preparation_current(a.record->'admission');
 ELSE
  SELECT * INTO p FROM public.charter_creation_preparations WHERE attempt_id=NEW.attempt_id;
  SELECT * INTO a FROM public.charter_creation_issuance_attempts WHERE id=NEW.attempt_id;
  IF a.id IS NULL OR p.attempt_id IS NULL OR to_jsonb(p) IS DISTINCT FROM to_jsonb(NEW)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_PREPARATION_SOURCE';END IF;
 END IF;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=a.reservation_id;
 PERFORM public.shardkeep_charter_preparation_read(r.payer,r.intent_id);RETURN NULL;
END $$;
--> statement-breakpoint
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_creation_issuance_attempts','charter_creation_preparations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_preparation_private()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_preparation_private()',tab||'_no_truncate',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_preparation_complete()',tab||'_complete',tab);END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',tab);
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_preparation_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
