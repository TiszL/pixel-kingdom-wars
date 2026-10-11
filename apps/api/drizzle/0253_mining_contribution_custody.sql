-- D153.199 native-resource custody. Prospective, private, S5 HELD.
-- No HTTP mount/publication activation. Game valuation is installed from the
-- versioned shared catalogue, never supplied in an HTTP commitment.
SET LOCAL lock_timeout='10s';
SELECT public.shardkeep_divine_fragment_source();
CREATE TABLE IF NOT EXISTS public.mining_contribution_policies (
 version integer PRIMARY KEY CHECK(version>0),
 catalogue jsonb NOT NULL CHECK(jsonb_typeof(catalogue)='object'),
 free_value numeric(32,0) NOT NULL CHECK(free_value>0)
);
CREATE TABLE IF NOT EXISTS public.mining_contribution_receipts (
 id uuid PRIMARY KEY,
 actor_wallet text NOT NULL REFERENCES players(wallet),
 base_id uuid NOT NULL REFERENCES bases(id),
 epoch_id uuid NOT NULL REFERENCES mining_ingot_epochs(id),
 day date NOT NULL,
 policy_version integer NOT NULL REFERENCES mining_contribution_policies(version),
 pool text NOT NULL CHECK(pool IN('free','deed')),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 total_value numeric(32,0) NOT NULL CHECK(total_value>0),
 shards_txn_id uuid UNIQUE REFERENCES ledger_transactions(id),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at))
);
CREATE INDEX IF NOT EXISTS mining_contribution_wallet_day ON public.mining_contribution_receipts(actor_wallet,day,pool);
CREATE INDEX IF NOT EXISTS mining_contribution_epoch ON public.mining_contribution_receipts(epoch_id,base_id,id);
CREATE INDEX IF NOT EXISTS mining_contribution_base ON public.mining_contribution_receipts(base_id);
CREATE TABLE IF NOT EXISTS public.mining_contribution_lines (
 receipt_id uuid NOT NULL REFERENCES mining_contribution_receipts(id),
 resource_id text NOT NULL,
 quantity bigint NOT NULL CHECK(quantity>0),
 unit_value numeric(32,0) NOT NULL CHECK(unit_value>0),
 value numeric(32,0) NOT NULL CHECK(value=quantity::numeric*unit_value),
 PRIMARY KEY(receipt_id,resource_id)
);
CREATE TABLE IF NOT EXISTS public.mining_contribution_terminals (
 receipt_id uuid PRIMARY KEY REFERENCES mining_contribution_receipts(id),
 outcome text NOT NULL CHECK(outcome IN('consumed','returned')),
 epoch_id uuid NOT NULL REFERENCES mining_ingot_epochs(id),
 shards_txn_id uuid UNIQUE REFERENCES ledger_transactions(id),
 settled_at timestamptz NOT NULL CHECK(isfinite(settled_at))
);
CREATE TABLE IF NOT EXISTS public.divine_fragment_mining_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
ALTER TABLE public.resource_stocks ADD COLUMN IF NOT EXISTS mining_pending bigint NOT NULL DEFAULT 0;
ALTER TABLE public.crafting_stocks ADD COLUMN IF NOT EXISTS mining_pending bigint NOT NULL DEFAULT 0;
ALTER TABLE public.crystal_fragment_stocks ADD COLUMN IF NOT EXISTS mining_pending bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.resource_stocks'::regclass AND conname='resource_mining_capacity') THEN
 ALTER TABLE public.resource_stocks ADD CONSTRAINT resource_mining_capacity CHECK(mining_pending>=0 AND available::numeric+reserved::numeric+mining_pending::numeric<=9223372036854775807);
 ALTER TABLE public.crafting_stocks ADD CONSTRAINT crafting_mining_capacity CHECK(mining_pending>=0 AND available::numeric+pending_output::numeric+market_outgoing::numeric+market_incoming::numeric+mining_pending::numeric<=9223372036854775807);
 ALTER TABLE public.crystal_fragment_stocks ADD CONSTRAINT fragment_mining_capacity CHECK(mining_pending>=0 AND available::numeric+market_outgoing::numeric+market_incoming::numeric+mining_pending::numeric<=9223372036854775807);
 END IF;
END $$;
REVOKE ALL ON public.mining_contribution_policies,public.mining_contribution_receipts,public.mining_contribution_lines,public.mining_contribution_terminals,public.divine_fragment_mining_contract FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_contribution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.mining_contribution_receipts;policy public.mining_contribution_policies;b public.bases;prior numeric;k text;plan jsonb;
BEGIN
 IF TG_RELID NOT IN('public.mining_contribution_policies'::regclass,'public.mining_contribution_receipts'::regclass,'public.mining_contribution_lines'::regclass,'public.mining_contribution_terminals'::regclass,'public.divine_fragment_mining_contract'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END))
 OR TG_WHEN<>'BEFORE' OR TG_NARGS<>0 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_IMMUTABLE';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_OWNER_ISOLATION';END IF;
 IF TG_TABLE_NAME='divine_fragment_mining_contract' THEN
  IF EXISTS(SELECT 1 FROM public.divine_fragment_mining_contract) OR NEW.record IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_SEAL';END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='mining_contribution_policies' THEN RETURN NEW;
 ELSIF TG_TABLE_NAME='mining_contribution_receipts' THEN
  PERFORM 1 FROM public.players WHERE wallet=NEW.actor_wallet FOR UPDATE;
  SELECT * INTO STRICT b FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  IF b.owner_wallet IS DISTINCT FROM NEW.actor_wallet OR b.status<>'active'
   OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.actor_wallet AND active)
   OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id)
  THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_CUSTODY';END IF;
  PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id AND epoch_key='resource-mining-v'||NEW.policy_version||':'||NEW.day::text FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id)
   OR EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=NEW.epoch_id)
   OR EXISTS(SELECT 1 FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_EPOCH';END IF;
  IF NEW.request->>'idempotencyKey' IS DISTINCT FROM NEW.id::text OR NEW.request->>'baseId' IS DISTINCT FROM NEW.base_id::text
   OR NEW.request->>'expectedDay' IS DISTINCT FROM NEW.day::text OR NEW.request->>'policyVersion' IS DISTINCT FROM NEW.policy_version::text
   OR (NEW.created_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM NEW.day OR jsonb_typeof(NEW.request->'lines') IS DISTINCT FROM 'array'
   OR NEW.pool IS DISTINCT FROM (CASE WHEN b.land_paid_at IS NOT NULL AND b.deed_asset_id IS NOT NULL THEN 'deed' ELSE 'free' END)
  THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_ORIGINAL';END IF;
  SELECT * INTO STRICT policy FROM public.mining_contribution_policies WHERE version=NEW.policy_version;
  IF jsonb_array_length(NEW.request->'lines')<1 OR jsonb_array_length(NEW.request->'lines')>(SELECT count(*) FROM jsonb_object_keys(policy.catalogue))
   OR (SELECT count(DISTINCT v->>'resourceId') FROM jsonb_array_elements(NEW.request->'lines') v)<>jsonb_array_length(NEW.request->'lines') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_ORIGINAL';END IF;
  IF NEW.pool='free' THEN
   SELECT coalesce(sum(total_value),0) INTO prior FROM public.mining_contribution_receipts WHERE actor_wallet=NEW.actor_wallet AND day=NEW.day AND pool='free';
   IF prior+NEW.total_value>policy.free_value THEN RAISE EXCEPTION 'MINING_FREE_CAP_EXCEEDED';END IF;
  END IF;
 ELSE
  SELECT * INTO STRICT r FROM public.mining_contribution_receipts WHERE id=NEW.receipt_id;
  PERFORM 1 FROM public.mining_ingot_epochs WHERE id=r.epoch_id FOR UPDATE NOWAIT;
  IF TG_TABLE_NAME='mining_contribution_lines' THEN
   IF EXISTS(SELECT 1 FROM public.mining_contribution_terminals WHERE receipt_id=r.id)
    OR EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=r.epoch_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_FROZEN';END IF;
   SELECT * INTO STRICT policy FROM public.mining_contribution_policies WHERE version=r.policy_version;
   IF NOT(policy.catalogue ? NEW.resource_id) OR NEW.unit_value IS DISTINCT FROM (policy.catalogue->>NEW.resource_id)::numeric
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.request->'lines') v WHERE v->>'resourceId'=NEW.resource_id AND v->>'quantity'=NEW.quantity::text)
   THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_VALUE';END IF;
  ELSE
   IF NEW.epoch_id<>r.epoch_id OR NEW.settled_at<r.created_at THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TERMINAL';END IF;
   IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=r.epoch_id) THEN
    IF NEW.outcome<>'returned' OR EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=r.epoch_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TERMINAL';END IF;
   ELSE
    SELECT m.manifest_json::jsonb INTO STRICT plan FROM public.mining_publication_manifests m JOIN public.mining_publication_settlements s USING(epoch_id) WHERE m.epoch_id=r.epoch_id;
    IF plan->>'version' IS DISTINCT FROM '5' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'contributions') v WHERE v->>'id'=r.id::text AND v->>'outcome'=NEW.outcome)
    THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TERMINAL';END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_contribution_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.mining_contribution_receipts;l record;direction integer;give_back boolean;
BEGIN
 IF TG_RELID NOT IN('public.mining_contribution_lines'::regclass,'public.mining_contribution_terminals'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_effect' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 SELECT * INTO STRICT r FROM public.mining_contribution_receipts WHERE id=NEW.receipt_id;
 direction:=CASE WHEN TG_TABLE_NAME='mining_contribution_lines' THEN 1 ELSE -1 END;
 give_back:=TG_TABLE_NAME='mining_contribution_terminals' AND to_jsonb(NEW)->>'outcome'='returned';
 FOR l IN SELECT * FROM public.mining_contribution_lines WHERE receipt_id=r.id AND (TG_TABLE_NAME='mining_contribution_terminals' OR resource_id=to_jsonb(NEW)->>'resource_id') ORDER BY resource_id LOOP
  IF l.resource_id='shards' THEN CONTINUE;
  ELSIF l.resource_id='forge_ingot' THEN
   INSERT INTO public.mining_ingot_admissions(base_id) VALUES(r.base_id) ON CONFLICT DO NOTHING;
   IF direction=1 THEN
    UPDATE public.base_items SET qty=qty-l.quantity WHERE base_id=r.base_id AND item_id=l.resource_id AND qty>=l.quantity;
   ELSIF give_back THEN UPDATE public.base_items SET qty=qty+l.quantity WHERE base_id=r.base_id AND item_id=l.resource_id;
   ELSE CONTINUE;END IF;
  ELSIF l.resource_id='crystal_fragment' THEN
   UPDATE public.crystal_fragment_stocks SET available=available+CASE WHEN direction=1 THEN -l.quantity WHEN give_back THEN l.quantity ELSE 0 END,
    mining_pending=mining_pending+direction*l.quantity WHERE base_id=r.base_id AND (direction<>1 OR available>=l.quantity);
  ELSIF EXISTS(SELECT 1 FROM public.resource_stocks WHERE base_id=r.base_id AND resource_id=l.resource_id) THEN
   UPDATE public.resource_stocks SET available=available+CASE WHEN direction=1 THEN -l.quantity WHEN give_back THEN l.quantity ELSE 0 END,
    mining_pending=mining_pending+direction*l.quantity WHERE base_id=r.base_id AND resource_id=l.resource_id AND (direction<>1 OR available>=l.quantity);
  ELSE
   UPDATE public.crafting_stocks SET available=available+CASE WHEN direction=1 THEN -l.quantity WHEN give_back THEN l.quantity ELSE 0 END,
    mining_pending=mining_pending+direction*l.quantity WHERE base_id=r.base_id AND item_id=l.resource_id AND (direction<>1 OR available>=l.quantity);
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_MINING_RESOURCES';END IF;
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_pending_stock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item text;expected numeric;
BEGIN
 IF TG_RELID NOT IN('public.resource_stocks'::regclass,'public.crafting_stocks'::regclass,'public.crystal_fragment_stocks'::regclass)
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_pending_stock_no_truncate' ELSE 'mining_pending_stock_guard' END) OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN
  -- TRUNCATE ignores row versions; an old RR snapshot could hide a newer hold.
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_READ_COMMITTED';END IF;
  IF TG_TABLE_NAME='resource_stocks' AND EXISTS(SELECT 1 FROM public.resource_stocks WHERE mining_pending>0) OR TG_TABLE_NAME='crafting_stocks' AND EXISTS(SELECT 1 FROM public.crafting_stocks WHERE mining_pending>0) OR TG_TABLE_NAME='crystal_fragment_stocks' AND EXISTS(SELECT 1 FROM public.crystal_fragment_stocks WHERE mining_pending>0) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_PENDING';END IF;RETURN NULL;
 END IF;
 IF TG_OP='INSERT' AND NEW.mining_pending=0 AND EXISTS(SELECT 1 FROM public.mining_contribution_receipts WHERE base_id=NEW.base_id) THEN
  -- A zero candidate may reach ON CONFLICT; the actual UPDATE is checked below.
  IF TG_TABLE_NAME='resource_stocks' AND EXISTS(SELECT 1 FROM public.resource_stocks WHERE base_id=NEW.base_id AND resource_id=to_jsonb(NEW)->>'resource_id') OR TG_TABLE_NAME='crafting_stocks' AND EXISTS(SELECT 1 FROM public.crafting_stocks WHERE base_id=NEW.base_id AND item_id=to_jsonb(NEW)->>'item_id') THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)->>'resource_id' IS DISTINCT FROM to_jsonb(OLD)->>'resource_id' OR to_jsonb(NEW)->>'item_id' IS DISTINCT FROM to_jsonb(OLD)->>'item_id') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_PENDING';END IF;
 item:=CASE WHEN TG_TABLE_NAME='crystal_fragment_stocks' THEN 'crystal_fragment' WHEN TG_TABLE_NAME='resource_stocks' THEN coalesce(to_jsonb(NEW)->>'resource_id',to_jsonb(OLD)->>'resource_id') ELSE coalesce(to_jsonb(NEW)->>'item_id',to_jsonb(OLD)->>'item_id') END;
 SELECT coalesce(sum(l.quantity::numeric),0) INTO expected FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id
 WHERE r.base_id=coalesce(NEW.base_id,OLD.base_id) AND l.resource_id=item AND NOT EXISTS(SELECT 1 FROM public.mining_contribution_terminals t WHERE t.receipt_id=r.id);
 IF TG_OP='DELETE' THEN IF expected<>0 THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_PENDING';END IF;RETURN OLD;END IF;
 IF NEW.mining_pending::numeric<>expected OR (TG_OP='UPDATE' AND NEW.base_id<>OLD.base_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_PENDING';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_mining_contribution_money(target uuid,terminal boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.mining_contribution_receipts;t public.mining_contribution_terminals;txn uuid;qty bigint;move_kind text;direction integer;
BEGIN
 SELECT * INTO STRICT r FROM public.mining_contribution_receipts WHERE id=target;
 SELECT quantity INTO qty FROM public.mining_contribution_lines WHERE receipt_id=target AND resource_id='shards';
 IF terminal THEN SELECT * INTO STRICT t FROM public.mining_contribution_terminals WHERE receipt_id=target;txn:=t.shards_txn_id;move_kind:=t.outcome;direction:=-1;
 ELSE txn:=r.shards_txn_id;move_kind:='reserve';direction:=1;END IF;
 IF qty IS NULL THEN IF txn IS NOT NULL THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY';END IF;RETURN;END IF;
 IF txn IS NULL OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=txn AND type='mining.contribution.'||move_kind
  AND idempotency_key='mining-contribution:'||target::text||':'||move_kind AND metadata=jsonb_build_object('contributionId',target,'baseId',r.base_id,'wallet',r.actor_wallet,'quantity',qty::text))
  OR (SELECT count(*) FROM public.ledger_entries WHERE txn_id=txn)<>2
  OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=txn AND a.kind='mining_contribution_escrow' AND a.currency='SHARDS' AND a.base_id IS NULL AND a.owner_wallet IS NULL AND e.delta=direction*qty)
  OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=txn AND a.currency='SHARDS' AND a.owner_wallet IS NULL AND e.delta=-direction*qty
   AND (move_kind='consumed' AND a.kind='shard_burn' AND a.base_id IS NULL OR move_kind<>'consumed' AND a.kind='base_shards' AND a.base_id=r.base_id))
 THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_contribution_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;original_receipt public.mining_contribution_receipts;qty numeric;expected numeric;actual numeric;txn uuid;
BEGIN
 IF TG_RELID NOT IN('public.mining_contribution_receipts'::regclass,'public.mining_contribution_lines'::regclass,'public.mining_contribution_terminals'::regclass,'public.mining_ingot_aborts'::regclass,'public.accounts'::regclass,'public.ledger_entries'::regclass,'public.ledger_transactions'::regclass)
 OR TG_NAME<>'mining_contribution_complete' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 IF TG_TABLE_NAME='mining_ingot_aborts' THEN
  IF EXISTS(SELECT 1 FROM public.mining_contribution_receipts r WHERE r.epoch_id=NEW.epoch_id AND NOT EXISTS(SELECT 1 FROM public.mining_contribution_terminals t WHERE t.receipt_id=r.id AND t.outcome='returned')) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_ABORT_INCOMPLETE';END IF;
 ELSIF TG_TABLE_NAME IN('mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals') THEN
  target:=CASE WHEN TG_TABLE_NAME='mining_contribution_receipts' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'receipt_id')::uuid END;
  SELECT * INTO STRICT original_receipt FROM public.mining_contribution_receipts WHERE id=target;
  IF (SELECT count(*) FROM public.mining_contribution_lines WHERE receipt_id=target)<>jsonb_array_length(original_receipt.request->'lines') OR
   (SELECT sum(value) FROM public.mining_contribution_lines WHERE receipt_id=target) IS DISTINCT FROM original_receipt.total_value THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_INCOMPLETE';END IF;
  PERFORM public.shardkeep_assert_mining_contribution_money(target,false);
  IF EXISTS(SELECT 1 FROM public.mining_contribution_terminals WHERE receipt_id=target) THEN PERFORM public.shardkeep_assert_mining_contribution_money(target,true);END IF;
  IF EXISTS(SELECT 1 FROM public.mining_contribution_lines WHERE receipt_id=target AND resource_id='forge_ingot') THEN PERFORM public.shardkeep_assert_mining_ingot_stock(original_receipt.base_id);END IF;
 ELSIF TG_TABLE_NAME IN('ledger_entries','ledger_transactions') THEN
  txn:=CASE WHEN TG_TABLE_NAME='ledger_entries' THEN (to_jsonb(NEW)->>'txn_id')::uuid ELSE (to_jsonb(NEW)->>'id')::uuid END;
  IF EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=txn AND type LIKE 'mining.contribution.%')
   OR EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=txn AND a.kind='mining_contribution_escrow') THEN
   SELECT id INTO target FROM public.mining_contribution_receipts WHERE shards_txn_id=txn;
   IF target IS NOT NULL THEN PERFORM public.shardkeep_assert_mining_contribution_money(target,false);
   ELSE SELECT receipt_id INTO target FROM public.mining_contribution_terminals WHERE shards_txn_id=txn;
    IF target IS NULL THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY_UNBOUND';END IF;
    PERFORM public.shardkeep_assert_mining_contribution_money(target,true);
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='accounts' AND to_jsonb(NEW)->>'kind'<>'mining_contribution_escrow' THEN
  IF NEW.kind='base_shards' AND EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=NEW.id AND a.balance::numeric+(SELECT coalesce(sum(l.quantity::numeric),0) FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id WHERE r.base_id=a.base_id AND l.resource_id='shards' AND NOT EXISTS(SELECT 1 FROM public.mining_contribution_terminals t WHERE t.receipt_id=r.id))>9223372036854775807) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_RETURN_CAPACITY';END IF;
  RETURN NULL;
 END IF;
 SELECT (SELECT coalesce(sum(l.quantity::numeric),0) FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id WHERE l.resource_id='shards' AND NOT EXISTS(SELECT 1 FROM public.mining_contribution_terminals t WHERE t.receipt_id=r.id)),
  (SELECT coalesce(sum(balance::numeric),0) FROM public.accounts WHERE kind='mining_contribution_escrow') INTO expected,actual;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_ESCROW_CONSERVATION';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_contribution_money_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_txn uuid;new_txn uuid;protected boolean;
BEGIN
 IF TG_RELID NOT IN('public.accounts'::regclass,'public.ledger_transactions'::regclass,'public.ledger_entries'::regclass)
 OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'mining_contribution_money_no_truncate' ELSE 'mining_contribution_money_guard' END)
 OR TG_WHEN<>'BEFORE' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_READ_COMMITTED';END IF;
  IF EXISTS(SELECT 1 FROM public.mining_contribution_receipts WHERE shards_txn_id IS NOT NULL) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY_IMMUTABLE';END IF;RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='accounts' THEN
  protected:=EXISTS(SELECT 1 FROM public.ledger_entries e WHERE e.account_id=OLD.id AND (EXISTS(SELECT 1 FROM public.mining_contribution_receipts WHERE shards_txn_id=e.txn_id) OR EXISTS(SELECT 1 FROM public.mining_contribution_terminals WHERE shards_txn_id=e.txn_id)));
  IF TG_OP IN('UPDATE','DELETE') AND (protected OR OLD.kind='mining_contribution_escrow') AND (TG_OP='DELETE' OR to_jsonb(OLD)-'balance' IS DISTINCT FROM to_jsonb(NEW)-'balance') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY_IMMUTABLE';END IF;
  IF TG_OP<>'DELETE' AND NEW.kind='mining_contribution_escrow' AND(NEW.balance<0 OR NEW.currency<>'SHARDS' OR NEW.base_id IS NOT NULL OR NEW.owner_wallet IS NOT NULL OR TG_OP='INSERT' AND NEW.balance<>0 OR TG_OP='UPDATE' AND OLD.kind<>NEW.kind) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY';END IF;
 ELSE
  old_txn:=CASE WHEN TG_TABLE_NAME='ledger_entries' THEN (to_jsonb(OLD)->>'txn_id')::uuid ELSE (to_jsonb(OLD)->>'id')::uuid END;
  new_txn:=CASE WHEN TG_TABLE_NAME='ledger_entries' THEN (to_jsonb(NEW)->>'txn_id')::uuid ELSE (to_jsonb(NEW)->>'id')::uuid END;
  IF TG_OP<>'INSERT' AND (EXISTS(SELECT 1 FROM public.mining_contribution_receipts WHERE shards_txn_id IN(old_txn,new_txn)) OR EXISTS(SELECT 1 FROM public.mining_contribution_terminals WHERE shards_txn_id IN(old_txn,new_txn))) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_MONEY_IMMUTABLE';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint
-- A resource epoch cannot be admitted to the older ingot-only capture path.
CREATE OR REPLACE FUNCTION public.shardkeep_mining_contribution_epoch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID NOT IN('public.mining_ingot_reservations'::regclass,'public.mining_publication_attempts'::regclass)
 OR TG_NAME<>'mining_contribution_epoch_guard' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 PERFORM id FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id AND epoch_key LIKE 'resource-mining-v%') THEN RAISE EXCEPTION 'MINING_RESOURCE_PUBLICATION_NOT_ADMITTED';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_mining_ingot_stock(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE minted bigint; held bigint; reserved bigint; consumed bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.mining_ingot_admissions WHERE base_id=target) THEN RETURN; END IF;
 -- Receipt identity and BOTH exact ledger legs are required; acquired_via is
 -- merely a label. No uncollected or malformed job supplies earned inventory.
 IF EXISTS(SELECT 1 FROM public.workshop_jobs j WHERE j.base_id=target AND j.collected_at IS NOT NULL AND (
  j.collected_by_wallet IS NULL OR j.collect_idempotency_key IS NULL OR j.collected_at<j.ready_at OR
  NOT EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.id=j.debit_ledger_txn_id AND t.type='workshop.refine'
   AND t.idempotency_key='workshop:'||j.base_id::text||':'||j.started_by_wallet||':'||j.start_idempotency_key
   AND t.metadata=jsonb_build_object('baseId',j.base_id,'wallet',j.started_by_wallet,'ingots',j.ingots,'shards',j.shards_charged::text,'recipeVersion',j.recipe_version,'workshopLevel',j.workshop_level_at_start)) OR
  (SELECT count(*) FROM public.ledger_entries e WHERE e.txn_id=j.debit_ledger_txn_id)<>2 OR
  NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=j.debit_ledger_txn_id
   AND a.kind='base_shards' AND a.currency='SHARDS' AND a.base_id=target AND a.owner_wallet IS NULL AND e.delta=-j.shards_charged) OR
  NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=j.debit_ledger_txn_id
   AND a.kind='shard_burn' AND a.currency='SHARDS' AND a.base_id IS NULL AND a.owner_wallet IS NULL AND e.delta=j.shards_charged)
 )) THEN RAISE EXCEPTION 'MINING_INGOT_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(ingots),0) INTO minted FROM public.workshop_jobs WHERE base_id=target AND collected_at IS NOT NULL;
 SELECT coalesce(sum(qty),0) INTO held FROM public.base_items WHERE base_id=target AND item_id='forge_ingot';
 SELECT coalesce(sum(r.qty),0) INTO reserved FROM public.mining_ingot_reservations r
  WHERE r.base_id=target AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_releases x WHERE x.reservation_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_dispositions d WHERE d.reservation_id=r.id);
 SELECT coalesce(sum(d.consumed_qty),0) INTO consumed FROM public.mining_ingot_dispositions d JOIN public.mining_ingot_reservations r ON r.id=d.reservation_id WHERE r.base_id=target;
 SELECT reserved+coalesce(sum(l.quantity),0) INTO reserved FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id WHERE r.base_id=target AND l.resource_id='forge_ingot' AND NOT EXISTS(SELECT 1 FROM public.mining_contribution_terminals t WHERE t.receipt_id=r.id);
 SELECT consumed+coalesce(sum(l.quantity),0) INTO consumed FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id JOIN public.mining_contribution_terminals t ON t.receipt_id=r.id WHERE r.base_id=target AND l.resource_id='forge_ingot' AND t.outcome='consumed';
 IF held+reserved+consumed<>minted THEN RAISE EXCEPTION 'MINING_INGOT_CONSERVATION' USING ERRCODE='23514'; END IF;
END $$;

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
 IF NEW.available::numeric+NEW.market_outgoing::numeric+NEW.mining_pending::numeric+(SELECT coalesce(sum(l.quantity::numeric),0) FROM public.mining_contribution_lines l JOIN public.mining_contribution_receipts r ON r.id=l.receipt_id JOIN public.mining_contribution_terminals t ON t.receipt_id=r.id WHERE r.base_id=NEW.base_id AND l.resource_id='crystal_fragment' AND t.outcome='consumed') IS DISTINCT FROM expected THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_CONSERVATION';END IF;
 IF NEW.market_outgoing::numeric IS DISTINCT FROM outgoing OR NEW.market_incoming::numeric IS DISTINCT FROM incoming THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_HOLD_CONSERVATION';END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['divine_fragment_policy','shardkeep_mining_contribution_guard','shardkeep_mining_contribution_effect','shardkeep_mining_pending_stock_guard','shardkeep_mining_contribution_complete','shardkeep_assert_mining_contribution_money','shardkeep_mining_contribution_money_guard','shardkeep_mining_contribution_epoch_guard','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard','divine_fragment_source_event','divine_fragment_clan_policy','shardkeep_keep_equipment_market_guard','shardkeep_keep_equipment_market_stock','shardkeep_keep_equipment_payment_guard','shardkeep_keep_equipment_payment_effect','shardkeep_keep_equipment_release_guard','shardkeep_keep_equipment_release_effect','shardkeep_keep_equipment_payment_release_guard','shardkeep_claim_payment_signature','shardkeep_payment_signature_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])))
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_fragment_mining_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;

--> statement-breakpoint
DO $install$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','divine_fragment_mining_contract'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_contribution_guard()',n||'_guard',n);
  EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_contribution_guard()',n||'_no_truncate',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['mining_contribution_lines','mining_contribution_terminals'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_contribution_effect()',n||'_effect',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['resource_stocks','crafting_stocks','crystal_fragment_stocks'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER mining_pending_stock_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_pending_stock_guard()',n);
  EXECUTE format('CREATE OR REPLACE TRIGGER mining_pending_stock_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_pending_stock_guard()',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','mining_ingot_aborts','accounts','ledger_entries','ledger_transactions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND tgname='mining_contribution_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER mining_contribution_complete AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_contribution_complete()',n);
  END IF;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['accounts','ledger_transactions','ledger_entries'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER mining_contribution_money_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_contribution_money_guard()',n);
  EXECUTE format('CREATE OR REPLACE TRIGGER mining_contribution_money_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_contribution_money_guard()',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['mining_ingot_reservations','mining_publication_attempts'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER mining_contribution_epoch_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_contribution_epoch_guard()',n);
 END LOOP;
END $install$;
REVOKE ALL ON FUNCTION public.shardkeep_mining_contribution_guard(),public.shardkeep_mining_contribution_effect(),public.shardkeep_mining_pending_stock_guard(),public.shardkeep_mining_contribution_complete(),public.shardkeep_assert_mining_contribution_money(uuid,boolean),public.shardkeep_mining_contribution_money_guard(),public.shardkeep_mining_contribution_epoch_guard() FROM PUBLIC;
INSERT INTO public.divine_fragment_mining_contract(record) SELECT public.shardkeep_divine_fragment_contract() WHERE NOT EXISTS(SELECT 1 FROM public.divine_fragment_mining_contract);
SELECT public.shardkeep_divine_fragment_source();
