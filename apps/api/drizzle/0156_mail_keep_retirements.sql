-- Fixture-only per-leg provenance. Original attachments/expiry are retained.
CREATE TABLE IF NOT EXISTS public.mail_keep_retirements (
  attachment_id uuid PRIMARY KEY REFERENCES public.mail_attachments(id),
  message_id uuid NOT NULL REFERENCES public.mail_messages(id),
  recipient_wallet text NOT NULL REFERENCES public.players(wallet),
  amount bigint NOT NULL CHECK (amount>0),
  original_expires_at timestamptz NOT NULL,
  ledger_txn_id uuid NOT NULL REFERENCES public.ledger_transactions(id),
  journal_id uuid NOT NULL REFERENCES public.keep_custody_journal(id) DEFERRABLE INITIALLY DEFERRED,
  receipt jsonb NOT NULL
);
REVOKE ALL ON public.mail_keep_retirements FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mail_keep_retired(attachment uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.mail_keep_retirements p
 JOIN public.mail_attachments a ON a.id=p.attachment_id
 JOIN public.mail_messages m ON m.id=p.message_id
 JOIN public.keep_custody_journal j ON j.id=p.journal_id
 JOIN public.ledger_transactions t ON t.id=p.ledger_txn_id
 CROSS JOIN LATERAL (SELECT sum(x.amount)::text AS keep FROM public.mail_attachments x
   WHERE x.message_id=m.id AND x.kind='KEEP') total
 WHERE p.attachment_id=attachment AND a.message_id=p.message_id AND a.kind='KEEP'
 AND a.amount=p.amount AND m.recipient_wallet=p.recipient_wallet AND m.expires_at=p.original_expires_at
 AND j.scope='fixture' AND j.subcommand='retire-l1-mail' AND NOT j.dry_run
 AND j.operation='fixture:l1-mail-retirement' AND j.database_name=current_database()
 AND j.request->>'fixtureId'=j.id::text
 AND j.request->'mails' @> jsonb_build_array(jsonb_build_object('messageId',m.id::text,
   'wallet',m.recipient_wallet,'keep',total.keep,'internal',t.type='gems.retirement.sweep'))
 AND j.receipts @> jsonb_build_array(p.receipt)
 AND t.idempotency_key='mail:retire:'||m.id::text
 AND t.type IN ('gems.retirement','gems.retirement.sweep')
 AND t.metadata->>'messageId'=m.id::text AND t.metadata->>'wallet'=m.recipient_wallet
 AND t.metadata->>'fixtureId'=j.id::text
 -- G-9 locks whole KEEP and Gems to identical units; independently prove the
 -- complete L4 posting, not merely agreement between two saved receipts.
 AND t.metadata=CASE WHEN t.type='gems.retirement.sweep' THEN
   jsonb_build_object('wallet',m.recipient_wallet,'keep',total.keep,'reason','internal-wallet','fixtureId',j.id::text,'messageId',m.id::text)
 ELSE jsonb_build_object('wallet',m.recipient_wallet,'class','L4','keep',total.keep,'gems',total.keep,'reason','retirement','fixtureId',j.id::text,'messageId',m.id::text) END
 AND (SELECT jsonb_agg(jsonb_build_array(a.kind,a.currency,a.owner_wallet,a.base_id,e.delta::text) ORDER BY a.kind::text)
   FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id)
 = CASE WHEN t.type='gems.retirement.sweep' THEN jsonb_build_array(
     jsonb_build_array('emission_pool','KEEP',NULL,NULL,total.keep),
     jsonb_build_array('mail_keep_escrow','KEEP',NULL,NULL,'-'||total.keep))
   ELSE jsonb_build_array(
     jsonb_build_array('emission_pool','KEEP',NULL,NULL,total.keep),
     jsonb_build_array('gems_mint','GEMS',NULL,NULL,'-'||total.keep),
     jsonb_build_array('mail_keep_escrow','KEEP',NULL,NULL,'-'||total.keep),
     jsonb_build_array('player_gems','GEMS',m.recipient_wallet,NULL,total.keep)) END
 AND p.receipt->>'id'=t.id::text AND p.receipt->>'type'=t.type
 AND p.receipt->>'idempotencyKey'=t.idempotency_key AND p.receipt->'metadata'=t.metadata
 AND (p.receipt->>'createdAt')::timestamptz=t.created_at
 AND p.receipt->'entries'=(SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'account',a.id,'kind',a.kind,'currency',a.currency,
   'wallet',a.owner_wallet,'baseId',a.base_id,'delta',e.delta::text,'balanceAfter',e.balance_after::text) ORDER BY e.id)
   FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=t.id))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mail_retirement_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MAIL_RETIREMENT_IMMUTABLE'; END IF;
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.mail_keep_retirements'::regclass)
 OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.keep_custody_cutover_state'::regclass)
 OR current_database() !~ '^shardkeep_custody_apply_[0-9a-f]{32}_test$'
 THEN RAISE EXCEPTION 'MAIL_RETIREMENT_OWNER_REQUIRED'; END IF;
 IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed'
 THEN RAISE EXCEPTION 'MAIL_RETIREMENT_PHASE_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mail_attachments a JOIN public.mail_messages m ON m.id=a.message_id
 WHERE a.id=NEW.attachment_id AND a.message_id=NEW.message_id AND a.kind='KEEP' AND a.amount=NEW.amount
 AND m.recipient_wallet=NEW.recipient_wallet AND m.expires_at=NEW.original_expires_at AND m.reward_state='pending')
 THEN RAISE EXCEPTION 'MAIL_RETIREMENT_IDENTITY_REQUIRED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mail_keep_retirements_guard ON public.mail_keep_retirements;
CREATE TRIGGER mail_keep_retirements_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mail_keep_retirements
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mail_retirement_guard();
DROP TRIGGER IF EXISTS mail_keep_retirements_no_truncate ON public.mail_keep_retirements;
CREATE TRIGGER mail_keep_retirements_no_truncate BEFORE TRUNCATE ON public.mail_keep_retirements
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mail_retirement_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mail_retirement_proof_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT public.shardkeep_mail_keep_retired(NEW.attachment_id) THEN RAISE EXCEPTION 'MAIL_RETIREMENT_PROOF_REQUIRED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mail_keep_retirements_proof ON public.mail_keep_retirements;
CREATE CONSTRAINT TRIGGER mail_keep_retirements_proof AFTER INSERT ON public.mail_keep_retirements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mail_retirement_proof_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_retired_mail_original_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE message uuid;
BEGIN
 IF TG_OP='TRUNCATE' THEN
   IF EXISTS(SELECT 1 FROM public.mail_keep_retirements) THEN RAISE EXCEPTION 'MAIL_RETIREMENT_IMMUTABLE'; END IF;
   RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='mail_attachments' THEN
   message:=CASE WHEN TG_OP='INSERT' THEN NEW.message_id ELSE OLD.message_id END;
   IF EXISTS(SELECT 1 FROM public.mail_keep_retirements WHERE message_id=message)
   OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.mail_keep_retirements WHERE message_id=NEW.message_id))
   THEN RAISE EXCEPTION 'MAIL_RETIREMENT_IMMUTABLE'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM public.mail_keep_retirements WHERE message_id=OLD.id) AND
    (TG_OP='DELETE' OR ROW(NEW.id,NEW.recipient_wallet,NEW.kind,NEW.expires_at,NEW.reserve_ledger_txn_id)
     IS DISTINCT FROM ROW(OLD.id,OLD.recipient_wallet,OLD.kind,OLD.expires_at,OLD.reserve_ledger_txn_id)
     OR NEW.reward_state='expired' OR (OLD.reward_state='claimed' AND NEW.reward_state<>'claimed'))
   THEN RAISE EXCEPTION 'MAIL_RETIREMENT_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS mail_retirement_attachments_guard ON public.mail_attachments;
CREATE TRIGGER mail_retirement_attachments_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mail_attachments FOR EACH ROW EXECUTE FUNCTION public.shardkeep_retired_mail_original_guard();
DROP TRIGGER IF EXISTS mail_retirement_messages_guard ON public.mail_messages;
CREATE TRIGGER mail_retirement_messages_guard BEFORE UPDATE OR DELETE ON public.mail_messages FOR EACH ROW EXECUTE FUNCTION public.shardkeep_retired_mail_original_guard();
DROP TRIGGER IF EXISTS mail_retirement_attachments_truncate ON public.mail_attachments;
CREATE TRIGGER mail_retirement_attachments_truncate BEFORE TRUNCATE ON public.mail_attachments FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_retired_mail_original_guard();
DROP TRIGGER IF EXISTS mail_retirement_messages_truncate ON public.mail_messages;
CREATE TRIGGER mail_retirement_messages_truncate BEFORE TRUNCATE ON public.mail_messages FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_retired_mail_original_guard();

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
    'withdrawal_payout_reservations','deposits','player_items','item_listings','mail_keep_retirements'] LOOP
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
    IF EXISTS(SELECT 1 FROM public.mail_messages m JOIN public.mail_attachments a ON a.message_id=m.id WHERE m.reward_state='pending' AND a.kind='KEEP' AND NOT public.shardkeep_mail_keep_retired(a.id))
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
    public.player_items,public.item_listings,public.mail_keep_retirements IN ACCESS EXCLUSIVE MODE NOWAIT;
  UPDATE public.keep_custody_cutover_state SET phase=target,changed_at=clock_timestamp() WHERE id AND phase=expected RETURNING phase INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'KEEP_CUSTODY_PHASE_CHANGED' USING ERRCODE='P0001'; END IF;
  RETURN result;
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
    OR NEW.scope<>'fixture' OR NEW.subcommand NOT IN ('retire-l1','retire-l1-mail') OR NEW.dry_run
    OR NEW.operation IS DISTINCT FROM (CASE NEW.subcommand WHEN 'retire-l1' THEN 'fixture:l1-retirement' ELSE 'fixture:l1-mail-retirement' END)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed'
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
