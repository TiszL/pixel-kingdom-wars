-- D153.186 prospective source retention. S5 HELD; no runtime grants or activation.
-- Existing v1 journals retain their original admission and posting semantics.
DO $preflight$ BEGIN
 IF to_regclass('public.keep_custody_source_observations') IS NOT NULL OR to_regclass('public.keep_custody_source_windows') IS NOT NULL THEN
  IF to_regclass('public.keep_custody_source_observations') IS NULL OR to_regclass('public.keep_custody_source_windows') IS NULL
   OR to_regprocedure('public.shardkeep_keep_source_assert_hooks()') IS NULL THEN RAISE EXCEPTION 'KEEP_SOURCE_SCHEMA'; END IF;
  PERFORM public.shardkeep_keep_source_assert_hooks();
 END IF;
END $preflight$;
CREATE TABLE IF NOT EXISTS public.keep_custody_source_observations(
 deposit_id uuid NOT NULL REFERENCES public.deposits(id),commitment text NOT NULL CHECK(commitment IN('confirmed','finalized')),
 signature text NOT NULL,observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),proof jsonb NOT NULL,original jsonb NOT NULL,xid xid8 NOT NULL,
 PRIMARY KEY(deposit_id,commitment),UNIQUE(signature,commitment));
CREATE TABLE IF NOT EXISTS public.keep_custody_source_windows(
 id uuid PRIMARY KEY,closed_at timestamptz NOT NULL CHECK(isfinite(closed_at)),inventory jsonb NOT NULL CHECK(jsonb_typeof(inventory)='array'),xid xid8 NOT NULL);
ALTER TABLE public.keep_custody_journal ADD COLUMN IF NOT EXISTS custody_source_xid xid8;
REVOKE ALL ON public.keep_custody_source_observations,public.keep_custody_source_windows FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_owner() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
  OR current_setting('transaction_isolation')<>'read committed'
  OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.keep_custody_source_observations'::regclass)
  OR EXISTS(SELECT 1 FROM pg_class WHERE oid=ANY(ARRAY['public.keep_custody_source_windows'::regclass,'public.keep_custody_journal'::regclass,
    'public.keep_custody_cutover_state'::regclass,'public.deposits'::regclass]) AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
  OR current_database() !~ '^shardkeep_custody_apply_[0-9a-f]{32}_test$'
 THEN RAISE EXCEPTION 'KEEP_SOURCE_OWNER_REQUIRED'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_barrier() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM public.shardkeep_keep_source_owner();
 LOCK TABLE public.ledger_transactions,public.accounts,public.ledger_entries,public.players,public.bases,public.base_slots,
 public.deed_ownership_observations,public.base_forge_positions,public.forge_contributions,public.raid_loot_reservations,
 public.base_raid_locks,public.mail_messages,public.mail_attachments,public.base_league_entitlements,
 public.withdrawals,public.withdrawal_attempts,public.withdrawal_payout_reservations,public.withdrawal_authorizations,public.deposits,
 public.player_items,public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,
 public.keep_custody_late_authorizations,public.keep_custody_late_journal,
 public.keep_custody_league_bridge,public.keep_custody_league_weeks,public.keep_custody_league_retirements,
 public.keep_custody_withdrawal_drains,public.keep_custody_withdrawal_sources,
 public.keep_custody_source_observations,public.keep_custody_source_windows IN ACCESS EXCLUSIVE MODE NOWAIT;
 PERFORM public.shardkeep_keep_source_assert_hooks();
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_eligible(window_id uuid,deposit_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT EXISTS(SELECT 1 FROM public.keep_custody_source_windows w CROSS JOIN LATERAL jsonb_array_elements(w.inventory) i
 JOIN public.deposits d ON d.id=(i->'source'->>'id')::uuid
 JOIN public.keep_custody_source_observations o ON o.deposit_id=d.id AND o.commitment='confirmed'
 WHERE w.id=$1 AND d.id=$2 AND d.kind='keep_deposit' AND d.status='pending'
 AND d.payment_signature=o.signature AND d.tx_signature IS NULL AND d.amount IS NULL AND d.mint IS NULL AND d.finalized_at IS NULL AND d.ledger_txn_id IS NULL
 AND to_jsonb(d)=i->'source' AND o.original=i->'source' AND to_jsonb(o)=i->'observation'
 AND d.created_at<=o.observed_at AND o.observed_at<w.closed_at)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_inventory() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(d),'observation',to_jsonb(o)) ORDER BY d.id),'[]'::jsonb)
 FROM public.deposits d LEFT JOIN public.keep_custody_source_observations o ON o.deposit_id=d.id AND o.commitment='confirmed'
 WHERE d.kind IN('keep_deposit','keep_vend') AND d.status<>'credited'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_assert_barrier() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['ledger_transactions','accounts','ledger_entries','players','bases','base_slots','deed_ownership_observations','base_forge_positions','forge_contributions','raid_loot_reservations','base_raid_locks','mail_messages','mail_attachments','base_league_entitlements','withdrawals','withdrawal_attempts','withdrawal_payout_reservations','withdrawal_authorizations','deposits','player_items','item_listings','keep_custody_journal','mail_keep_retirements','keep_custody_late_authorizations','keep_custody_late_journal','keep_custody_league_bridge','keep_custody_league_weeks','keep_custody_league_retirements','keep_custody_withdrawal_drains','keep_custody_withdrawal_sources','keep_custody_source_observations','keep_custody_source_windows'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND relation=to_regclass('public.'||tab) AND mode='AccessExclusiveLock' AND granted)
  THEN RAISE EXCEPTION 'KEEP_SOURCE_BARRIER_REQUIRED'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_source_assert_barrier() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE d public.deposits; prior public.keep_custody_source_observations; phase text;
BEGIN
 PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
 IF TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_TABLE_SCHEMA<>'public'
 OR TG_RELID NOT IN('public.keep_custody_source_windows'::regclass,'public.keep_custody_source_observations'::regclass)
 OR TG_NAME<>'keep_source_guard' THEN RAISE EXCEPTION 'KEEP_SOURCE_IMMUTABLE'; END IF;
 IF NEW.xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'KEEP_SOURCE_TRANSACTION'; END IF;
 phase:=public.shardkeep_keep_custody_phase_locked();
 IF TG_RELID='public.keep_custody_source_windows'::regclass THEN
  PERFORM public.shardkeep_keep_source_assert_barrier();
  IF phase<>'open' OR NEW.inventory IS DISTINCT FROM public.shardkeep_keep_source_inventory()
   OR NEW.closed_at IS DISTINCT FROM date_trunc('milliseconds',NEW.closed_at) OR NEW.closed_at>clock_timestamp()
   OR NEW.closed_at<date_trunc('milliseconds',transaction_timestamp()) THEN RAISE EXCEPTION 'KEEP_SOURCE_WINDOW_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.inventory) i WHERE i->'observation'<>'null'::jsonb
   AND (i->'observation'->>'observed_at')::timestamptz>=NEW.closed_at) THEN RAISE EXCEPTION 'KEEP_SOURCE_TIME'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO d FROM public.deposits WHERE id=NEW.deposit_id;
 IF NEW.original IS DISTINCT FROM to_jsonb(d) OR d.kind<>'keep_deposit' OR d.status<>'pending'
 OR d.payment_signature IS DISTINCT FROM NEW.signature OR d.tx_signature IS NOT NULL OR d.amount IS NOT NULL OR d.mint IS NOT NULL
 OR d.finalized_at IS NOT NULL OR d.ledger_txn_id IS NOT NULL
 OR NEW.proof->>'signature' IS DISTINCT FROM NEW.signature OR (NEW.proof->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
 OR NEW.observed_at<d.created_at OR NEW.observed_at>clock_timestamp()
 OR coalesce(NEW.proof->>'amountBaseUnits','') !~ '^[1-9][0-9]*$' OR (NEW.proof->>'amountBaseUnits')::numeric>9223372036854775807
 OR coalesce(NEW.proof->>'messageHash','') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(NEW.proof->'transaction') IS DISTINCT FROM 'object'
 OR NEW.proof->'transaction'->'transaction'->'signatures'->>0 IS DISTINCT FROM NEW.signature
 OR NEW.proof->'transaction'->'meta'->'err' IS DISTINCT FROM 'null'::jsonb
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['genesisHash','mint','custodyOwner','destination']) k WHERE coalesce(NEW.proof->>k,'') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
 THEN RAISE EXCEPTION 'KEEP_SOURCE_PROOF_REQUIRED'; END IF;
 IF NEW.commitment='confirmed' THEN
  IF phase<>'open' THEN RAISE EXCEPTION 'KEEP_SOURCE_PRE_W_REQUIRED'; END IF;
 ELSE
  PERFORM public.shardkeep_keep_source_assert_barrier();
  SELECT * INTO prior FROM public.keep_custody_source_observations WHERE deposit_id=NEW.deposit_id AND commitment='confirmed';
  IF phase<>'frozen' OR prior.deposit_id IS NULL OR prior.original IS DISTINCT FROM NEW.original
   OR (NEW.proof-ARRAY['observedAt','transaction']) IS DISTINCT FROM (prior.proof-ARRAY['observedAt','transaction'])
   OR NOT EXISTS(SELECT 1 FROM public.keep_custody_journal j WHERE j.request ? 'custodyWindowId'
    AND public.shardkeep_keep_source_eligible((j.request->>'custodyWindowId')::uuid,d.id)
    AND j.late_deposit_sources @> jsonb_build_array(NEW.original) AND (j.request->>'asOf')::timestamptz<NEW.observed_at)
  THEN RAISE EXCEPTION 'KEEP_SOURCE_FINAL_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
 IF TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_TABLE_SCHEMA<>'public'
 OR TG_NAME<>'keep_source_complete' OR TG_RELID NOT IN('public.keep_custody_source_windows'::regclass,'public.keep_custody_source_observations'::regclass)
 THEN RAISE EXCEPTION 'KEEP_SOURCE_HOOKS_REQUIRED'; END IF;
 IF TG_RELID='public.keep_custody_source_windows'::regclass THEN
  IF NOT EXISTS(SELECT 1 FROM public.keep_custody_cutover_state WHERE id AND phase='fenced' AND changed_at=NEW.closed_at)
  THEN RAISE EXCEPTION 'KEEP_SOURCE_WINDOW_UNSEALED'; END IF;
 ELSIF NEW.commitment='confirmed' THEN
  IF NEW.original IS DISTINCT FROM (SELECT to_jsonb(d) FROM public.deposits d WHERE id=NEW.deposit_id)
  THEN RAISE EXCEPTION 'KEEP_SOURCE_CONFIRMED_UNSEALED'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.keep_custody_late_authorizations a JOIN public.keep_custody_late_journal j ON j.id=a.id
   WHERE a.xid=NEW.xid AND a.request->>'sourceVersion'='2' AND a.request->>'depositId'=NEW.deposit_id::text
   AND a.request->'proof'->'transaction'=NEW.proof->'transaction' AND a.request->'proof'->>'finalizedObservedAt'=NEW.proof->>'observedAt')
  THEN RAISE EXCEPTION 'KEEP_SOURCE_FINAL_UNSEALED'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_retirement_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_TABLE_SCHEMA<>'public'
 OR TG_RELID<>'public.keep_custody_journal'::regclass OR TG_NAME<>'keep_source_retirement_complete'
 THEN RAISE EXCEPTION 'KEEP_SOURCE_HOOKS_REQUIRED'; END IF;
 IF NEW.request ? 'custodyWindowId' THEN
  PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
  IF NEW.custody_source_xid IS DISTINCT FROM pg_current_xact_id()
   OR (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'frozen'
  THEN RAISE EXCEPTION 'KEEP_SOURCE_F_UNSEALED'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_source_retirement_complete() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_retain_keep_source(deposit_id uuid,commitment text,proof jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
#variable_conflict use_variable
BEGIN
 PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
 INSERT INTO public.keep_custody_source_observations(deposit_id,commitment,signature,observed_at,proof,original,xid)
 SELECT deposit_id,commitment,proof->>'signature',(proof->>'observedAt')::timestamptz,proof,to_jsonb(d),pg_current_xact_id()
 FROM public.deposits d WHERE d.id=deposit_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'KEEP_SOURCE_DEPOSIT_REQUIRED'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_close_keep_source_window(window_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE saved public.keep_custody_source_windows; at timestamptz;
BEGIN
 PERFORM public.shardkeep_keep_source_barrier();
 SELECT * INTO saved FROM public.keep_custody_source_windows WHERE id=window_id;
 IF saved.id IS NULL THEN
  IF public.shardkeep_keep_custody_phase_locked()<>'open' THEN RAISE EXCEPTION 'KEEP_SOURCE_W_REQUIRED'; END IF;
  at:=date_trunc('milliseconds',clock_timestamp());
  INSERT INTO public.keep_custody_source_windows(id,closed_at,inventory,xid)
   VALUES(window_id,at,public.shardkeep_keep_source_inventory(),pg_current_xact_id()) RETURNING * INTO saved;
  UPDATE public.keep_custody_cutover_state SET phase='fenced',changed_at=at WHERE id AND phase='open';
 ELSE
  IF public.shardkeep_keep_custody_phase_locked()='open' THEN RAISE EXCEPTION 'KEEP_SOURCE_WINDOW_UNSEALED'; END IF;
 END IF;
 RETURN jsonb_build_object('windowId',saved.id,'closedAt',to_char(saved.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'inventory',saved.inventory);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE table_name text;
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'KEEP_CUSTODY_STATE_IMMUTABLE' USING ERRCODE='P0001'; END IF;
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_cutover_state'::regclass) THEN
    RAISE EXCEPTION 'KEEP_CUSTODY_STATE_OWNER_REQUIRED' USING ERRCODE='P0001';
  END IF;
  -- The barrier must already be held BEFORE the latch row is modified. Never
  -- acquire it here: a writer may hold a domain/account lock and need the latch.
  FOREACH table_name IN ARRAY ARRAY['ledger_transactions','accounts','ledger_entries','players','bases','base_slots',
    'deed_ownership_observations','base_forge_positions','forge_contributions','raid_loot_reservations','base_raid_locks',
    'mail_messages','mail_attachments','base_league_entitlements','withdrawals','withdrawal_attempts',
    'withdrawal_payout_reservations','withdrawal_authorizations','deposits','player_items','item_listings','mail_keep_retirements','keep_custody_source_windows','keep_custody_source_observations'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='relation'
      AND relation=to_regclass('public.' || table_name) AND mode='AccessExclusiveLock' AND granted) THEN
      RAISE EXCEPTION 'KEEP_CUSTODY_BARRIER_REQUIRED' USING ERRCODE='P0001';
    END IF;
  END LOOP;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.changed_at<OLD.changed_at OR NOT (
    (OLD.phase='open' AND NEW.phase='fenced') OR (OLD.phase='fenced' AND NEW.phase='withdrawals_closed')
    OR (OLD.phase='withdrawals_closed' AND NEW.phase='frozen') OR (OLD.phase='frozen' AND NEW.phase='retired')
  ) THEN RAISE EXCEPTION 'KEEP_CUSTODY_PHASE_INVALID' USING ERRCODE='P0001'; END IF;
  IF NEW.phase='retired' THEN RAISE EXCEPTION 'KEEP_CUSTODY_RETIREMENT_ATTESTATION_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF NEW.phase='frozen' THEN
    -- Only the F journal inserted in THIS transaction can authorize v2 rows.
    IF EXISTS(SELECT 1 FROM public.keep_custody_journal j WHERE j.custody_source_xid=pg_current_xact_id()) THEN
      PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
      IF EXISTS(SELECT 1 FROM public.deposits d WHERE d.kind IN('keep_deposit','keep_vend')
       AND (d.status IN('pending','finalized') OR (d.status<>'credited' AND (d.payment_signature IS NOT NULL OR d.tx_signature IS NOT NULL OR d.finalized_at IS NOT NULL OR d.amount IS NOT NULL)))
       AND NOT EXISTS(SELECT 1 FROM public.keep_custody_journal j WHERE j.custody_source_xid=pg_current_xact_id()
        AND j.late_deposit_sources @> jsonb_build_array(to_jsonb(d))
        AND public.shardkeep_keep_source_eligible((j.request->>'custodyWindowId')::uuid,d.id)))
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_DEPOSIT_UNRESOLVED'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM public.accounts WHERE kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow') AND balance<>0)
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_LIABILITY_NONZERO' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.accounts a WHERE balance<>coalesce((SELECT sum(delta) FROM public.ledger_entries e WHERE e.account_id=a.id),0))
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_LEDGER_MISMATCH' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id GROUP BY e.txn_id,a.currency HAVING sum(e.delta)<>0)
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_LEDGER_UNBALANCED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.base_forge_positions WHERE settled_at IS NULL OR (keep_escrow_txn_id IS NOT NULL AND claimed_at IS NULL AND expired_at IS NULL))
      OR EXISTS(SELECT 1 FROM public.forge_contributions WHERE settled_at IS NULL OR (keep_escrow_txn_id IS NOT NULL AND claimed_at IS NULL AND expired_at IS NULL))
      OR EXISTS(SELECT 1 FROM public.accounts WHERE kind IN ('forge_escrow','base_forge_escrow') AND balance<>0)
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_FORGE_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.raid_loot_reservations WHERE state='reserved' AND forge_reserved_shards>0)
      OR EXISTS(SELECT 1 FROM public.base_raid_locks)
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_RAID_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.mail_messages m JOIN public.mail_attachments a ON a.message_id=m.id WHERE m.reward_state='pending' AND a.kind='KEEP' AND NOT public.shardkeep_mail_keep_retired(a.id))
      OR EXISTS(SELECT 1 FROM public.base_league_entitlements WHERE paid_at IS NULL AND keep_amount>0)
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_REWARD_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.withdrawals WHERE status IN ('unbonding','processing','failed'))
      OR EXISTS(SELECT 1 FROM public.withdrawal_attempts WHERE status IN ('prepared','broadcast'))
      OR EXISTS(SELECT 1 FROM public.withdrawal_payout_reservations WHERE status='reserved')
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_WITHDRAWAL_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.deposits d WHERE
      (kind IN ('keep_deposit','keep_vend') AND (status IN ('pending','finalized') OR
        (status<>'credited' AND (payment_signature IS NOT NULL OR tx_signature IS NOT NULL OR finalized_at IS NOT NULL OR amount IS NOT NULL))) AND NOT EXISTS(SELECT 1 FROM public.keep_custody_journal j WHERE j.custody_source_xid=pg_current_xact_id()
        AND j.late_deposit_sources @> jsonb_build_array(to_jsonb(d))
        AND public.shardkeep_keep_source_eligible((j.request->>'custodyWindowId')::uuid,d.id)))
      OR (kind='mine_build' AND (status<>'credited' OR ledger_txn_id IS NULL)))
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_DEPOSIT_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.player_items WHERE item_id IN ('skin_keep_gilded','skin_keep_frost','skin_keep_voidstone'))
      OR EXISTS(SELECT 1 FROM public.item_listings WHERE status IN ('active','reserved') AND item_id IN ('skin_keep_gilded','skin_keep_frost','skin_keep_voidstone'))
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_SKIN_REFUND_UNRESOLVED' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_advance_keep_custody_phase(expected text, target text)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result text;
BEGIN
  -- Fail-and-rollback on a busy writer; waiting here could invert an existing
  -- outer domain/account → ledger lock order. No early latch lock is taken.
  LOCK TABLE public.ledger_transactions,public.accounts,public.ledger_entries,public.players,public.bases,public.base_slots,
 public.deed_ownership_observations,public.base_forge_positions,public.forge_contributions,public.raid_loot_reservations,
 public.base_raid_locks,public.mail_messages,public.mail_attachments,public.base_league_entitlements,
 public.withdrawals,public.withdrawal_attempts,public.withdrawal_payout_reservations,public.withdrawal_authorizations,public.deposits,
 public.player_items,public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,
 public.keep_custody_late_authorizations,public.keep_custody_late_journal,
 public.keep_custody_league_bridge,public.keep_custody_league_weeks,public.keep_custody_league_retirements,
 public.keep_custody_withdrawal_drains,public.keep_custody_withdrawal_sources,
 public.keep_custody_source_observations,public.keep_custody_source_windows IN ACCESS EXCLUSIVE MODE NOWAIT;
  UPDATE public.keep_custody_cutover_state SET phase=target,changed_at=clock_timestamp() WHERE id AND phase=expected RETURNING phase INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'KEEP_CUSTODY_PHASE_CHANGED' USING ERRCODE='P0001'; END IF;
  RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_barrier()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
BEGIN
 IF NOT public.shardkeep_fixture_late_owner() OR current_user<>(SELECT pg_get_userbyid(relowner)
 FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_OWNER_REQUIRED'; END IF;
 LOCK TABLE public.ledger_transactions,public.accounts,public.ledger_entries,public.players,public.bases,public.base_slots,
 public.deed_ownership_observations,public.base_forge_positions,public.forge_contributions,public.raid_loot_reservations,
 public.base_raid_locks,public.mail_messages,public.mail_attachments,public.base_league_entitlements,
 public.withdrawals,public.withdrawal_attempts,public.withdrawal_payout_reservations,public.withdrawal_authorizations,public.deposits,
 public.player_items,public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,
 public.keep_custody_late_authorizations,public.keep_custody_late_journal,
 public.keep_custody_league_bridge,public.keep_custody_league_weeks,public.keep_custody_league_retirements,
 public.keep_custody_withdrawal_drains,public.keep_custody_withdrawal_sources,
 public.keep_custody_source_observations,public.keep_custody_source_windows IN ACCESS EXCLUSIVE MODE NOWAIT;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_journal_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_IMMUTABLE' USING ERRCODE='P0001'; END IF;
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
    OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_cutover_state'::regclass)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_OWNER_REQUIRED' USING ERRCODE='P0001'; END IF;
  -- No production command is admitted by this initial implementation. Custom
  -- GUCs and broad runtime DML grants do not confer journal authority.
  IF current_database() !~ '^shardkeep_custody_apply_[0-9a-f]{32}_test$'
    OR NEW.database_name<>current_database() OR NEW.operator_name<>current_user
    OR NEW.scope<>'fixture' OR NEW.subcommand NOT IN ('retire-l1','retire-l1-mail','retire-l1-mail-forge','retire-l1-mail-forge-league') OR NEW.dry_run
    OR NEW.operation IS DISTINCT FROM (CASE NEW.subcommand WHEN 'retire-l1' THEN 'fixture:l1-retirement' WHEN 'retire-l1-mail' THEN 'fixture:l1-mail-retirement' WHEN 'retire-l1-mail-forge' THEN 'fixture:l1-mail-forge-retirement' ELSE 'fixture:l1-mail-forge-league-retirement' END)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed'
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF NEW.request ? 'custodyWindowId' THEN
    PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
    PERFORM public.shardkeep_keep_source_assert_barrier();
    IF NOT EXISTS(SELECT 1 FROM public.keep_custody_source_windows w WHERE w.id=(NEW.request->>'custodyWindowId')::uuid
       AND w.closed_at<=(NEW.request->>'asOf')::timestamptz AND (NEW.request->>'asOf')::timestamptz<=clock_timestamp())
     OR NEW.late_deposit_sources IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)
       FROM public.deposits d WHERE public.shardkeep_keep_source_eligible((NEW.request->>'custodyWindowId')::uuid,d.id))
    THEN RAISE EXCEPTION 'KEEP_SOURCE_F_REQUIRED'; END IF;
    NEW.custody_source_xid:=pg_current_xact_id();
  ELSIF NEW.custody_source_xid IS NOT NULL THEN RAISE EXCEPTION 'KEEP_SOURCE_F_REQUIRED'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_context(req jsonb,hash text,k bigint,units bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE source jsonb; retirement public.keep_custody_journal%ROWTYPE; plans jsonb; snapshots jsonb;
  pk uuid; pg uuid; inflow uuid; emission uuid; mint uuid; wallet text; minted numeric; found_count integer;
BEGIN
 IF NOT public.shardkeep_fixture_late_owner() OR current_user<>(SELECT pg_get_userbyid(relowner)
 FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_OWNER_REQUIRED'; END IF;
 PERFORM public.shardkeep_fixture_late_barrier();
 IF public.shardkeep_keep_custody_phase_locked()<>'frozen' THEN RAISE EXCEPTION 'CUSTODY_LATE_FROZEN_REQUIRED'; END IF;
 IF jsonb_typeof(req)<>'object' OR jsonb_typeof(req->'proof')<>'object'
 OR req->>'fixtureId' IS NULL OR req->>'retirementJournalId' IS NULL OR req->>'depositId' IS NULL
 OR hash IS NULL OR hash !~ '^[a-f0-9]{64}$' OR k IS NULL OR k<=0 OR units IS NULL OR units<=0
 OR req->'proof'->>'signature' IS NULL OR req->'proof'->>'mint' IS NULL
 OR req->'proof'->>'custodyOwner' IS NULL OR req->'proof'->>'destination' IS NULL
 OR jsonb_typeof(req->'proof'->'transaction') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'CUSTODY_LATE_REQUEST_INVALID'; END IF;
 SELECT * INTO retirement FROM public.keep_custody_journal WHERE id=(req->>'retirementJournalId')::uuid;
 SELECT to_jsonb(d) INTO source FROM public.deposits d WHERE id=(req->>'depositId')::uuid;
 IF retirement.id IS NULL OR retirement.database_name<>current_database() OR retirement.scope<>'fixture'
 OR retirement.dry_run OR retirement.subcommand NOT IN ('retire-l1','retire-l1-mail','retire-l1-mail-forge','retire-l1-mail-forge-league')
 OR retirement.request->>'fixtureId' IS DISTINCT FROM retirement.id::text
 OR source IS NULL OR source->>'kind'<>'keep_deposit'
 OR (CASE WHEN req->>'sourceVersion'='2' THEN source->>'status'<>'pending' OR source->>'payment_signature' IS DISTINCT FROM req->'proof'->>'signature'
     ELSE source->>'status'<>'expired' OR source->>'payment_signature' IS NOT NULL END)
 OR source->>'tx_signature' IS NOT NULL
 OR source->>'amount' IS NOT NULL OR source->>'mint' IS NOT NULL
 OR source->>'finalized_at' IS NOT NULL OR source->>'ledger_txn_id' IS NOT NULL
 OR (SELECT count(*) FROM jsonb_array_elements(retirement.late_deposit_sources) s WHERE s=source)<>1
 THEN RAISE EXCEPTION 'CUSTODY_LATE_SOURCE_REQUIRED'; END IF;
 IF req->>'sourceVersion'='2' THEN
  PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
  IF NOT public.shardkeep_keep_source_eligible((retirement.request->>'custodyWindowId')::uuid,(req->>'depositId')::uuid)
   OR NOT EXISTS(SELECT 1 FROM public.keep_custody_source_observations c
    JOIN public.keep_custody_source_observations f ON f.deposit_id=c.deposit_id AND f.commitment='finalized'
    JOIN public.keep_custody_source_windows w ON w.id=(retirement.request->>'custodyWindowId')::uuid
    WHERE c.deposit_id=(req->>'depositId')::uuid AND c.commitment='confirmed' AND f.xid=pg_current_xact_id()
     AND f.original=source AND f.signature=req->'proof'->>'signature'
     AND f.proof->'transaction'=req->'proof'->'transaction'
     AND f.proof->>'observedAt'=req->'proof'->>'finalizedObservedAt'
     AND c.proof->>'observedAt'=req->'proof'->>'broadcastObservedAt'
     AND w.closed_at=(req->'proof'->>'withdrawalsClosedAt')::timestamptz
     AND f.proof->>'mint'=req->'proof'->>'mint' AND f.proof->>'destination'=req->'proof'->>'destination'
     AND f.proof->>'custodyOwner'=req->'proof'->>'custodyOwner'
     AND (f.proof->>'amountBaseUnits')::bigint=units)
  THEN RAISE EXCEPTION 'KEEP_SOURCE_FINAL_REQUIRED'; END IF;
 ELSIF req ? 'sourceVersion' THEN RAISE EXCEPTION 'KEEP_SOURCE_VERSION'; END IF;
 IF EXISTS(SELECT 1 FROM public.deposits WHERE id<>(req->>'depositId')::uuid
  AND (payment_signature=req->'proof'->>'signature' OR tx_signature=req->'proof'->>'signature'))
 THEN RAISE EXCEPTION 'CUSTODY_LATE_SIGNATURE_ALREADY_USED'; END IF;
 IF NOT coalesce((source->>'created_at')::timestamptz <= (req->'proof'->>'broadcastObservedAt')::timestamptz
 AND (req->'proof'->>'broadcastObservedAt')::timestamptz < (req->'proof'->>'withdrawalsClosedAt')::timestamptz
 AND (req->'proof'->>'withdrawalsClosedAt')::timestamptz <= (retirement.request->>'asOf')::timestamptz
 AND (retirement.request->>'asOf')::timestamptz < (req->'proof'->>'finalizedObservedAt')::timestamptz,false)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_TIME_ORDER_REQUIRED'; END IF;
 wallet:=source->>'player_wallet';
 SELECT count(*),max(id::text)::uuid INTO found_count,pk FROM public.accounts WHERE kind='player_keep' AND currency='KEEP' AND owner_wallet=wallet AND base_id IS NULL;
 IF found_count<>1 OR (SELECT balance FROM public.accounts WHERE id=pk)<>0 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 INSERT INTO public.accounts(owner_wallet,kind,currency,balance)
SELECT wallet,'player_gems','GEMS',0 WHERE NOT EXISTS(SELECT 1 FROM public.accounts WHERE kind='player_gems' AND owner_wallet=wallet AND base_id IS NULL);
SELECT count(*),max(id::text)::uuid INTO found_count,pg FROM public.accounts WHERE kind='player_gems' AND currency='GEMS' AND owner_wallet=wallet AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 SELECT count(*),max(id::text)::uuid INTO found_count,inflow FROM public.accounts WHERE kind='onchain_inflow' AND currency='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 SELECT count(*),max(id::text)::uuid INTO found_count,emission FROM public.accounts WHERE kind='emission_pool' AND currency='KEEP' AND owner_wallet IS NULL AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 SELECT count(*),max(id::text)::uuid INTO found_count,mint FROM public.accounts WHERE kind='gems_mint' AND currency='GEMS' AND owner_wallet IS NULL AND base_id IS NULL;
 IF found_count<>1 THEN RAISE EXCEPTION 'CUSTODY_LATE_ACCOUNT_REQUIRED'; END IF;
 plans:=jsonb_build_array(jsonb_build_object('key','deposit:'||(req->>'depositId')||':credit','type','deposit.keep',
 'metadata',jsonb_build_object('wallet',wallet,'txSignature',req->'proof'->>'signature','baseUnits',units::text),
 'entries',jsonb_build_array(jsonb_build_object('account',inflow,'delta',(-k)::text),jsonb_build_object('account',pk,'delta',k::text))),
 jsonb_build_object('key','late-credit:deposit:'||(req->>'depositId')||':convert','type','gems.late_credit',
 'metadata',jsonb_build_object('wallet',wallet,'depositId',req->>'depositId','txSignature',req->'proof'->>'signature',
 'keep',k::text,'gems',k::text,'reason','keep_conversion','proofHash',hash,
 'retirementJournalId',req->>'retirementJournalId','fixtureId',req->>'fixtureId'),
 'entries',jsonb_build_array(jsonb_build_object('account',pk,'delta',(-k)::text),jsonb_build_object('account',emission,'delta',k::text),
 jsonb_build_object('account',mint,'delta',(-k)::text),jsonb_build_object('account',pg,'delta',k::text))));
 IF EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN jsonb_array_elements(plans) p ON p->>'key'=t.idempotency_key)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_RECEIPT_ALREADY_EXISTS'; END IF;
 SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) INTO snapshots FROM public.accounts a WHERE id=ANY(ARRAY[pk,pg,inflow,emission,mint]);
 SELECT coalesce(sum(-e.delta),0) INTO minted FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 JOIN public.ledger_transactions t ON t.id=e.txn_id WHERE a.kind='gems_mint' AND t.type='gems.retirement';
 RETURN jsonb_build_object('source_before',source,'postings',plans,'accounts_before',snapshots,'retirement_minted_before',minted);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prepare_fixture_keep_late_credit(request jsonb,input_hash text,verified_keep bigint,verified_base_units bigint)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
#variable_conflict use_variable
DECLARE context jsonb; saved public.keep_custody_late_authorizations%ROWTYPE; completed jsonb; receipt jsonb;
BEGIN
 IF NOT public.shardkeep_fixture_late_owner() OR current_user<>(SELECT pg_get_userbyid(relowner)
 FROM pg_catalog.pg_class WHERE oid='public.keep_custody_journal'::regclass)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_OWNER_REQUIRED'; END IF;
 PERFORM public.shardkeep_fixture_late_barrier();
 SELECT * INTO saved FROM public.keep_custody_late_authorizations WHERE id=(request->>'fixtureId')::uuid;
 IF saved.id IS NOT NULL THEN
   IF saved.request IS DISTINCT FROM request OR saved.input_hash IS DISTINCT FROM input_hash
   OR saved.verified_keep IS DISTINCT FROM verified_keep OR saved.verified_base_units IS DISTINCT FROM verified_base_units
   THEN RAISE EXCEPTION 'CUSTODY_LATE_REPLAY_MISMATCH'; END IF;
   IF request->>'sourceVersion'='2' THEN
     PERFORM public.shardkeep_keep_source_owner(); PERFORM public.shardkeep_keep_source_assert_hooks();
     PERFORM public.shardkeep_keep_source_assert_barrier();
     -- Recovery consumes the immutable first retained observations. A clock,
     -- reader or mutable configuration change never rewrites that evidence.
     IF NOT EXISTS(SELECT 1 FROM public.keep_custody_journal retirement
      JOIN public.keep_custody_source_windows w ON w.id=(retirement.request->>'custodyWindowId')::uuid
      CROSS JOIN LATERAL jsonb_array_elements(w.inventory) AS source_item(value)
      JOIN public.keep_custody_source_observations c ON c.deposit_id=(request->>'depositId')::uuid AND c.commitment='confirmed'
      JOIN public.keep_custody_source_observations f ON f.deposit_id=c.deposit_id AND f.commitment='finalized'
      WHERE retirement.id=(request->>'retirementJournalId')::uuid
       AND retirement.late_deposit_sources @> jsonb_build_array(saved.source_before)
       AND source_item.value->'source'=saved.source_before AND source_item.value->'observation'=to_jsonb(c)
       AND c.original=saved.source_before AND f.original=saved.source_before AND f.xid=saved.xid
       AND (f.proof-ARRAY['observedAt','transaction'])=(c.proof-ARRAY['observedAt','transaction'])
       AND f.signature=request->'proof'->>'signature' AND f.proof->'transaction'=request->'proof'->'transaction'
       AND f.proof->>'observedAt'=request->'proof'->>'finalizedObservedAt'
       AND c.proof->>'observedAt'=request->'proof'->>'broadcastObservedAt'
       AND w.closed_at=(request->'proof'->>'withdrawalsClosedAt')::timestamptz
       AND f.proof->>'mint'=request->'proof'->>'mint' AND f.proof->>'custodyOwner'=request->'proof'->>'custodyOwner'
       AND f.proof->>'destination'=request->'proof'->>'destination'
       AND (f.proof->>'amountBaseUnits')::bigint=saved.verified_base_units)
     THEN RAISE EXCEPTION 'KEEP_SOURCE_REPLAY_WITNESS'; END IF;
   END IF;
   SELECT result INTO completed FROM public.keep_custody_late_journal WHERE id=saved.id;
   IF completed IS NULL OR completed->'sourceAfter' IS DISTINCT FROM (SELECT to_jsonb(d)||jsonb_build_object('amount',d.amount::text) FROM public.deposits d WHERE id=(request->>'depositId')::uuid)
   OR NOT coalesce((SELECT phase FROM public.keep_custody_cutover_state WHERE id) IN ('frozen','retired'),false)
   THEN RAISE EXCEPTION 'CUSTODY_LATE_REPLAY_INVALID'; END IF;
   FOR receipt IN SELECT value FROM jsonb_array_elements(completed->'receipts') LOOP
     IF receipt IS DISTINCT FROM public.shardkeep_fixture_late_receipt((receipt->>'id')::uuid)
     THEN RAISE EXCEPTION 'CUSTODY_LATE_REPLAY_INVALID'; END IF;
   END LOOP;
   RETURN jsonb_build_object('replay',completed);
 END IF;
 context:=public.shardkeep_fixture_late_context(request,input_hash,verified_keep,verified_base_units);
 INSERT INTO public.keep_custody_late_authorizations(id,xid,request,input_hash,verified_keep,verified_base_units,
 source_before,postings,accounts_before,retirement_minted_before) VALUES((request->>'fixtureId')::uuid,pg_current_xact_id(),request,
 input_hash,verified_keep,verified_base_units,context->'source_before',context->'postings',context->'accounts_before',
 (context->>'retirement_minted_before')::numeric);
 RETURN jsonb_build_object('postings',context->'postings');
END $$;
REVOKE ALL ON FUNCTION public.prepare_fixture_keep_late_credit(jsonb,text,bigint,bigint) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_fixture_late_result(fixture uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE auth jsonb; plan jsonb; receipt jsonb; receipts jsonb:='[]'; source jsonb; expected jsonb; prior jsonb;
 delta numeric; minted numeric; actual_entries jsonb; expected_entries jsonb;
BEGIN
 auth:=public.shardkeep_fixture_late_active();
 IF auth IS NULL OR auth->>'id' IS DISTINCT FROM fixture::text THEN RAISE EXCEPTION 'CUSTODY_LATE_AUTH_REQUIRED'; END IF;
 FOR plan IN SELECT value FROM jsonb_array_elements(auth->'postings') LOOP
   SELECT public.shardkeep_fixture_late_receipt(id) INTO receipt FROM public.ledger_transactions WHERE idempotency_key=plan->>'key';
   SELECT jsonb_agg(jsonb_build_object('account',e->>'account','delta',e->>'delta') ORDER BY e->>'account')
   INTO actual_entries FROM jsonb_array_elements(receipt->'entries') e;
   SELECT jsonb_agg(e ORDER BY e->>'account') INTO expected_entries FROM jsonb_array_elements(plan->'entries') e;
   IF receipt IS NULL OR receipt->>'type' IS DISTINCT FROM plan->>'type' OR receipt->'metadata' IS DISTINCT FROM plan->'metadata'
   OR actual_entries IS DISTINCT FROM expected_entries THEN RAISE EXCEPTION 'CUSTODY_LATE_RECEIPT_INVALID'; END IF;
   receipts:=receipts||jsonb_build_array(receipt);
 END LOOP;
 SELECT to_jsonb(d) INTO source FROM public.deposits d WHERE d.id=(auth->'request'->>'depositId')::uuid;
 expected:=(auth->'source_before')||jsonb_build_object('status','credited','tx_signature',auth->'request'->'proof'->>'signature',
 'amount',(auth->>'verified_base_units')::bigint,'mint',auth->'request'->'proof'->>'mint',
 'finalized_at',((auth->'request'->'proof'->>'finalizedObservedAt')::timestamptz),'ledger_txn_id',receipts->0->>'id');
 IF source IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CUSTODY_LATE_DEPOSIT_INVALID'; END IF;
 FOR prior IN SELECT value FROM jsonb_array_elements(auth->'accounts_before') LOOP
   SELECT coalesce(sum((e->>'delta')::numeric),0) INTO delta FROM jsonb_array_elements(auth->'postings') p
     CROSS JOIN LATERAL jsonb_array_elements(p->'entries') e WHERE e->>'account'=prior->>'id';
   IF (SELECT to_jsonb(a)-'balance' FROM public.accounts a WHERE id=(prior->>'id')::uuid) IS DISTINCT FROM prior-'balance'
   OR (SELECT balance FROM public.accounts WHERE id=(prior->>'id')::uuid) IS DISTINCT FROM (prior->>'balance')::numeric+delta
   THEN RAISE EXCEPTION 'CUSTODY_LATE_BALANCE_INVALID'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.accounts WHERE kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow') AND balance<>0)
 OR EXISTS(SELECT 1 FROM public.accounts a WHERE balance<>(SELECT coalesce(sum(e.delta),0) FROM public.ledger_entries e WHERE e.account_id=a.id))
 OR EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id GROUP BY e.txn_id,a.currency HAVING sum(e.delta)<>0)
 THEN RAISE EXCEPTION 'CUSTODY_LATE_CONSERVATION_REQUIRED'; END IF;
 SELECT coalesce(sum(-e.delta),0) INTO minted FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 JOIN public.ledger_transactions t ON t.id=e.txn_id WHERE a.kind='gems_mint' AND t.type='gems.retirement';
 IF minted IS DISTINCT FROM (auth->>'retirement_minted_before')::numeric THEN RAISE EXCEPTION 'CUSTODY_LATE_RETIREMENT_CHANGED'; END IF;
 RETURN jsonb_build_object('fixtureOnly',true,'retirementAuthorized',false,'chainEvidence',CASE WHEN auth->'request'->>'sourceVersion'='2' THEN 'configured-rpc' ELSE 'injected-fixture' END,'fixtureId',fixture,'retirementJournalId',auth->'request'->>'retirementJournalId',
 'depositId',auth->'request'->>'depositId','inputHash',auth->>'input_hash','keep',auth->>'verified_keep','gems',auth->>'verified_keep',
 'receipts',receipts,'sourceAfter',source||jsonb_build_object('amount',(auth->>'verified_base_units')));
END $$;
--> statement-breakpoint
DO $hooks$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['keep_custody_source_observations','keep_custody_source_windows'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname='keep_source_guard') THEN
   EXECUTE format('CREATE TRIGGER keep_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_source_guard()',tab); END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname='keep_source_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER keep_source_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_source_guard()',tab); END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname='keep_source_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER keep_source_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_source_complete()',tab); END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.keep_custody_journal'::regclass AND tgname='keep_source_retirement_complete') THEN
  CREATE CONSTRAINT TRIGGER keep_source_retirement_complete AFTER INSERT ON public.keep_custody_journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_source_retirement_complete();
 END IF;
END $hooks$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_source_assert_hooks() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item record;
BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'KEEP_SOURCE_HOOKS_REQUIRED'; END IF;
 FOR item IN SELECT tab,hook.* FROM unnest(ARRAY['keep_custody_source_observations','keep_custody_source_windows']) tab CROSS JOIN
 (VALUES('keep_source_guard','shardkeep_keep_source_guard',31,false),('keep_source_no_truncate','shardkeep_keep_source_guard',34,false),
 ('keep_source_complete','shardkeep_keep_source_complete',5,true)) hook(name,fn,bits,deferred)
 UNION ALL SELECT 'keep_custody_journal','keep_source_retirement_complete','shardkeep_keep_source_retirement_complete',5,true LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass('public.'||item.tab) AND t.tgname=item.name
     AND t.tgfoid=to_regprocedure('public.'||item.fn||'()') AND t.tgenabled='O' AND NOT t.tgisinternal
     AND t.tgqual IS NULL AND t.tgnargs=0 AND (t.tgconstraint<>0)=item.deferred
     AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.keep_custody_source_observations'::regclass)
     AND p.proowner=(SELECT relowner FROM pg_class WHERE oid=t.tgrelid)
     AND t.tgtype=item.bits AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
     AND NOT p.prosecdef AND cardinality(p.proconfig)=2
     AND replace(p.proconfig[1],' ','')='search_path=pg_catalog,public,pg_temp' AND lower(p.proconfig[2])='timezone=utc')
  THEN RAISE EXCEPTION 'KEEP_SOURCE_HOOKS_REQUIRED'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_keep_source_owner(),public.shardkeep_keep_source_barrier(),public.shardkeep_keep_source_eligible(uuid,uuid),
 public.shardkeep_keep_source_inventory(),public.shardkeep_keep_source_guard(),public.shardkeep_keep_source_complete(),public.shardkeep_retain_keep_source(uuid,text,jsonb),
 public.shardkeep_close_keep_source_window(uuid),public.shardkeep_keep_source_assert_hooks() FROM PUBLIC;
