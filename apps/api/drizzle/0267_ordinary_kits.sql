-- GENERATED D153.208 immutable recipe2 projection from shared constants.
-- Additive local successor. Existing recipes, fee rails and old seals stay frozen.
SET LOCAL lock_timeout='10s';
ALTER TABLE public.crafting_stocks DROP CONSTRAINT IF EXISTS crafting_stocks_item_id_check;
ALTER TABLE public.crafting_stocks ADD CONSTRAINT crafting_stocks_item_id_check CHECK(item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit','climate_kit','expedition_kit'));
ALTER TABLE public.keep_equipment_listings DROP CONSTRAINT IF EXISTS keep_equipment_listings_item_id_check;
ALTER TABLE public.keep_equipment_listings ADD CONSTRAINT keep_equipment_listings_item_id_check CHECK(item_id IN('route_compass','survey_lens','frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit','crystal_fragment','climate_kit','expedition_kit'));
ALTER TABLE public.ordinary_crafting_inputs ADD COLUMN IF NOT EXISTS shards_ledger_txn_id uuid UNIQUE REFERENCES public.ledger_transactions(id);
ALTER TABLE public.ordinary_crafting_inputs DROP CONSTRAINT IF EXISTS ordinary_crafting_input_ck;
ALTER TABLE public.ordinary_crafting_inputs ADD CONSTRAINT ordinary_crafting_input_ck CHECK(position>=0 AND quantity>0 AND
 ((kind='raw' AND reserve_operation_id IS NOT NULL AND consume_operation_id IS NOT NULL AND reserve_operation_id<>consume_operation_id AND shards_ledger_txn_id IS NULL)
 OR(kind='crafting' AND reserve_operation_id IS NULL AND consume_operation_id IS NULL AND shards_ledger_txn_id IS NULL)
 OR(kind='shards' AND item_id='shards' AND reserve_operation_id IS NULL AND consume_operation_id IS NULL AND shards_ledger_txn_id IS NOT NULL)));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE unit jsonb; expected jsonb; job public.ordinary_crafting_jobs%ROWTYPE; custody text;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'ordinary crafting history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='ordinary_crafting_jobs' THEN
   IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
    AND to_jsonb(OLD)-'completed_at'=to_jsonb(NEW)-'completed_at' THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'ordinary crafting history is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='ordinary_crafting_jobs' THEN
  IF NEW.recipe_version=2 THEN
   IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_OWNER' USING ERRCODE='42501';END IF;
   unit := '{"refine_frostglass":{"recipeVersion":2,"recipeId":"refine_frostglass","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"frost_quartz","quantity":"10"}],"output":{"itemId":"frostglass","quantity":"1"}},"refine_heartwood_beams":{"recipeVersion":2,"recipeId":"refine_heartwood_beams","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"heartwood_logs","quantity":"10"}],"output":{"itemId":"heartwood_beams","quantity":"1"}},"refine_sunstone_blocks":{"recipeVersion":2,"recipeId":"refine_sunstone_blocks","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"sunstone_rubble","quantity":"10"}],"output":{"itemId":"sunstone_blocks","quantity":"1"}},"refine_crownsteel":{"recipeVersion":2,"recipeId":"refine_crownsteel","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"crown_iron_ore","quantity":"10"}],"output":{"itemId":"crownsteel","quantity":"1"}},"refine_prismstone_lens":{"recipeVersion":2,"recipeId":"refine_prismstone_lens","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"rough_prism","quantity":"10"}],"output":{"itemId":"prismstone_lens","quantity":"1"}},"refine_stormalloy":{"recipeVersion":2,"recipeId":"refine_stormalloy","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"storm_ore","quantity":"10"}],"output":{"itemId":"stormalloy","quantity":"1"}},"refine_thornsilk":{"recipeVersion":2,"recipeId":"refine_thornsilk","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"thorn_fibre","quantity":"10"}],"output":{"itemId":"thornsilk","quantity":"1"}},"refine_embercore":{"recipeVersion":2,"recipeId":"refine_embercore","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"ember_nodules","quantity":"10"}],"output":{"itemId":"embercore","quantity":"1"}},"craft_navigation_kit":{"recipeVersion":2,"recipeId":"craft_navigation_kit","quantity":1,"durationSec":120,"inputs":[{"kind":"crafting","itemId":"prismstone_lens","quantity":"1"},{"kind":"crafting","itemId":"frostglass","quantity":"1"}],"output":{"itemId":"navigation_kit","quantity":"1"}},"craft_climate_kit":{"recipeVersion":2,"recipeId":"craft_climate_kit","quantity":1,"durationSec":120,"inputs":[{"kind":"crafting","itemId":"sunstone_blocks","quantity":"1"},{"kind":"crafting","itemId":"embercore","quantity":"1"}],"output":{"itemId":"climate_kit","quantity":"1"}},"craft_expedition_kit":{"recipeVersion":2,"recipeId":"craft_expedition_kit","quantity":1,"durationSec":180,"inputs":[{"kind":"crafting","itemId":"heartwood_beams","quantity":"1"},{"kind":"crafting","itemId":"thornsilk","quantity":"1"},{"kind":"shards","itemId":"shards","quantity":"25"}],"output":{"itemId":"expedition_kit","quantity":"1"}}}'::jsonb -> NEW.recipe_id;
  ELSE
  unit := '{"refine_frostglass":{"recipeVersion":1,"recipeId":"refine_frostglass","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"frost_quartz","quantity":"10"}],"output":{"itemId":"frostglass","quantity":"1"}},"refine_heartwood_beams":{"recipeVersion":1,"recipeId":"refine_heartwood_beams","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"heartwood_logs","quantity":"10"}],"output":{"itemId":"heartwood_beams","quantity":"1"}},"refine_sunstone_blocks":{"recipeVersion":1,"recipeId":"refine_sunstone_blocks","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"sunstone_rubble","quantity":"10"}],"output":{"itemId":"sunstone_blocks","quantity":"1"}},"refine_crownsteel":{"recipeVersion":1,"recipeId":"refine_crownsteel","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"crown_iron_ore","quantity":"10"}],"output":{"itemId":"crownsteel","quantity":"1"}},"refine_prismstone_lens":{"recipeVersion":1,"recipeId":"refine_prismstone_lens","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"rough_prism","quantity":"10"}],"output":{"itemId":"prismstone_lens","quantity":"1"}},"refine_stormalloy":{"recipeVersion":1,"recipeId":"refine_stormalloy","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"storm_ore","quantity":"10"}],"output":{"itemId":"stormalloy","quantity":"1"}},"refine_thornsilk":{"recipeVersion":1,"recipeId":"refine_thornsilk","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"thorn_fibre","quantity":"10"}],"output":{"itemId":"thornsilk","quantity":"1"}},"refine_embercore":{"recipeVersion":1,"recipeId":"refine_embercore","quantity":1,"durationSec":60,"inputs":[{"kind":"raw","itemId":"ember_nodules","quantity":"10"}],"output":{"itemId":"embercore","quantity":"1"}},"craft_navigation_kit":{"recipeVersion":1,"recipeId":"craft_navigation_kit","quantity":1,"durationSec":120,"inputs":[{"kind":"crafting","itemId":"prismstone_lens","quantity":"1"},{"kind":"crafting","itemId":"frostglass","quantity":"1"}],"output":{"itemId":"navigation_kit","quantity":"1"}}}'::jsonb -> NEW.recipe_id;
  END IF;
  IF unit IS NULL OR NEW.recipe_version NOT IN(1,2) OR NEW.quantity NOT BETWEEN 1 AND 10 OR NEW.completed_at IS NOT NULL THEN
   RAISE EXCEPTION 'unsupported ordinary recipe' USING ERRCODE='23514'; END IF;
  SELECT unit || jsonb_build_object('quantity',NEW.quantity,'durationSec',(unit->>'durationSec')::bigint*NEW.quantity,
   'output',(unit->'output')||jsonb_build_object('quantity',((unit->'output'->>'quantity')::bigint*NEW.quantity)::text),
   'inputs',(SELECT jsonb_agg(value||jsonb_build_object('quantity',((value->>'quantity')::bigint*NEW.quantity)::text) ORDER BY ord)
     FROM jsonb_array_elements(unit->'inputs') WITH ORDINALITY x(value,ord))) INTO expected;
  IF (NEW.recipe_snapshot=expected AND NEW.output_item_id=expected->'output'->>'itemId'
   AND NEW.output_quantity=(expected->'output'->>'quantity')::bigint
   AND NEW.ready_at-NEW.started_at=(expected->>'durationSec')::bigint*interval '1 second'
   AND isfinite(NEW.started_at) AND isfinite(NEW.ready_at)) IS NOT TRUE THEN
   RAISE EXCEPTION 'ordinary recipe identity mismatch' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='ordinary_crafting_completions' THEN
  SELECT * INTO STRICT job FROM public.ordinary_crafting_jobs WHERE id=NEW.job_id;
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=job.base_id FOR UPDATE;
  IF NEW.custody_wallet IS DISTINCT FROM custody OR NOT isfinite(NEW.completed_at) OR NEW.completed_at<job.ready_at THEN
   RAISE EXCEPTION 'ordinary completion custody or time mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_ordinary_crafting_shards(target uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.ordinary_crafting_jobs;i public.ordinary_crafting_inputs;
BEGIN
 SELECT * INTO STRICT j FROM public.ordinary_crafting_jobs WHERE id=target;
 FOR i IN SELECT * FROM public.ordinary_crafting_inputs WHERE job_id=target AND kind='shards' LOOP
  IF i.item_id<>'shards' OR i.shards_ledger_txn_id IS NULL OR j.recipe_version<>2
   OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=i.shards_ledger_txn_id AND t.type='ordinary.crafting.shards'
    AND t.idempotency_key='ordinary-crafting:'||j.id::text||':shards'
    AND t.metadata=jsonb_build_object('baseId',j.base_id,'jobId',j.id,'wallet',j.actor_wallet,'position',i.position,'quantity',i.quantity::text))
   OR (SELECT count(*) FROM public.ledger_entries WHERE txn_id=i.shards_ledger_txn_id)<>2
   OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=i.shards_ledger_txn_id
    AND a.kind='base_shards' AND a.base_id=j.base_id AND a.owner_wallet IS NULL AND a.currency='SHARDS' AND e.delta=-i.quantity)
   OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=i.shards_ledger_txn_id
    AND a.kind='shard_burn' AND a.base_id IS NULL AND a.owner_wallet IS NULL AND a.currency='SHARDS' AND e.delta=i.quantity)
  THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_SHARDS_PROOF' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_shards_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;t public.ledger_transactions;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) OR TG_NAME<>'ordinary_crafting_shards_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_TRIGGER';END IF;
 IF TG_TABLE_NAME='ledger_transactions' THEN t:=NEW;
 ELSE tid:=coalesce(NEW.txn_id,OLD.txn_id);SELECT * INTO t FROM public.ledger_transactions WHERE id=tid;END IF;
 IF t.type='ordinary.crafting.shards' OR t.idempotency_key LIKE 'ordinary-crafting:%' THEN
  IF TG_OP<>'INSERT' OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.ordinary_crafting_jobs'::regclass)
   OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_OWNER' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_shards_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;target uuid;t public.ledger_transactions;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) OR TG_NAME<>'ordinary_crafting_shards_complete' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_TRIGGER';END IF;
 tid:=CASE WHEN TG_TABLE_NAME='ledger_transactions' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'txn_id')::uuid END;
 SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=tid;
 IF t.type='ordinary.crafting.shards' OR t.idempotency_key LIKE 'ordinary-crafting:%' THEN
  SELECT job_id INTO target FROM public.ordinary_crafting_inputs WHERE shards_ledger_txn_id=tid AND kind='shards';
  IF target IS NULL THEN RAISE EXCEPTION 'ORDINARY_CRAFTING_SHARDS_UNBOUND' USING ERRCODE='23514';END IF;
  PERFORM public.shardkeep_assert_ordinary_crafting_shards(target);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_assert_ordinary_crafting_shards(uuid),public.shardkeep_ordinary_crafting_shards_guard(),public.shardkeep_ordinary_crafting_shards_complete() FROM PUBLIC;
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['ledger_transactions','ledger_entries'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER ordinary_crafting_shards_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_shards_guard()',n);
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND tgname='ordinary_crafting_shards_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER ordinary_crafting_shards_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_crafting_shards_complete()',n);
  END IF;
 END LOOP;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE jid uuid; job public.ordinary_crafting_jobs%ROWTYPE; input public.ordinary_crafting_inputs%ROWTYPE;
 expected jsonb; r public.resource_stock_operations%ROWTYPE; c public.resource_stock_operations%ROWTYPE;
 terminal public.ordinary_crafting_completions%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='ordinary_crafting_jobs' THEN jid:=NEW.id; ELSE jid:=NEW.job_id; END IF;
 SELECT * INTO STRICT job FROM public.ordinary_crafting_jobs WHERE id=jid;
 IF (SELECT count(*) FROM public.ordinary_crafting_inputs WHERE job_id=jid)<>jsonb_array_length(job.recipe_snapshot->'inputs') THEN
  RAISE EXCEPTION 'ordinary job requires every input proof' USING ERRCODE='23514'; END IF;
 FOR input IN SELECT * FROM public.ordinary_crafting_inputs WHERE job_id=jid ORDER BY position LOOP
  expected:=job.recipe_snapshot->'inputs'->input.position;
  IF (input.kind=expected->>'kind' AND input.item_id=expected->>'itemId' AND input.quantity=(expected->>'quantity')::bigint) IS NOT TRUE THEN
   RAISE EXCEPTION 'ordinary input differs from original recipe' USING ERRCODE='23514'; END IF;
  IF input.kind='raw' THEN
   SELECT * INTO STRICT r FROM public.resource_stock_operations WHERE id=input.reserve_operation_id;
   SELECT * INTO STRICT c FROM public.resource_stock_operations WHERE id=input.consume_operation_id;
   IF (r.kind='reserve' AND c.kind='consume' AND c.reservation_id=r.id
    AND r.base_id=job.base_id AND c.base_id=job.base_id AND r.custody_wallet=job.actor_wallet AND c.custody_wallet=job.actor_wallet
    AND r.resource_id=input.item_id AND c.resource_id=input.item_id AND r.quantity=input.quantity AND c.quantity=input.quantity) IS NOT TRUE THEN
    RAISE EXCEPTION 'ordinary job requires exact raw consumption' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 PERFORM public.shardkeep_assert_ordinary_crafting_shards(jid);
 SELECT * INTO terminal FROM public.ordinary_crafting_completions WHERE job_id=jid;
 IF (job.completed_at IS NULL) IS DISTINCT FROM (terminal.job_id IS NULL)
  OR (terminal.job_id IS NOT NULL AND terminal.completed_at IS DISTINCT FROM job.completed_at) THEN
  RAISE EXCEPTION 'ordinary completion requires original terminal proof' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
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
 IF offer.item_id='crystal_fragment' THEN
 PERFORM public.shardkeep_divine_fragment_source();
 IF TG_TABLE_NAME='keep_equipment_listings' THEN
  UPDATE public.crystal_fragment_stocks SET available=available-NEW.quantity,market_outgoing=market_outgoing+NEW.quantity
   WHERE base_id=NEW.seller_base_id AND available>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_STOCK';END IF;
 ELSIF TG_TABLE_NAME='keep_equipment_fills' THEN
  -- Bases are already locked. Do not use a zero-row ON CONFLICT candidate:
  -- the strict BEFORE INSERT source guard must inspect its exact earned total.
  IF EXISTS(SELECT 1 FROM public.crystal_fragment_stocks WHERE base_id=NEW.buyer_base_id) THEN
   UPDATE public.crystal_fragment_stocks SET market_incoming=market_incoming+NEW.quantity WHERE base_id=NEW.buyer_base_id
    AND available::numeric+market_outgoing::numeric+market_incoming::numeric+NEW.quantity::numeric<=9223372036854775807;
   IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_CAPACITY';END IF;
  ELSE
   INSERT INTO public.crystal_fragment_stocks(base_id,market_incoming) VALUES(NEW.buyer_base_id,NEW.quantity);
  END IF;
 ELSE
  UPDATE public.crystal_fragment_stocks SET available=available+NEW.quantity,market_outgoing=market_outgoing-NEW.quantity
   WHERE base_id=offer.seller_base_id AND market_outgoing>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_CAPACITY';END IF;
 END IF;
 ELSIF offer.item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit','climate_kit','expedition_kit') THEN
 IF TG_TABLE_NAME='keep_equipment_listings' THEN
  UPDATE public.crafting_stocks SET available=available-NEW.quantity,market_outgoing=market_outgoing+NEW.quantity
   WHERE base_id=NEW.seller_base_id AND item_id=NEW.item_id AND available>=NEW.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_MARKET_STOCK';END IF;
 ELSIF TG_TABLE_NAME='keep_equipment_fills' THEN
  SELECT * INTO STRICT offer FROM public.keep_equipment_listings WHERE id=NEW.listing_id;
  INSERT INTO public.crafting_stocks(base_id,item_id,market_incoming) VALUES(NEW.buyer_base_id,offer.item_id,NEW.quantity)
   ON CONFLICT(base_id,item_id) DO UPDATE SET market_incoming=crafting_stocks.market_incoming+NEW.quantity
    WHERE crafting_stocks.available::numeric+crafting_stocks.pending_output::numeric+crafting_stocks.market_outgoing::numeric+crafting_stocks.market_incoming::numeric+crafting_stocks.mining_pending::numeric+NEW.quantity::numeric<=9223372036854775807;
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
  IF l.item_id='crystal_fragment' THEN
  PERFORM public.shardkeep_divine_fragment_source();
  PERFORM base_id FROM public.crystal_fragment_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) ORDER BY base_id FOR UPDATE;
  UPDATE public.crystal_fragment_stocks SET market_outgoing=market_outgoing-f.quantity WHERE base_id=l.seller_base_id AND market_outgoing>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CUSTODY';END IF;
  UPDATE public.crystal_fragment_stocks SET market_incoming=market_incoming-f.quantity,available=available+f.quantity WHERE base_id=f.buyer_base_id AND market_incoming>=f.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_PAYMENT_CAPACITY';END IF;
 ELSIF l.item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit','climate_kit','expedition_kit') THEN
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
 IF l.item_id='crystal_fragment' THEN
 PERFORM public.shardkeep_divine_fragment_source();
 PERFORM base_id FROM public.crystal_fragment_stocks WHERE base_id=ANY(ARRAY[f.buyer_base_id,l.seller_base_id]) ORDER BY base_id FOR UPDATE;
 UPDATE public.crystal_fragment_stocks SET available=available+f.quantity,market_outgoing=market_outgoing-f.quantity WHERE base_id=l.seller_base_id AND market_outgoing>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CUSTODY';END IF;
 UPDATE public.crystal_fragment_stocks SET market_incoming=market_incoming-f.quantity WHERE base_id=f.buyer_base_id AND market_incoming>=f.quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_EQUIPMENT_RELEASE_CAPACITY';END IF;
 ELSIF l.item_id IN('frostglass','heartwood_beams','sunstone_blocks','crownsteel','prismstone_lens','stormalloy','thornsilk','embercore','navigation_kit','climate_kit','expedition_kit') THEN
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
CREATE TABLE IF NOT EXISTS public.divine_fragment_ordinary_kits_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.divine_fragment_ordinary_kits_contract FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_assert_ordinary_crafting_shards','shardkeep_ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_guard','shardkeep_ordinary_crafting_proof','shardkeep_ordinary_kits_seal_guard','divine_fragment_policy','shardkeep_mining_contribution_guard','shardkeep_mining_resource_canonical','shardkeep_mining_resource_originals','shardkeep_mining_publication_attempt_guard','shardkeep_mining_settlement_guard','shardkeep_mining_entitlement_guard','shardkeep_mining_entitlement_complete','shardkeep_mining_settlement_complete','shardkeep_mining_resource_publication_seal_guard','shardkeep_mining_seeker_publication_seal_guard','shardkeep_mining_resource_publication_source_guard','shardkeep_mining_contribution_effect','shardkeep_mining_pending_stock_guard','shardkeep_mining_contribution_complete','shardkeep_assert_mining_contribution_money','shardkeep_mining_contribution_money_guard','shardkeep_mining_contribution_epoch_guard','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard','divine_fragment_source_event','divine_fragment_clan_policy','shardkeep_keep_equipment_market_guard','shardkeep_keep_equipment_market_stock','shardkeep_keep_equipment_payment_guard','shardkeep_keep_equipment_payment_effect','shardkeep_keep_equipment_release_guard','shardkeep_keep_equipment_release_effect','shardkeep_keep_equipment_payment_release_guard','shardkeep_claim_payment_signature','shardkeep_payment_signature_guard'])),
 'ingredientLedgerTriggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) AND t.tgname IN('ordinary_crafting_shards_guard','ordinary_crafting_shards_complete')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_fragment_ordinary_kits_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_kits_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.divine_fragment_ordinary_kits_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'divine_fragment_ordinary_kits_contract_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) OR EXISTS(SELECT 1 FROM public.divine_fragment_ordinary_kits_contract)
 OR NEW.record IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'ORDINARY_KITS_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER divine_fragment_ordinary_kits_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.divine_fragment_ordinary_kits_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_ordinary_kits_seal_guard();
CREATE OR REPLACE TRIGGER divine_fragment_ordinary_kits_contract_no_truncate BEFORE TRUNCATE ON public.divine_fragment_ordinary_kits_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_ordinary_kits_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_ordinary_kits_seal_guard() FROM PUBLIC;
INSERT INTO public.divine_fragment_ordinary_kits_contract(record) SELECT public.shardkeep_divine_fragment_contract() WHERE NOT EXISTS(SELECT 1 FROM public.divine_fragment_ordinary_kits_contract);
SELECT public.shardkeep_divine_fragment_source();
