-- D153.180 append-only detached Charter consent. No new SQL signing authority.
-- Real Ed25519 checks belong to the owner store and unchanged full-wire verifier;
-- SQL binds every retained byte to the original attempt and its complete wire.
SET LOCAL lock_timeout='10s';
DO $$BEGIN
 IF to_regclass('public.charter_sale_contributions') IS NOT NULL
  AND obj_description(to_regclass('public.charter_sale_contributions'),'pg_class') IS DISTINCT FROM 'D153.180 charter-contributions-v1'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA';END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.charter_sale_contributions(
 sale_id uuid NOT NULL REFERENCES public.charter_sale_preparations(sale_id),
 attempt_id uuid NOT NULL REFERENCES public.charter_sale_attempts(id),actor_wallet text NOT NULL,
 message_sha256 text NOT NULL CHECK(message_sha256 ~ '^[0-9a-f]{64}$'),
 signature_bytes bytea NOT NULL CHECK(octet_length(signature_bytes)=64),
 tx_key text NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 PRIMARY KEY(sale_id,attempt_id,actor_wallet),UNIQUE(sale_id,actor_wallet)
);
-- Compare literal shape, constraints and FK identities before accepting replay.
DO $$DECLARE shadow text:='charter_contribution_shape_'||replace(gen_random_uuid()::text,'-','');actual jsonb;expected jsonb;fk record;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.charter_sale_contributions'::regclass AND relkind='r'
  AND relpersistence='p' AND relowner=current_user::regrole::oid AND NOT relrowsecurity AND NOT relforcerowsecurity)
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid='public.charter_sale_contributions'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA';END IF;
 EXECUTE format($shape$CREATE TEMPORARY TABLE %I(
  sale_id uuid NOT NULL,attempt_id uuid NOT NULL,actor_wallet text NOT NULL,
  message_sha256 text NOT NULL CHECK(message_sha256 ~ '^[0-9a-f]{64}$'),
  signature_bytes bytea NOT NULL CHECK(octet_length(signature_bytes)=64),
  tx_key text NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
  PRIMARY KEY(sale_id,attempt_id,actor_wallet),UNIQUE(sale_id,actor_wallet)) ON COMMIT DROP$shape$,shadow);
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
  a.attcollation,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.charter_sale_contributions'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
  a.attcollation,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO expected
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=to_regclass('pg_temp.'||shadow) AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA';END IF;
 SELECT jsonb_agg(v ORDER BY v::text) INTO actual FROM(SELECT jsonb_build_array(q.contype,q.conkey,q.condeferrable,q.condeferred,q.convalidated,
  CASE WHEN q.contype='c' THEN pg_get_constraintdef(q.oid) ELSE NULL END) v FROM pg_constraint q
  WHERE q.conrelid='public.charter_sale_contributions'::regclass AND q.contype NOT IN('f','t')) fields;
 SELECT jsonb_agg(v ORDER BY v::text) INTO expected FROM(SELECT jsonb_build_array(q.contype,q.conkey,q.condeferrable,q.condeferred,q.convalidated,
  CASE WHEN q.contype='c' THEN pg_get_constraintdef(q.oid) ELSE NULL END) v FROM pg_constraint q
  WHERE q.conrelid=to_regclass('pg_temp.'||shadow)) fields;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA';END IF;
 IF(SELECT count(*) FROM pg_constraint WHERE conrelid='public.charter_sale_contributions'::regclass AND contype='f')<>2
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA';END IF;
 FOR fk IN SELECT * FROM(VALUES('sale_id','charter_sale_preparations','sale_id'),('attempt_id','charter_sale_attempts','id')) f(col,tab,target_col) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint q WHERE q.conrelid='public.charter_sale_contributions'::regclass AND q.contype='f'
   AND q.confrelid=to_regclass('public.'||fk.tab)
   AND q.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=q.conrelid AND attname=fk.col)]::smallint[]
   AND q.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=q.confrelid AND attname=fk.target_col)]::smallint[]
   AND q.confupdtype='a' AND q.confdeltype='a' AND q.confmatchtype='s' AND NOT q.condeferrable AND NOT q.condeferred AND q.convalidated)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA';END IF;
 END LOOP;
 EXECUTE format('DROP TABLE pg_temp.%I',shadow);
END $$;
COMMENT ON TABLE public.charter_sale_contributions IS 'D153.180 charter-contributions-v1';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_contributions_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE v record;owner_id oid;BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_sales'::regclass;
 FOR v IN SELECT * FROM(VALUES
  ('charter_sale_contributions','charter_sale_contributions_guard','shardkeep_charter_contributions_guard',31,false),
  ('charter_sale_contributions','charter_sale_contributions_no_truncate','shardkeep_charter_contributions_guard',34,false),
  ('charter_sale_wires','charter_sale_wires_contribution_guard','shardkeep_charter_contributions_guard',31,false),
  ('charter_sale_terminals','charter_sale_terminals_contribution_guard','shardkeep_charter_contributions_guard',31,false),
  ('charter_sale_contributions','charter_sale_contributions_complete','shardkeep_charter_contributions_complete',29,true),
  ('charter_sale_wires','charter_sale_wires_contribution_complete','shardkeep_charter_contributions_complete',29,true),
  ('charter_sale_terminals','charter_sale_terminals_contribution_complete','shardkeep_charter_contributions_complete',29,true)
 ) f(tab,name,fn,typ,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=('public.'||v.tab)::regclass AND t.tgname=v.name
   AND t.tgtype=v.typ AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname=v.fn AND p.pronargs=0 AND p.proowner=owner_id AND c.relowner=owner_id
   AND NOT p.prosecdef AND t.tgdeferrable=v.deferred AND t.tginitdeferred=v.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) cfg WHERE replace(cfg,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT v.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE';END IF;
 END LOOP;
END $$;
-- Rechecked at both mutation sides and again at commit. Passing a prospective
-- wire handles BEFORE INSERT without exposing a caller capability or GUC.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_contributions_check(sid uuid,prospective_wire jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;a public.charter_sale_attempts%ROWTYPE;p public.charter_sale_preparations%ROWTYPE;
 c public.charter_sale_contributions%ROWTYPE;w jsonb;message bytea;wire bytea;n integer:=0;BEGIN
 PERFORM public.shardkeep_charter_contributions_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 IF s.id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE';END IF;
 SELECT * INTO a FROM public.charter_sale_attempts WHERE sale_id=sid;
 SELECT * INTO p FROM public.charter_sale_preparations WHERE sale_id=sid;
 w:=prospective_wire;IF w IS NULL THEN SELECT record INTO w FROM public.charter_sale_wires WHERE sale_id=sid;END IF;
 message:=decode(p.record->'packet'->>'messageHex','hex');
 IF w IS NOT NULL THEN
  wire:=decode(w->>'signedTransactionHex','hex');
  IF message IS NULL OR octet_length(wire)<>129+octet_length(message) OR get_byte(wire,0)<>2
   OR substring(wire FROM 130) IS DISTINCT FROM message
   OR w->>'messageSha256' IS DISTINCT FROM encode(sha256(message),'hex')
   OR w->>'wireSha256' IS DISTINCT FROM encode(sha256(wire),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE';END IF;
 END IF;
 FOR c IN SELECT * FROM public.charter_sale_contributions WHERE sale_id=sid LOOP
  n:=n+1;
  IF a.id IS NULL OR p.sale_id IS NULL OR c.attempt_id IS DISTINCT FROM a.id OR c.actor_wallet NOT IN(s.buyer,s.seller)
   OR c.message_sha256 IS DISTINCT FROM encode(sha256(message),'hex') OR octet_length(c.signature_bytes)<>64
   OR(wire IS NOT NULL AND c.signature_bytes IS DISTINCT FROM substring(wire FROM CASE WHEN c.actor_wallet=s.buyer THEN 2 ELSE 66 END FOR 64))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE';END IF;
 END LOOP;
 IF n>2 OR(n=2 AND wire IS NULL) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_contributions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;a public.charter_sale_attempts%ROWTYPE;p public.charter_sale_preparations%ROWTYPE;w bytea;BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_WHEN<>'BEFORE'
  OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_TABLE_NAME='charter_sale_contributions' THEN CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END ELSE '_contribution_guard' END)
  OR TG_TABLE_NAME NOT IN('charter_sale_contributions','charter_sale_wires','charter_sale_terminals')
  OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_contributions_hooks();
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_IMMUTABLE';END IF;
 SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
 IF TG_TABLE_NAME='charter_sale_wires' THEN PERFORM public.shardkeep_charter_contributions_check(NEW.sale_id,NEW.record);RETURN NEW;END IF;
 PERFORM public.shardkeep_charter_contributions_check(NEW.sale_id);
 IF TG_TABLE_NAME='charter_sale_terminals' THEN RETURN NEW;END IF;
 SELECT * INTO a FROM public.charter_sale_attempts WHERE sale_id=NEW.sale_id;
 SELECT * INTO p FROM public.charter_sale_preparations WHERE sale_id=NEW.sale_id;
 SELECT decode(record->>'signedTransactionHex','hex') INTO w FROM public.charter_sale_wires WHERE sale_id=NEW.sale_id;
 IF a.id IS NULL OR p.sale_id IS NULL OR NEW.attempt_id IS DISTINCT FROM a.id OR NEW.actor_wallet NOT IN(s.buyer,s.seller)
  OR NEW.message_sha256 IS DISTINCT FROM encode(sha256(decode(p.record->'packet'->>'messageHex','hex')),'hex')
  OR NEW.signature_bytes IS NULL OR octet_length(NEW.signature_bytes)<>64
  OR(w IS NOT NULL AND NEW.signature_bytes IS DISTINCT FROM substring(w FROM CASE WHEN NEW.actor_wallet=s.buyer THEN 2 ELSE 66 END FOR 64))
  OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE';END IF;
 NEW.tx_key:=pg_current_xact_id()::text;NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_contributions_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
  OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_TABLE_NAME='charter_sale_contributions' THEN '_complete' ELSE '_contribution_complete' END)
  OR TG_TABLE_NAME NOT IN('charter_sale_contributions','charter_sale_wires','charter_sale_terminals')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONTRIBUTION_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_contributions_check(CASE WHEN TG_OP='DELETE' THEN OLD.sale_id ELSE NEW.sale_id END);RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_contributions_read(actor text,sid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;original jsonb;rows jsonb;BEGIN
 PERFORM public.shardkeep_charter_contributions_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 IF s.id IS NULL OR actor NOT IN(s.seller,s.buyer) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 original:=public.shardkeep_charter_sale_read(actor,sid);PERFORM public.shardkeep_charter_contributions_check(sid);
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',actor_wallet,'attemptId',attempt_id,'messageSha256',message_sha256,
  'signature',replace(encode(signature_bytes,'base64'),E'\n','')) ORDER BY CASE WHEN actor_wallet=s.buyer THEN 0 ELSE 1 END),'[]'::jsonb)
  INTO rows FROM public.charter_sale_contributions WHERE sale_id=sid;
 RETURN jsonb_build_object('state',original,'contributions',rows);
END $$;
--> statement-breakpoint
DO $$DECLARE t record;fn record;BEGIN
 REVOKE ALL ON public.charter_sale_contributions FROM PUBLIC;
 FOR t IN SELECT * FROM(VALUES
  ('charter_sale_contributions','charter_sale_contributions_guard','BEFORE INSERT OR UPDATE OR DELETE','ROW','shardkeep_charter_contributions_guard',false),
  ('charter_sale_contributions','charter_sale_contributions_no_truncate','BEFORE TRUNCATE','STATEMENT','shardkeep_charter_contributions_guard',false),
  ('charter_sale_wires','charter_sale_wires_contribution_guard','BEFORE INSERT OR UPDATE OR DELETE','ROW','shardkeep_charter_contributions_guard',false),
  ('charter_sale_terminals','charter_sale_terminals_contribution_guard','BEFORE INSERT OR UPDATE OR DELETE','ROW','shardkeep_charter_contributions_guard',false),
  ('charter_sale_contributions','charter_sale_contributions_complete','AFTER INSERT OR UPDATE OR DELETE','ROW','shardkeep_charter_contributions_complete',true),
  ('charter_sale_wires','charter_sale_wires_contribution_complete','AFTER INSERT OR UPDATE OR DELETE','ROW','shardkeep_charter_contributions_complete',true),
  ('charter_sale_terminals','charter_sale_terminals_contribution_complete','AFTER INSERT OR UPDATE OR DELETE','ROW','shardkeep_charter_contributions_complete',true)
 ) v(tab,name,event,level,fn,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||t.tab) AND tgname=t.name) THEN
   EXECUTE format('CREATE %s TRIGGER %I %s ON public.%I %s FOR EACH %s EXECUTE FUNCTION public.%I()',
    CASE WHEN t.deferred THEN 'CONSTRAINT' ELSE '' END,t.name,t.event,t.tab,CASE WHEN t.deferred THEN 'DEFERRABLE INITIALLY DEFERRED' ELSE '' END,t.level,t.fn);
  END IF;
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_contributions_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
 PERFORM public.shardkeep_charter_contributions_hooks();
END $$;
