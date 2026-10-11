-- D153.190 stable-base ordinary equipment custody. HELD S5: new triggers
-- consume/return existing equipment stock; no payment or delivery is admitted.
-- Frozen generated policy: PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits=1000000.
-- 9223372036854775807 and 18446744073709551615 are bigint/SPL representation bounds.
SET LOCAL lock_timeout='10s';
ALTER TABLE public.ordinary_equipment_stocks ADD COLUMN IF NOT EXISTS market_outgoing bigint NOT NULL DEFAULT 0;
ALTER TABLE public.ordinary_equipment_stocks ADD COLUMN IF NOT EXISTS market_incoming bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.ordinary_equipment_stocks'::regclass AND conname='ordinary_equipment_market_capacity') THEN
  ALTER TABLE public.ordinary_equipment_stocks ADD CONSTRAINT ordinary_equipment_market_capacity CHECK(
   market_outgoing>=0 AND market_incoming>=0 AND available::numeric+reserved::numeric+pending_output::numeric+market_outgoing::numeric+market_incoming::numeric<=9223372036854775807);
 END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.keep_equipment_listings(
 id uuid PRIMARY KEY,seller_wallet text NOT NULL REFERENCES public.players(wallet),seller_base_id uuid NOT NULL REFERENCES public.bases(id),
 item_id text NOT NULL CHECK(item_id IN('route_compass','survey_lens')),quantity bigint NOT NULL CHECK(quantity>0),
 unit_price_base_units numeric(20,0) NOT NULL CHECK(unit_price_base_units BETWEEN 1 AND 18446744073709551615),
 created_at timestamptz NOT NULL DEFAULT now() CHECK(isfinite(created_at))
);
CREATE TABLE IF NOT EXISTS public.keep_equipment_fills(
 id uuid PRIMARY KEY CHECK(id::text~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),listing_id uuid NOT NULL REFERENCES public.keep_equipment_listings(id),
 buyer_wallet text NOT NULL REFERENCES public.players(wallet),buyer_base_id uuid NOT NULL REFERENCES public.bases(id),
 quantity bigint NOT NULL CHECK(quantity>0),total_base_units numeric(20,0) NOT NULL CHECK(total_base_units BETWEEN 1000000 AND 18446744073709551615),
 created_at timestamptz NOT NULL DEFAULT now() CHECK(isfinite(created_at))
);
CREATE TABLE IF NOT EXISTS public.keep_equipment_listing_cancellations(
 id uuid PRIMARY KEY,listing_id uuid NOT NULL UNIQUE REFERENCES public.keep_equipment_listings(id),
 actor_wallet text NOT NULL REFERENCES public.players(wallet),quantity bigint NOT NULL CHECK(quantity>0),
 created_at timestamptz NOT NULL DEFAULT now() CHECK(isfinite(created_at))
);
CREATE INDEX IF NOT EXISTS keep_equipment_listings_seller ON public.keep_equipment_listings(seller_wallet,created_at,id);
CREATE INDEX IF NOT EXISTS keep_equipment_fills_listing ON public.keep_equipment_fills(listing_id);
CREATE INDEX IF NOT EXISTS keep_equipment_fills_buyer ON public.keep_equipment_fills(buyer_wallet,created_at,id);
REVOKE ALL ON public.keep_equipment_listings,public.keep_equipment_fills,public.keep_equipment_listing_cancellations FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_market_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE offer public.keep_equipment_listings%ROWTYPE;actor text;source_id uuid;wallets text[];base_ids uuid[];remaining numeric;
BEGIN
 IF TG_RELID NOT IN('public.keep_equipment_listings'::regclass,'public.keep_equipment_fills'::regclass,'public.keep_equipment_listing_cancellations'::regclass)
  OR TG_WHEN<>'BEFORE' OR NOT((TG_NAME='keep_equipment_market_guard' AND TG_LEVEL='ROW') OR (TG_NAME='keep_equipment_market_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.keep_equipment_listings'::regclass)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_OWNER' USING ERRCODE='42501';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_IMMUTABLE';END IF;
 -- The immutable listing row serializes writers but cannot advance an older
 -- REPEATABLE READ aggregate snapshot. Never admit against stale fill totals.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_ISOLATION';END IF;
 IF TG_TABLE_NAME='keep_equipment_listings' THEN
  actor:=NEW.seller_wallet;source_id:=NEW.seller_base_id;wallets:=ARRAY[actor];base_ids:=ARRAY[source_id];
 ELSE
  SELECT * INTO offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;
  IF offer.id IS NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_NOT_FOUND';END IF;
  source_id:=offer.seller_base_id;
  IF TG_TABLE_NAME='keep_equipment_fills' THEN
   actor:=NEW.buyer_wallet;wallets:=ARRAY[actor,offer.seller_wallet];base_ids:=ARRAY[source_id,NEW.buyer_base_id];
  ELSE actor:=NEW.actor_wallet;wallets:=ARRAY[actor];base_ids:=ARRAY[source_id];END IF;
 END IF;
 -- Same canonical roots as transfers and the services: every player, every
 -- base, then slots, then the listing. No listing -> player/base inversion.
 PERFORM wallet FROM public.players WHERE wallet=ANY(wallets) ORDER BY wallet FOR UPDATE;
 PERFORM id FROM public.bases WHERE id=ANY(base_ids) ORDER BY id FOR UPDATE;
 PERFORM base_id FROM public.base_slots WHERE base_id=ANY(base_ids) ORDER BY base_id,wallet FOR UPDATE;
 PERFORM base_id FROM public.base_raid_locks WHERE base_id=ANY(base_ids) ORDER BY base_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=ANY(base_ids)) THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_RAID';END IF;
 IF TG_TABLE_NAME='keep_equipment_fills' THEN
  IF actor=offer.seller_wallet OR NEW.buyer_base_id=source_id
   OR NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id
    WHERE b.id=source_id AND b.owner_wallet=offer.seller_wallet AND b.status='active' AND b.land_paid_at IS NOT NULL AND b.deed_asset_id IS NOT NULL
     AND s.wallet=offer.seller_wallet AND s.active)
   OR NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id
    WHERE b.id=NEW.buyer_base_id AND b.owner_wallet=actor AND b.status='active' AND b.land_paid_at IS NOT NULL AND b.deed_asset_id IS NOT NULL
     AND s.wallet=actor AND s.active)
  THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_AUTHORITY';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id
   WHERE b.id=source_id AND b.owner_wallet=actor AND b.status='active' AND b.land_paid_at IS NOT NULL AND b.deed_asset_id IS NOT NULL AND s.wallet=actor AND s.active)
  THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_AUTHORITY';END IF;
 END IF;
 IF TG_TABLE_NAME<>'keep_equipment_listings' THEN
  SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id FOR UPDATE;
  IF NEW.created_at<offer.created_at THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_TERMS';END IF;
  SELECT offer.quantity::numeric-coalesce((SELECT sum(quantity::numeric) FROM public.keep_equipment_fills WHERE listing_id=offer.id),0)
   -coalesce((SELECT sum(quantity::numeric) FROM public.keep_equipment_listing_cancellations WHERE listing_id=offer.id),0) INTO remaining;
  IF remaining<=0 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE';END IF;
  IF TG_TABLE_NAME='keep_equipment_fills' THEN
   IF EXISTS(SELECT 1 FROM public.keep_equipment_listing_cancellations WHERE listing_id=offer.id) THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE';END IF;
   IF NEW.quantity>remaining THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE';END IF;
   IF NEW.total_base_units IS NOT NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_TERMS';END IF;
   NEW.total_base_units:=offer.unit_price_base_units*NEW.quantity::numeric;
   IF NEW.total_base_units<1000000 OR NEW.total_base_units>18446744073709551615 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_PRICE';END IF;
  ELSE
   IF NEW.quantity IS NOT NULL THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_TERMS';END IF;
   NEW.quantity:=remaining::bigint;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_market_guard() FROM PUBLIC;
--> statement-breakpoint
-- Stock effects run AFTER a real insertion: an ignored ON CONFLICT insert can
-- never debit a phantom listing or return unsold stock without its receipt.
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_market_stock()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE offer public.keep_equipment_listings%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.keep_equipment_listings'::regclass,'public.keep_equipment_fills'::regclass,'public.keep_equipment_listing_cancellations'::regclass)
  OR TG_NAME<>'keep_equipment_market_stock' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.keep_equipment_listings'::regclass)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_OWNER' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='keep_equipment_listings' THEN
  UPDATE public.ordinary_equipment_stocks SET available=available-NEW.quantity,market_outgoing=market_outgoing+NEW.quantity
   WHERE base_id=NEW.seller_base_id AND item_id=NEW.item_id AND available>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_STOCK';END IF;
 ELSIF TG_TABLE_NAME='keep_equipment_fills' THEN
  SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;
  INSERT INTO public.ordinary_equipment_stocks(base_id,item_id) VALUES(NEW.buyer_base_id,offer.item_id) ON CONFLICT DO NOTHING;
  UPDATE public.ordinary_equipment_stocks SET market_incoming=market_incoming+NEW.quantity
   WHERE base_id=NEW.buyer_base_id AND item_id=offer.item_id
    AND available::numeric+reserved::numeric+pending_output::numeric+market_outgoing::numeric+market_incoming::numeric+NEW.quantity::numeric<=9223372036854775807;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_CAPACITY';END IF;
 ELSE
  SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;
  UPDATE public.ordinary_equipment_stocks SET available=available+NEW.quantity,market_outgoing=market_outgoing-NEW.quantity
   WHERE base_id=offer.seller_base_id AND item_id=offer.item_id
    AND market_outgoing>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_CAPACITY';END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_equipment_market_stock() FROM PUBLIC;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_market_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_market_guard()',tab);
  EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_market_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_equipment_market_guard()',tab);
  EXECUTE format('CREATE OR REPLACE TRIGGER keep_equipment_market_stock AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_equipment_market_stock()',tab);
 END LOOP;
END $$;
