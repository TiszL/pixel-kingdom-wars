-- D153.194 crafting materials market custody. Prospective, HELD S5.
-- Frozen item identity projection: shared phaseEOrdinaryCrafting / keepEquipmentMarketApi.
-- No source issuance, recipe/tax change or independent payment rail.
SET LOCAL lock_timeout='10s';
ALTER TABLE public.crafting_stocks ADD COLUMN IF NOT EXISTS market_outgoing bigint NOT NULL DEFAULT 0;
ALTER TABLE public.crafting_stocks ADD COLUMN IF NOT EXISTS market_incoming bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.crafting_stocks'::regclass AND conname='crafting_market_capacity_ck') THEN
  ALTER TABLE public.crafting_stocks ADD CONSTRAINT crafting_market_capacity_ck CHECK(market_outgoing>=0 AND market_incoming>=0 AND available::numeric+pending_output::numeric+market_outgoing::numeric+market_incoming::numeric<=9223372036854775807);
 END IF;
END $$;
ALTER TABLE public.keep_equipment_listings DROP CONSTRAINT IF EXISTS keep_equipment_listings_item_id_check;
ALTER TABLE public.keep_equipment_listings ADD CONSTRAINT keep_equipment_listings_item_id_check CHECK(item_id IN('route_compass','survey_lens','frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_equipment_market_stock()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE offer public.keep_equipment_listings%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.keep_equipment_listings'::regclass,'public.keep_equipment_fills'::regclass,'public.keep_equipment_listing_cancellations'::regclass)
  OR TG_NAME<>'keep_equipment_market_stock' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.keep_equipment_listings'::regclass)
 THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_OWNER' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='keep_equipment_listings' THEN SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.id;
 ELSE SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;END IF;
 IF offer.item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit') THEN
 IF TG_TABLE_NAME='keep_equipment_listings' THEN
  UPDATE public.crafting_stocks SET available=available-NEW.quantity,market_outgoing=market_outgoing+NEW.quantity
   WHERE base_id=NEW.seller_base_id AND item_id=NEW.item_id AND available>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_STOCK';END IF;
 ELSIF TG_TABLE_NAME='keep_equipment_fills' THEN
  SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;
  INSERT INTO public.crafting_stocks(base_id,item_id,market_incoming) VALUES(NEW.buyer_base_id,offer.item_id,NEW.quantity)
   ON CONFLICT(base_id,item_id) DO UPDATE SET market_incoming=crafting_stocks.market_incoming+NEW.quantity
    WHERE crafting_stocks.available::numeric+crafting_stocks.pending_output::numeric+crafting_stocks.market_outgoing::numeric+crafting_stocks.market_incoming::numeric+NEW.quantity::numeric<=9223372036854775807;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_CAPACITY';END IF;
 ELSE
  SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;
  UPDATE public.crafting_stocks SET available=available+NEW.quantity,market_outgoing=market_outgoing-NEW.quantity
   WHERE base_id=offer.seller_base_id AND item_id=offer.item_id
    AND market_outgoing>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_CAPACITY';END IF;
 END IF;
 ELSE
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
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
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
  IF l.item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit') THEN
 PERFORM base_id FROM public.crafting_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) AND item_id=l.item_id ORDER BY base_id FOR UPDATE;
  UPDATE public.crafting_stocks SET market_outgoing=market_outgoing-f.quantity WHERE base_id=l.seller_base_id AND item_id=l.item_id AND market_outgoing>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CUSTODY';END IF;
  UPDATE public.crafting_stocks SET market_incoming=market_incoming-f.quantity,available=available+f.quantity WHERE base_id=f.buyer_base_id AND item_id=l.item_id AND market_incoming>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CAPACITY';END IF;
 ELSE
 PERFORM base_id FROM public.ordinary_equipment_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) AND item_id=l.item_id ORDER BY base_id FOR UPDATE;
  UPDATE public.ordinary_equipment_stocks SET market_outgoing=market_outgoing-f.quantity WHERE base_id=l.seller_base_id AND item_id=l.item_id AND market_outgoing>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CUSTODY';END IF;
  UPDATE public.ordinary_equipment_stocks SET market_incoming=market_incoming-f.quantity,available=available+f.quantity WHERE base_id=f.buyer_base_id AND item_id=l.item_id AND market_incoming>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CAPACITY';END IF;
 END IF;
 END IF;
 RETURN NULL;
END $$;
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
 IF l.item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit') THEN
 PERFORM base_id FROM public.crafting_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) AND item_id=l.item_id ORDER BY base_id FOR UPDATE;
 UPDATE public.crafting_stocks SET available=available+f.quantity,market_outgoing=market_outgoing-f.quantity
  WHERE base_id=l.seller_base_id AND item_id=l.item_id AND market_outgoing>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CUSTODY';END IF;
 UPDATE public.crafting_stocks SET market_incoming=market_incoming-f.quantity
  WHERE base_id=f.buyer_base_id AND item_id=l.item_id AND market_incoming>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CAPACITY';END IF;
 ELSE
 PERFORM base_id FROM public.ordinary_equipment_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) AND item_id=l.item_id ORDER BY base_id FOR UPDATE;
 UPDATE public.ordinary_equipment_stocks SET available=available+f.quantity,market_outgoing=market_outgoing-f.quantity
  WHERE base_id=l.seller_base_id AND item_id=l.item_id AND market_outgoing>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CUSTODY';END IF;
 UPDATE public.ordinary_equipment_stocks SET market_incoming=market_incoming-f.quantity
  WHERE base_id=f.buyer_base_id AND item_id=l.item_id AND market_incoming>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CAPACITY';END IF;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint

-- Holds are a projection of permanent market rows. Check AFTER real effects,
-- including INSERT ON CONFLICT, so ignored inserts cannot create or clear holds.
CREATE OR REPLACE FUNCTION public.shardkeep_crafting_market_stock_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE outgoing numeric;incoming numeric;
BEGIN
 IF TG_RELID<>'public.crafting_stocks'::regclass OR TG_WHEN<>'AFTER'
  OR NOT((TG_NAME='crafting_market_stock_guard' AND TG_LEVEL='ROW') OR (TG_NAME='crafting_market_stock_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
 THEN RAISE EXCEPTION 'CRAFTING_MARKET_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.keep_equipment_listings WHERE item_id NOT IN('route_compass','survey_lens')) THEN RAISE EXCEPTION 'CRAFTING_MARKET_IMMUTABLE';END IF;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.base_id IS DISTINCT FROM OLD.base_id OR NEW.item_id IS DISTINCT FROM OLD.item_id) THEN RAISE EXCEPTION 'CRAFTING_MARKET_IDENTITY';END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.market_outgoing<>0 OR OLD.market_incoming<>0 THEN RAISE EXCEPTION 'CRAFTING_MARKET_IMMUTABLE';END IF;
  RETURN NULL;
 END IF;
 SELECT coalesce(sum(l.quantity::numeric
  -coalesce((SELECT sum(c.quantity::numeric) FROM public.keep_equipment_listing_cancellations c WHERE c.listing_id=l.id),0)
  -coalesce((SELECT sum(f.quantity::numeric) FROM public.keep_equipment_fills f WHERE f.listing_id=l.id AND (EXISTS(SELECT 1 FROM public.keep_equipment_deliveries d WHERE d.fill_id=f.id) OR EXISTS(SELECT 1 FROM public.keep_equipment_fill_releases r WHERE r.fill_id=f.id))),0)),0)
 INTO outgoing FROM public.keep_equipment_listings l WHERE l.seller_base_id=NEW.base_id AND l.item_id=NEW.item_id;
 SELECT coalesce(sum(f.quantity::numeric),0) INTO incoming FROM public.keep_equipment_fills f JOIN public.keep_equipment_listings l ON l.id=f.listing_id
 WHERE f.buyer_base_id=NEW.base_id AND l.item_id=NEW.item_id AND NOT EXISTS(SELECT 1 FROM public.keep_equipment_deliveries d WHERE d.fill_id=f.id) AND NOT EXISTS(SELECT 1 FROM public.keep_equipment_fill_releases r WHERE r.fill_id=f.id);
 IF NEW.market_outgoing::numeric IS DISTINCT FROM outgoing OR NEW.market_incoming::numeric IS DISTINCT FROM incoming THEN RAISE EXCEPTION 'CRAFTING_MARKET_HOLD_CONSERVATION';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_crafting_market_stock_guard() FROM PUBLIC;
CREATE OR REPLACE TRIGGER crafting_market_stock_guard AFTER INSERT OR UPDATE OR DELETE ON public.crafting_stocks FOR EACH ROW EXECUTE FUNCTION public.shardkeep_crafting_market_stock_guard();
CREATE OR REPLACE TRIGGER crafting_market_stock_no_truncate AFTER TRUNCATE ON public.crafting_stocks FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_crafting_market_stock_guard();
