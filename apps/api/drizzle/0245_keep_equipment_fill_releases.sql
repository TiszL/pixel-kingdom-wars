-- D153.190 exact-original failed / never-prepared reservation recovery. HELD S5.
-- The private table owner authenticates failure evidence; SQL binds that evidence
-- to one retained packet and atomically returns ordinary stock. No expiry proof.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.keep_equipment_fill_releases(
 fill_id uuid PRIMARY KEY REFERENCES public.keep_equipment_fills(id),
 reason text NOT NULL CHECK(reason IN('never_prepared','finalized_failed')),
 signature text REFERENCES public.keep_equipment_payment_wires(signature),
 proof jsonb CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=16384),
 released_at timestamptz NOT NULL CHECK(isfinite(released_at)),
 CHECK((reason='never_prepared' AND signature IS NULL AND proof IS NULL)
    OR (reason='finalized_failed' AND signature IS NOT NULL AND proof IS NOT NULL))
);
REVOKE ALL ON public.keep_equipment_fill_releases FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.keep_equipment_fills%ROWTYPE;l public.keep_equipment_listings%ROWTYPE;
 p public.keep_equipment_payment_preparations%ROWTYPE;w public.keep_equipment_payment_wires%ROWTYPE;r jsonb;
BEGIN
 IF TG_RELID<>'public.keep_equipment_fill_releases'::regclass OR TG_WHEN<>'BEFORE'
  OR NOT((TG_NAME='keep_equipment_release_guard' AND TG_LEVEL='ROW') OR (TG_NAME='keep_equipment_release_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_READ_COMMITTED';END IF;
 IF NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_DERIVED';END IF;
 SELECT * INTO STRICT f FROM public.keep_equipment_fills WHERE id=NEW.fill_id;
 SELECT * INTO STRICT l FROM public.keep_equipment_listings WHERE id=f.listing_id;
 -- Match historical delivery / transfer roots; current owners never redirect
 -- the original custody or gain permission to recover the buyer's payment.
 PERFORM wallet FROM public.players WHERE wallet=ANY(ARRAY[f.buyer_wallet,l.seller_wallet]) ORDER BY wallet FOR UPDATE;
 PERFORM id FROM public.bases WHERE id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) ORDER BY id FOR UPDATE;
 PERFORM base_id FROM public.base_slots WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) ORDER BY base_id,wallet FOR UPDATE;
 PERFORM id FROM public.keep_equipment_listings WHERE id=l.id FOR UPDATE;
 PERFORM id FROM public.keep_equipment_fills WHERE id=f.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.keep_equipment_deliveries WHERE fill_id=f.id) THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_DELIVERED';END IF;
 IF NEW.reason='never_prepared' THEN
  IF NEW.signature IS NOT NULL OR NEW.proof IS NOT NULL OR EXISTS(SELECT 1 FROM public.keep_equipment_payment_preparations WHERE fill_id=f.id)
  THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_PREPARED';END IF;
 ELSIF NEW.reason='finalized_failed' THEN
  SELECT * INTO p FROM public.keep_equipment_payment_preparations WHERE fill_id=f.id;
  SELECT * INTO w FROM public.keep_equipment_payment_wires WHERE fill_id=f.id;
  r:=NEW.proof;
  IF p.fill_id IS NULL OR w.fill_id IS NULL OR NEW.signature IS DISTINCT FROM w.signature
   OR r->'version' IS DISTINCT FROM '1'::jsonb OR r->'outcome' IS DISTINCT FROM '"failed"'::jsonb OR r->'finalizedAgreement' IS DISTINCT FROM 'true'::jsonb
   OR r->>'totalBaseUnits' IS DISTINCT FROM f.total_base_units::text
   OR r->'rentLamports' IS DISTINCT FROM '"0"'::jsonb OR r->'paidKeepBaseUnits' IS DISTINCT FROM '"0"'::jsonb
   OR jsonb_typeof(r->'error') IS NULL OR jsonb_typeof(r->'error') NOT IN('object','string') OR octet_length((r->'error')::text)>512
   OR r->'transactionVersion' IS DISTINCT FROM p.preparation->'transactionVersion'
   OR r->>'reservationId' IS DISTINCT FROM f.id::text OR r->>'signature' IS DISTINCT FROM w.signature
   OR r->>'messageSha256' IS DISTINCT FROM p.message_sha256 OR r->>'wireSha256' IS DISTINCT FROM w.wire_sha256
   OR r->>'buyer' IS DISTINCT FROM f.buyer_wallet OR r->>'seller' IS DISTINCT FROM l.seller_wallet
   OR r->>'keepMint' IS DISTINCT FROM p.preparation->>'expectedKeepMint'
   OR r->>'expectedGenesisHash' IS DISTINCT FROM p.preparation->>'expectedGenesisHash'
   OR r->'providerIds' IS DISTINCT FROM p.preparation->'providerIds'
   OR jsonb_typeof(r->'slot') IS DISTINCT FROM 'number' OR (r->>'slot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
   OR (r->>'slot')::numeric>9007199254740991 OR (r->>'slot')::numeric<(p.preparation->>'minContextSlot')::numeric
   OR jsonb_typeof(r->'feeLamports') IS DISTINCT FROM 'string'
   OR (r->>'feeLamports'~'^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (r->>'feeLamports')::numeric>18446744073709551615
   OR (r->>'evidenceSha256'~'^[0-9a-f]{64}$') IS DISTINCT FROM true
   OR r->'paymentAuthorized' IS DISTINCT FROM 'false'::jsonb
   OR r->'signingAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'broadcastAuthorized' IS DISTINCT FROM 'false'::jsonb
   OR r->'deliveryAuthorized' IS DISTINCT FROM 'false'::jsonb OR r->'fenceReleaseAuthorized' IS DISTINCT FROM 'false'::jsonb
   OR r->'unpaidProven' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_PROOF';END IF;
 ELSE RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_REASON';END IF;
 NEW.released_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_release_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_release_effect()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.keep_equipment_fills%ROWTYPE;l public.keep_equipment_listings%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.keep_equipment_fill_releases'::regclass OR TG_NAME<>'keep_equipment_release_effect' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_OWNER' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT f FROM public.keep_equipment_fills WHERE id=NEW.fill_id;
 SELECT * INTO STRICT l FROM public.keep_equipment_listings WHERE id=f.listing_id;
 -- Signature consumption is permanent, even for a positively failed payment.
 IF NEW.signature IS NOT NULL THEN PERFORM public.shardkeep_claim_payment_signature(NEW.signature,'keep_equipment_market',f.id);END IF;
 PERFORM base_id FROM public.ordinary_equipment_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) AND item_id=l.item_id ORDER BY base_id FOR UPDATE;
 UPDATE public.ordinary_equipment_stocks SET available=available+f.quantity,market_outgoing=market_outgoing-f.quantity
  WHERE base_id=l.seller_base_id AND item_id=l.item_id AND market_outgoing>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CUSTODY';END IF;
 UPDATE public.ordinary_equipment_stocks SET market_incoming=market_incoming-f.quantity
  WHERE base_id=f.buyer_base_id AND item_id=l.item_id AND market_incoming>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CAPACITY';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_release_effect() FROM PUBLIC;
CREATE OR REPLACE TRIGGER keep_equipment_release_guard BEFORE INSERT OR UPDATE OR DELETE ON public.keep_equipment_fill_releases FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_release_guard();
CREATE OR REPLACE TRIGGER keep_equipment_release_no_truncate BEFORE TRUNCATE ON public.keep_equipment_fill_releases FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_equipment_release_guard();
CREATE OR REPLACE TRIGGER keep_equipment_release_effect AFTER INSERT ON public.keep_equipment_fill_releases FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_release_effect();
--> statement-breakpoint
-- This sorts AFTER keep_equipment_payment_guard, whose fill lock (and, for
-- delivery, player/base/slot/listing locks) must remain the canonical order.
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_payment_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN('public.keep_equipment_payment_preparations'::regclass,'public.keep_equipment_payment_wires'::regclass,'public.keep_equipment_deliveries'::regclass)
  OR TG_NAME<>'keep_equipment_payment_release_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_READ_COMMITTED';END IF;
 PERFORM id FROM public.keep_equipment_fills WHERE id=NEW.fill_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.keep_equipment_fill_releases WHERE fill_id=NEW.fill_id) THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_FILL_RELEASED';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_payment_release_guard() FROM PUBLIC;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_payment_release_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_payment_release_guard()',tab);
 END LOOP;
END $$;
