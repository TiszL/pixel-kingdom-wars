-- Additive original Forge evidence; no activation or money-table mutation.
ALTER TABLE public.keep_custody_journal ADD COLUMN IF NOT EXISTS source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
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
 AND j.scope='fixture' AND j.subcommand IN ('retire-l1-mail','retire-l1-mail-forge') AND NOT j.dry_run
 AND j.operation=CASE j.subcommand WHEN 'retire-l1-mail' THEN 'fixture:l1-mail-retirement' ELSE 'fixture:l1-mail-forge-retirement' END AND j.database_name=current_database()
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
    OR NEW.scope<>'fixture' OR NEW.subcommand NOT IN ('retire-l1','retire-l1-mail','retire-l1-mail-forge') OR NEW.dry_run
    OR NEW.operation IS DISTINCT FROM (CASE NEW.subcommand WHEN 'retire-l1' THEN 'fixture:l1-retirement' WHEN 'retire-l1-mail' THEN 'fixture:l1-mail-retirement' ELSE 'fixture:l1-mail-forge-retirement' END)
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_FIXTURE_REQUIRED' USING ERRCODE='P0001'; END IF;
  IF (SELECT phase FROM public.keep_custody_cutover_state WHERE id) IS DISTINCT FROM 'withdrawals_closed'
    THEN RAISE EXCEPTION 'CUSTODY_JOURNAL_PHASE_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
