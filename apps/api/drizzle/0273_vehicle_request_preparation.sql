-- D153.214 private, once-only original request preparation. No mounting, grants,
-- custody transfer, backfill or fresh permission from a retained observation.
CREATE TABLE public.vehicle_request_issuance_attempts(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_craft_material_reservations(id),
 actor_wallet text NOT NULL,idempotency_key uuid NOT NULL,policy_authority text NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=16384),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),UNIQUE(actor_wallet,idempotency_key)
);
CREATE TABLE public.vehicle_request_preparations(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_request_issuance_attempts(reservation_id),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=196608),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE public.vehicle_request_signed_wires(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_request_preparations(reservation_id),
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 66 AND 1232),
 signature bytea NOT NULL CHECK(octet_length(signature)=64),
 wire_sha256 text NOT NULL CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at))
);
CREATE TABLE public.vehicle_request_preparation_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.vehicle_request_issuance_attempts,public.vehicle_request_preparations,public.vehicle_request_signed_wires,public.vehicle_request_preparation_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_vehicle_request_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.vehicle_request_issuance_attempts'::regclass)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'VEHICLE_REQUEST_OWNER_ISOLATION' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_request_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('materialSource',public.shardkeep_divine_fragment_contract(),
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',to_jsonb(c.relacl),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,to_jsonb(a.attacl),pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(pg_get_constraintdef(k.oid),k.convalidated) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid)))
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['vehicle_request_issuance_attempts','vehicle_request_preparations','vehicle_request_signed_wires','vehicle_request_preparation_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',to_jsonb(p.proacl),'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['shardkeep_vehicle_request_owner','shardkeep_vehicle_request_contract','shardkeep_vehicle_request_source','shardkeep_vehicle_request_attempt_valid','shardkeep_vehicle_request_prepared_valid','shardkeep_vehicle_request_guard','shardkeep_vehicle_request_complete','shardkeep_vehicle_request_seal_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN('public.vehicle_request_issuance_attempts'::regclass,'public.vehicle_request_preparations'::regclass,'public.vehicle_request_signed_wires'::regclass,'public.vehicle_request_preparation_contract'::regclass)))
$$;
CREATE FUNCTION public.shardkeep_vehicle_request_source() RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_vehicle_request_owner();PERFORM public.shardkeep_divine_fragment_source();
 IF (SELECT record FROM public.vehicle_request_preparation_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_vehicle_request_contract()
 THEN RAISE EXCEPTION 'VEHICLE_REQUEST_SOURCE';END IF;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_request_attempt_valid(v jsonb,rid uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.vehicle_craft_material_reservations%ROWTYPE;o jsonb;p jsonb;expected jsonb;
BEGIN
 SELECT * INTO r FROM public.vehicle_craft_material_reservations WHERE id=rid;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT original INTO o FROM public.vehicle_issuance_originals WHERE root_id=r.root_id;
 SELECT canonical::jsonb INTO p FROM public.vehicle_craft_recipe_policies WHERE recipe_hash=r.recipe_hash;
 expected:=jsonb_build_object('reservationId',r.id,'baseId',r.base_id,'nonce',r.nonce,'reservedAt',to_char(r.reserved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recipe',p,'recipeHash',r.recipe_hash,'materialHash',r.material_hash);
 RETURN coalesce(jsonb_typeof(v)='object' AND v-ARRAY['wallet','idempotencyKey','purpose','publicKey','material','original','messageHex']='{}'::jsonb
  AND v ?& ARRAY['wallet','idempotencyKey','purpose','publicKey','material','original','messageHex']
  AND v->>'wallet'=r.actor_wallet AND v->>'idempotencyKey'=r.idempotency_key::text AND v->>'purpose'='vehicle-request-v1'
  AND jsonb_typeof(v->'publicKey')='string' AND (v->>'publicKey')~'^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  AND v->'material'=expected AND o IS NOT NULL AND v->'original'=o
  AND jsonb_typeof(v->'messageHex')='string' AND length(v->>'messageHex')=322 AND (v->>'messageHex')~'^[0-9a-f]+$',false);
END $$;
CREATE FUNCTION public.shardkeep_vehicle_request_prepared_valid(v jsonb,a jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE receipt jsonb;q jsonb;
BEGIN
 receipt:=v->'issuerReceipt';q:=v->'quote';
 RETURN coalesce(jsonb_typeof(v)='object' AND v-ARRAY['version','issuerReceipt','quote']='{}'::jsonb AND v ?& ARRAY['version','issuerReceipt','quote'] AND v->'version'='1'::jsonb
  AND jsonb_typeof(receipt)='object' AND receipt-ARRAY['attempt','signatureHex']='{}'::jsonb AND receipt ?& ARRAY['attempt','signatureHex']
  AND receipt->'attempt'=a AND jsonb_typeof(receipt->'signatureHex')='string' AND (receipt->>'signatureHex')~'^[0-9a-f]{128}$'
  AND jsonb_typeof(q)='object' AND q->'version'='1'::jsonb AND q->'original'=a->'original'
  AND q->'originalHash'=a->'original'->'originalHash' AND q->'policyAuthority'=a->'publicKey' AND q->'policySignatureHex'=receipt->'signatureHex'
  AND jsonb_typeof(q->'messageHex')='string' AND (q->>'messageHex')~'^([0-9a-f]{2})+$' AND length(q->>'messageHex') BETWEEN 2 AND 2334
  AND q->>'messageSha256'=encode(sha256(decode(q->>'messageHex','hex')),'hex')
  AND q->'signingAuthorized'='false'::jsonb AND q->'broadcastAuthorized'='false'::jsonb AND q->'paymentAuthorized'='false'::jsonb
  AND q->'activationAuthorized'='false'::jsonb AND q->'reservationReleaseAuthorized'='false'::jsonb,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_vehicle_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE rid uuid;r public.vehicle_craft_material_reservations%ROWTYPE;a public.vehicle_request_issuance_attempts%ROWTYPE;p public.vehicle_request_preparations%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_request_issuance_attempts'::regclass,'public.vehicle_request_preparations'::regclass,'public.vehicle_request_signed_wires'::regclass)
 OR TG_WHEN<>'BEFORE' OR TG_NAME<>TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'VEHICLE_REQUEST_IMMUTABLE';END IF;
 PERFORM public.shardkeep_vehicle_request_source();rid:=NEW.reservation_id;
 SELECT * INTO r FROM public.vehicle_craft_material_reservations WHERE id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_REQUEST_MATERIAL';END IF;
 IF TG_TABLE_NAME='vehicle_request_issuance_attempts' THEN
  IF NEW.recorded_at IS NOT NULL OR NEW.actor_wallet IS DISTINCT FROM r.actor_wallet OR NEW.idempotency_key IS DISTINCT FROM r.idempotency_key
  OR NEW.policy_authority IS DISTINCT FROM NEW.record->>'publicKey' OR public.shardkeep_vehicle_request_attempt_valid(NEW.record,rid) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.vehicle_craft_material_terminals WHERE reservation_id=rid)
  THEN RAISE EXCEPTION 'VEHICLE_REQUEST_ATTEMPT';END IF;
  NEW.recorded_at:=clock_timestamp();
 ELSE
  SELECT * INTO a FROM public.vehicle_request_issuance_attempts WHERE reservation_id=rid;
  IF NOT FOUND OR public.shardkeep_vehicle_request_attempt_valid(a.record,rid) IS NOT TRUE THEN RAISE EXCEPTION 'VEHICLE_REQUEST_ATTEMPT';END IF;
  IF TG_TABLE_NAME='vehicle_request_preparations' THEN
   IF NEW.recorded_at IS NOT NULL OR public.shardkeep_vehicle_request_prepared_valid(NEW.record,a.record) IS NOT TRUE THEN RAISE EXCEPTION 'VEHICLE_REQUEST_PREPARATION';END IF;
   NEW.recorded_at:=clock_timestamp();
  ELSE
   SELECT * INTO p FROM public.vehicle_request_preparations WHERE reservation_id=rid;
   IF NOT FOUND OR public.shardkeep_vehicle_request_prepared_valid(p.record,a.record) IS NOT TRUE OR NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL
   OR octet_length(NEW.signed_transaction) NOT BETWEEN 66 AND 1232 OR get_byte(NEW.signed_transaction,0)<>1
   OR substring(NEW.signed_transaction from 66) IS DISTINCT FROM decode(p.record#>>'{quote,messageHex}','hex')
   OR substring(NEW.signed_transaction from 2 for 64)=decode(repeat('00',64),'hex')
   THEN RAISE EXCEPTION 'VEHICLE_REQUEST_WIRE';END IF;
   -- SQL binds exact bytes; TS independently proves canonical wire + Ed25519.
   NEW.signature:=substring(NEW.signed_transaction from 2 for 64);NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');
   NEW.message_sha256:=p.record#>>'{quote,messageSha256}';NEW.accepted_at:=clock_timestamp();
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_request_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE actual jsonb;a public.vehicle_request_issuance_attempts%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_request_issuance_attempts'::regclass,'public.vehicle_request_preparations'::regclass,'public.vehicle_request_signed_wires'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_complete' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_REQUEST_TRIGGER';END IF;
 PERFORM public.shardkeep_vehicle_request_source();
 EXECUTE format('SELECT to_jsonb(x) FROM public.%I x WHERE reservation_id=$1',TG_TABLE_NAME) INTO actual USING NEW.reservation_id;
 IF actual IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'VEHICLE_REQUEST_SOURCE';END IF;
 SELECT * INTO a FROM public.vehicle_request_issuance_attempts WHERE reservation_id=NEW.reservation_id;
 IF NOT FOUND OR public.shardkeep_vehicle_request_attempt_valid(a.record,a.reservation_id) IS NOT TRUE THEN RAISE EXCEPTION 'VEHICLE_REQUEST_ATTEMPT';END IF;
 IF TG_TABLE_NAME='vehicle_request_issuance_attempts' AND EXISTS(SELECT 1 FROM public.vehicle_craft_material_terminals WHERE reservation_id=a.reservation_id) THEN RAISE EXCEPTION 'VEHICLE_REQUEST_ATTEMPT';END IF;
 IF TG_TABLE_NAME='vehicle_request_preparations' THEN
  IF public.shardkeep_vehicle_request_prepared_valid(NEW.record,a.record) IS NOT TRUE THEN RAISE EXCEPTION 'VEHICLE_REQUEST_PREPARATION';END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['vehicle_request_issuance_attempts','vehicle_request_preparations','vehicle_request_signed_wires'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_request_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_request_guard()',tab||'_no_truncate',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_request_complete()',tab||'_complete',tab);
 END LOOP;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_request_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_vehicle_request_owner();
 IF TG_RELID<>'public.vehicle_request_preparation_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'vehicle_request_preparation_contract_guard'
 OR EXISTS(SELECT 1 FROM public.vehicle_request_preparation_contract) OR NEW.record IS DISTINCT FROM public.shardkeep_vehicle_request_contract()
 THEN RAISE EXCEPTION 'VEHICLE_REQUEST_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER vehicle_request_preparation_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_request_preparation_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_request_seal_guard();
CREATE TRIGGER vehicle_request_preparation_contract_no_truncate BEFORE TRUNCATE ON public.vehicle_request_preparation_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_request_seal_guard();
DO $$DECLARE fn record;BEGIN
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN('shardkeep_vehicle_request_owner','shardkeep_vehicle_request_contract','shardkeep_vehicle_request_source','shardkeep_vehicle_request_attempt_valid','shardkeep_vehicle_request_prepared_valid','shardkeep_vehicle_request_guard','shardkeep_vehicle_request_complete','shardkeep_vehicle_request_seal_guard') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
INSERT INTO public.vehicle_request_preparation_contract(record) SELECT public.shardkeep_vehicle_request_contract();
SELECT public.shardkeep_vehicle_request_source();
