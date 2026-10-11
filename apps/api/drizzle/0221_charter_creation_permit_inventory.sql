-- B6n: prospective unsigned candidate retention only. No policy admission,
-- signing, activation, cancellation or money movement. S5-held source hooks
-- depend on the protected B6l posting/reservation and its existing RC boundary.
-- A missing historical head is never adopted as evidence of zero exposure.
CREATE TABLE IF NOT EXISTS public.charter_creation_permit_heads (
 reservation_id uuid PRIMARY KEY REFERENCES public.charter_creation_reservations(id),
 commitment_version integer NOT NULL CHECK(commitment_version=1),
 admission_preimage bytea NOT NULL CHECK(octet_length(admission_preimage) BETWEEN 2 AND 16384),
 admission_commitment text NOT NULL CHECK(admission_commitment~'^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_creation_permit_messages (
 reservation_id uuid PRIMARY KEY REFERENCES public.charter_creation_permit_heads(reservation_id),
 message_bytes bytea NOT NULL CHECK(octet_length(message_bytes)=161),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL
);
-- Both rows are immutable. The complete optional PK row determines count and
-- revision 0|1 under the head lock; no mutable pointer can hide an exposure.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_permit_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.charter_creation_permit_heads'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_OWNER' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
-- Reservation -> head is the sole inventory lock order. Historical backing is
-- checked without comparing today's caches/xid to the original funding post.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_permit_read(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;h public.charter_creation_permit_heads%ROWTYPE;
 m public.charter_creation_permit_messages%ROWTYPE;source jsonb;expected bytea;message jsonb:=NULL;
BEGIN
 PERFORM public.shardkeep_charter_permit_owner();PERFORM public.shardkeep_charter_permit_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE intent_id=intent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 IF w IS NOT NULL AND w IS DISTINCT FROM r.payer THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_PAYER';END IF;
 BEGIN
  source:=public.shardkeep_charter_creation_read(r.payer,r.intent_id);
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END;
 IF source IS NULL OR r.state<>'reserved' THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 SELECT * INTO h FROM public.charter_creation_permit_heads WHERE reservation_id=r.id FOR UPDATE;
 IF NOT FOUND OR (SELECT count(*) FROM public.charter_creation_permit_heads WHERE reservation_id=r.id)<>1
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 expected:=convert_to(jsonb_build_object('domain','SHARDKEEP_CHARTER_CREATION_ADMISSION','version',1,
  'consent',r.consent,'reserveTransactionId',r.reserve_transaction_id)::text,'UTF8');
 IF h.commitment_version<>1 OR NOT isfinite(h.recorded_at) OR octet_length(h.admission_preimage) NOT BETWEEN 2 AND 16384
 OR h.admission_preimage IS DISTINCT FROM expected OR h.admission_commitment IS DISTINCT FROM encode(sha256(h.admission_preimage),'hex')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 IF (SELECT count(*) FROM public.charter_creation_permit_messages WHERE reservation_id=r.id)>1
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 SELECT * INTO m FROM public.charter_creation_permit_messages WHERE reservation_id=r.id;
 IF FOUND THEN
  IF octet_length(m.message_bytes)<>161 OR NOT isfinite(m.recorded_at)
  OR m.message_sha256 IS DISTINCT FROM encode(sha256(m.message_bytes),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
  message:=jsonb_build_object('messageHex',encode(m.message_bytes,'hex'),'messageSha256',m.message_sha256);
 END IF;
 RETURN jsonb_build_object('reservation',source,'admission',jsonb_build_object('version',h.commitment_version,
  'preimageHex',encode(h.admission_preimage,'hex'),'commitment',h.admission_commitment),'message',message);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_permit_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r record;owner_id oid;
BEGIN
 PERFORM public.shardkeep_charter_permit_owner();
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_creation_permit_heads'::regclass;
 IF current_setting('session_replication_role')<>'origin' OR EXISTS(
 SELECT 1 FROM pg_class WHERE oid IN('public.charter_creation_permit_messages'::regclass,
 'public.charter_creation_reservations'::regclass,'public.charter_creation_funding_posts'::regclass) AND relowner<>owner_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 FOR r IN
  SELECT t.tab,t.tab||s.suffix name,s.fn,s.typ,false deferred,false definer FROM
   (VALUES('charter_creation_permit_heads'),('charter_creation_permit_messages')) t(tab)
   CROSS JOIN(VALUES('_guard','private',31),('_no_truncate','private',34)) s(suffix,fn,typ)
  UNION ALL SELECT 'charter_creation_reservations','charter_creation_reservations_permit_capture','capture',5,false,true
  UNION ALL SELECT 'charter_creation_reservations','charter_creation_reservations_permit_complete','complete',5,true,true
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE t.tgrelid=('public.'||r.tab)::regclass AND t.tgname=r.name AND t.tgtype=r.typ AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND p.oid=to_regprocedure('public.shardkeep_charter_permit_'||r.fn||'()') AND p.proowner=owner_id
   AND p.prosecdef=r.definer AND t.tgdeferrable=r.deferred AND t.tginitdeferred=r.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE v='TimeZone=UTC')
   AND(NOT r.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 END LOOP;
 -- Public EXECUTE grants cannot turn invoker helpers into a privileged loader.
 FOR r IN SELECT * FROM(VALUES('owner()'),('hooks()'),('read(text,uuid)')) x(signature) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.shardkeep_charter_permit_'||r.signature)
   AND p.proowner=owner_id AND NOT p.prosecdef
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_permit_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;p public.charter_creation_funding_posts%ROWTYPE;source jsonb;
BEGIN
 PERFORM public.shardkeep_charter_permit_owner();
 IF TG_RELID NOT IN('public.charter_creation_permit_heads'::regclass,'public.charter_creation_permit_messages'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)) OR TG_WHEN<>'BEFORE'
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND(TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE')))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_permit_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=NEW.reservation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_SOURCE';END IF;
 IF TG_RELID='public.charter_creation_permit_heads'::regclass THEN
  -- Depth is only an additional origin fence. The authority is the actual
  -- canonical current-transaction funding and reservation, never caller fields.
  SELECT * INTO p FROM public.charter_creation_funding_posts WHERE ledger_id=r.reserve_transaction_id;
  IF pg_trigger_depth()<>2 OR p.ledger_id IS NULL OR p.tx_key<>pg_current_xact_id()::text
  OR EXISTS(SELECT 1 FROM public.charter_creation_permit_heads WHERE reservation_id=r.id)
  OR NOT public.shardkeep_charter_creation_money(r.reserve_transaction_id,true)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_SOURCE';END IF;
  BEGIN source:=public.shardkeep_charter_creation_read(r.payer,r.intent_id);
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_SOURCE';END;
  IF source IS NULL OR r.state<>'reserved' THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_SOURCE';END IF;
  NEW.commitment_version:=1;
  -- SQL's actual versioned JSONB UTF8 bytes are retained. Consumers hash these
  -- bytes and compare parsed fields, without assuming a JavaScript serializer.
  NEW.admission_preimage:=convert_to(jsonb_build_object('domain','SHARDKEEP_CHARTER_CREATION_ADMISSION','version',1,
   'consent',r.consent,'reserveTransactionId',r.reserve_transaction_id)::text,'UTF8');
  IF octet_length(NEW.admission_preimage)>16384 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_SOURCE';END IF;
  NEW.admission_commitment:=encode(sha256(NEW.admission_preimage),'hex');
 ELSE
  PERFORM public.shardkeep_charter_permit_read(NULL,r.intent_id);
  IF EXISTS(SELECT 1 FROM public.charter_creation_permit_messages WHERE reservation_id=r.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_CONFLICT';END IF;
  IF NEW.message_bytes IS NULL OR octet_length(NEW.message_bytes)<>161
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_INPUT';END IF;
  -- This is durable unsigned byte storage, not Solana/Keccak or signer proof.
  -- Every facade read and retry independently validates the entire message.
  NEW.message_sha256:=encode(sha256(NEW.message_bytes),'hex');
 END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_permit_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_charter_permit_owner();
 IF TG_RELID<>'public.charter_creation_reservations'::regclass OR TG_NAME<>'charter_creation_reservations_permit_capture'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_permit_hooks();
 INSERT INTO public.charter_creation_permit_heads(reservation_id) VALUES(NEW.id);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_permit_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_charter_permit_owner();
 IF TG_RELID<>'public.charter_creation_reservations'::regclass OR TG_NAME<>'charter_creation_reservations_permit_complete'
 OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_TRIGGER';END IF;
 -- A skipped head INSERT cannot leave money/reservation committed without
 -- prospective inventory. This check does not enroll any earlier reservation.
 PERFORM public.shardkeep_charter_permit_read(NEW.payer,NEW.intent_id);RETURN NULL;
END $$;
--> statement-breakpoint
DO $$DECLARE t text;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['charter_creation_permit_heads','charter_creation_permit_messages'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_permit_private()',t||'_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_permit_private()',t||'_no_truncate',t);END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_reservations'::regclass AND tgname='charter_creation_reservations_permit_capture') THEN
  CREATE TRIGGER charter_creation_reservations_permit_capture AFTER INSERT ON public.charter_creation_reservations
   FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_permit_capture();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_reservations'::regclass AND tgname='charter_creation_reservations_permit_complete') THEN
  CREATE CONSTRAINT TRIGGER charter_creation_reservations_permit_complete AFTER INSERT ON public.charter_creation_reservations
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_permit_complete();END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_permit_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
