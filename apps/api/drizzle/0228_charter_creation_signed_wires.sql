-- D153.168 private immutable wallet consent. SQL binds the exact original v0
-- bytes; the application independently verifies D166 and wallet Ed25519 on each
-- read. Historical retention is not relay, mint, activation or refund authority.
CREATE TABLE IF NOT EXISTS public.charter_creation_signed_wires (
 attempt_id uuid PRIMARY KEY REFERENCES public.charter_creation_preparations(attempt_id),
 wallet text NOT NULL,
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 66 AND 1232),
 signature bytea NOT NULL CHECK(octet_length(signature)=64),
 wire_sha256 text NOT NULL CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_signed_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.charter_creation_signed_wires'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_OWNER' USING ERRCODE='42501';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_signed_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE item record;owner_id oid;
BEGIN
 PERFORM public.shardkeep_charter_signed_owner();
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_creation_signed_wires'::regclass;
 IF current_setting('session_replication_role')<>'origin' OR owner_id IS DISTINCT FROM
 (SELECT relowner FROM pg_class WHERE oid='public.charter_creation_preparations'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_HELD';END IF;
 FOR item IN SELECT * FROM(VALUES('_guard','private',31,false),('_no_truncate','private',34,false),('_complete','complete',5,true)) x(suffix,fn,typ,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE t.tgrelid='public.charter_creation_signed_wires'::regclass AND t.tgname='charter_creation_signed_wires'||item.suffix
   AND t.tgtype=item.typ AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname='shardkeep_charter_signed_'||item.fn AND p.pronargs=0 AND p.proowner=owner_id AND NOT p.prosecdef
   AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT item.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_HELD';END IF;
 END LOOP;
 FOR item IN SELECT * FROM(VALUES('owner()'),('hooks()'),('read(text,uuid)'),('valid(public.charter_creation_signed_wires,jsonb)')) x(signature) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.shardkeep_charter_signed_'||item.signature)
   AND p.proowner=owner_id AND NOT p.prosecdef
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_HELD';END IF;
 END LOOP;
 PERFORM public.shardkeep_charter_preparation_hooks();
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_signed_valid(v public.charter_creation_signed_wires,source jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE message bytea;packet jsonb;c jsonb;
BEGIN
 PERFORM public.shardkeep_charter_signed_owner();packet:=source->'preparation'->'packet';c:=source->'policy'->'original'->'consent';
 IF packet IS NULL OR packet='null'::jsonb OR jsonb_typeof(packet->'messageHex') IS DISTINCT FROM 'string'
 OR packet->>'messageHex' !~ '^(80)([0-9a-f]{2})+$' OR length(packet->>'messageHex')>2334
 OR v.attempt_id::text IS DISTINCT FROM source->'attempt'->'attempt'->>'id'
 OR v.wallet IS DISTINCT FROM c->>'payer' OR v.signed_transaction IS NULL OR octet_length(v.signed_transaction) NOT BETWEEN 66 AND 1232
 OR get_byte(v.signed_transaction,0)<>1 OR get_byte(v.signed_transaction,65)<>128
 OR v.signature IS DISTINCT FROM substring(v.signed_transaction FROM 2 FOR 64)
 OR v.signature=decode(repeat('00',64),'hex') OR v.wire_sha256 IS DISTINCT FROM encode(sha256(v.signed_transaction),'hex')
 OR v.accepted_at IS NULL OR NOT isfinite(v.accepted_at) THEN RETURN false;END IF;
 message:=substring(v.signed_transaction FROM 66);
 RETURN message=decode(packet->>'messageHex','hex') AND v.message_sha256=encode(sha256(message),'hex')
  AND v.message_sha256=packet->>'messageSha256';
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_signed_read(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source jsonb;v public.charter_creation_signed_wires%ROWTYPE;aid uuid;
BEGIN
 PERFORM public.shardkeep_charter_signed_hooks();
 -- Established reservation -> inventory head -> preparation -> signed order.
 source:=public.shardkeep_charter_preparation_read(w,intent);
 IF source IS NULL OR source->'preparation' IS NULL OR source->'preparation'='null'::jsonb THEN RETURN NULL;END IF;
 aid:=(source->'attempt'->'attempt'->>'id')::uuid;
 SELECT * INTO v FROM public.charter_creation_signed_wires WHERE attempt_id=aid FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF public.shardkeep_charter_signed_valid(v,source) IS NOT TRUE THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_SOURCE';END IF;
 RETURN jsonb_build_object('attemptId',v.attempt_id,'wallet',v.wallet,'signedTransactionHex',encode(v.signed_transaction,'hex'),
  'signatureHex',encode(v.signature,'hex'),'wireSha256',v.wire_sha256,'messageSha256',v.message_sha256,
  'acceptedAt',to_char(v.accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_signed_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_creation_issuance_attempts%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;source jsonb;
BEGIN
 PERFORM public.shardkeep_charter_signed_owner();
 IF TG_RELID<>'public.charter_creation_signed_wires'::regclass OR TG_WHEN<>'BEFORE'
 OR TG_NAME<>('charter_creation_signed_wires'||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END))
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND(TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE')))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_signed_hooks();
 IF NEW.wallet IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.accepted_at IS NOT NULL
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_DERIVED';END IF;
 SELECT * INTO a FROM public.charter_creation_issuance_attempts WHERE id=NEW.attempt_id;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=a.reservation_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_SOURCE';END IF;
 source:=public.shardkeep_charter_preparation_read(r.payer,r.intent_id);
 IF source->'preparation' IS NULL OR source->'preparation'='null'::jsonb THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_SOURCE';END IF;
 NEW.wallet:=r.payer;NEW.signature:=substring(NEW.signed_transaction FROM 2 FOR 64);
 NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.message_sha256:=encode(sha256(substring(NEW.signed_transaction FROM 66)),'hex');
 NEW.accepted_at:=clock_timestamp();
 IF public.shardkeep_charter_signed_valid(NEW,source) IS NOT TRUE THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_WIRE';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_signed_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE v public.charter_creation_signed_wires%ROWTYPE;a public.charter_creation_issuance_attempts%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_signed_owner();
 IF TG_RELID<>'public.charter_creation_signed_wires'::regclass OR TG_NAME<>'charter_creation_signed_wires_complete'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_signed_hooks();
 SELECT * INTO v FROM public.charter_creation_signed_wires WHERE attempt_id=NEW.attempt_id;
 IF v.attempt_id IS NULL OR to_jsonb(v) IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_SOURCE';END IF;
 SELECT * INTO a FROM public.charter_creation_issuance_attempts WHERE id=v.attempt_id;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=a.reservation_id;
 IF public.shardkeep_charter_signed_read(r.payer,r.intent_id) IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SIGNED_SOURCE';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
DO $$DECLARE fn record;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_signed_wires'::regclass AND tgname='charter_creation_signed_wires_guard') THEN
 CREATE TRIGGER charter_creation_signed_wires_guard BEFORE INSERT OR UPDATE OR DELETE ON public.charter_creation_signed_wires FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_signed_private();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_signed_wires'::regclass AND tgname='charter_creation_signed_wires_no_truncate') THEN
 CREATE TRIGGER charter_creation_signed_wires_no_truncate BEFORE TRUNCATE ON public.charter_creation_signed_wires FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_signed_private();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_signed_wires'::regclass AND tgname='charter_creation_signed_wires_complete') THEN
 CREATE CONSTRAINT TRIGGER charter_creation_signed_wires_complete AFTER INSERT ON public.charter_creation_signed_wires DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_signed_complete();END IF;
 REVOKE ALL ON public.charter_creation_signed_wires FROM PUBLIC;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_signed_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
