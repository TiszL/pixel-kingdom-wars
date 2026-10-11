-- D153.211 private material custody. No activation, returns, or legacy backfill.
CREATE TABLE public.vehicle_craft_recipe_policies(
 recipe_hash text PRIMARY KEY CHECK(recipe_hash~'^[0-9a-f]{64}$'),canonical text NOT NULL,UNIQUE(canonical)
);
CREATE TABLE public.vehicle_craft_material_reservations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_wallet text NOT NULL,idempotency_key uuid NOT NULL,base_id uuid NOT NULL,
 root_id text NOT NULL UNIQUE CHECK(root_id~'^[0-9a-f]{32}$'),attempt_id text NOT NULL UNIQUE CHECK(attempt_id~'^[0-9a-f]{32}$'),
 permit_id text NOT NULL UNIQUE CHECK(permit_id~'^[0-9a-f]{32}$'),asset_id text NOT NULL UNIQUE,
 recipe_hash text NOT NULL REFERENCES public.vehicle_craft_recipe_policies(recipe_hash),
 nonce text NOT NULL UNIQUE CHECK(nonce~'^[0-9a-f]{64}$'),material_hash text NOT NULL CHECK(material_hash~'^[0-9a-f]{64}$'),
 workshop_id uuid NOT NULL,workshop_job_id uuid NOT NULL,reserved_at timestamptz NOT NULL CHECK(isfinite(reserved_at)),
 UNIQUE(actor_wallet,idempotency_key),
 FOREIGN KEY(root_id) REFERENCES public.vehicle_issuance_originals(root_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.vehicle_craft_material_lines(
 reservation_id uuid NOT NULL REFERENCES public.vehicle_craft_material_reservations(id),position integer NOT NULL CHECK(position>=0),
 kind text NOT NULL CHECK(kind IN('refined','fragment')),item_id text NOT NULL,quantity bigint NOT NULL CHECK(quantity>0),
 PRIMARY KEY(reservation_id,position),UNIQUE(reservation_id,kind,item_id)
);
CREATE TABLE public.vehicle_craft_material_terminals(
 reservation_id uuid PRIMARY KEY REFERENCES public.vehicle_craft_material_reservations(id),outcome text NOT NULL CHECK(outcome IN('won','lost')),
 proof jsonb NOT NULL CHECK(octet_length(proof::text)<=65536),recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE public.divine_fragment_vehicle_material_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.vehicle_craft_recipe_policies,public.vehicle_craft_material_reservations,public.vehicle_craft_material_lines,public.vehicle_craft_material_terminals,public.divine_fragment_vehicle_material_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_vehicle_material_hash(actor text,base uuid,root text,attempt text,nonce text,recipe_hash text,recipe jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to('SKVEHMAT01'||chr(10)||actor||chr(10)||base::text||chr(10)||root||chr(10)||attempt||chr(10)||nonce||chr(10)||recipe_hash||chr(10)||
 (SELECT string_agg((v->>'kind')||':'||(v->>'itemId')||':'||(v->>'quantity'),chr(10) ORDER BY n) FROM jsonb_array_elements(recipe->'inputs') WITH ORDINALITY a(v,n)),'UTF8')),'hex')
$$;
CREATE FUNCTION public.shardkeep_vehicle_material_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_craft_material_reservations%ROWTYPE;o public.vehicle_issuance_originals%ROWTYPE;p jsonb;line jsonb;fi integer;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_craft_recipe_policies'::regclass,'public.vehicle_craft_material_reservations'::regclass,'public.vehicle_craft_material_lines'::regclass,'public.vehicle_craft_material_terminals'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_IMMUTABLE';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_OWNER';END IF;
 IF TG_TABLE_NAME='vehicle_craft_recipe_policies' THEN
  -- Generated from immutable shared canonical recipe bytes. Hash commitments
  -- pin the catalogue without copying game quantities into SQL.
  IF encode(sha256(convert_to(NEW.canonical||chr(10)||NEW.recipe_hash,'UTF8')),'hex') NOT IN ('86a0917502555eaba4611053fbe6af11a468e09bf04236b4063e0797cabbceed','555a9a23f830b9e9af75f65378e1b18c2fed30057fcc72999092050150be2dfc','e5a3ea42af5ece787887a88e44db9c67c23319a5a12db09aded867f649e9903e','5e01eb149134fab8bfd60a2504d9e0c8482d24c91d9e57f28475eb48fdc66ea5','fb43d52ee2c32d27654ad92f620e9a4cbc8b9db3ec0d61780d13a50db5b8f964','e7aab59b3de2f573e5bfa89e3f2156d4a7cf21daf0833dcb59f313bda35466d7','9db7b6ef02733b11230206a08378bf21cfbfd8f5aa71f9a5e1f886f01a65bdce','2385d8aaf4819b0b69c73100c1c9eb708c4c460a31d1a65e1fbe171f9a068bc1','e978b05a7dccacef638c5a11abba99ff99cf40697e283ada93c20b4c07a045b0','fd1d59056cf9240fce516a74191b59df873a3dc82f4789b05b30bb7c90e50608','a220af4f4160b6fbabd6f2ef7db32021dcd13e0ca7a4434e81889a0bb51d7bb8','99e202561eba0f4c419b0d6a15be023230384ed70bd6dca0ca35381fb6f27c29','cf15c377303326b5d772f3b49525b9aa0362aa999a978d19591b8189097bdb81','e450737b2875ab33dc6fc3a4e5a7f95e4c4cf171950ec96da541eddaaa348235','04c775dfefca5bab71715aedc674cec672dcf622062631a8f3d663e50f9d62e8','a8b8665d7a63437669f9268af69e19b420646ceea1f86890e4b8e573bbc4a33e')
  THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_RECIPE';END IF;
 ELSIF TG_TABLE_NAME='vehicle_craft_material_reservations' THEN
  IF NEW.nonce IS NOT NULL OR NEW.material_hash IS NOT NULL OR NEW.reserved_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_DERIVED';END IF;
  PERFORM wallet FROM public.players WHERE wallet=NEW.actor_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_ACTOR';END IF;
  PERFORM id FROM public.bases WHERE id=NEW.base_id AND owner_wallet=NEW.actor_wallet AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_BASE';END IF;
  PERFORM base_id FROM public.base_slots WHERE base_id=NEW.base_id AND wallet=NEW.actor_wallet AND active FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=NEW.base_id) THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_BASE';END IF;
  PERFORM b.id FROM public.buildings b JOIN public.builder_jobs j ON j.building_id=b.id WHERE b.id=NEW.workshop_id AND b.base_id=NEW.base_id AND b.type='workshop' AND b.level>=1
   AND j.id=NEW.workshop_job_id AND j.base_id=NEW.base_id AND j.kind='build' AND j.completed_at IS NOT NULL AND j.completed_at<=clock_timestamp() AND j.cancelled_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.builder_jobs pending WHERE pending.building_id=b.id AND pending.kind='build' AND pending.completed_at IS NULL) FOR UPDATE OF b,j;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_WORKSHOP';END IF;
  IF EXISTS(SELECT 1 FROM public.vehicle_issuance_originals WHERE root_id=NEW.root_id OR attempt_id=NEW.attempt_id OR permit_id=NEW.permit_id OR asset_id=NEW.asset_id)
  THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_EXISTING_ORIGINAL';END IF;
  SELECT canonical::jsonb INTO p FROM public.vehicle_craft_recipe_policies WHERE recipe_hash=NEW.recipe_hash;
  IF p IS NULL THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_RECIPE';END IF;
  NEW.id:=gen_random_uuid();NEW.nonce:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');NEW.reserved_at:=clock_timestamp();
  NEW.material_hash:=public.shardkeep_vehicle_material_hash(NEW.actor_wallet,NEW.base_id,NEW.root_id,NEW.attempt_id,NEW.nonce,NEW.recipe_hash,p);
 ELSE
  SELECT * INTO r FROM public.vehicle_craft_material_reservations WHERE id=NEW.reservation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_RESERVATION';END IF;
  SELECT canonical::jsonb INTO p FROM public.vehicle_craft_recipe_policies WHERE recipe_hash=r.recipe_hash;
  IF TG_TABLE_NAME='vehicle_craft_material_lines' THEN
   IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_LINE_ORIGIN';END IF;
   line:=p->'inputs'->NEW.position;
   IF (NEW.kind,NEW.item_id,NEW.quantity::text) IS DISTINCT FROM(line->>'kind',line->>'itemId',line->>'quantity') THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_LINE';END IF;
  ELSE
   SELECT * INTO o FROM public.vehicle_issuance_originals WHERE root_id=r.root_id;
   IF NEW.recorded_at IS NOT NULL OR NEW.proof->>'version' IS DISTINCT FROM '1' OR NEW.proof->>'rootId' IS DISTINCT FROM r.root_id
    OR NEW.proof->>'attemptId' IS DISTINCT FROM r.attempt_id OR NEW.proof->>'permitId' IS DISTINCT FROM r.permit_id OR NEW.proof->>'buyer' IS DISTINCT FROM r.actor_wallet
    OR NEW.proof->>'originalHash' IS DISTINCT FROM o.original->>'originalHash' OR NEW.proof->'identity' IS DISTINCT FROM o.original->'identity'
    OR NEW.proof->>'outcome' IS DISTINCT FROM NEW.outcome OR NEW.proof->>'paid' IS DISTINCT FROM 'true' OR NEW.proof->>'finalizedNormalResultObserved' IS DISTINCT FROM 'true'
    OR NEW.proof->>'finalizedMintObserved' IS DISTINCT FROM 'false' OR NEW.proof#>>'{source,profile}' IS DISTINCT FROM 'paid-normal-result-12-v1'
    OR NEW.proof#>>'{source,genesisHash}' IS DISTINCT FROM o.original->>'genesisHash'
    OR NEW.proof->>'transactionProofVerified' IS DISTINCT FROM 'false' OR NEW.proof->>'paymentAuthorized' IS DISTINCT FROM 'false'
    OR NEW.proof->>'activationAuthorized' IS DISTINCT FROM 'false' OR NEW.proof->>'reservationReleaseAuthorized' IS DISTINCT FROM 'false'
   THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_TERMINAL';END IF;
   NEW.recorded_at:=clock_timestamp();
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_material_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p jsonb;r public.vehicle_craft_material_reservations%ROWTYPE;line record;
BEGIN
 IF TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NAME<>TG_TABLE_NAME||'_effect' THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_EFFECT';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 IF TG_RELID='public.vehicle_craft_material_reservations'::regclass THEN
  SELECT canonical::jsonb INTO p FROM public.vehicle_craft_recipe_policies WHERE recipe_hash=NEW.recipe_hash;
  FOR line IN SELECT v,n FROM jsonb_array_elements(p->'inputs') WITH ORDINALITY a(v,n) ORDER BY n LOOP
   INSERT INTO public.vehicle_craft_material_lines(reservation_id,position,kind,item_id,quantity) VALUES(NEW.id,line.n-1,line.v->>'kind',line.v->>'itemId',(line.v->>'quantity')::bigint);
  END LOOP;
 ELSIF TG_RELID='public.vehicle_craft_material_lines'::regclass THEN
  SELECT * INTO r FROM public.vehicle_craft_material_reservations WHERE id=NEW.reservation_id;
  IF NEW.kind='refined' THEN
   UPDATE public.crafting_stocks SET available=available-NEW.quantity WHERE base_id=r.base_id AND item_id=NEW.item_id AND available>=NEW.quantity;
  ELSE
   UPDATE public.crystal_fragment_stocks SET available=available-NEW.quantity WHERE base_id=r.base_id AND available>=NEW.quantity;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_STOCK';END IF;
 ELSE RAISE EXCEPTION 'VEHICLE_MATERIAL_EFFECT';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_material_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_craft_material_reservations%ROWTYPE;o public.vehicle_issuance_originals%ROWTYPE;p jsonb;fi integer;
BEGIN
 IF TG_RELID<>'public.vehicle_craft_material_reservations'::regclass OR TG_NAME<>'vehicle_craft_material_complete' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_COMPLETE_TRIGGER';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 SELECT * INTO r FROM public.vehicle_craft_material_reservations WHERE id=NEW.id;
 SELECT * INTO o FROM public.vehicle_issuance_originals WHERE root_id=r.root_id;
 SELECT canonical::jsonb INTO p FROM public.vehicle_craft_recipe_policies WHERE recipe_hash=r.recipe_hash;
 fi:=array_position(ARRAY['survey_balloon','cargo_cutter','courier_airship','expedition_barge'],p->>'family')-1;
 IF o.root_id IS NULL OR (o.attempt_id,o.permit_id,o.asset_id,o.buyer) IS DISTINCT FROM(r.attempt_id,r.permit_id,r.asset_id,r.actor_wallet)
 OR (o.original#>>'{terms,recipeHash}',o.original#>>'{terms,materialHash}',o.original#>>'{terms,recipeVersion}',o.original#>>'{terms,oddsBps}',o.original#>>'{terms,family}',o.original#>>'{terms,tier}')
 IS DISTINCT FROM(r.recipe_hash,r.material_hash,p->>'recipeVersion',p->>'oddsBps',fi::text,p->>'tier')
 OR (SELECT count(*) FROM public.vehicle_craft_material_lines WHERE reservation_id=r.id)<>jsonb_array_length(p->'inputs')
 THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_INCOMPLETE';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.shardkeep_vehicle_material_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN RAISE EXCEPTION 'VEHICLE_MATERIAL_IMMUTABLE';END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_material_guard()',t||'_guard',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_material_no_truncate()',t||'_no_truncate',t);
 END LOOP;
END $$;
CREATE TRIGGER vehicle_craft_material_reservations_effect AFTER INSERT ON public.vehicle_craft_material_reservations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_material_effect();
CREATE TRIGGER vehicle_craft_material_lines_effect AFTER INSERT ON public.vehicle_craft_material_lines FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_material_effect();
CREATE CONSTRAINT TRIGGER vehicle_craft_material_complete AFTER INSERT ON public.vehicle_craft_material_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_material_complete();
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_material_hash(text,uuid,text,text,text,text,jsonb),public.shardkeep_vehicle_material_guard(),public.shardkeep_vehicle_material_effect(),public.shardkeep_vehicle_material_complete(),public.shardkeep_vehicle_material_no_truncate() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_stock_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected numeric;outgoing numeric;incoming numeric;BEGIN
 PERFORM public.shardkeep_divine_fragment_source();
 IF TG_RELID<>'public.crystal_fragment_stocks'::regclass OR TG_WHEN<>'BEFORE' OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'crystal_fragment_stocks_no_truncate' ELSE 'crystal_fragment_stocks_guard' END) THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TRIGGER';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_IMMUTABLE';END IF;
 IF TG_OP='UPDATE' AND NEW.base_id IS DISTINCT FROM OLD.base_id THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_IDENTITY';END IF;
 -- Protected source conservation includes finalized shipments/receipts, never
 -- unresolved incoming promises. Every hold independently derives from journals.
 SELECT coalesce(sum(q),0) INTO expected FROM(
  SELECT quantity::numeric q FROM public.divine_fragment_deliveries WHERE base_id=NEW.base_id
  UNION ALL SELECT quantity::numeric FROM public.seeker_fragment_claims WHERE base_id=NEW.base_id
  UNION ALL SELECT f.quantity::numeric FROM public.keep_equipment_deliveries d JOIN public.keep_equipment_fills f ON f.id=d.fill_id JOIN public.keep_equipment_listings l ON l.id=f.listing_id WHERE f.buyer_base_id=NEW.base_id AND l.item_id='crystal_fragment'
  UNION ALL SELECT -f.quantity::numeric FROM public.keep_equipment_deliveries d JOIN public.keep_equipment_fills f ON f.id=d.fill_id JOIN public.keep_equipment_listings l ON l.id=f.listing_id WHERE l.seller_base_id=NEW.base_id AND l.item_id='crystal_fragment'
 ) x;
 SELECT coalesce(sum(l.quantity::numeric
  -coalesce((SELECT sum(c.quantity::numeric) FROM public.keep_equipment_listing_cancellations c WHERE c.listing_id=l.id),0)
  -coalesce((SELECT sum(f.quantity::numeric) FROM public.keep_equipment_fills f WHERE f.listing_id=l.id AND (EXISTS(SELECT 1 FROM public.keep_equipment_deliveries d WHERE d.fill_id=f.id) OR EXISTS(SELECT 1 FROM public.keep_equipment_fill_releases r WHERE r.fill_id=f.id))),0)),0)
 INTO outgoing FROM public.keep_equipment_listings l WHERE l.seller_base_id=NEW.base_id AND l.item_id='crystal_fragment';
 SELECT coalesce(sum(f.quantity::numeric),0) INTO incoming FROM public.keep_equipment_fills f JOIN public.keep_equipment_listings l ON l.id=f.listing_id
 WHERE f.buyer_base_id=NEW.base_id AND l.item_id='crystal_fragment' AND NOT EXISTS(SELECT 1 FROM public.keep_equipment_deliveries d WHERE d.fill_id=f.id) AND NOT EXISTS(SELECT 1 FROM public.keep_equipment_fill_releases r WHERE r.fill_id=f.id);
 IF NEW.available::numeric+NEW.market_outgoing::numeric+NEW.mining_pending::numeric+(SELECT coalesce(sum(l.quantity::numeric),0) FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id JOIN public.mining_contribution_terminals t ON t.receipt_id=r.id WHERE r.base_id=NEW.base_id AND l.resource_id='crystal_fragment' AND t.outcome='consumed')+(SELECT coalesce(sum(l.quantity::numeric),0) FROM public.vehicle_craft_material_lines l JOIN public.vehicle_craft_material_reservations r ON r.id=l.reservation_id WHERE r.base_id=NEW.base_id AND l.kind='fragment') IS DISTINCT FROM expected THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_CONSERVATION';END IF;
 IF NEW.market_outgoing::numeric IS DISTINCT FROM outgoing OR NEW.market_incoming::numeric IS DISTINCT FROM incoming THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_HOLD_CONSERVATION';END IF;
 RETURN NEW;
END $$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals','vehicle_issuance_originals','divine_fragment_vehicle_material_contract','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','divine_fragment_enrolled_seeker_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',to_jsonb(p.proacl),'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_vehicle_material_hash','shardkeep_vehicle_material_guard','shardkeep_vehicle_material_effect','shardkeep_vehicle_material_complete','shardkeep_vehicle_material_no_truncate','shardkeep_vehicle_material_seal_guard','shardkeep_vehicle_issuance_guard','shardkeep_assert_ordinary_crafting_shards','shardkeep_ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_guard','shardkeep_ordinary_crafting_proof','shardkeep_ordinary_kits_seal_guard','shardkeep_mining_resource_kits_seal_guard','shardkeep_mining_enrolled_seeker_seal_guard','shardkeep_mining_resource_day_policy','shardkeep_mining_resource_cutover_guard','shardkeep_mining_resource_epoch_day_guard','shardkeep_mining_resource_prior_decided','divine_fragment_policy','shardkeep_mining_contribution_guard','shardkeep_mining_resource_canonical','shardkeep_mining_resource_originals','shardkeep_mining_publication_attempt_guard','shardkeep_mining_settlement_guard','shardkeep_mining_entitlement_guard','shardkeep_mining_entitlement_complete','shardkeep_mining_settlement_complete','shardkeep_mining_resource_publication_seal_guard','shardkeep_mining_seeker_publication_seal_guard','shardkeep_mining_resource_publication_source_guard','shardkeep_mining_contribution_effect','shardkeep_mining_pending_stock_guard','shardkeep_mining_contribution_complete','shardkeep_assert_mining_contribution_money','shardkeep_mining_contribution_money_guard','shardkeep_mining_contribution_epoch_guard','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard','divine_fragment_source_event','divine_fragment_clan_policy','shardkeep_keep_equipment_market_guard','shardkeep_keep_equipment_market_stock','shardkeep_keep_equipment_payment_guard','shardkeep_keep_equipment_payment_effect','shardkeep_keep_equipment_release_guard','shardkeep_keep_equipment_release_effect','shardkeep_keep_equipment_payment_release_guard','shardkeep_claim_payment_signature','shardkeep_payment_signature_guard'])),
 'ingredientLedgerTriggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) AND t.tgname IN('ordinary_crafting_shards_guard','ordinary_crafting_shards_complete')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['vehicle_craft_recipe_policies','vehicle_craft_material_reservations','vehicle_craft_material_lines','vehicle_craft_material_terminals','vehicle_issuance_originals','divine_fragment_vehicle_material_contract','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','divine_fragment_enrolled_seeker_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])))
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_fragment_vehicle_material_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_material_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.divine_fragment_vehicle_material_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'divine_fragment_vehicle_material_contract_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM public.divine_fragment_vehicle_material_contract)
 OR NEW.record IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'VEHICLE_MATERIAL_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER divine_fragment_vehicle_material_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.divine_fragment_vehicle_material_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_material_seal_guard();
CREATE TRIGGER divine_fragment_vehicle_material_contract_no_truncate BEFORE TRUNCATE ON public.divine_fragment_vehicle_material_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_material_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_material_seal_guard() FROM PUBLIC;
INSERT INTO public.divine_fragment_vehicle_material_contract(record) SELECT public.shardkeep_divine_fragment_contract();
SELECT public.shardkeep_divine_fragment_source();
