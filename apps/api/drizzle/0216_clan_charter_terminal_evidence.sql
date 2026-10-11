-- B6b observations of actual statements, not monetary authority or reconciliation.
-- Existing-table hooks remain S5-held. No backfill or commit-time graph promise:
-- readers must discover all implicated raw posts and revalidate every saved row.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.clan_charter_loot_posts(
 ledger_id uuid PRIMARY KEY REFERENCES public.ledger_transactions(id),
 raid_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_raid_events(raid_id),
 source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$' AND tx_key::numeric<=18446744073709551615),original_transaction jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS clan_charter_loot_posts_tx_idx ON public.clan_charter_loot_posts(tx_key,ledger_id);
CREATE TABLE IF NOT EXISTS public.clan_charter_loot_entries(
 entry_id bigint PRIMARY KEY REFERENCES public.ledger_entries(id),ledger_id uuid NOT NULL REFERENCES public.clan_charter_loot_posts(ledger_id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$' AND tx_key::numeric<=18446744073709551615),original_entry jsonb NOT NULL,account_identity jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS clan_charter_loot_entries_post_idx ON public.clan_charter_loot_entries(ledger_id,entry_id);
CREATE TABLE IF NOT EXISTS public.clan_charter_chest_updates(
 id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),
 actual_clan_id uuid NOT NULL,tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$' AND tx_key::numeric<=18446744073709551615),
 before_clan jsonb NOT NULL,after_clan jsonb NOT NULL,delta bigint NOT NULL CHECK(delta>0),
 pairing text NOT NULL CHECK(pairing IN('matched','unmatched','ambiguous')),candidate_ledger_ids uuid[] NOT NULL,
 ledger_id uuid UNIQUE REFERENCES public.clan_charter_loot_posts(ledger_id),
 CHECK((pairing='matched' AND cardinality(candidate_ledger_ids)=1 AND ledger_id IS NOT NULL AND ledger_id=candidate_ledger_ids[1])
 OR(pairing='unmatched' AND cardinality(candidate_ledger_ids)=0 AND ledger_id IS NULL)
 OR(pairing='ambiguous' AND cardinality(candidate_ledger_ids)>1 AND ledger_id IS NULL))
);
CREATE INDEX IF NOT EXISTS clan_charter_chest_updates_tx_idx ON public.clan_charter_chest_updates(tx_key,id);
CREATE TABLE IF NOT EXISTS public.clan_charter_raid_terminals(
 raid_id uuid PRIMARY KEY REFERENCES public.clan_charter_raid_events(raid_id),source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),
 tx_key text NOT NULL CHECK(tx_key~'^[1-9][0-9]*$' AND tx_key::numeric<=18446744073709551615),
 before_raid jsonb NOT NULL,after_raid jsonb NOT NULL,terminal_status text NOT NULL CHECK(terminal_status IN('resolved','expired'))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_terminal_witness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE parent_oid oid;parent_name text;writer_oid oid;
BEGIN
 IF TG_RELID NOT IN('public.clan_charter_loot_posts'::regclass,'public.clan_charter_loot_entries'::regclass,'public.clan_charter_chest_updates'::regclass,'public.clan_charter_raid_terminals'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) OR pg_trigger_depth()<>2 OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_ORIGIN' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 IF TG_TABLE_NAME='clan_charter_loot_posts' THEN
  parent_oid:='public.ledger_transactions'::regclass;parent_name:='ledger_transactions_clan_charter_loot';writer_oid:='public.shardkeep_clan_charter_capture_loot()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN public.clan_charter_raid_events e ON e.raid_id=NEW.raid_id WHERE t.id=NEW.ledger_id AND e.source_id=NEW.source_id
   AND t.type='raid.loot' AND t.idempotency_key='raid:'||e.raid_id::text||':loot' AND to_jsonb(t)=NEW.original_transaction) THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 ELSIF TG_TABLE_NAME='clan_charter_loot_entries' THEN
  parent_oid:='public.ledger_entries'::regclass;parent_name:='ledger_entries_clan_charter_loot';writer_oid:='public.shardkeep_clan_charter_capture_loot()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id JOIN public.clan_charter_loot_posts p ON p.ledger_id=e.txn_id
   WHERE e.id=NEW.entry_id AND p.ledger_id=NEW.ledger_id AND p.tx_key=NEW.tx_key AND to_jsonb(e)=NEW.original_entry AND to_jsonb(a)-'balance'=NEW.account_identity)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 ELSIF TG_TABLE_NAME='clan_charter_chest_updates' THEN
  parent_oid:='public.clans'::regclass;parent_name:='clans_clan_charter_chest';writer_oid:='public.shardkeep_clan_charter_capture_chest()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.clans c WHERE c.id=NEW.actual_clan_id AND to_jsonb(c)=NEW.after_clan)
   OR NEW.before_clan->>'id' IS DISTINCT FROM NEW.after_clan->>'id'
   OR (NEW.after_clan->>'chest_shards')::bigint-(NEW.before_clan->>'chest_shards')::bigint IS DISTINCT FROM NEW.delta
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 ELSE
  parent_oid:='public.raids'::regclass;parent_name:='raids_clan_charter_terminal';writer_oid:='public.shardkeep_clan_charter_capture_terminal()'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM public.raids r JOIN public.clan_charter_raid_events e ON e.raid_id=r.id WHERE r.id=NEW.raid_id AND e.source_id=NEW.source_id AND to_jsonb(r)=NEW.after_raid)
   OR NEW.before_raid->>'id' IS DISTINCT FROM NEW.raid_id::text OR NEW.after_raid->>'status' IS DISTINCT FROM NEW.terminal_status
   OR NOT((NEW.before_raid->>'status'='resolving' AND NEW.terminal_status='resolved') OR(NEW.before_raid->>'status'='pending_orders' AND NEW.terminal_status='expired'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=parent_oid AND tgname=parent_name AND tgfoid=writer_oid AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_ORIGIN' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_capture_loot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE event public.clan_charter_raid_events%ROWTYPE;post_tx text;rid uuid;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) OR TG_NAME<>TG_TABLE_NAME||'_clan_charter_loot' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_capture_loot()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF NEW.type<>'raid.loot' OR NEW.idempotency_key!~'^raid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:loot$' THEN RETURN NULL;END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
  rid:=substring(NEW.idempotency_key FROM 6 FOR 36)::uuid;
  SELECT * INTO event FROM public.clan_charter_raid_events WHERE raid_id=rid;IF NOT FOUND THEN RETURN NULL;END IF;
  INSERT INTO public.clan_charter_loot_posts VALUES(NEW.id,event.raid_id,event.source_id,pg_current_xact_id()::text,to_jsonb(NEW));
 ELSE
  SELECT tx_key INTO post_tx FROM public.clan_charter_loot_posts WHERE ledger_id=NEW.txn_id;IF NOT FOUND THEN RETURN NULL;END IF;
  -- Later-added legs are intentionally not INSERT witnesses for an old post.
  -- The owner reader detects their presence by complete raw-entry comparison.
  IF post_tx<>pg_current_xact_id()::text THEN RETURN NULL;END IF;
  INSERT INTO public.clan_charter_loot_entries SELECT NEW.id,NEW.txn_id,post_tx,to_jsonb(NEW),to_jsonb(a)-'balance' FROM public.accounts a WHERE a.id=NEW.account_id;
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_capture_chest() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source uuid;difference bigint;candidates uuid[];xid text:=pg_current_xact_id()::text;
BEGIN
 IF TG_RELID<>'public.clans'::regclass OR TG_NAME<>'clans_clan_charter_chest' OR TG_WHEN<>'AFTER' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_capture_chest()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF NEW.chest_shards<=OLD.chest_shards THEN RETURN NULL;END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 SELECT source_id INTO source FROM public.clan_charter_event_source;IF NOT FOUND THEN RETURN NULL;END IF;
 difference:=NEW.chest_shards-OLD.chest_shards;
 SELECT coalesce(array_agg(p.ledger_id ORDER BY p.ledger_id),'{}'::uuid[]) INTO candidates FROM public.clan_charter_loot_posts p
 WHERE p.tx_key=xid AND NOT EXISTS(SELECT 1 FROM public.clan_charter_chest_updates u WHERE u.ledger_id=p.ledger_id)
 AND 1=(SELECT count(*) FROM public.clan_charter_loot_entries w WHERE w.ledger_id=p.ledger_id AND w.tx_key=xid
  AND w.account_identity->>'kind'='clan_chest' AND w.account_identity->>'currency'='SHARDS'
  AND w.account_identity->'owner_wallet'='null'::jsonb AND w.account_identity->'base_id'='null'::jsonb AND (w.original_entry->>'delta')::bigint>0)
 AND EXISTS(SELECT 1 FROM public.clan_charter_loot_entries w WHERE w.ledger_id=p.ledger_id AND w.tx_key=xid
  AND w.account_identity->>'kind'='clan_chest' AND w.account_identity->>'currency'='SHARDS'
  AND w.account_identity->'owner_wallet'='null'::jsonb AND w.account_identity->'base_id'='null'::jsonb AND (w.original_entry->>'delta')::bigint=difference);
 -- Destination is the actual updated row, even when admission named another
 -- clan or no clan. Ambiguity/unmatched observations never alter the money path.
 INSERT INTO public.clan_charter_chest_updates VALUES(gen_random_uuid(),source,NEW.id,xid,to_jsonb(OLD),to_jsonb(NEW),difference,
  CASE cardinality(candidates) WHEN 0 THEN 'unmatched' WHEN 1 THEN 'matched' ELSE 'ambiguous' END,candidates,CASE WHEN cardinality(candidates)=1 THEN candidates[1] ELSE NULL END);
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_capture_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE event public.clan_charter_raid_events%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raids_clan_charter_terminal' OR TG_WHEN<>'AFTER' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_capture_terminal()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF NOT((OLD.status='resolving' AND NEW.status='resolved') OR(OLD.status='pending_orders' AND NEW.status='expired')) THEN RETURN NULL;END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 SELECT * INTO event FROM public.clan_charter_raid_events WHERE raid_id=NEW.id;IF NOT FOUND THEN RETURN NULL;END IF;
 IF(OLD.id,OLD.attacker_wallet,OLD.attacker_base_id,OLD.defender_wallet,OLD.defender_base_id,OLD.pve_camp_id,OLD.campaign_stage,OLD.created_at)
 IS DISTINCT FROM(event.raid_id,event.attacker_wallet,event.attacker_base_id,event.defender_wallet,event.defender_base_id,event.pve_camp_id,event.campaign_stage,event.admitted_at)
 OR(NEW.id,NEW.attacker_wallet,NEW.attacker_base_id,NEW.defender_wallet,NEW.defender_base_id,NEW.pve_camp_id,NEW.campaign_stage,NEW.created_at)
 IS DISTINCT FROM(event.raid_id,event.attacker_wallet,event.attacker_base_id,event.defender_wallet,event.defender_base_id,event.pve_camp_id,event.campaign_stage,event.admitted_at)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
 INSERT INTO public.clan_charter_raid_terminals VALUES(NEW.id,event.source_id,pg_current_xact_id()::text,to_jsonb(OLD),to_jsonb(NEW),NEW.status::text);RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_clan_charter_terminal_witness_guard(),public.shardkeep_clan_charter_capture_loot(),public.shardkeep_clan_charter_capture_chest(),public.shardkeep_clan_charter_capture_terminal() FROM PUBLIC;
REVOKE ALL ON public.clan_charter_loot_posts,public.clan_charter_loot_entries,public.clan_charter_chest_updates,public.clan_charter_raid_terminals FROM PUBLIC;
--> statement-breakpoint
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['clan_charter_loot_posts','clan_charter_loot_entries','clan_charter_chest_updates','clan_charter_raid_terminals'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_terminal_witness_guard()',t||'_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_clan_charter_terminal_witness_guard()',t||'_no_truncate',t);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ledger_transactions'::regclass AND tgname='ledger_transactions_clan_charter_loot') THEN CREATE TRIGGER ledger_transactions_clan_charter_loot AFTER INSERT ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_capture_loot();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ledger_entries'::regclass AND tgname='ledger_entries_clan_charter_loot') THEN CREATE TRIGGER ledger_entries_clan_charter_loot AFTER INSERT ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_capture_loot();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clans'::regclass AND tgname='clans_clan_charter_chest') THEN CREATE TRIGGER clans_clan_charter_chest AFTER UPDATE ON public.clans FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_capture_chest();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.raids'::regclass AND tgname='raids_clan_charter_terminal') THEN CREATE TRIGGER raids_clan_charter_terminal AFTER UPDATE ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_capture_terminal();END IF;
END $$;
