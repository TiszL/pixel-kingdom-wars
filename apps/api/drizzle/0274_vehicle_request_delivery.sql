-- D153.215. A committed dispatch is never retried. A request receipt is not a
-- paid crafting outcome, material release, or permission for another request.
CREATE TABLE public.vehicle_request_dispatches(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_request_signed_wires(reservation_id),
 actor_wallet text NOT NULL,idempotency_key uuid NOT NULL,
 original_hash text NOT NULL CHECK(original_hash~'^[0-9a-f]{64}$'),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 wire_sha256 text NOT NULL UNIQUE CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 signature bytea NOT NULL UNIQUE CHECK(octet_length(signature)=64),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),UNIQUE(actor_wallet,idempotency_key)
);
CREATE TABLE public.vehicle_request_dispatch_acknowledgements(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_request_dispatches(reservation_id),
 signature bytea NOT NULL CHECK(octet_length(signature)=64),recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE public.vehicle_request_delivery_receipts(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_request_signed_wires(reservation_id),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=262144),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE UNIQUE INDEX vehicle_request_delivery_receipts_wire ON public.vehicle_request_delivery_receipts((record->>'wireSha256'));
CREATE TABLE public.vehicle_request_delivery_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.vehicle_request_dispatches,public.vehicle_request_dispatch_acknowledgements,public.vehicle_request_delivery_receipts,public.vehicle_request_delivery_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_vehicle_delivery_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.vehicle_request_dispatches'::regclass)
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_OWNER_ISOLATION' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_delivery_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('preparationSource',public.shardkeep_vehicle_request_contract(),
 'tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',to_jsonb(c.relacl),
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,to_jsonb(a.attacl),pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(pg_get_constraintdef(k.oid),k.convalidated) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid)))
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['vehicle_request_dispatches','vehicle_request_dispatch_acknowledgements','vehicle_request_delivery_receipts','vehicle_request_delivery_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',to_jsonb(p.proacl),'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['shardkeep_vehicle_delivery_owner','shardkeep_vehicle_delivery_contract','shardkeep_vehicle_delivery_source','shardkeep_vehicle_delivery_guard','shardkeep_vehicle_delivery_complete','shardkeep_vehicle_delivery_seal_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN('public.vehicle_request_dispatches'::regclass,'public.vehicle_request_dispatch_acknowledgements'::regclass,'public.vehicle_request_delivery_receipts'::regclass,'public.vehicle_request_delivery_contract'::regclass)))
$$;
CREATE FUNCTION public.shardkeep_vehicle_delivery_source() RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_vehicle_delivery_owner();PERFORM public.shardkeep_vehicle_request_source();
 IF (SELECT record FROM public.vehicle_request_delivery_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_vehicle_delivery_contract()
 THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_SOURCE';END IF;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.vehicle_craft_material_reservations%ROWTYPE;a public.vehicle_request_issuance_attempts%ROWTYPE;p public.vehicle_request_preparations%ROWTYPE;w public.vehicle_request_signed_wires%ROWTYPE;d public.vehicle_request_dispatches%ROWTYPE;v jsonb;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_request_dispatches'::regclass,'public.vehicle_request_dispatch_acknowledgements'::regclass,'public.vehicle_request_delivery_receipts'::regclass)
 OR TG_WHEN<>'BEFORE' OR TG_NAME<>TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_IMMUTABLE';END IF;
 PERFORM public.shardkeep_vehicle_delivery_source();
 SELECT * INTO r FROM public.vehicle_craft_material_reservations WHERE id=NEW.reservation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_ORIGINAL';END IF;
 SELECT * INTO a FROM public.vehicle_request_issuance_attempts WHERE reservation_id=r.id;
 SELECT * INTO p FROM public.vehicle_request_preparations WHERE reservation_id=r.id;
 SELECT * INTO w FROM public.vehicle_request_signed_wires WHERE reservation_id=r.id;
 IF a.reservation_id IS NULL OR p.reservation_id IS NULL OR w.reservation_id IS NULL
 OR a.actor_wallet IS DISTINCT FROM r.actor_wallet OR a.idempotency_key IS DISTINCT FROM r.idempotency_key OR a.policy_authority IS DISTINCT FROM a.record->>'publicKey'
 OR public.shardkeep_vehicle_request_attempt_valid(a.record,r.id) IS NOT TRUE OR public.shardkeep_vehicle_request_prepared_valid(p.record,a.record) IS NOT TRUE
 OR get_byte(w.signed_transaction,0)<>1 OR w.signature IS DISTINCT FROM substring(w.signed_transaction from 2 for 64)
 OR w.wire_sha256 IS DISTINCT FROM encode(sha256(w.signed_transaction),'hex') OR w.message_sha256 IS DISTINCT FROM p.record#>>'{quote,messageSha256}'
 OR substring(w.signed_transaction from 66) IS DISTINCT FROM decode(p.record#>>'{quote,messageHex}','hex')
 THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_ORIGINAL';END IF;
 IF NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_TIMESTAMP';END IF;
 IF TG_TABLE_NAME='vehicle_request_dispatches' THEN
  IF NEW.actor_wallet IS NOT NULL OR NEW.idempotency_key IS NOT NULL OR NEW.original_hash IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.signature IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.vehicle_craft_material_terminals WHERE reservation_id=r.id)
  OR EXISTS(SELECT 1 FROM public.vehicle_request_delivery_receipts WHERE reservation_id=r.id)
  THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_DISPATCH';END IF;
  NEW.actor_wallet:=r.actor_wallet;NEW.idempotency_key:=r.idempotency_key;NEW.original_hash:=p.record#>>'{quote,originalHash}';NEW.message_sha256:=w.message_sha256;NEW.wire_sha256:=w.wire_sha256;NEW.signature:=w.signature;
 ELSIF TG_TABLE_NAME='vehicle_request_dispatch_acknowledgements' THEN
  SELECT * INTO d FROM public.vehicle_request_dispatches WHERE reservation_id=r.id;
  IF NOT FOUND OR NEW.signature IS DISTINCT FROM d.signature OR d.signature IS DISTINCT FROM w.signature OR d.wire_sha256 IS DISTINCT FROM w.wire_sha256
  THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_ACKNOWLEDGEMENT';END IF;
 ELSE
  v:=NEW.record;
  IF jsonb_typeof(v)<>'object' OR v->'version' IS DISTINCT FROM '1'::jsonb OR coalesce(v->>'outcome','') NOT IN('request_succeeded','wire_reverted')
  OR v->>'wallet' IS DISTINCT FROM r.actor_wallet OR v->>'idempotencyKey' IS DISTINCT FROM r.idempotency_key::text OR v->'transactionProofVerified' IS DISTINCT FROM 'true'::jsonb
  OR v->>'originalHash' IS DISTINCT FROM p.record#>>'{quote,originalHash}' OR v->>'wireSha256' IS DISTINCT FROM w.wire_sha256 OR v->>'messageSha256' IS DISTINCT FROM w.message_sha256
  OR v->'paymentAuthorized' IS DISTINCT FROM 'false'::jsonb OR v->'activationAuthorized' IS DISTINCT FROM 'false'::jsonb OR v->'reservationReleaseAuthorized' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_RECEIPT';END IF;
 END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_delivery_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE actual jsonb;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_request_dispatches'::regclass,'public.vehicle_request_dispatch_acknowledgements'::regclass,'public.vehicle_request_delivery_receipts'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_complete' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_TRIGGER';END IF;
 PERFORM public.shardkeep_vehicle_delivery_source();
 EXECUTE format('SELECT to_jsonb(x) FROM public.%I x WHERE reservation_id=$1',TG_TABLE_NAME) INTO actual USING NEW.reservation_id;
 IF actual IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_SOURCE';END IF;
 IF TG_TABLE_NAME='vehicle_request_dispatches' AND EXISTS(SELECT 1 FROM public.vehicle_craft_material_terminals WHERE reservation_id=NEW.reservation_id) THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_DISPATCH';END IF;
 RETURN NULL;
END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['vehicle_request_dispatches','vehicle_request_dispatch_acknowledgements','vehicle_request_delivery_receipts'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_delivery_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_delivery_guard()',tab||'_no_truncate',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_delivery_complete()',tab||'_complete',tab);
 END LOOP;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_delivery_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_vehicle_delivery_owner();
 IF TG_RELID<>'public.vehicle_request_delivery_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'vehicle_request_delivery_contract_guard'
 OR EXISTS(SELECT 1 FROM public.vehicle_request_delivery_contract) OR NEW.record IS DISTINCT FROM public.shardkeep_vehicle_delivery_contract()
 THEN RAISE EXCEPTION 'VEHICLE_DELIVERY_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER vehicle_request_delivery_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_request_delivery_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_delivery_seal_guard();
CREATE TRIGGER vehicle_request_delivery_contract_no_truncate BEFORE TRUNCATE ON public.vehicle_request_delivery_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_delivery_seal_guard();
DO $$DECLARE fn record;BEGIN
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN('shardkeep_vehicle_delivery_owner','shardkeep_vehicle_delivery_contract','shardkeep_vehicle_delivery_source','shardkeep_vehicle_delivery_guard','shardkeep_vehicle_delivery_complete','shardkeep_vehicle_delivery_seal_guard') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
INSERT INTO public.vehicle_request_delivery_contract(record) SELECT public.shardkeep_vehicle_delivery_contract();
SELECT public.shardkeep_vehicle_delivery_source();
