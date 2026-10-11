-- B6p prospective rule capture and enduring original-clan chest proof only.
-- Existing-table hooks and their RC requirement remain S5-held. No backfill,
-- member payments, signing authority, or protected submitOrders integration.
-- Enrolled raid IDs are retained: DELETE/TRUNCATE and terminal reopening refuse.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.clan_charter_raid_tithe_rules(
 id uuid PRIMARY KEY,source_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_event_source(source_id),
 version integer NOT NULL CHECK(version=1),rate_source text NOT NULL CHECK(rate_source='CLANS.chestTitheBps'),
 tithe_bps integer NOT NULL CHECK(tithe_bps>=0),basis_points integer NOT NULL CHECK(basis_points>tithe_bps),
 enrolled_at timestamptz NOT NULL CHECK(isfinite(enrolled_at))
);
ALTER TABLE public.clan_charter_raid_events ADD COLUMN IF NOT EXISTS tithe_rule_id uuid
 REFERENCES public.clan_charter_raid_tithe_rules(id);
-- A prospective source-state witness. This is not a terminal state machine.
-- Deleted clans retain a permanent tombstone; no recapture or reparenting.
CREATE TABLE IF NOT EXISTS public.clan_charter_raid_chest_heads(
 clan_id uuid PRIMARY KEY,rule_id uuid NOT NULL REFERENCES public.clan_charter_raid_tithe_rules(id),
 first_raid_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_raid_events(raid_id),
 revision bigint NOT NULL CHECK(revision>=0),clan_state jsonb,
 CHECK(clan_state IS NULL OR(clan_state->>'id'=clan_id::text AND jsonb_typeof(clan_state)='object'))
);
ALTER TABLE public.clan_charter_chest_updates ADD COLUMN IF NOT EXISTS chest_predecessor_revision bigint;
CREATE UNIQUE INDEX IF NOT EXISTS clan_charter_chest_updates_predecessor_uq
 ON public.clan_charter_chest_updates(actual_clan_id,chest_predecessor_revision)
 WHERE chest_predecessor_revision IS NOT NULL;
ALTER TABLE public.clan_charter_raid_events ADD COLUMN IF NOT EXISTS chest_admission_tx text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.clan_charter_raid_tithe_rules'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_OWNER' USING ERRCODE='42501';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_rule_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF TG_RELID<>'public.clan_charter_raid_tithe_rules'::regclass
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_IMMUTABLE';END IF;
 LOCK TABLE public.raids IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.raids WHERE status NOT IN('resolved','expired')) THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PENDING_RAIDS';END IF;
 IF NEW.source_id IS DISTINCT FROM(SELECT source_id FROM public.clan_charter_event_source)
 OR NEW.tithe_bps IS NULL OR NEW.basis_points IS NULL OR NEW.tithe_bps<0 OR NEW.basis_points<=NEW.tithe_bps
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_SOURCE';END IF;
 NEW.id:=gen_random_uuid();NEW.version:=1;NEW.rate_source:='CLANS.chestTitheBps';NEW.enrolled_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_rule_initialize(rate integer,divisor integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source uuid;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 LOCK TABLE public.raids IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules) THEN RETURN;END IF;
 IF EXISTS(SELECT 1 FROM public.raids WHERE status NOT IN('resolved','expired')) THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PENDING_RAIDS';END IF;
 SELECT source_id INTO source FROM public.shardkeep_clan_charter_event_source_initialize();
 INSERT INTO public.clan_charter_raid_tithe_rules(source_id,tithe_bps,basis_points) VALUES(source,rate,divisor);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_rule_read() RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 SELECT jsonb_build_object('id',r.id,'sourceId',r.source_id,'version',r.version,'rateSource',r.rate_source,
  'titheBps',r.tithe_bps,'basisPoints',r.basis_points,'enrolledAt',to_char(r.enrolled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 INTO result FROM public.clan_charter_raid_tithe_rules r JOIN public.clan_charter_event_source s USING(source_id);
 IF result IS NULL AND EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules) THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_capture_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rule uuid;
BEGIN
 IF TG_RELID<>'public.clan_charter_raid_events'::regclass OR TG_NAME<>'clan_charter_raid_events_aa_chest_rule'
 OR TG_WHEN<>'BEFORE' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 SELECT id INTO rule FROM public.clan_charter_raid_tithe_rules WHERE source_id=NEW.source_id;
 NEW.tithe_rule_id:=rule;NEW.chest_admission_tx:=CASE WHEN rule IS NOT NULL THEN pg_current_xact_id()::text ELSE NULL END;
 -- Enrollment permits only terminal predecessors. The source hook below
 -- prohibits reopening/deleting them; every eligible pending row is therefore
 -- a new INSERT captured synchronously by the mandatory canonical AFTER hook.
 -- Gameplay timestamps and subtransaction xmin are not admission authority.
 IF rule IS NOT NULL AND(NOT EXISTS(SELECT 1 FROM public.raids r WHERE r.id=NEW.raid_id
  AND r.status='pending_orders')
  OR EXISTS(SELECT 1 FROM public.clan_charter_raid_events WHERE raid_id=NEW.raid_id))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_head_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.clan_charter_raid_events%ROWTYPE;current_clan jsonb;difference bigint;w public.clan_charter_chest_updates%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.clan_charter_raid_chest_heads'::regclass
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_IMMUTABLE';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
 IF TG_OP='INSERT' THEN
  SELECT * INTO e FROM public.clan_charter_raid_events WHERE raid_id=NEW.first_raid_id;
  IF NOT FOUND OR e.tithe_rule_id IS NULL OR e.original_clan_id IS DISTINCT FROM NEW.clan_id
   OR e.chest_admission_tx IS DISTINCT FROM pg_current_xact_id()::text OR current_clan IS NULL
   OR EXISTS(SELECT 1 FROM public.clan_charter_raid_events p WHERE p.original_clan_id=NEW.clan_id
    AND p.tithe_rule_id IS NOT NULL AND p.raid_id<>e.raid_id)
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules r WHERE r.id=e.tithe_rule_id AND r.source_id=e.source_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_SOURCE';END IF;
  NEW.rule_id:=e.tithe_rule_id;NEW.revision:=0;NEW.clan_state:=current_clan;RETURN NEW;
 END IF;
 IF(NEW.clan_id,NEW.rule_id,NEW.first_raid_id) IS DISTINCT FROM(OLD.clan_id,OLD.rule_id,OLD.first_raid_id)
 OR OLD.clan_state IS NULL AND current_clan IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_IMMUTABLE';END IF;
 IF OLD.clan_state IS NOT DISTINCT FROM current_clan THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;RETURN OLD;
 END IF;
 IF NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.clan_state IS DISTINCT FROM current_clan THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF current_clan IS NOT NULL THEN
  difference:=(current_clan->>'chest_shards')::bigint-(OLD.clan_state->>'chest_shards')::bigint;
  IF difference>0 THEN
   SELECT * INTO w FROM public.clan_charter_chest_updates WHERE actual_clan_id=OLD.clan_id AND chest_predecessor_revision=OLD.revision;
   IF NOT FOUND OR w.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR w.before_clan IS DISTINCT FROM OLD.clan_state
    OR w.after_clan IS DISTINCT FROM current_clan OR w.delta IS DISTINCT FROM difference
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_events event WHERE event.original_clan_id=OLD.clan_id
   AND public.shardkeep_clan_charter_raid_chest_proof(event.raid_id,true)->>'status' IS DISTINCT FROM 'reconciled')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PENDING';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_capture_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.clan_charter_raid_chest_heads%ROWTYPE;current_clan jsonb;cid uuid;
BEGIN
 IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 OR NOT((TG_RELID='public.clan_charter_raid_events'::regclass AND TG_NAME='clan_charter_raid_events_chest_head' AND TG_OP='INSERT')
  OR(TG_RELID='public.clans'::regclass AND TG_NAME='clans_clan_charter_zz_chest_head' AND TG_OP IN('UPDATE','DELETE')))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF TG_TABLE_NAME='clan_charter_raid_events' THEN
  IF NEW.tithe_rule_id IS NULL OR NEW.original_clan_id IS NULL THEN RETURN NULL;END IF;cid:=NEW.original_clan_id;
 ELSE cid:=OLD.id;END IF;
 -- Source clan mutation already owns this lock; event admission follows the
 -- same clan→head order. NOWAIT prevents inversion for raw owner callers.
 SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=cid FOR UPDATE NOWAIT;
 SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=cid FOR UPDATE NOWAIT;
 IF TG_TABLE_NAME='clan_charter_raid_events' THEN
  IF NOT FOUND THEN
   INSERT INTO public.clan_charter_raid_chest_heads(clan_id,first_raid_id) VALUES(cid,NEW.raid_id);
  ELSIF h.rule_id IS DISTINCT FROM NEW.tithe_rule_id OR h.clan_state IS DISTINCT FROM current_clan OR h.clan_state IS NULL
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 ELSIF FOUND AND h.clan_state IS DISTINCT FROM current_clan THEN
  UPDATE public.clan_charter_raid_chest_heads SET revision=revision+1,clan_state=current_clan WHERE clan_id=cid;
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_witness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.clan_charter_raid_chest_heads%ROWTYPE;current_clan jsonb;difference bigint;
BEGIN
 IF TG_RELID<>'public.clan_charter_chest_updates'::regclass OR TG_NAME<>'clan_charter_chest_updates_raid_chest_guard'
 OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=NEW.actual_clan_id FOR UPDATE NOWAIT;
 SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=NEW.actual_clan_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN NEW.chest_predecessor_revision:=NULL;RETURN NEW;END IF;
 difference:=(current_clan->>'chest_shards')::bigint-(h.clan_state->>'chest_shards')::bigint;
 IF h.clan_state IS NULL OR current_clan IS NULL OR difference IS NULL OR difference<=0
 OR NEW.before_clan IS DISTINCT FROM h.clan_state OR NEW.after_clan IS DISTINCT FROM current_clan
 OR NEW.delta IS DISTINCT FROM difference OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text
 OR NEW.pairing IS DISTINCT FROM 'matched' OR cardinality(NEW.candidate_ledger_ids) IS DISTINCT FROM 1
 OR NEW.ledger_id IS DISTINCT FROM NEW.candidate_ledger_ids[1]
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_loot_posts p JOIN public.clan_charter_raid_events e ON e.raid_id=p.raid_id
  WHERE p.ledger_id=NEW.ledger_id AND p.tx_key=NEW.tx_key AND p.source_id=NEW.source_id
  AND e.tithe_rule_id=h.rule_id AND e.original_clan_id=h.clan_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 NEW.chest_predecessor_revision:=h.revision;RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_proof(rid uuid,terminal_required boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.clan_charter_raid_events%ROWTYPE;r public.raids%ROWTYPE;rule public.clan_charter_raid_tithe_rules%ROWTYPE;
 h public.clan_charter_raid_chest_heads%ROWTYPE;t public.clan_charter_raid_terminals%ROWTYPE;p public.clan_charter_loot_posts%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;ids uuid[];credits bigint;entries bigint;attack bigint;defend bigint;pool bigint;
 sum_delta numeric;gross numeric;net numeric;cut numeric;expected_cut numeric;valid boolean;current_clan jsonb;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RETURN jsonb_build_object('status','held','reason','hooks_missing');END IF;
 SELECT * INTO e FROM public.clan_charter_raid_events WHERE raid_id=rid;
 IF NOT FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source) THEN RETURN jsonb_build_object('status','unenrolled');END IF;
  RETURN jsonb_build_object('status','held','reason','admission_missing');
 END IF;
 SELECT * INTO r FROM public.raids WHERE id=rid;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=e.source_id)
 OR(e.attacker_wallet,e.attacker_base_id,e.defender_wallet,e.defender_base_id,e.pve_camp_id,e.campaign_stage,e.admitted_at)
 IS DISTINCT FROM(r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,r.pve_camp_id,r.campaign_stage,r.created_at)
 OR e.kind IS DISTINCT FROM(CASE WHEN r.campaign_stage IS NOT NULL THEN 'campaign' WHEN r.pve_camp_id IS NOT NULL THEN 'pve'
   WHEN r.attacker_base_id IS NOT NULL AND r.defender_base_id IS NOT NULL THEN 'deed_pvp' ELSE 'legacy_pvp' END)
 OR num_nonnulls(e.defender_wallet,e.pve_camp_id,e.campaign_stage)<>1 OR e.defender_wallet=e.attacker_wallet
 OR(e.defender_base_id IS NOT NULL AND e.defender_wallet IS NULL) OR e.campaign_stage<=0
 OR(e.original_clan_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clan_charter_event_heads x WHERE x.clan_id=e.original_clan_id
  AND x.ordinal=(SELECT count(*) FROM public.clan_charter_raid_events n WHERE n.original_clan_id=e.original_clan_id)
  AND x.ordinal=(SELECT max(clan_ordinal) FROM public.clan_charter_raid_events n WHERE n.original_clan_id=e.original_clan_id)))
 THEN RETURN jsonb_build_object('status','held','reason','admission_mismatch');END IF;
 IF e.tithe_rule_id IS NULL THEN RETURN jsonb_build_object('status','held','reason','rule_missing');END IF;
 SELECT * INTO rule FROM public.clan_charter_raid_tithe_rules WHERE id=e.tithe_rule_id AND source_id=e.source_id;
 IF NOT FOUND OR rule.version<>1 OR rule.rate_source<>'CLANS.chestTitheBps' OR rule.tithe_bps<0 OR rule.basis_points<=rule.tithe_bps
 OR e.chest_admission_tx IS NULL THEN RETURN jsonb_build_object('status','held','reason','rule_mismatch');END IF;
 IF e.original_clan_id IS NOT NULL THEN
  SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=e.original_clan_id;
  SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=e.original_clan_id;
  IF h.clan_id IS NULL OR h.rule_id IS DISTINCT FROM rule.id
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
    AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id)
  THEN RETURN jsonb_build_object('status','held','reason','head_mismatch');END IF;
 END IF;
 SELECT * INTO t FROM public.clan_charter_raid_terminals WHERE raid_id=rid;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO ids FROM(
  SELECT ledger_id id FROM public.clan_charter_loot_posts WHERE raid_id=rid
  UNION SELECT id FROM public.ledger_transactions WHERE idempotency_key='raid:'||rid::text||':loot'
   OR(type='raid.loot' AND metadata->>'raidId'=rid::text)) found;
 IF t.raid_id IS NULL THEN
  IF NOT terminal_required AND cardinality(ids)=0 AND r.status IN('pending_orders','resolving') THEN RETURN jsonb_build_object('status','pending');END IF;
  RETURN jsonb_build_object('status','held','reason','terminal_missing');
 END IF;
 IF t.source_id IS DISTINCT FROM e.source_id OR t.after_raid IS DISTINCT FROM to_jsonb(r)
 OR t.after_raid->>'status' IS DISTINCT FROM t.terminal_status OR t.before_raid->>'id' IS DISTINCT FROM rid::text
 OR NOT((t.terminal_status='resolved' AND t.before_raid->>'status'='resolving' AND r.resolved_at IS NOT NULL)
  OR(t.terminal_status='expired' AND t.before_raid->>'status'='pending_orders'))
 OR jsonb_build_array(t.before_raid->'attacker_wallet',t.before_raid->'attacker_base_id',t.before_raid->'defender_wallet',t.before_raid->'defender_base_id',t.before_raid->'pve_camp_id',t.before_raid->'campaign_stage',t.before_raid->'created_at')
  IS DISTINCT FROM jsonb_build_array(t.after_raid->'attacker_wallet',t.after_raid->'attacker_base_id',t.after_raid->'defender_wallet',t.after_raid->'defender_base_id',t.after_raid->'pve_camp_id',t.after_raid->'campaign_stage',t.after_raid->'created_at')
 THEN RETURN jsonb_build_object('status','held','reason','terminal_mismatch');END IF;
 SELECT count(*) INTO credits FROM public.clan_charter_chest_updates c WHERE c.ledger_id=ANY(ids)
  OR c.candidate_ledger_ids&&ids OR(c.tx_key=t.tx_key AND c.ledger_id IS NULL);
 IF cardinality(ids)=0 THEN
  IF credits<>0 OR(t.terminal_status='resolved' AND e.kind='legacy_pvp' AND t.after_raid->'result'->>'lootShards' IS DISTINCT FROM '0')
  THEN RETURN jsonb_build_object('status','held','reason','loot_missing');END IF;
  cut:=0;
 ELSE
  IF cardinality(ids)<>1 OR e.kind<>'legacy_pvp' OR t.terminal_status<>'resolved' THEN RETURN jsonb_build_object('status','held','reason','unexpected_loot');END IF;
  SELECT * INTO p FROM public.clan_charter_loot_posts WHERE ledger_id=ids[1];
  IF NOT FOUND OR p.raid_id IS DISTINCT FROM rid OR p.source_id IS DISTINCT FROM e.source_id OR p.tx_key IS DISTINCT FROM t.tx_key
   OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions actual WHERE actual.id=p.ledger_id AND actual.type='raid.loot'
    AND actual.idempotency_key='raid:'||rid::text||':loot' AND to_jsonb(actual)=p.original_transaction)
  THEN RETURN jsonb_build_object('status','held','reason','loot_mismatch');END IF;
  WITH all_ids AS(SELECT entry_id id FROM public.clan_charter_loot_entries WHERE ledger_id=p.ledger_id
    UNION SELECT id FROM public.ledger_entries WHERE txn_id=p.ledger_id), legs AS(
   SELECT actual.delta,a.kind,a.owner_wallet,a.currency,a.base_id,
    (saved.ledger_id=p.ledger_id AND saved.tx_key=p.tx_key AND saved.original_entry=to_jsonb(actual)
     AND saved.account_identity=to_jsonb(a)-'balance' AND actual.txn_id=p.ledger_id) okay
   FROM all_ids LEFT JOIN public.ledger_entries actual ON actual.id=all_ids.id
    LEFT JOIN public.accounts a ON a.id=actual.account_id LEFT JOIN public.clan_charter_loot_entries saved ON saved.entry_id=all_ids.id)
  SELECT count(*),bool_and(coalesce(okay,false) AND currency='SHARDS' AND base_id IS NULL),sum(delta),
   count(*) FILTER(WHERE kind='player_shards' AND owner_wallet=e.attacker_wallet AND delta>0),
   count(*) FILTER(WHERE kind='player_shards' AND owner_wallet=e.defender_wallet AND delta<0),
   count(*) FILTER(WHERE kind='clan_chest' AND owner_wallet IS NULL AND delta>0),
   sum(delta) FILTER(WHERE kind='player_shards' AND owner_wallet=e.attacker_wallet AND delta>0),
   -sum(delta) FILTER(WHERE kind='player_shards' AND owner_wallet=e.defender_wallet AND delta<0),
   coalesce(sum(delta) FILTER(WHERE kind='clan_chest' AND owner_wallet IS NULL AND delta>0),0)
  INTO entries,valid,sum_delta,attack,defend,pool,net,gross,cut FROM legs;
  expected_cut:=CASE WHEN e.original_clan_id IS NULL THEN 0 ELSE floor(gross*rule.tithe_bps/rule.basis_points) END;
  IF valid IS DISTINCT FROM true OR entries NOT IN(2,3) OR attack<>1 OR defend<>1 OR pool>1 OR entries<>attack+defend+pool
   OR sum_delta IS DISTINCT FROM 0::numeric OR cut IS DISTINCT FROM expected_cut
   OR t.after_raid->'result'->>'lootShards' IS DISTINCT FROM net::text
   OR p.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('raidId',rid::text,'attacker',e.attacker_wallet,'defender',e.defender_wallet,'clanChest',cut::text)
  THEN RETURN jsonb_build_object('status','held','reason','loot_conservation');END IF;
  IF cut=0 THEN
   IF credits<>0 OR entries<>2 THEN RETURN jsonb_build_object('status','held','reason','unexpected_credit');END IF;
  ELSE
   SELECT * INTO w FROM public.clan_charter_chest_updates WHERE ledger_id=p.ledger_id;
   IF credits<>1 OR w.id IS NULL OR w.actual_clan_id IS DISTINCT FROM e.original_clan_id OR w.source_id IS DISTINCT FROM e.source_id
    OR w.tx_key IS DISTINCT FROM p.tx_key OR w.delta IS DISTINCT FROM cut OR w.pairing IS DISTINCT FROM 'matched'
    OR w.candidate_ledger_ids IS DISTINCT FROM ARRAY[p.ledger_id] OR w.chest_predecessor_revision IS NULL
    OR w.chest_predecessor_revision>=h.revision OR w.before_clan->>'id' IS DISTINCT FROM e.original_clan_id::text
    OR w.after_clan->>'id' IS DISTINCT FROM e.original_clan_id::text
    OR w.before_clan-'chest_shards' IS DISTINCT FROM w.after_clan-'chest_shards'
    OR (w.after_clan->>'chest_shards')::bigint-(w.before_clan->>'chest_shards')::bigint IS DISTINCT FROM w.delta
   THEN RETURN jsonb_build_object('status','held','reason','credit_mismatch');END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('status','reconciled','raidId',rid,'originalClanId',e.original_clan_id,'ruleId',rule.id,
  'terminalStatus',t.terminal_status,'chestShards',cut::text);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_read(rid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE current_clan jsonb;h public.clan_charter_raid_chest_heads%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 SELECT head.* INTO h FROM public.clan_charter_raid_chest_heads head JOIN public.clan_charter_raid_events e ON e.original_clan_id=head.clan_id WHERE e.raid_id=rid;
 IF FOUND THEN
  SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE c.id=h.clan_id;
  IF h.clan_state IS DISTINCT FROM current_clan THEN RETURN jsonb_build_object('status','held','reason','head_mismatch');END IF;
 END IF;
 RETURN public.shardkeep_clan_charter_raid_chest_proof(rid,true);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_resolve(rid uuid,actor text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.clan_charter_raid_events%ROWTYPE;r public.raids%ROWTYPE;rule public.clan_charter_raid_tithe_rules%ROWTYPE;cid uuid;current_clan jsonb;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 SELECT * INTO r FROM public.raids WHERE id=rid FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.attacker_wallet IS DISTINCT FROM actor OR r.defender_wallet IS NULL OR r.attacker_base_id IS NOT NULL OR r.defender_base_id IS NOT NULL
  OR r.pve_camp_id IS NOT NULL OR r.campaign_stage IS NOT NULL OR r.status NOT IN('pending_orders','resolving') THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source) THEN
  SELECT c.id INTO cid FROM public.clan_members m JOIN public.clans c ON c.id=m.clan_id WHERE m.player_wallet=actor FOR UPDATE OF c;
  RETURN jsonb_build_object('history','unenrolled','clanId',cid);
 END IF;
 SELECT * INTO e FROM public.clan_charter_raid_events WHERE raid_id=rid FOR UPDATE NOWAIT;
 IF NOT FOUND OR e.tithe_rule_id IS NULL OR public.shardkeep_clan_charter_raid_chest_proof(rid,false)->>'status' IS DISTINCT FROM 'pending'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF e.original_clan_id IS NOT NULL THEN
  SELECT id INTO cid FROM public.clans WHERE id=e.original_clan_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=cid;
  IF NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_chest_heads h WHERE h.clan_id=cid AND h.clan_state=current_clan)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 END IF;
 SELECT * INTO STRICT rule FROM public.clan_charter_raid_tithe_rules WHERE id=e.tithe_rule_id;
 RETURN jsonb_build_object('history','captured','clanId',cid,'titheBps',rule.tithe_bps,'basisPoints',rule.basis_points);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_affected(tab text,value jsonb) RETURNS uuid[]
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ids uuid[]:='{}'::uuid[];clan_key uuid;raw text;parent jsonb;
BEGIN
 IF value IS NULL THEN RETURN ids;END IF;
 IF tab='ledger_transactions' THEN
  raw:=value->>'idempotency_key';
  IF raw~'^raid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:loot$' THEN ids:=array_append(ids,substring(raw FROM 6 FOR 36)::uuid);END IF;
  raw:=value->'metadata'->>'raidId';
  IF value->>'type'='raid.loot' AND raw~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ids:=array_append(ids,raw::uuid);END IF;
  ids:=ids||ARRAY(SELECT raid_id FROM public.clan_charter_loot_posts WHERE ledger_id=(value->>'id')::uuid);
 ELSIF tab='ledger_entries' THEN
  SELECT to_jsonb(t) INTO parent FROM public.ledger_transactions t WHERE t.id=(value->>'txn_id')::uuid;
  ids:=public.shardkeep_clan_charter_raid_chest_affected('ledger_transactions',parent)
   ||ARRAY(SELECT p.raid_id FROM public.clan_charter_loot_entries w JOIN public.clan_charter_loot_posts p ON p.ledger_id=w.ledger_id WHERE w.entry_id=(value->>'id')::bigint);
 ELSIF tab='accounts' THEN
  ids:=ARRAY(SELECT DISTINCT p.raid_id FROM public.clan_charter_loot_posts p JOIN public.clan_charter_loot_entries w ON w.ledger_id=p.ledger_id
   WHERE w.original_entry->>'account_id'=value->>'id');
 ELSIF tab='raids' THEN ids:=ARRAY[(value->>'id')::uuid];
 ELSIF tab='clan_charter_raid_events' THEN ids:=ARRAY[(value->>'raid_id')::uuid];
 ELSIF tab IN('clans','clan_charter_raid_chest_heads') THEN
  clan_key:=coalesce(value->>'clan_id',value->>'id')::uuid;
  ids:=ARRAY(SELECT e.raid_id FROM public.clan_charter_raid_events e WHERE e.original_clan_id=clan_key);
 ELSIF tab='clan_charter_chest_updates' THEN
  ids:=ARRAY(SELECT p.raid_id FROM public.clan_charter_loot_posts p WHERE p.ledger_id=(value->>'ledger_id')::uuid
   OR p.ledger_id IN(SELECT jsonb_array_elements_text(value->'candidate_ledger_ids')::uuid));
 END IF;
 RETURN ARRAY(SELECT DISTINCT e.raid_id FROM public.clan_charter_raid_events e WHERE e.raid_id=ANY(ids) AND e.tithe_rule_id IS NOT NULL ORDER BY e.raid_id);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE previous jsonb;next jsonb;ids uuid[];rid uuid;clan uuid;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass,'public.raids'::regclass,'public.clans'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_clan_charter_raid_chest_truncate' ELSE '_clan_charter_raid_chest' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF TG_OP='TRUNCATE' THEN
  -- Empty-only test reset may temporarily disable private retention guards.
  -- No captured history is removable, even when that catalog is incomplete.
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_events WHERE tithe_rule_id IS NOT NULL)
   OR(TG_TABLE_NAME='clans' AND EXISTS(SELECT 1 FROM public.clan_charter_raid_events))
   OR(TG_TABLE_NAME='raids' AND EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;RETURN NULL;
 END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 previous:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
 next:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
 IF TG_OP='UPDATE' AND(previous=next OR(TG_TABLE_NAME='accounts' AND previous-'balance'=next-'balance')) THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='clans' THEN
  -- Deletion/rekey uses the caller's clan tuple lock, never a blocking money
  -- or raid lock. Admission and settlement use this same mutex with NOWAIT.
  -- Historical B6a events without a rule remain held here, including ones
  -- whose narrower B6b observation is readable; no retrospective rate proof.
  IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id) THEN
   FOR rid IN SELECT e.raid_id FROM public.clan_charter_raid_events e WHERE e.original_clan_id=OLD.id ORDER BY e.raid_id LOOP
    IF public.shardkeep_clan_charter_raid_chest_proof(rid,true)->>'status' IS DISTINCT FROM 'reconciled'
    THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PENDING';END IF;
   END LOOP;
  END IF;
  IF TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id AND EXISTS(SELECT 1 FROM public.clan_charter_raid_chest_heads WHERE clan_id=OLD.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 ids:=public.shardkeep_clan_charter_raid_chest_affected(TG_TABLE_NAME,previous)||public.shardkeep_clan_charter_raid_chest_affected(TG_TABLE_NAME,next);
 FOR rid IN SELECT DISTINCT id FROM unnest(ids) id ORDER BY id LOOP
  PERFORM 1 FROM public.clan_charter_raid_events WHERE raid_id=rid FOR UPDATE NOWAIT;
  SELECT original_clan_id INTO clan FROM public.clan_charter_raid_events WHERE raid_id=rid;
  -- A raid-only status change owns the event mutex; its unfinished proof
  -- already prevents dissolution. Money sources additionally own the clan.
  IF clan IS NOT NULL AND TG_TABLE_NAME<>'raids' THEN PERFORM 1 FROM public.clans WHERE id=clan FOR UPDATE NOWAIT;END IF;
  -- Once committed, canonical raw facts are immutable. Ordinary cache balance
  -- updates returned above; unrelated postings never enter this affected set.
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_terminals t WHERE t.raid_id=rid AND t.tx_key<>pg_current_xact_id()::text)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  -- Only actual source transitions can acquire a terminal witness. A TEMP
  -- wrapper cannot supply a fictional predecessor after a direct status jump.
  IF TG_TABLE_NAME='raids' THEN
   IF TG_OP='UPDATE' THEN
    IF NEW.status IN('resolved','expired') AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT((OLD.status='resolving' AND NEW.status='resolved') OR(OLD.status='pending_orders' AND NEW.status='expired'))
    THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
   END IF;
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='raids' THEN
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
   IF TG_OP='UPDATE' THEN
    IF(OLD.status IN('resolved','expired') AND NEW.status IN('pending_orders','resolving'))
     OR(OLD.id,OLD.attacker_wallet,OLD.attacker_base_id,OLD.defender_wallet,OLD.defender_base_id,OLD.pve_camp_id,OLD.campaign_stage,OLD.created_at)
      IS DISTINCT FROM(NEW.id,NEW.attacker_wallet,NEW.attacker_base_id,NEW.defender_wallet,NEW.defender_base_id,NEW.pve_camp_id,NEW.campaign_stage,NEW.created_at)
    THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE ids uuid[];rid uuid;h public.clan_charter_raid_chest_heads%ROWTYPE;current_clan jsonb;status text;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass,'public.raids'::regclass,'public.clans'::regclass,
  'public.clan_charter_raid_events'::regclass,'public.clan_charter_raid_chest_heads'::regclass,'public.clan_charter_chest_updates'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_clan_charter_raid_chest_complete' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF TG_OP='UPDATE' AND(to_jsonb(OLD)=to_jsonb(NEW) OR(TG_TABLE_NAME='accounts' AND to_jsonb(OLD)-'balance'=to_jsonb(NEW)-'balance')) THEN RETURN NULL;END IF;
 ids:=public.shardkeep_clan_charter_raid_chest_affected(TG_TABLE_NAME,CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END)
  ||public.shardkeep_clan_charter_raid_chest_affected(TG_TABLE_NAME,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END);
 FOR rid IN SELECT DISTINCT id FROM unnest(ids) id ORDER BY id LOOP
  PERFORM 1 FROM public.clan_charter_raid_events WHERE raid_id=rid FOR UPDATE NOWAIT;
  SELECT head.* INTO h FROM public.clan_charter_raid_chest_heads head JOIN public.clan_charter_raid_events e ON e.original_clan_id=head.clan_id WHERE e.raid_id=rid;
  IF FOUND THEN
   SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=h.clan_id;
   IF h.clan_state IS DISTINCT FROM current_clan THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  END IF;
  status:=public.shardkeep_clan_charter_raid_chest_proof(rid,false)->>'status';
  IF status NOT IN('pending','reconciled') OR status IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 END LOOP;RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_hooks() RETURNS boolean
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 WITH expected(rel,name,fn,kind,deferred,definer) AS(
  VALUES
  ('clan_charter_raid_tithe_rules','clan_charter_raid_tithe_rules_guard','shardkeep_clan_charter_raid_chest_rule_guard',31,false,false),
  ('clan_charter_raid_tithe_rules','clan_charter_raid_tithe_rules_no_truncate','shardkeep_clan_charter_raid_chest_rule_guard',34,false,false),
  ('clan_charter_raid_chest_heads','clan_charter_raid_chest_heads_guard','shardkeep_clan_charter_raid_chest_head_guard',31,false,false),
  ('clan_charter_raid_chest_heads','clan_charter_raid_chest_heads_no_truncate','shardkeep_clan_charter_raid_chest_head_guard',34,false,false),
  ('clan_charter_raid_events','clan_charter_raid_events_aa_chest_rule','shardkeep_clan_charter_raid_chest_capture_rule',7,false,true),
  ('clan_charter_raid_events','clan_charter_raid_events_chest_head','shardkeep_clan_charter_raid_chest_capture_head',5,false,true),
  ('clans','clans_clan_charter_zz_chest_head','shardkeep_clan_charter_raid_chest_capture_head',25,false,true),
  ('clan_charter_chest_updates','clan_charter_chest_updates_raid_chest_guard','shardkeep_clan_charter_raid_chest_witness_guard',7,false,false),
  ('raids','raids_clan_charter_capture','shardkeep_clan_charter_capture_raid',5,false,true),
  ('raids','raids_clan_charter_terminal','shardkeep_clan_charter_capture_terminal',17,false,true),
  ('ledger_transactions','ledger_transactions_clan_charter_loot','shardkeep_clan_charter_capture_loot',5,false,true),
  ('ledger_entries','ledger_entries_clan_charter_loot','shardkeep_clan_charter_capture_loot',5,false,true),
  ('clans','clans_clan_charter_chest','shardkeep_clan_charter_capture_chest',17,false,true)
  UNION ALL SELECT rel,rel||'_guard','shardkeep_clan_charter_terminal_witness_guard',31,false,false
   FROM unnest(ARRAY['clan_charter_loot_posts','clan_charter_loot_entries','clan_charter_chest_updates','clan_charter_raid_terminals']) rel
  UNION ALL SELECT rel,rel||'_no_truncate','shardkeep_clan_charter_terminal_witness_guard',34,false,false
   FROM unnest(ARRAY['clan_charter_loot_posts','clan_charter_loot_entries','clan_charter_chest_updates','clan_charter_raid_terminals']) rel
  UNION ALL SELECT rel,rel||'_guard','shardkeep_clan_charter_event_guard',31,false,false
   FROM unnest(ARRAY['clan_charter_event_source','clan_charter_event_heads','clan_charter_raid_events']) rel
  UNION ALL SELECT rel,rel||'_no_truncate','shardkeep_clan_charter_event_guard',34,false,false
   FROM unnest(ARRAY['clan_charter_event_source','clan_charter_event_heads','clan_charter_raid_events']) rel
  UNION ALL SELECT rel,rel||'_clan_charter_raid_chest','shardkeep_clan_charter_raid_chest_source',31,false,true
   FROM unnest(ARRAY['ledger_transactions','ledger_entries','accounts','raids','clans']) rel
  UNION ALL SELECT rel,rel||'_clan_charter_raid_chest_truncate','shardkeep_clan_charter_raid_chest_source',34,false,true
   FROM unnest(ARRAY['ledger_transactions','ledger_entries','accounts','raids','clans']) rel
  UNION ALL SELECT rel,rel||'_clan_charter_raid_chest_complete','shardkeep_clan_charter_raid_chest_complete',29,true,true
   FROM unnest(ARRAY['ledger_transactions','ledger_entries','accounts','raids','clans','clan_charter_raid_events','clan_charter_raid_chest_heads','clan_charter_chest_updates']) rel
 ) SELECT NOT EXISTS(SELECT 1 FROM expected x WHERE NOT EXISTS(
  SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
  WHERE t.tgrelid=to_regclass('public.'||x.rel) AND t.tgname=x.name AND t.tgfoid=to_regprocedure('public.'||x.fn||'()')
   AND t.tgtype=x.kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgqual IS NULL
   AND t.tgdeferrable=x.deferred AND t.tginitdeferred=x.deferred
   AND p.prosecdef=x.definer AND p.proowner=c.relowner AND c.relowner=(SELECT relowner FROM pg_class WHERE oid='public.clan_charter_raid_tithe_rules'::regclass)))
$$;
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['clan_charter_raid_tithe_rules','clan_charter_raid_chest_heads'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',tab||'_guard',tab,
    CASE WHEN tab='clan_charter_raid_tithe_rules' THEN 'shardkeep_clan_charter_raid_chest_rule_guard' ELSE 'shardkeep_clan_charter_raid_chest_head_guard' END);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.%I()',tab||'_no_truncate',tab,
    CASE WHEN tab='clan_charter_raid_tithe_rules' THEN 'shardkeep_clan_charter_raid_chest_rule_guard' ELSE 'shardkeep_clan_charter_raid_chest_head_guard' END);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_raid_events'::regclass AND tgname='clan_charter_raid_events_aa_chest_rule') THEN
  CREATE TRIGGER clan_charter_raid_events_aa_chest_rule BEFORE INSERT ON public.clan_charter_raid_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_capture_rule();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_raid_events'::regclass AND tgname='clan_charter_raid_events_chest_head') THEN
  CREATE TRIGGER clan_charter_raid_events_chest_head AFTER INSERT ON public.clan_charter_raid_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_capture_head();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clans'::regclass AND tgname='clans_clan_charter_zz_chest_head') THEN
  CREATE TRIGGER clans_clan_charter_zz_chest_head AFTER UPDATE OR DELETE ON public.clans FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_capture_head();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_chest_updates'::regclass AND tgname='clan_charter_chest_updates_raid_chest_guard') THEN
  CREATE TRIGGER clan_charter_chest_updates_raid_chest_guard BEFORE INSERT ON public.clan_charter_chest_updates FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_witness_guard();END IF;
 FOREACH tab IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts','raids','clans'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_clan_charter_raid_chest') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_source()',tab||'_clan_charter_raid_chest',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_clan_charter_raid_chest_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_source()',tab||'_clan_charter_raid_chest_truncate',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts','raids','clans','clan_charter_raid_events','clan_charter_raid_chest_heads','clan_charter_chest_updates'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_clan_charter_raid_chest_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_raid_chest_complete()',tab||'_clan_charter_raid_chest_complete',tab);END IF;
 END LOOP;
 REVOKE ALL ON public.clan_charter_raid_tithe_rules,public.clan_charter_raid_chest_heads FROM PUBLIC;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_clan_charter_raid_chest_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_assert_posting(rid uuid,pid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source) THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clan_charter_loot_posts p JOIN public.clan_charter_raid_events e ON e.raid_id=p.raid_id
  JOIN public.ledger_transactions t ON t.id=p.ledger_id WHERE p.raid_id=rid AND p.ledger_id=pid
  AND e.tithe_rule_id IS NOT NULL AND p.tx_key=pg_current_xact_id()::text AND p.original_transaction=to_jsonb(t))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 -- Completeness is enforced at commit using the same predicate as reads and
 -- dissolution, after the real caller has written its terminal transition.
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_clan_charter_raid_chest_assert_posting(uuid,uuid) FROM PUBLIC;
