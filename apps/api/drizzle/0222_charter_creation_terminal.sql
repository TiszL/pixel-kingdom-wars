-- B6o private original completion. S5-held changes to existing guards and the
-- reservation state constraint. No issuer, provider, policy TTL or live apply.
-- RPC finality belongs to the private application/B6k reader; SQL validates the
-- exact retained assertion, original backing and actual ledger/game effects.
SET LOCAL lock_timeout='10s';
ALTER TABLE public.charter_creation_reservations DROP CONSTRAINT IF EXISTS charter_creation_reservations_state_check;
ALTER TABLE public.charter_creation_reservations ADD CONSTRAINT charter_creation_reservations_state_check
 CHECK(state IN('reserved','activated','cancelled_unpaid','refunded'));
CREATE TABLE IF NOT EXISTS public.charter_creation_terminal_posts (
 ledger_id uuid PRIMARY KEY REFERENCES public.ledger_transactions(id),
 reservation_id uuid NOT NULL REFERENCES public.charter_creation_reservations(id),operation text NOT NULL CHECK(operation IN('activate','refund')),
 tx_key text NOT NULL,original_transaction jsonb NOT NULL,amount bigint NOT NULL CHECK(amount>0),
 source_account_id uuid NOT NULL,destination_account_id uuid NOT NULL,source_identity jsonb NOT NULL,destination_identity jsonb NOT NULL,
 source_before bigint NOT NULL,destination_before bigint NOT NULL,quest_before jsonb NOT NULL,refund_authority jsonb,
 CHECK(source_account_id<>destination_account_id),CHECK(source_before>=amount),CHECK(destination_before>=0),UNIQUE(reservation_id,operation)
);
CREATE TABLE IF NOT EXISTS public.charter_creation_terminal_entries (
 entry_id bigint PRIMARY KEY REFERENCES public.ledger_entries(id),ledger_id uuid NOT NULL REFERENCES public.charter_creation_terminal_posts(ledger_id),
 tx_key text NOT NULL,original_entry jsonb NOT NULL,account_identity jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_creation_terminals (
 reservation_id uuid PRIMARY KEY REFERENCES public.charter_creation_reservations(id),id uuid NOT NULL UNIQUE,
 tx_key text NOT NULL,outcome text NOT NULL CHECK(outcome IN('activated','cancelled_unpaid')),
 inventory jsonb NOT NULL,observation jsonb NOT NULL,observation_sha256 text NOT NULL,
 terminal_transaction_id uuid UNIQUE REFERENCES public.charter_creation_terminal_posts(ledger_id),
 clan_snapshot jsonb,founder_snapshot jsonb,quest_effects jsonb NOT NULL,event_at timestamptz NOT NULL,
 CHECK((outcome='activated')=(terminal_transaction_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.charter_creation_refunds (
 reservation_id uuid PRIMARY KEY REFERENCES public.charter_creation_terminals(reservation_id),id uuid NOT NULL UNIQUE,
 tx_key text NOT NULL,refund_transaction_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_terminal_posts(ledger_id),
 destination_base_id uuid NOT NULL,authority jsonb NOT NULL,event_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.charter_creation_terminals'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_OWNER' USING ERRCODE='42501';END IF;
END $$;

--> statement-breakpoint
-- Fresh refund authority is database-observed custody, not proof of continuous
-- chain ownership. The original epoch is required only for automatic return.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_destination(rid uuid,destination uuid,automatic boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;b public.bases%ROWTYPE;o public.deed_ownership_observations%ROWTYPE;
 proof jsonb;fresh integer:=current_setting('shardkeep.deed_mutation_freshness_ms')::integer;
BEGIN
 PERFORM public.shardkeep_charter_terminal_owner();
 IF fresh IS NULL OR fresh<=0 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
 SELECT * INTO STRICT r FROM public.charter_creation_reservations WHERE id=rid;
 PERFORM wallet FROM public.players WHERE wallet=r.payer FOR UPDATE NOWAIT;
 SELECT * INTO b FROM public.bases WHERE id=destination FOR UPDATE NOWAIT;
 IF b.id IS NULL OR b.owner_wallet IS DISTINCT FROM r.payer OR b.status<>'active' OR b.land_paid_at IS NULL
 OR b.deed_asset_id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
 PERFORM base_id FROM public.base_slots WHERE base_id=b.id AND wallet=r.payer AND active FOR UPDATE NOWAIT;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
 SELECT * INTO o FROM public.deed_ownership_observations WHERE base_id=b.id FOR UPDATE NOWAIT;
 IF o.id IS NULL OR o.asset_id IS DISTINCT FROM b.deed_asset_id OR o.owner IS DISTINCT FROM r.payer OR o.status<>'owned'
 OR public.shardkeep_charter_custody_proof(o) IS NOT TRUE OR o.checked_at>clock_timestamp()
 OR clock_timestamp()-o.checked_at>fresh*interval '1 millisecond'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
 IF automatic THEN
  -- The connection setting is application policy plumbing, never evidence.
  -- Automatic return also retains the original protected enrollment ceiling.
  fresh:=least(fresh,(SELECT freshness_ms FROM public.charter_custody_sources WHERE base_id=b.id));
  proof:=public.shardkeep_charter_custody_read(b.id,fresh);
  IF b.id<>r.base_id OR b.deed_asset_id<>r.deed_asset_id OR proof->>'authority' IS DISTINCT FROM 'current'
  OR proof->>'id' IS DISTINCT FROM r.epoch_id::text OR proof->>'evidenceCommitment' IS DISTINCT FROM r.evidence_commitment
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
 END IF;
 RETURN jsonb_build_object('automatic',automatic,'base',to_jsonb(b),'observation',to_jsonb(o),'epoch',proof);
END $$;

-- Match quests.ts liveQuests and its clamped spend ticks. These retained facts
-- are checked against live rows only during this completion transaction.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_quests(bid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('quest',to_jsonb(q),'progress',to_jsonb(p)) ORDER BY q.id),'[]'::jsonb)
 FROM public.quests q LEFT JOIN public.base_quest_progress p ON p.quest_id=q.id AND p.base_id=bid
 WHERE q.template_code IN('spend_200','spend_500') AND
 ((q.scope='daily' AND q.active_on=current_date) OR(q.scope='weekly' AND q.active_on=date_trunc('week',current_date)::date)
 OR(q.scope='onboarding' AND q.active_on=DATE '2000-01-01'))
$$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_quest_valid(before_rows jsonb,after_rows jsonb,bid uuid,amount bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b jsonb;a jsonb;prior jsonb;next jsonb;target bigint;old_value bigint;
BEGIN
 IF jsonb_typeof(before_rows)<>'array' OR jsonb_typeof(after_rows)<>'array'
 OR jsonb_array_length(before_rows)<>jsonb_array_length(after_rows) THEN RETURN false;END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(before_rows) LOOP
  SELECT value INTO a FROM jsonb_array_elements(after_rows) WHERE value->'quest'->>'id'=b->'quest'->>'id';
  prior:=b->'progress';next:=a->'progress';target:=(b->'quest'->>'target')::bigint;
  old_value:=coalesce((prior->>'progress')::bigint,0);
  IF a IS NULL OR a->'quest' IS DISTINCT FROM b->'quest' OR next IS NULL OR next='null'::jsonb
  OR next->>'base_id' IS DISTINCT FROM bid::text OR next->>'quest_id' IS DISTINCT FROM b->'quest'->>'id'
  OR (next->>'progress')::bigint IS DISTINCT FROM least(target,old_value+amount)
  OR (prior<>'null'::jsonb AND (next->>'id' IS DISTINCT FROM prior->>'id' OR next->'claimed_at' IS DISTINCT FROM prior->'claimed_at'))
  OR (prior='null'::jsonb AND next->'claimed_at'<>'null'::jsonb)
  OR (prior->'completed_at'<>'null'::jsonb AND next->'completed_at' IS DISTINCT FROM prior->'completed_at')
  OR ((prior='null'::jsonb OR prior->'completed_at'='null'::jsonb)
      AND ((old_value+amount>=target) IS DISTINCT FROM (next->'completed_at'<>'null'::jsonb)))
  THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_money(lid uuid,committing boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.charter_creation_terminal_posts%ROWTYPE;t public.ledger_transactions%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM public.charter_creation_terminal_posts WHERE ledger_id=lid;
 SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=lid;
 SELECT * INTO STRICT r FROM public.charter_creation_reservations WHERE id=p.reservation_id;
 IF p.original_transaction IS DISTINCT FROM to_jsonb(t) OR t.type IS DISTINCT FROM 'clan.charter.'||p.operation
 OR t.idempotency_key IS DISTINCT FROM 'charter-'||p.operation||':'||r.intent_id
 OR p.amount IS DISTINCT FROM (r.consent->'price'->>'shards')::bigint OR p.source_before<p.amount OR p.destination_before<0
 OR (SELECT count(*) FROM public.ledger_entries WHERE txn_id=lid)<>2
 OR (SELECT count(*) FROM public.charter_creation_terminal_entries WHERE ledger_id=lid)<>2
 OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_entries w LEFT JOIN public.ledger_entries e ON e.id=w.entry_id
 LEFT JOIN public.accounts a ON a.id=e.account_id WHERE w.ledger_id=lid AND
 (e.id IS NULL OR e.txn_id<>lid OR w.tx_key<>p.tx_key OR w.original_entry IS DISTINCT FROM to_jsonb(e)
 OR w.account_identity IS DISTINCT FROM to_jsonb(a)-'balance'))
 OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 WHERE e.txn_id=lid AND e.account_id=p.source_account_id AND e.delta=-p.amount AND e.balance_after=p.source_before-p.amount
 AND to_jsonb(a)-'balance'=p.source_identity AND a.kind='charter_creation_escrow' AND a.currency='SHARDS'
 AND a.owner_wallet IS NULL AND a.base_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 WHERE e.txn_id=lid AND e.account_id=p.destination_account_id AND e.delta=p.amount AND e.balance_after=p.destination_before+p.amount
 AND to_jsonb(a)-'balance'=p.destination_identity AND a.currency='SHARDS' AND a.owner_wallet IS NULL
 AND ((p.operation='activate' AND a.kind='shard_burn' AND a.base_id IS NULL)
 OR(p.operation='refund' AND a.kind='base_shards' AND a.base_id::text=t.metadata->>'destinationBaseId')))
 THEN RETURN false;END IF;
 IF committing AND(p.tx_key<>pg_current_xact_id()::text OR NOT EXISTS(SELECT 1 FROM public.accounts s,public.accounts d
 WHERE s.id=p.source_account_id AND d.id=p.destination_account_id AND s.balance=p.source_before-p.amount
 AND d.balance=p.destination_before+p.amount)) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- This canonical snapshot excludes ONLY mutable reservation state. Never
-- relabel a completed reservation as reserved to reuse an issuance decoder.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_snapshot(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_set(v,'{reservation}',(v->'reservation')-'state')
$$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_observation(v jsonb,inventory jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE c jsonb:=inventory->'reservation'->'consent';m jsonb:=inventory->'message';expected jsonb;
BEGIN
 IF v IS NULL OR octet_length(v::text)>65536 OR jsonb_typeof(v)<>'object' THEN RETURN false;END IF;
 expected:=jsonb_build_object('creationIntentId',c->'creationIntentId','clanId',c->'clanId','payer',c->'payer',
 'metadata',c->'metadata','chain',c->'chain','admissionCommitment',inventory->'admission'->'commitment');
 IF v->>'version' IS DISTINCT FROM '1' OR v->'original' IS DISTINCT FROM expected
 OR v->'source'->>'genesisHash' IS DISTINCT FROM c->'chain'->>'genesisHash'
 OR v->'source'->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program'
 OR v->'source'->>'stateProvenance' IS DISTINCT FROM 'fresh-reviewed-deployment'
 OR jsonb_array_length(v->'source'->'accounts') IS DISTINCT FROM 14 OR jsonb_array_length(v->'source'->'programs') IS DISTINCT FROM 3
 OR v->'inventory'->>'version' IS DISTINCT FROM '1' OR v->'inventory'->>'count' IS DISTINCT FROM (CASE WHEN m='null'::jsonb THEN '0' ELSE '1' END)
 OR v->'inventory'->>'revision' IS DISTINCT FROM v->'inventory'->>'count'
 OR jsonb_array_length(v->'inventory'->'messages') IS DISTINCT FROM (v->'inventory'->>'count')::integer
 OR(m<>'null'::jsonb AND v->'inventory'->'messages'->0->>'messageHex' IS DISTINCT FROM m->>'messageHex')
 OR coalesce(v->>'slot','')!~'^[0-9]{1,16}$' OR coalesce(v->>'unixTimestamp','')!~'^[1-9][0-9]{0,18}$'
 THEN RETURN false;END IF;
 IF v->>'outcome'='minted' THEN
  RETURN m<>'null'::jsonb AND v->'mint'->>'creationIntentId'=c->>'creationIntentId' AND v->'mint'->>'clanId'=c->>'clanId'
   AND v->'mint'->>'payer'=c->>'payer' AND v->'mint'->>'admissionCommitment'=inventory->'admission'->>'commitment'
   AND v->'mint'->>'metadataHash'=c->'metadata'->>'hash' AND v->'mint'->>'asset'=c->'chain'->>'asset'
   AND v->'mint'->>'charter'=c->'chain'->>'charter' AND v->'mint'->>'creationReceipt'=c->'chain'->>'creationReceipt'
   AND v->'mint'->>'permitId'=v->'inventory'->'messages'->0->>'permitId'
   AND v->'mint'->>'slot'=v->>'slot' AND v->'mint'->>'unixTimestamp'=v->>'unixTimestamp';
 ELSIF v->>'outcome'='absent-after-expiry' THEN
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'inventory'->'messages') x WHERE x->>'expiry' IS NULL OR (x->>'expiry')::bigint>=(v->>'unixTimestamp')::bigint)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'source'->'accounts') WITH ORDINALITY a(value,n)
    WHERE n BETWEEN 9 AND 12 AND (value->'owner' IS DISTINCT FROM 'null'::jsonb OR value->'dataSha256' IS DISTINCT FROM 'null'::jsonb OR value->'executable' IS DISTINCT FROM 'null'::jsonb));
 END IF;RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

--> statement-breakpoint
-- Historical validators retain the exact 0220/0221 source checks, permitting
-- supported terminal states only for receipt recovery. Ordinary prepare stays
-- on the unchanged reserved-only 0221 reader. No current cache/custody check.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_funding(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;c jsonb;e public.charter_custody_epochs%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_creation_owner();PERFORM public.shardkeep_charter_creation_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE intent_id=intent;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.payer IS DISTINCT FROM w THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PAYER';END IF;
 c:=r.consent;SELECT * INTO e FROM public.charter_custody_epochs WHERE id=r.epoch_id;
 IF r.state NOT IN('reserved','activated','cancelled_unpaid','refunded') OR NOT isfinite(r.accepted_at) OR e.id IS NULL
 OR ROW(r.id::text,r.intent_id::text,r.clan_id::text,r.payer,r.base_id::text,r.deed_asset_id,r.epoch_id::text,r.evidence_commitment,r.name,r.tag)
 IS DISTINCT FROM ROW(c->>'reservationId',c->>'creationIntentId',c->>'clanId',c->>'payer',c->'funding'->>'baseId',c->'funding'->>'deedAssetId',
 c->'funding'->'ownershipEpoch'->>'id',c->'funding'->'ownershipEpoch'->>'evidenceCommitment',c->'clan'->>'name',c->'clan'->>'tag')
 OR e.base_id<>r.base_id OR e.deed_asset_id<>r.deed_asset_id OR e.owner_wallet<>r.payer OR e.evidence_commitment<>r.evidence_commitment
 OR r.custody_evidence->'epoch'->>'id' IS DISTINCT FROM r.epoch_id::text
 OR r.custody_evidence->'epoch'->>'authority' IS DISTINCT FROM 'current'
 OR r.custody_evidence->'base'->>'id' IS DISTINCT FROM r.base_id::text
 OR r.custody_evidence->'base'->>'owner_wallet' IS DISTINCT FROM r.payer
 OR NOT public.shardkeep_charter_creation_money(r.reserve_transaction_id,false)
 OR NOT EXISTS(SELECT 1 FROM public.charter_creation_funding_posts p WHERE p.ledger_id=r.reserve_transaction_id AND p.original_transaction->'metadata'->'consent'=c)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_HELD';END IF;
 RETURN jsonb_build_object('consent',c,'reserveTransactionId',r.reserve_transaction_id,'state',r.state);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_inventory(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;h public.charter_creation_permit_heads%ROWTYPE;
 m public.charter_creation_permit_messages%ROWTYPE;source jsonb;expected bytea;message jsonb:=NULL;
BEGIN
 PERFORM public.shardkeep_charter_permit_owner();PERFORM public.shardkeep_charter_permit_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE intent_id=intent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 IF w IS NOT NULL AND w IS DISTINCT FROM r.payer THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_PAYER';END IF;
 BEGIN
  source:=public.shardkeep_charter_terminal_funding(r.payer,r.intent_id);
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END;
 IF source IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 SELECT * INTO h FROM public.charter_creation_permit_heads WHERE reservation_id=r.id FOR UPDATE;
 IF NOT FOUND OR (SELECT count(*) FROM public.charter_creation_permit_heads WHERE reservation_id=r.id)<>1
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 expected:=convert_to(jsonb_build_object('domain','SHARDKEEP_CHARTER_CREATION_ADMISSION','version',1,
  'consent',r.consent,'reserveTransactionId',r.reserve_transaction_id)::text,'UTF8');
 IF h.commitment_version<>1 OR NOT isfinite(h.recorded_at) OR octet_length(h.admission_preimage) NOT BETWEEN 2 AND 16384
 OR h.admission_preimage IS DISTINCT FROM expected OR h.admission_commitment IS DISTINCT FROM encode(sha256(h.admission_preimage),'hex')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 IF (SELECT count(*) FROM public.charter_creation_permit_messages WHERE reservation_id=r.id)>1
 THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
 SELECT * INTO m FROM public.charter_creation_permit_messages WHERE reservation_id=r.id;
 IF FOUND THEN
  IF octet_length(m.message_bytes)<>161 OR NOT isfinite(m.recorded_at)
  OR m.message_sha256 IS DISTINCT FROM encode(sha256(m.message_bytes),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_INVENTORY_HELD';END IF;
  message:=jsonb_build_object('messageHex',encode(m.message_bytes,'hex'),'messageSha256',m.message_sha256);
 END IF;
 RETURN jsonb_build_object('reservation',source,'admission',jsonb_build_object('version',h.commitment_version,
  'preimageHex',encode(h.admission_preimage,'hex'),'commitment',h.admission_commitment),'message',message);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE t public.ledger_transactions%ROWTYPE;p public.charter_creation_terminal_posts%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;
 e public.ledger_entries%ROWTYPE;s public.accounts%ROWTYPE;d public.accounts%ROWTYPE;a public.accounts%ROWTYPE;
 receipt public.charter_creation_terminals%ROWTYPE;inventory jsonb;c jsonb;clan_row jsonb;founder jsonb;effects jsonb;authority jsonb;
BEGIN
 IF TG_RELID NOT IN('public.charter_creation_terminal_posts'::regclass,'public.charter_creation_terminal_entries'::regclass,
 'public.charter_creation_terminals'::regclass,'public.charter_creation_refunds'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)) OR TG_WHEN<>'BEFORE'
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_terminal_hooks();
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_IMMUTABLE';END IF;
 IF TG_RELID='public.charter_creation_terminal_posts'::regclass THEN
  SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=NEW.ledger_id;
  IF t.type NOT IN('clan.charter.activate','clan.charter.refund') OR jsonb_typeof(t.metadata)<>'object'
  OR t.metadata->>'version' IS DISTINCT FROM '1' OR EXISTS(SELECT 1 FROM public.ledger_entries WHERE txn_id=t.id)
  OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE ledger_id=t.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
  SELECT * INTO STRICT r FROM public.charter_creation_reservations WHERE id=(t.metadata->>'reservationId')::uuid FOR UPDATE NOWAIT;
  inventory:=public.shardkeep_charter_terminal_snapshot(public.shardkeep_charter_terminal_inventory(r.payer,r.intent_id));
  NEW.operation:=CASE WHEN t.type='clan.charter.activate' THEN 'activate' ELSE 'refund' END;
  IF t.idempotency_key IS DISTINCT FROM 'charter-'||NEW.operation||':'||r.intent_id
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
  SELECT * INTO STRICT s FROM public.accounts WHERE kind='charter_creation_escrow' AND owner_wallet IS NULL AND base_id IS NULL;
  IF NEW.operation='activate' THEN
   IF r.state<>'reserved' OR EXISTS(SELECT 1 FROM public.charter_creation_terminals WHERE reservation_id=r.id)
   OR t.metadata IS DISTINCT FROM jsonb_build_object('version',1,'reservationId',r.id,'inventory',inventory,'observation',t.metadata->'observation')
   OR public.shardkeep_charter_terminal_observation(t.metadata->'observation',inventory) IS NOT TRUE
   OR t.metadata->'observation'->>'outcome' IS DISTINCT FROM 'minted'
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;
   PERFORM id FROM public.bases WHERE id=r.base_id FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
   SELECT * INTO STRICT d FROM public.accounts WHERE kind='shard_burn' AND owner_wallet IS NULL AND base_id IS NULL;
   NEW.quest_before:=public.shardkeep_charter_terminal_quests(r.base_id);NEW.refund_authority:=NULL;
  ELSE
   SELECT * INTO receipt FROM public.charter_creation_terminals WHERE reservation_id=r.id;
   IF r.state<>'cancelled_unpaid' OR receipt.outcome IS DISTINCT FROM 'cancelled_unpaid'
   OR EXISTS(SELECT 1 FROM public.charter_creation_refunds WHERE reservation_id=r.id)
   OR t.metadata IS DISTINCT FROM jsonb_build_object('version',1,'reservationId',r.id,
    'destinationBaseId',t.metadata->'destinationBaseId','automatic',t.metadata->'automatic')
   OR jsonb_typeof(t.metadata->'automatic') IS DISTINCT FROM 'boolean'
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;
   PERFORM public.shardkeep_charter_terminal_read(r.payer,r.intent_id,false);
   authority:=public.shardkeep_charter_terminal_destination(r.id,(t.metadata->>'destinationBaseId')::uuid,(t.metadata->>'automatic')::boolean);
   SELECT * INTO STRICT d FROM public.accounts WHERE kind='base_shards' AND base_id=(t.metadata->>'destinationBaseId')::uuid;
   NEW.quest_before:='[]';NEW.refund_authority:=authority;
  END IF;
  PERFORM id FROM public.accounts WHERE id IN(s.id,d.id) ORDER BY id FOR UPDATE NOWAIT;
  SELECT * INTO STRICT s FROM public.accounts WHERE id=s.id;SELECT * INTO STRICT d FROM public.accounts WHERE id=d.id;
  NEW.amount:=(r.consent->'price'->>'shards')::bigint;
  IF s.balance<NEW.amount OR d.balance<0 OR d.balance::numeric+NEW.amount>9223372036854775807
  OR s.currency<>'SHARDS' OR d.currency<>'SHARDS' OR d.owner_wallet IS NOT NULL
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_MONEY';END IF;
  IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts q WHERE q.tx_key=pg_current_xact_id()::text
    AND(q.source_account_id IN(s.id,d.id) OR q.destination_account_id IN(s.id,d.id)))
  OR EXISTS(SELECT 1 FROM public.charter_creation_funding_posts q WHERE q.tx_key=pg_current_xact_id()::text
    AND(q.source_account_id IN(s.id,d.id) OR q.escrow_account_id IN(s.id,d.id)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_POST_CONFLICT';END IF;
  NEW.reservation_id:=r.id;NEW.tx_key:=pg_current_xact_id()::text;NEW.original_transaction:=to_jsonb(t);
  NEW.source_account_id:=s.id;NEW.destination_account_id:=d.id;NEW.source_identity:=to_jsonb(s)-'balance';NEW.destination_identity:=to_jsonb(d)-'balance';
  NEW.source_before:=s.balance;NEW.destination_before:=d.balance;
 ELSIF TG_RELID='public.charter_creation_terminal_entries'::regclass THEN
  SELECT * INTO STRICT e FROM public.ledger_entries WHERE id=NEW.entry_id;
  SELECT * INTO STRICT p FROM public.charter_creation_terminal_posts WHERE ledger_id=e.txn_id;
  SELECT * INTO STRICT a FROM public.accounts WHERE id=e.account_id;
  IF p.tx_key<>pg_current_xact_id()::text OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_entries WHERE entry_id=e.id)
  OR (SELECT count(*) FROM public.charter_creation_terminal_entries WHERE ledger_id=p.ledger_id)>=2
  OR NOT((e.account_id=p.source_account_id AND to_jsonb(a)-'balance'=p.source_identity)
    OR(e.account_id=p.destination_account_id AND to_jsonb(a)-'balance'=p.destination_identity))
  OR e.delta<>(CASE WHEN e.account_id=p.source_account_id THEN -p.amount ELSE p.amount END)
  OR e.balance_after<>(CASE WHEN e.account_id=p.source_account_id THEN p.source_before-p.amount ELSE p.destination_before+p.amount END)
  OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_entries WHERE ledger_id=p.ledger_id AND original_entry->>'account_id'=e.account_id::text)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_MONEY';END IF;
  NEW.ledger_id:=p.ledger_id;NEW.tx_key:=p.tx_key;NEW.original_entry:=to_jsonb(e);NEW.account_identity:=to_jsonb(a)-'balance';
 ELSIF TG_RELID='public.charter_creation_terminals'::regclass THEN
  SELECT * INTO STRICT r FROM public.charter_creation_reservations WHERE id=NEW.reservation_id FOR UPDATE NOWAIT;
  IF r.state<>'reserved' OR EXISTS(SELECT 1 FROM public.charter_creation_terminals WHERE reservation_id=r.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;
  inventory:=public.shardkeep_charter_terminal_snapshot(public.shardkeep_charter_terminal_inventory(r.payer,r.intent_id));
  IF NEW.inventory IS DISTINCT FROM inventory THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STALE_INVENTORY';END IF;
  IF public.shardkeep_charter_terminal_observation(NEW.observation,inventory) IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
  c:=r.consent;
  IF NEW.observation->>'outcome'='minted' THEN
   SELECT * INTO STRICT p FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id AND operation='activate';
   IF p.tx_key<>pg_current_xact_id()::text OR public.shardkeep_charter_terminal_money(p.ledger_id,true) IS NOT TRUE
   OR p.original_transaction->'metadata'->'inventory' IS DISTINCT FROM inventory
   OR p.original_transaction->'metadata'->'observation' IS DISTINCT FROM NEW.observation
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_MONEY';END IF;
   SELECT to_jsonb(x) INTO clan_row FROM public.clans x WHERE id=r.clan_id;
   SELECT to_jsonb(x) INTO founder FROM public.clan_members x WHERE player_wallet=r.payer;
   IF public.shardkeep_charter_terminal_clan(c,clan_row,founder) IS NOT TRUE
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_EFFECTS';END IF;
   effects:=public.shardkeep_charter_terminal_quests(r.base_id);
   IF public.shardkeep_charter_terminal_quest_valid(p.quest_before,effects,r.base_id,p.amount) IS NOT TRUE
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_QUESTS';END IF;
   NEW.outcome:='activated';NEW.terminal_transaction_id:=p.ledger_id;NEW.clan_snapshot:=clan_row;NEW.founder_snapshot:=founder;NEW.quest_effects:=effects;
  ELSE
   IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;
   NEW.outcome:='cancelled_unpaid';NEW.terminal_transaction_id:=NULL;NEW.clan_snapshot:=NULL;NEW.founder_snapshot:=NULL;NEW.quest_effects:='[]';
  END IF;
  NEW.id:=gen_random_uuid();NEW.tx_key:=pg_current_xact_id()::text;NEW.observation_sha256:=encode(sha256(convert_to(NEW.observation::text,'UTF8')),'hex');NEW.event_at:=clock_timestamp();
 ELSE
  SELECT * INTO STRICT r FROM public.charter_creation_reservations WHERE id=NEW.reservation_id FOR UPDATE NOWAIT;
  SELECT * INTO STRICT receipt FROM public.charter_creation_terminals WHERE reservation_id=r.id;
  SELECT * INTO STRICT p FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id AND operation='refund';
  IF r.state<>'cancelled_unpaid' OR receipt.outcome<>'cancelled_unpaid' OR public.shardkeep_charter_terminal_money(p.ledger_id,true) IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;
  authority:=public.shardkeep_charter_terminal_destination(r.id,(p.original_transaction->'metadata'->>'destinationBaseId')::uuid,
   (p.original_transaction->'metadata'->>'automatic')::boolean);
  IF authority IS DISTINCT FROM p.refund_authority THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
  NEW.id:=gen_random_uuid();NEW.tx_key:=pg_current_xact_id()::text;NEW.refund_transaction_id:=p.ledger_id;
  NEW.destination_base_id:=(authority->'base'->>'id')::uuid;NEW.authority:=authority;NEW.event_at:=clock_timestamp();
 END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_clan(c jsonb,clan_row jsonb,founder jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(clan_row->>'id'=c->>'clanId' AND clan_row->>'name'=c->'clan'->>'name' AND clan_row->>'tag'=c->'clan'->>'tag'
 AND clan_row->>'leader_wallet'=c->>'payer' AND clan_row->>'invite_mode'=c->'clan'->>'inviteMode'
 AND clan_row->>'chest_shards'='0' AND founder->>'clan_id'=c->>'clanId' AND founder->>'player_wallet'=c->>'payer'
 AND((c->'clan'->>'inviteMode'='open' AND clan_row->'invite_code'='null'::jsonb)
 OR(c->'clan'->>'inviteMode'='invite' AND length(clan_row->>'invite_code')>0)),false)
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_read(w text,intent uuid,committing boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;t public.charter_creation_terminals%ROWTYPE;f public.charter_creation_refunds%ROWTYPE;
 p public.charter_creation_terminal_posts%ROWTYPE;inventory jsonb;clan_row jsonb;founder jsonb;authority jsonb;
BEGIN
 PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_terminal_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE intent_id=intent FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.payer IS DISTINCT FROM w THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_PAYER';END IF;
 inventory:=public.shardkeep_charter_terminal_inventory(w,intent);
 SELECT * INTO t FROM public.charter_creation_terminals WHERE reservation_id=r.id;
 SELECT * INTO f FROM public.charter_creation_refunds WHERE reservation_id=r.id;
 IF r.state='reserved' THEN
  IF t.id IS NOT NULL OR f.id IS NOT NULL OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;RETURN NULL;
 END IF;
 IF t.id IS NULL OR NOT isfinite(t.event_at) OR t.inventory IS DISTINCT FROM public.shardkeep_charter_terminal_snapshot(inventory)
 OR t.observation_sha256 IS DISTINCT FROM encode(sha256(convert_to(t.observation::text,'UTF8')),'hex')
 OR public.shardkeep_charter_terminal_observation(t.observation,t.inventory) IS NOT TRUE
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
 IF r.state='activated' THEN
  SELECT * INTO p FROM public.charter_creation_terminal_posts WHERE ledger_id=t.terminal_transaction_id;
  IF t.outcome<>'activated' OR t.observation->>'outcome' IS DISTINCT FROM 'minted' OR f.id IS NOT NULL
  OR p.ledger_id IS NULL OR p.reservation_id<>r.id OR p.operation<>'activate' OR p.tx_key<>t.tx_key
  OR p.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('version',1,'reservationId',r.id,'inventory',t.inventory,'observation',t.observation)
  OR public.shardkeep_charter_terminal_money(p.ledger_id,committing) IS NOT TRUE
  OR public.shardkeep_charter_terminal_clan(r.consent,t.clan_snapshot,t.founder_snapshot) IS NOT TRUE
  OR public.shardkeep_charter_terminal_quest_valid(p.quest_before,t.quest_effects,r.base_id,p.amount) IS NOT TRUE
  OR (SELECT count(*) FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id)<>1
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
  IF committing THEN
   SELECT to_jsonb(x) INTO clan_row FROM public.clans x WHERE id=r.clan_id;
   SELECT to_jsonb(x) INTO founder FROM public.clan_members x WHERE player_wallet=r.payer;
   IF t.tx_key<>pg_current_xact_id()::text OR clan_row IS DISTINCT FROM t.clan_snapshot OR founder IS DISTINCT FROM t.founder_snapshot
   OR public.shardkeep_charter_terminal_quests(r.base_id) IS DISTINCT FROM t.quest_effects
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_EFFECTS';END IF;
  END IF;
 ELSE
  IF t.outcome<>'cancelled_unpaid' OR t.observation->>'outcome' IS DISTINCT FROM 'absent-after-expiry'
  OR t.terminal_transaction_id IS NOT NULL OR t.clan_snapshot IS NOT NULL OR t.founder_snapshot IS NOT NULL OR t.quest_effects<>'[]'::jsonb
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
  IF r.state='cancelled_unpaid' THEN
   IF f.id IS NOT NULL OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
   IF committing AND t.tx_key<>pg_current_xact_id()::text THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;
  ELSIF r.state='refunded' THEN
   SELECT * INTO p FROM public.charter_creation_terminal_posts WHERE ledger_id=f.refund_transaction_id;
   IF f.id IS NULL OR NOT isfinite(f.event_at) OR p.ledger_id IS NULL OR p.operation<>'refund' OR p.reservation_id<>r.id
   OR p.tx_key<>f.tx_key OR public.shardkeep_charter_terminal_money(p.ledger_id,committing) IS NOT TRUE
   OR (SELECT count(*) FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id)<>1
   OR f.authority IS DISTINCT FROM p.refund_authority OR f.authority->'base'->>'id' IS DISTINCT FROM f.destination_base_id::text
   OR f.authority->'base'->>'owner_wallet' IS DISTINCT FROM r.payer OR f.authority->'base'->>'status' IS DISTINCT FROM 'active'
   OR f.authority->'base'->'land_paid_at'='null'::jsonb OR f.authority->'observation'->>'owner' IS DISTINCT FROM r.payer
   OR f.authority->'observation'->>'status' IS DISTINCT FROM 'owned'
   OR p.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('version',1,'reservationId',r.id,
    'destinationBaseId',f.destination_base_id,'automatic',f.authority->'automatic')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
   IF committing THEN
    authority:=public.shardkeep_charter_terminal_destination(r.id,f.destination_base_id,(f.authority->>'automatic')::boolean);
    IF f.tx_key<>pg_current_xact_id()::text OR authority IS DISTINCT FROM f.authority
    THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY';END IF;
   END IF;
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;
 END IF;
 RETURN jsonb_build_object('result',jsonb_build_object('consent',r.consent,'reserveTransactionId',r.reserve_transaction_id,'state',r.state,
 'terminalId',t.id,'terminalTransactionId',t.terminal_transaction_id,'refundTransactionId',f.refund_transaction_id,'refundDestinationBaseId',f.destination_base_id),
 'inventory',inventory,'observation',t.observation);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE rid uuid;r public.charter_creation_reservations%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.charter_creation_terminal_posts'::regclass,'public.charter_creation_terminal_entries'::regclass,
 'public.charter_creation_terminals'::regclass,'public.charter_creation_refunds'::regclass,'public.charter_creation_reservations'::regclass)
 OR TG_NAME IS DISTINCT FROM (CASE WHEN TG_RELID='public.charter_creation_reservations'::regclass
  THEN 'charter_creation_reservations_terminal_complete' ELSE TG_TABLE_NAME||'_complete' END)
 OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP IS DISTINCT FROM
  (CASE WHEN TG_RELID='public.charter_creation_reservations'::regclass THEN 'UPDATE' ELSE 'INSERT' END)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_terminal_hooks();
 IF TG_RELID='public.charter_creation_terminal_entries'::regclass THEN
  SELECT reservation_id INTO rid FROM public.charter_creation_terminal_posts WHERE ledger_id=NEW.ledger_id;
 ELSIF TG_RELID='public.charter_creation_reservations'::regclass THEN rid:=NEW.id;ELSE rid:=NEW.reservation_id;END IF;
 SELECT * INTO STRICT r FROM public.charter_creation_reservations WHERE id=rid;
 IF public.shardkeep_charter_terminal_read(r.payer,r.intent_id,true) IS NULL
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_PAIRING';END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.charter_creation_terminal_posts%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||'_charter_terminal_capture') OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF TG_RELID='public.ledger_transactions'::regclass THEN
  IF NEW.type NOT IN('clan.charter.activate','clan.charter.refund') THEN RETURN NULL;END IF;
  PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_terminal_hooks();
  INSERT INTO public.charter_creation_terminal_posts(ledger_id) VALUES(NEW.id);
 ELSE
  IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts q WHERE q.tx_key=pg_current_xact_id()::text
    AND NEW.account_id IN(q.source_account_id,q.destination_account_id) AND NEW.txn_id<>q.ledger_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_POST_CONFLICT';END IF;
  SELECT * INTO p FROM public.charter_creation_terminal_posts WHERE ledger_id=NEW.txn_id;
  IF p.ledger_id IS NULL THEN
   IF EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=NEW.txn_id AND type IN('clan.charter.activate','clan.charter.refund'))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_SOURCE';END IF;RETURN NULL;
  END IF;
  PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_terminal_hooks();
  INSERT INTO public.charter_creation_terminal_entries(entry_id) VALUES(NEW.id);
 END IF;RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE protected boolean;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_READ_COMMITTED';END IF;
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_charter_terminal_no_truncate' ELSE '_charter_terminal_source' END))
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT')
 OR(TG_OP<>'TRUNCATE' AND(TG_OP NOT IN('UPDATE','DELETE') OR TG_LEVEL<>'ROW'))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN protected:=EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts);
 ELSIF TG_RELID='public.ledger_transactions'::regclass THEN
  protected:=OLD.type IN('clan.charter.activate','clan.charter.refund')
   OR EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE ledger_id=OLD.id)
   OR(TG_OP='UPDATE' AND NEW.type IN('clan.charter.activate','clan.charter.refund'));
 ELSIF TG_RELID='public.ledger_entries'::regclass THEN
  protected:=EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE ledger_id=OLD.txn_id)
   OR(TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE ledger_id=NEW.txn_id));
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_TRIGGER';END IF;
 IF protected THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_IMMUTABLE';END IF;
 IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;

--> statement-breakpoint
-- Narrow 0220 overrides retain the old funding proof and add only witnessed
-- state/account transitions. Prior migration files remain repeatable originals.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE t public.ledger_transactions%ROWTYPE;p public.charter_creation_funding_posts%ROWTYPE;e public.ledger_entries%ROWTYPE;
 s public.accounts%ROWTYPE;a public.accounts%ROWTYPE;c jsonb;b public.bases%ROWTYPE;proof jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.charter_creation_funding_posts'::regclass,'public.charter_creation_funding_entries'::regclass,'public.charter_creation_reservations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 IF TG_RELID='public.charter_creation_reservations'::regclass AND TG_OP='UPDATE' THEN
  PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_creation_hooks();
  IF to_jsonb(NEW)-'state' IS DISTINCT FROM to_jsonb(OLD)-'state' OR NOT(
   (OLD.state='reserved' AND NEW.state IN('activated','cancelled_unpaid') AND EXISTS(
    SELECT 1 FROM public.charter_creation_terminals x WHERE x.reservation_id=OLD.id AND x.outcome=NEW.state AND x.tx_key=pg_current_xact_id()::text))
   OR(OLD.state='cancelled_unpaid' AND NEW.state='refunded' AND EXISTS(
    SELECT 1 FROM public.charter_creation_refunds x WHERE x.reservation_id=OLD.id AND x.tx_key=pg_current_xact_id()::text)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_STATE';END IF;RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_creation_owner();PERFORM public.shardkeep_charter_creation_hooks();
 IF TG_RELID='public.charter_creation_funding_posts'::regclass THEN
  IF pg_trigger_depth()<>2 OR EXISTS(SELECT 1 FROM public.charter_creation_funding_posts WHERE ledger_id=NEW.ledger_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_SOURCE';END IF;
  SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=NEW.ledger_id;
  c:=t.metadata->'consent';
  IF t.type<>'clan.charter.reserve' OR jsonb_typeof(c)<>'object' OR c->>'version'<>'1'
  OR t.metadata IS DISTINCT FROM jsonb_build_object('version',1,'consent',c)
  OR t.idempotency_key IS DISTINCT FROM 'charter-create:'||(c->>'creationIntentId')
  OR coalesce(c->'price'->>'shards','')!~'^[1-9][0-9]{0,18}$'
  OR (c->'price'->>'shards')::numeric>9223372036854775807
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_SOURCE';END IF;
  SELECT * INTO STRICT s FROM public.accounts WHERE kind='base_shards' AND base_id=(c->'funding'->>'baseId')::uuid;
  SELECT * INTO STRICT a FROM public.accounts WHERE kind='charter_creation_escrow' AND owner_wallet IS NULL AND base_id IS NULL;
  PERFORM id FROM public.accounts WHERE id IN(s.id,a.id) ORDER BY id FOR UPDATE NOWAIT;
  SELECT * INTO STRICT s FROM public.accounts WHERE id=s.id;SELECT * INTO STRICT a FROM public.accounts WHERE id=a.id;
  NEW.amount:=(c->'price'->>'shards')::bigint;
  IF s.balance<NEW.amount THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_UNAFFORDABLE';END IF;
  IF s.currency<>'SHARDS' OR s.owner_wallet IS NOT NULL OR a.currency<>'SHARDS' OR a.balance<0
  OR a.balance::numeric+NEW.amount>9223372036854775807 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';END IF;
  IF EXISTS(SELECT 1 FROM public.charter_creation_funding_posts q
  WHERE q.tx_key=pg_current_xact_id()::text AND (q.source_account_id IN(s.id,a.id) OR q.escrow_account_id IN(s.id,a.id)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_POST_CONFLICT';END IF;
  NEW.tx_key:=pg_current_xact_id()::text;NEW.original_transaction:=to_jsonb(t);
  NEW.source_account_id:=s.id;NEW.escrow_account_id:=a.id;NEW.source_identity:=to_jsonb(s)-'balance';NEW.escrow_identity:=to_jsonb(a)-'balance';
  NEW.source_before:=s.balance;NEW.escrow_before:=a.balance;
 ELSIF TG_RELID='public.charter_creation_funding_entries'::regclass THEN
  IF pg_trigger_depth()<>2 OR EXISTS(SELECT 1 FROM public.charter_creation_funding_entries WHERE entry_id=NEW.entry_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_SOURCE';END IF;
  SELECT * INTO STRICT e FROM public.ledger_entries WHERE id=NEW.entry_id;
  SELECT * INTO STRICT p FROM public.charter_creation_funding_posts WHERE ledger_id=e.txn_id;
  SELECT * INTO STRICT a FROM public.accounts WHERE id=e.account_id;
  IF p.tx_key<>pg_current_xact_id()::text THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_SOURCE';END IF;
  IF (SELECT count(*) FROM public.charter_creation_funding_entries WHERE ledger_id=p.ledger_id)>=2
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_ENTRY_EXTRA';END IF;
  IF NOT ((e.account_id=p.source_account_id AND to_jsonb(a)-'balance'=p.source_identity)
   OR(e.account_id=p.escrow_account_id AND to_jsonb(a)-'balance'=p.escrow_identity))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_ENTRY_ACCOUNT';END IF;
  IF e.delta<>(CASE WHEN e.account_id=p.source_account_id THEN -p.amount ELSE p.amount END)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_ENTRY_AMOUNT';END IF;
  IF e.balance_after<>(CASE WHEN e.account_id=p.source_account_id THEN p.source_before-p.amount ELSE p.escrow_before+p.amount END)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_ENTRY_BALANCE';END IF;
  IF EXISTS(SELECT 1 FROM public.charter_creation_funding_entries w WHERE w.ledger_id=p.ledger_id AND w.original_entry->>'account_id'=e.account_id::text)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_ENTRY_DUPLICATE';END IF;
  NEW.ledger_id:=p.ledger_id;NEW.tx_key:=p.tx_key;NEW.original_entry:=to_jsonb(e);NEW.account_identity:=to_jsonb(a)-'balance';
 ELSE
  SELECT * INTO STRICT p FROM public.charter_creation_funding_posts WHERE ledger_id=NEW.reserve_transaction_id;
  IF NOT public.shardkeep_charter_creation_money(p.ledger_id,true) THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';END IF;
  c:=p.original_transaction->'metadata'->'consent';
  IF NEW.consent IS DISTINCT FROM c THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_CONSENT';END IF;
  -- NOWAIT protects even raw owner callers from waiting underneath clan barriers.
  PERFORM wallet FROM public.players WHERE wallet=c->>'payer' FOR UPDATE NOWAIT;
  SELECT * INTO STRICT b FROM public.bases WHERE id=(c->'funding'->>'baseId')::uuid FOR UPDATE NOWAIT;
  PERFORM base_id FROM public.base_slots WHERE base_id=b.id AND wallet=c->>'payer' AND active FOR UPDATE NOWAIT;
  IF NOT FOUND OR b.owner_wallet IS DISTINCT FROM c->>'payer' OR b.deed_asset_id IS DISTINCT FROM c->'funding'->>'deedAssetId'
  OR b.status<>'active' OR b.land_paid_at IS NULL OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_CUSTODY';END IF;
  -- The protected enrollment retains its accepted observation freshness bound.
  -- The facade independently applies today's BASE_OWNERSHIP bound as well.
  proof:=public.shardkeep_charter_custody_read(b.id,(SELECT freshness_ms FROM public.charter_custody_sources WHERE base_id=b.id));
  IF proof->>'authority'<>'current' OR proof->>'ownerWallet'<>c->>'payer'
  OR proof->>'id' IS DISTINCT FROM c->'funding'->'ownershipEpoch'->>'id'
  OR proof->>'evidenceCommitment' IS DISTINCT FROM c->'funding'->'ownershipEpoch'->>'evidenceCommitment'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_CUSTODY';END IF;
  LOCK TABLE public.clans,public.clan_members IN SHARE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.charter_creation_reservations WHERE state IN('reserved','cancelled_unpaid')
   AND(payer=c->>'payer' OR base_id=b.id)) THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_OUTSTANDING';END IF;
  IF EXISTS(SELECT 1 FROM public.clans WHERE id=(c->>'clanId')::uuid OR name=c->'clan'->>'name' OR tag=c->'clan'->>'tag' OR leader_wallet=c->>'payer')
  OR EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=c->>'payer')
  OR EXISTS(SELECT 1 FROM public.charter_creation_reservations WHERE state='reserved' AND(clan_id=(c->>'clanId')::uuid
   OR name=c->'clan'->>'name' OR tag=c->'clan'->>'tag' OR payer=c->>'payer')) THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PENDING';END IF;
  NEW.id:=(c->>'reservationId')::uuid;NEW.intent_id:=(c->>'creationIntentId')::uuid;NEW.clan_id:=(c->>'clanId')::uuid;
  NEW.payer:=c->>'payer';NEW.base_id:=b.id;NEW.deed_asset_id:=b.deed_asset_id;NEW.epoch_id:=(proof->>'id')::uuid;
  NEW.evidence_commitment:=proof->>'evidenceCommitment';NEW.name:=c->'clan'->>'name';NEW.tag:=c->'clan'->>'tag';
  NEW.state:='reserved';NEW.accepted_at:=clock_timestamp();NEW.custody_evidence:=jsonb_build_object('base',to_jsonb(b),'epoch',proof);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.charter_creation_funding_posts%ROWTYPE;k text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_READ_COMMITTED';END IF;
 IF TG_RELID NOT IN ('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||'_charter_creation_capture') OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 IF TG_RELID='public.ledger_transactions'::regclass THEN
  IF NEW.type<>'clan.charter.reserve' THEN RETURN NULL;END IF;
  PERFORM public.shardkeep_charter_creation_owner();PERFORM public.shardkeep_charter_creation_hooks();
  -- The private BEFORE guard derives identities and balances after the actual
  -- unique ledger key insert, locking canonical accounts in sorted order.
  INSERT INTO public.charter_creation_funding_posts(ledger_id) VALUES(NEW.id);
 ELSE
  -- The separately inventoried terminal hook owns these exact captured posts.
  IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE ledger_id=NEW.txn_id) THEN
   PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_terminal_hooks();RETURN NULL;
  END IF;
  SELECT * INTO p FROM public.charter_creation_funding_posts WHERE ledger_id=NEW.txn_id;
  SELECT kind::text INTO STRICT k FROM public.accounts WHERE id=NEW.account_id;
  IF EXISTS(SELECT 1 FROM public.charter_creation_funding_posts q WHERE q.tx_key=pg_current_xact_id()::text
   AND NEW.account_id IN(q.source_account_id,q.escrow_account_id) AND NEW.txn_id<>q.ledger_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_POST_CONFLICT';END IF;
  IF p.ledger_id IS NULL THEN
   IF k='charter_creation_escrow' OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=NEW.txn_id AND type='clan.charter.reserve')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';END IF;
   RETURN NULL;
  END IF;
  PERFORM public.shardkeep_charter_creation_owner();PERFORM public.shardkeep_charter_creation_hooks();
  INSERT INTO public.charter_creation_funding_entries(entry_id) VALUES(NEW.id);
 END IF;RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE q public.charter_creation_terminal_posts%ROWTYPE;p public.charter_creation_funding_posts%ROWTYPE;protected boolean;before_value bigint;after_value bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_READ_COMMITTED';END IF;
 IF TG_RELID<>'public.accounts'::regclass OR TG_NAME<>'accounts_charter_creation_guard'
 OR TG_WHEN<>'BEFORE' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.kind='charter_creation_escrow' AND(NEW.balance<>0 OR NEW.currency<>'SHARDS' OR NEW.owner_wallet IS NOT NULL OR NEW.base_id IS NOT NULL)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';END IF;RETURN NEW;
 END IF;
 SELECT EXISTS(SELECT 1 FROM public.charter_creation_funding_posts WHERE OLD.id IN(source_account_id,escrow_account_id)) INTO protected;
 IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts WHERE OLD.id IN(source_account_id,destination_account_id)) THEN protected:=true;END IF;
 IF protected OR OLD.kind='charter_creation_escrow' THEN
  PERFORM public.shardkeep_charter_creation_hooks();
  IF TG_OP='DELETE' OR to_jsonb(NEW)-'balance' IS DISTINCT FROM to_jsonb(OLD)-'balance'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_IMMUTABLE';END IF;
 ELSIF TG_OP='UPDATE' AND NEW.kind='charter_creation_escrow' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';
 END IF;
 SELECT * INTO q FROM public.charter_creation_terminal_posts WHERE tx_key=pg_current_xact_id()::text
 AND OLD.id IN(source_account_id,destination_account_id);
 IF q.ledger_id IS NOT NULL THEN
  PERFORM public.shardkeep_charter_terminal_owner();PERFORM public.shardkeep_charter_terminal_hooks();
  before_value:=CASE WHEN OLD.id=q.source_account_id THEN q.source_before ELSE q.destination_before END;
  after_value:=CASE WHEN OLD.id=q.source_account_id THEN q.source_before-q.amount ELSE q.destination_before+q.amount END;
  IF TG_OP<>'UPDATE' OR OLD.balance<>before_value OR NEW.balance<>after_value OR NOT EXISTS(
   SELECT 1 FROM public.charter_creation_terminal_entries w JOIN public.ledger_entries e ON e.id=w.entry_id
   WHERE w.ledger_id=q.ledger_id AND e.account_id=OLD.id AND e.balance_after=after_value
   AND e.delta=after_value-before_value AND w.original_entry=to_jsonb(e))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_MONEY';END IF;RETURN NEW;
 END IF;
 SELECT * INTO p FROM public.charter_creation_funding_posts WHERE tx_key=pg_current_xact_id()::text
 AND OLD.id IN(source_account_id,escrow_account_id);
 IF p.ledger_id IS NOT NULL THEN
  PERFORM public.shardkeep_charter_creation_owner();
  before_value:=CASE WHEN OLD.id=p.source_account_id THEN p.source_before ELSE p.escrow_before END;
  after_value:=CASE WHEN OLD.id=p.source_account_id THEN p.source_before-p.amount ELSE p.escrow_before+p.amount END;
  IF TG_OP<>'UPDATE' OR OLD.balance<>before_value OR NEW.balance<>after_value OR NOT EXISTS(
   SELECT 1 FROM public.charter_creation_funding_entries w JOIN public.ledger_entries e ON e.id=w.entry_id
   WHERE w.ledger_id=p.ledger_id AND e.account_id=OLD.id AND e.balance_after=after_value
   AND e.delta=after_value-before_value AND w.original_entry=to_jsonb(e))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';END IF;
 ELSIF TG_OP='UPDATE' AND OLD.kind='charter_creation_escrow' AND NEW.balance<>OLD.balance
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r record;
BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_HELD';END IF;
 FOR r IN
  SELECT t.tab,t.tab||s.suffix name,s.fn,s.typ,s.deferred,s.definer FROM
   (VALUES('charter_creation_funding_posts'),('charter_creation_funding_entries'),('charter_creation_reservations')) t(tab)
   CROSS JOIN(VALUES('_guard','private',31,false,false),('_no_truncate','private',34,false,false),('_complete','complete',5,true,true)) s(suffix,fn,typ,deferred,definer)
  UNION ALL
  SELECT t.tab,t.tab||s.suffix,s.fn,s.typ,false,true FROM
   (VALUES('ledger_transactions'),('ledger_entries')) t(tab)
   CROSS JOIN(VALUES('_charter_creation_capture','capture',5),('_charter_creation_source','source',27)) s(suffix,fn,typ)
  UNION ALL
  SELECT t.tab,t.tab||'_charter_creation_no_truncate','source',34,false,true FROM
   (VALUES('ledger_transactions'),('ledger_entries'),('accounts')) t(tab)
  UNION ALL SELECT 'accounts','accounts_charter_creation_guard','account',31,false,true
  UNION ALL SELECT t.tab,t.tab||'_charter_creation_pending','pending',23,false,true FROM(VALUES('clans'),('clan_members')) t(tab)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE t.tgrelid=('public.'||r.tab)::regclass AND t.tgname=r.name AND t.tgtype=r.typ AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname='shardkeep_charter_creation_'||r.fn AND p.pronargs=0 AND p.proowner=c.relowner
   AND p.prosecdef=r.definer AND t.tgdeferrable=r.deferred AND t.tginitdeferred=r.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT r.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_HELD';END IF;
 END LOOP;
 PERFORM public.shardkeep_charter_terminal_hooks();
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;p public.charter_creation_terminal_posts%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_READ_COMMITTED';END IF;
 IF TG_RELID NOT IN('public.clans'::regclass,'public.clan_members'::regclass) OR TG_NAME<>(TG_TABLE_NAME||'_charter_creation_pending')
 OR TG_WHEN<>'BEFORE' OR TG_OP NOT IN('INSERT','UPDATE') OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_creation_hooks();
 FOR r IN SELECT x.* FROM public.charter_creation_reservations x WHERE x.state='reserved' AND
  ((TG_RELID='public.clans'::regclass AND(x.clan_id::text=to_jsonb(NEW)->>'id' OR x.name=to_jsonb(NEW)->>'name'
    OR x.tag=to_jsonb(NEW)->>'tag' OR x.payer=to_jsonb(NEW)->>'leader_wallet'))
  OR(TG_RELID='public.clan_members'::regclass AND(x.payer=to_jsonb(NEW)->>'player_wallet' OR x.clan_id::text=to_jsonb(NEW)->>'clan_id')))
 LOOP
  SELECT * INTO p FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id AND operation='activate' AND tx_key=pg_current_xact_id()::text;
  IF TG_OP<>'INSERT' OR p.ledger_id IS NULL OR public.shardkeep_charter_terminal_money(p.ledger_id,true) IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PENDING';END IF;
  PERFORM public.shardkeep_charter_terminal_owner();
  LOCK TABLE public.clans,public.clan_members IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF TG_RELID='public.clans'::regclass THEN
   IF public.shardkeep_charter_terminal_clan(r.consent,to_jsonb(NEW),jsonb_build_object('clan_id',r.clan_id,'player_wallet',r.payer)) IS NOT TRUE
   THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PENDING';END IF;
  ELSE
   IF NEW.clan_id<>r.clan_id OR NEW.player_wallet<>r.payer
   THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PENDING';END IF;
  END IF;
 END LOOP;RETURN NEW;
END $$;

-- Legacy original recovery remains readable after completion. A terminal
-- state now requires its entire immutable graph; original prepare stays closed.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_read(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source jsonb;
BEGIN
 source:=public.shardkeep_charter_terminal_funding(w,intent);
 IF source IS NOT NULL AND source->>'state'<>'reserved' THEN
  IF public.shardkeep_charter_terminal_read(w,intent,false) IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_HELD';END IF;
 END IF;RETURN source;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_terminal_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r record;
BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
 FOR r IN
  SELECT t.tab,t.tab||s.suffix name,s.fn,s.typ,s.deferred,s.definer FROM
   (VALUES('charter_creation_terminal_posts'),('charter_creation_terminal_entries'),('charter_creation_terminals'),('charter_creation_refunds')) t(tab)
   CROSS JOIN(VALUES('_guard','private',31,false,false),('_no_truncate','private',34,false,false),('_complete','complete',5,true,true)) s(suffix,fn,typ,deferred,definer)
  UNION ALL SELECT t.tab,t.tab||s.suffix,s.fn,s.typ,false,true FROM
   (VALUES('ledger_transactions'),('ledger_entries')) t(tab)
   CROSS JOIN(VALUES('_charter_terminal_capture','capture',5),('_charter_terminal_source','source',27)) s(suffix,fn,typ)
  UNION ALL SELECT t.tab,t.tab||'_charter_terminal_no_truncate','source',34,false,true FROM
   (VALUES('ledger_transactions'),('ledger_entries'),('accounts')) t(tab)
  UNION ALL SELECT 'charter_creation_reservations','charter_creation_reservations_terminal_complete','complete',17,true,true
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE t.tgrelid=('public.'||r.tab)::regclass AND t.tgname=r.name AND t.tgtype=r.typ AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector AND n.nspname='public' AND p.proname='shardkeep_charter_terminal_'||r.fn
   AND p.pronargs=0 AND p.proowner=c.relowner AND p.prosecdef=r.definer AND t.tgdeferrable=r.deferred AND t.tginitdeferred=r.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT r.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_HELD';END IF;
 END LOOP;
END $$;

--> statement-breakpoint
DO $$DECLARE t text;fn record;BEGIN
 IF EXISTS(SELECT 1 FROM public.ledger_transactions x WHERE x.type IN('clan.charter.activate','clan.charter.refund')
  AND NOT EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts p WHERE p.ledger_id=x.id))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TERMINAL_BOOTSTRAP_HELD';END IF;
 FOREACH t IN ARRAY ARRAY['charter_creation_terminal_posts','charter_creation_terminal_entries','charter_creation_terminals','charter_creation_refunds'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_terminal_private()',t||'_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_terminal_private()',t||'_no_truncate',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_terminal_complete()',t||'_complete',t);END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_terminal_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_terminal_capture()',t||'_charter_terminal_capture',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_terminal_source') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_terminal_source()',t||'_charter_terminal_source',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_terminal_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_terminal_source()',t||'_charter_terminal_no_truncate',t);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_creation_reservations'::regclass AND tgname='charter_creation_reservations_terminal_complete') THEN
  CREATE CONSTRAINT TRIGGER charter_creation_reservations_terminal_complete AFTER UPDATE ON public.charter_creation_reservations
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_terminal_complete();END IF;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_terminal_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
 PERFORM public.shardkeep_charter_terminal_hooks();PERFORM public.shardkeep_charter_creation_hooks();PERFORM public.shardkeep_charter_permit_hooks();
END $$;
