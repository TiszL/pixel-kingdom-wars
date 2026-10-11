-- D153.190 original KEEP consent and once-only equipment delivery. HELD S5.
-- The table owner is the private verifier capability; SQL binds immutable terms
-- and stock effects, but does not authenticate RPC observations or Ed25519.
-- Frozen policy: PHASE_E_POLICY.taxes.keepMarket.sellerBps=9000/basisPoints=10000.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.keep_equipment_payment_preparations(
 fill_id uuid PRIMARY KEY REFERENCES public.keep_equipment_fills(id),
 preparation jsonb NOT NULL CHECK(jsonb_typeof(preparation)='object' AND octet_length(preparation::text)<=16384),
 message_bytes bytea NOT NULL CHECK(octet_length(message_bytes) BETWEEN 1 AND 1167),
 message_sha256 text NOT NULL CHECK(message_sha256~'^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE IF NOT EXISTS public.keep_equipment_payment_wires(
 fill_id uuid PRIMARY KEY REFERENCES public.keep_equipment_payment_preparations(fill_id),
 signed_transaction bytea NOT NULL CHECK(octet_length(signed_transaction) BETWEEN 66 AND 1232),
 signature text NOT NULL UNIQUE CHECK(signature~'^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
 wire_sha256 text NOT NULL UNIQUE CHECK(wire_sha256~'^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE IF NOT EXISTS public.keep_equipment_deliveries(
 fill_id uuid PRIMARY KEY REFERENCES public.keep_equipment_payment_wires(fill_id),
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=16384),
 delivered_at timestamptz NOT NULL CHECK(isfinite(delivered_at))
);
REVOKE ALL ON public.keep_equipment_payment_preparations,public.keep_equipment_payment_wires,public.keep_equipment_deliveries FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_payment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.keep_equipment_fills%ROWTYPE;l public.keep_equipment_listings%ROWTYPE;
 p public.keep_equipment_payment_preparations%ROWTYPE;w public.keep_equipment_payment_wires%ROWTYPE;
 a jsonb;o jsonb;r jsonb;sig bytea;n numeric:=0;encoded text:='';i integer;
 alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
BEGIN
 IF TG_RELID NOT IN('public.keep_equipment_payment_preparations'::regclass,'public.keep_equipment_payment_wires'::regclass,'public.keep_equipment_deliveries'::regclass)
  OR TG_WHEN<>'BEFORE' OR NOT((TG_NAME='keep_equipment_payment_guard' AND TG_LEVEL='ROW') OR (TG_NAME='keep_equipment_payment_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_READ_COMMITTED';END IF;
 SELECT * INTO STRICT f FROM public.keep_equipment_fills WHERE id=NEW.fill_id;
 SELECT * INTO STRICT l FROM public.keep_equipment_listings WHERE id=f.listing_id;
 IF TG_TABLE_NAME='keep_equipment_deliveries' THEN
  -- Paid obligations follow the frozen bases through transfer. These locks
  -- serialize stock and transfers without granting either old owner admission.
  PERFORM wallet FROM public.players WHERE wallet=ANY(ARRAY[f.buyer_wallet,l.seller_wallet]) ORDER BY wallet FOR UPDATE;
  PERFORM id FROM public.bases WHERE id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) ORDER BY id FOR UPDATE;
  PERFORM base_id FROM public.base_slots WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) ORDER BY base_id,wallet FOR UPDATE;
  PERFORM id FROM public.keep_equipment_listings WHERE id=l.id FOR UPDATE;
 END IF;
 PERFORM id FROM public.keep_equipment_fills WHERE id=f.id FOR UPDATE;
 IF TG_TABLE_NAME='keep_equipment_payment_preparations' THEN
  IF NEW.message_sha256 IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_DERIVED';END IF;
  a:=NEW.preparation;o:=a->'original';
  IF a->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(o) IS DISTINCT FROM 'object'
   OR o->>'reservationId' IS DISTINCT FROM f.id::text OR o->>'buyer' IS DISTINCT FROM f.buyer_wallet
   OR o->>'seller' IS DISTINCT FROM l.seller_wallet OR o->>'totalBaseUnits' IS DISTINCT FROM f.total_base_units::text
   OR o->>'keepMint' IS DISTINCT FROM a->>'expectedKeepMint'
   OR (o->>'keepMint'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
   OR (a->>'expectedGenesisHash'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
   OR jsonb_typeof(a->'minContextSlot') IS DISTINCT FROM 'number' OR (a->>'minContextSlot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
   OR (a->>'minContextSlot')::numeric>9007199254740991
   OR a->'minContextSlot' IS DISTINCT FROM a->'blockhashSlot'
   OR a->>'messageHex' IS DISTINCT FROM encode(NEW.message_bytes,'hex')
   OR a->>'messageSha256' IS DISTINCT FROM encode(sha256(NEW.message_bytes),'hex')
   OR a->'signingAuthorized' IS DISTINCT FROM 'false'::jsonb OR a->'broadcastAuthorized' IS DISTINCT FROM 'false'::jsonb
   OR a->'deliveryAuthorized' IS DISTINCT FROM 'false'::jsonb OR a->'fenceReleaseAuthorized' IS DISTINCT FROM 'false'::jsonb
   OR a->'unpaidProven' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_PREPARATION';END IF;
  NEW.message_sha256:=encode(sha256(NEW.message_bytes),'hex');NEW.recorded_at:=clock_timestamp();
 ELSE
  SELECT * INTO STRICT p FROM public.keep_equipment_payment_preparations WHERE fill_id=f.id;
  IF TG_TABLE_NAME='keep_equipment_payment_wires' THEN
   IF NEW.signature IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_DERIVED';END IF;
   IF octet_length(NEW.signed_transaction) NOT BETWEEN 66 AND 1232 OR get_byte(NEW.signed_transaction,0)<>1
    OR substring(NEW.signed_transaction FROM 66) IS DISTINCT FROM p.message_bytes
   THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_WIRE';END IF;
   sig:=substring(NEW.signed_transaction FROM 2 FOR 64);
   IF sig=decode(repeat('00',64),'hex') THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_WIRE';END IF;
   FOR i IN 0..63 LOOP n:=n*256+get_byte(sig,i);END LOOP;
   WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58);END LOOP;
   FOR i IN 0..63 LOOP EXIT WHEN get_byte(sig,i)<>0;encoded:='1'||encoded;END LOOP;
   NEW.signature:=encoded;NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.recorded_at:=clock_timestamp();
  ELSE
   IF NEW.delivered_at IS NOT NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_DERIVED';END IF;
   SELECT * INTO STRICT w FROM public.keep_equipment_payment_wires WHERE fill_id=f.id;
   a:=p.preparation;o:=a->'original';r:=NEW.proof;
   IF r->'version' IS DISTINCT FROM '1'::jsonb OR r->'finalizedAgreement' IS DISTINCT FROM 'true'::jsonb
    OR r->>'reservationId' IS DISTINCT FROM f.id::text OR r->>'signature' IS DISTINCT FROM w.signature
    OR r->>'buyer' IS DISTINCT FROM f.buyer_wallet OR r->>'seller' IS DISTINCT FROM l.seller_wallet
    OR r->>'keepMint' IS DISTINCT FROM o->>'keepMint' OR r->>'totalBaseUnits' IS DISTINCT FROM f.total_base_units::text
    OR r->>'messageSha256' IS DISTINCT FROM p.message_sha256 OR r->>'expectedGenesisHash' IS DISTINCT FROM a->>'expectedGenesisHash'
    OR r->'providerIds' IS DISTINCT FROM a->'providerIds'
    OR r->'fenceReleaseAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'unpaidProven' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(r->'slot') IS DISTINCT FROM 'number' OR (r->>'slot'~'^[1-9][0-9]*$') IS DISTINCT FROM true
    OR ((r->>'slot')::numeric BETWEEN (a->>'minContextSlot')::numeric AND 9007199254740991) IS DISTINCT FROM true
    OR jsonb_typeof(r->'sellerBaseUnits') IS DISTINCT FROM 'string' OR (r->>'sellerBaseUnits'~'^[1-9][0-9]{0,19}$') IS DISTINCT FROM true
    OR jsonb_typeof(r->'burnBaseUnits') IS DISTINCT FROM 'string' OR (r->>'burnBaseUnits'~'^[1-9][0-9]{0,19}$') IS DISTINCT FROM true
    OR (r->>'sellerBaseUnits')::numeric IS DISTINCT FROM div(f.total_base_units*9000,10000)
    OR (r->>'burnBaseUnits')::numeric IS DISTINCT FROM f.total_base_units-div(f.total_base_units*9000,10000)
   THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_PROOF';END IF;
   NEW.delivered_at:=clock_timestamp();
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_payment_guard() FROM PUBLIC;
--> statement-breakpoint
-- Only real inserts consume signatures/stock. Ignored INSERTs have no effect.
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_payment_effect()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.keep_equipment_fills%ROWTYPE;l public.keep_equipment_listings%ROWTYPE;sig text;
BEGIN
 IF TG_RELID NOT IN('public.keep_equipment_payment_wires'::regclass,'public.keep_equipment_deliveries'::regclass)
  OR TG_NAME<>'keep_equipment_payment_effect' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_OWNER' USING ERRCODE='42501';END IF;
 SELECT signature INTO STRICT sig FROM public.keep_equipment_payment_wires WHERE fill_id=NEW.fill_id;
 PERFORM public.shardkeep_claim_payment_signature(sig,'keep_equipment_market',NEW.fill_id);
 IF TG_TABLE_NAME='keep_equipment_deliveries' THEN
  SELECT * INTO STRICT f FROM public.keep_equipment_fills WHERE id=NEW.fill_id;
  SELECT * INTO STRICT l FROM public.keep_equipment_listings WHERE id=f.listing_id;
  PERFORM base_id FROM public.ordinary_equipment_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) AND item_id=l.item_id ORDER BY base_id FOR UPDATE;
  UPDATE public.ordinary_equipment_stocks SET market_outgoing=market_outgoing-f.quantity WHERE base_id=l.seller_base_id AND item_id=l.item_id AND market_outgoing>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CUSTODY';END IF;
  UPDATE public.ordinary_equipment_stocks SET market_incoming=market_incoming-f.quantity,available=available+f.quantity WHERE base_id=f.buyer_base_id AND item_id=l.item_id AND market_incoming>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CAPACITY';END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_payment_effect() FROM PUBLIC;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_payment_guard()',tab);
  EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_payment_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_equipment_payment_guard()',tab);
  IF tab<>'keep_equipment_payment_preparations' THEN
   EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_payment_effect AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_payment_effect()',tab);
  END IF;
 END LOOP;
END $$;
