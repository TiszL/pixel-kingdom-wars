-- HELD money-table alteration (WORKING-RULES S5). Default OPEN preserves the
-- existing economy. No migration, conversion, exception grant or activation.
CREATE TABLE IF NOT EXISTS public.keep_custody_cutover_state (
  id boolean PRIMARY KEY DEFAULT true NOT NULL CHECK (id),
  phase text DEFAULT 'open' NOT NULL CHECK (phase IN ('open','fenced','withdrawals_closed','frozen','retired')),
  changed_at timestamptz DEFAULT now() NOT NULL
);
INSERT INTO public.keep_custody_cutover_state (id) SELECT true WHERE NOT EXISTS (SELECT 1 FROM public.keep_custody_cutover_state);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_phase_locked()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result text;
BEGIN
  SELECT phase INTO result FROM public.keep_custody_cutover_state WHERE id FOR SHARE;
  IF result IS NULL THEN RAISE EXCEPTION 'KEEP_CUSTODY_STATE_MISSING' USING ERRCODE='P0001'; END IF;
  RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_assert_keep_custody_post(account_ids uuid[], posting_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE touched boolean := false; candidate record; phase text;
BEGIN
  -- Normal account locks precede the latch. A receipt replay calls none of
  -- this; a Gems-only posting does not acquire a latch lock.
  FOR candidate IN SELECT id,kind FROM public.accounts WHERE id=ANY(account_ids) ORDER BY id FOR KEY SHARE LOOP
    touched := touched OR candidate.kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow');
  END LOOP;
  IF NOT touched THEN RETURN; END IF;
  phase := public.shardkeep_keep_custody_phase_locked();
  IF phase IN ('frozen','retired') THEN RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN' USING ERRCODE='P0001'; END IF;
  IF phase<>'open' AND posting_type='gems.from_keep' THEN RAISE EXCEPTION 'KEEP_CUSTODY_CLOSING' USING ERRCODE='P0001'; END IF;
  -- GUCs are not authority. Journal-bound late-credit/operator-settle and their
  -- measured ceilings are deliberately unavailable in this bounded slice.
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_entry_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE kind text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT type INTO kind FROM public.ledger_transactions WHERE id=OLD.txn_id;
    PERFORM public.shardkeep_assert_keep_custody_post(ARRAY[OLD.account_id],kind);
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT type INTO kind FROM public.ledger_transactions WHERE id=NEW.txn_id;
    PERFORM public.shardkeep_assert_keep_custody_post(ARRAY[NEW.account_id],kind);
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS ledger_entries_keep_custody_fence ON public.ledger_entries;
CREATE TRIGGER ledger_entries_keep_custody_fence BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_entry_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_account_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE relevant boolean; phase text;
BEGIN
  relevant := (TG_OP<>'INSERT' AND OLD.kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow')) OR (TG_OP<>'DELETE' AND NEW.kind IN ('player_keep','withdrawal_escrow','forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','forge_escrow','base_forge_escrow'));
  IF relevant THEN
    phase := public.shardkeep_keep_custody_phase_locked();
    IF phase IN ('frozen','retired') AND (
      TG_OP='DELETE' OR (TG_OP='INSERT' AND NEW.balance<>0)
      OR (TG_OP='UPDATE' AND ROW(NEW.id,NEW.kind,NEW.currency,NEW.owner_wallet,NEW.base_id,NEW.balance,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.currency,OLD.owner_wallet,OLD.base_id,OLD.balance,OLD.created_at))
    ) THEN RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN' USING ERRCODE='P0001'; END IF;
  END IF;
  -- Empty accounts remain creatable for old clients' balance reads.
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS accounts_keep_custody_fence ON public.accounts;
CREATE TRIGGER accounts_keep_custody_fence BEFORE INSERT OR UPDATE OR DELETE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_account_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(account_id) INTO ids FROM public.ledger_entries WHERE txn_id=OLD.id;
  PERFORM public.shardkeep_assert_keep_custody_post(ids,OLD.type);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS ledger_transactions_keep_custody_fence ON public.ledger_transactions;
CREATE TRIGGER ledger_transactions_keep_custody_fence BEFORE UPDATE OR DELETE ON public.ledger_transactions
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_receipt_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_admission_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE phase text;
BEGIN
  IF TG_TABLE_NAME='deposits' THEN
    IF NEW.kind NOT IN ('keep_deposit','keep_vend') THEN RETURN NEW; END IF;
  END IF;
  phase := public.shardkeep_keep_custody_phase_locked();
  IF phase IN ('frozen','retired') THEN RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN' USING ERRCODE='P0001'; END IF;
  IF phase<>'open' THEN RAISE EXCEPTION 'KEEP_CUSTODY_CLOSING' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deposits_keep_custody_admission ON public.deposits;
CREATE TRIGGER deposits_keep_custody_admission BEFORE INSERT ON public.deposits
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_admission_guard();
DROP TRIGGER IF EXISTS withdrawals_keep_custody_admission ON public.withdrawals;
CREATE TRIGGER withdrawals_keep_custody_admission BEFORE INSERT ON public.withdrawals
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_admission_guard();
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
    'withdrawal_payout_reservations','deposits','player_items','item_listings'] LOOP
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
    IF EXISTS(SELECT 1 FROM public.mail_messages m JOIN public.mail_attachments a ON a.message_id=m.id WHERE m.reward_state='pending' AND a.kind='KEEP')
      OR EXISTS(SELECT 1 FROM public.base_league_entitlements WHERE paid_at IS NULL AND keep_amount>0)
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_REWARD_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.withdrawals WHERE status IN ('unbonding','processing','failed'))
      OR EXISTS(SELECT 1 FROM public.withdrawal_attempts WHERE status IN ('prepared','broadcast'))
      OR EXISTS(SELECT 1 FROM public.withdrawal_payout_reservations WHERE status='reserved')
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_WITHDRAWAL_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.deposits WHERE
      (kind IN ('keep_deposit','keep_vend') AND (status IN ('pending','finalized') OR
        (status<>'credited' AND (payment_signature IS NOT NULL OR tx_signature IS NOT NULL OR finalized_at IS NOT NULL OR amount IS NOT NULL))))
      OR (kind='mine_build' AND (status<>'credited' OR ledger_txn_id IS NULL)))
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_DEPOSIT_UNRESOLVED' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.player_items WHERE item_id IN ('skin_keep_gilded','skin_keep_frost','skin_keep_voidstone'))
      OR EXISTS(SELECT 1 FROM public.item_listings WHERE status IN ('active','reserved') AND item_id IN ('skin_keep_gilded','skin_keep_frost','skin_keep_voidstone'))
      THEN RAISE EXCEPTION 'KEEP_CUSTODY_SKIN_REFUND_UNRESOLVED' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_custody_state_forward_only ON public.keep_custody_cutover_state;
CREATE TRIGGER keep_custody_state_forward_only BEFORE INSERT OR UPDATE OR DELETE ON public.keep_custody_cutover_state
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_state_guard();
DROP TRIGGER IF EXISTS keep_custody_state_no_truncate ON public.keep_custody_cutover_state;
CREATE TRIGGER keep_custody_state_no_truncate BEFORE TRUNCATE ON public.keep_custody_cutover_state
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_custody_state_guard();
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
    public.withdrawals,public.withdrawal_attempts,public.withdrawal_payout_reservations,public.deposits,
    public.player_items,public.item_listings IN ACCESS EXCLUSIVE MODE NOWAIT;
  UPDATE public.keep_custody_cutover_state SET phase=target,changed_at=clock_timestamp() WHERE id AND phase=expected RETURNING phase INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'KEEP_CUSTODY_PHASE_CHANGED' USING ERRCODE='P0001'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_advance_keep_custody_phase(text,text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.shardkeep_keep_custody_phase_locked() IN ('frozen','retired') THEN
    RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN' USING ERRCODE='P0001';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS accounts_keep_custody_no_truncate ON public.accounts;
CREATE TRIGGER accounts_keep_custody_no_truncate BEFORE TRUNCATE ON public.accounts FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_custody_truncate_guard();
DROP TRIGGER IF EXISTS ledger_entries_keep_custody_no_truncate ON public.ledger_entries;
CREATE TRIGGER ledger_entries_keep_custody_no_truncate BEFORE TRUNCATE ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_custody_truncate_guard();
DROP TRIGGER IF EXISTS ledger_transactions_keep_custody_no_truncate ON public.ledger_transactions;
CREATE TRIGGER ledger_transactions_keep_custody_no_truncate BEFORE TRUNCATE ON public.ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_keep_custody_truncate_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_keep_custody_forge_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.shardkeep_keep_custody_phase_locked() IN ('frozen','retired') THEN
    RAISE EXCEPTION 'KEEP_CUSTODY_FROZEN' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS base_forge_positions_keep_custody_fence ON public.base_forge_positions;
CREATE TRIGGER base_forge_positions_keep_custody_fence BEFORE INSERT OR UPDATE OR DELETE ON public.base_forge_positions
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_forge_guard();
DROP TRIGGER IF EXISTS forge_contributions_keep_custody_fence ON public.forge_contributions;
CREATE TRIGGER forge_contributions_keep_custody_fence BEFORE INSERT OR UPDATE OR DELETE ON public.forge_contributions
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_keep_custody_forge_guard();
