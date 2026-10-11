-- Prospective owner-only funding. Existing opening base balances are trusted;
-- this proves the new actual debit, not the provenance of all earlier money.
-- Existing-table source/pending hooks remain S5-held. No issuer or terminal.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.charter_creation_funding_posts (
 ledger_id uuid PRIMARY KEY REFERENCES public.ledger_transactions(id),tx_key text NOT NULL,
 original_transaction jsonb NOT NULL,source_account_id uuid NOT NULL,escrow_account_id uuid NOT NULL,
 source_identity jsonb NOT NULL,escrow_identity jsonb NOT NULL,source_before bigint NOT NULL,
 escrow_before bigint NOT NULL,amount bigint NOT NULL CHECK(amount>0),
 CHECK(source_account_id<>escrow_account_id),CHECK(source_before>=amount),CHECK(escrow_before>=0)
);
CREATE TABLE IF NOT EXISTS public.charter_creation_funding_entries (
 entry_id bigint PRIMARY KEY REFERENCES public.ledger_entries(id),ledger_id uuid NOT NULL REFERENCES public.charter_creation_funding_posts(ledger_id),
 tx_key text NOT NULL,original_entry jsonb NOT NULL,account_identity jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_creation_reservations (
 id uuid PRIMARY KEY,intent_id uuid NOT NULL UNIQUE,clan_id uuid NOT NULL,payer text NOT NULL,
 base_id uuid NOT NULL,deed_asset_id text NOT NULL,epoch_id uuid NOT NULL REFERENCES public.charter_custody_epochs(id),
 evidence_commitment text NOT NULL,consent jsonb NOT NULL,name text NOT NULL,tag text NOT NULL,
 reserve_transaction_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_funding_posts(ledger_id),
 state text NOT NULL DEFAULT 'reserved' CHECK(state='reserved'),accepted_at timestamptz NOT NULL,custody_evidence jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS charter_creation_pending_clan ON public.charter_creation_reservations(clan_id) WHERE state='reserved';
CREATE UNIQUE INDEX IF NOT EXISTS charter_creation_pending_name ON public.charter_creation_reservations(name) WHERE state='reserved';
CREATE UNIQUE INDEX IF NOT EXISTS charter_creation_pending_tag ON public.charter_creation_reservations(tag) WHERE state='reserved';
CREATE UNIQUE INDEX IF NOT EXISTS charter_creation_pending_founder ON public.charter_creation_reservations(payer) WHERE state='reserved';
CREATE UNIQUE INDEX IF NOT EXISTS charter_creation_obligation_payer ON public.charter_creation_reservations(payer) WHERE state IN ('reserved','cancelled_unpaid');
CREATE UNIQUE INDEX IF NOT EXISTS charter_creation_obligation_base ON public.charter_creation_reservations(base_id) WHERE state IN ('reserved','cancelled_unpaid');
-- A interrupted enum-only rollout cannot silently adopt earlier escrow money.
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE t.type='clan.charter.reserve'
 AND NOT EXISTS(SELECT 1 FROM public.charter_creation_funding_posts p WHERE p.ledger_id=t.id))
 OR (NOT EXISTS(SELECT 1 FROM public.charter_creation_funding_posts) AND EXISTS(
 SELECT 1 FROM public.accounts a WHERE a.kind='charter_creation_escrow' AND
 (a.balance<>0 OR EXISTS(SELECT 1 FROM public.ledger_entries e WHERE e.account_id=a.id))))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_BOOTSTRAP_HELD';END IF;
END $$;
--> statement-breakpoint
-- Commit-time pairing is bidirectional. Current cache equality belongs only
-- here; historical reads must remain valid after ordinary gameplay changes.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE lid uuid;r public.charter_creation_reservations%ROWTYPE;p public.charter_creation_funding_posts%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN ('public.charter_creation_funding_posts'::regclass,'public.charter_creation_funding_entries'::regclass,'public.charter_creation_reservations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||'_complete') OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_creation_hooks();
 IF TG_RELID='public.charter_creation_reservations'::regclass THEN lid:=NEW.reserve_transaction_id;ELSE lid:=NEW.ledger_id;END IF;
 SELECT * INTO p FROM public.charter_creation_funding_posts WHERE ledger_id=lid;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE reserve_transaction_id=lid;
 IF r.id IS NULL OR p.ledger_id IS NULL OR r.consent IS DISTINCT FROM p.original_transaction->'metadata'->'consent'
 OR NOT public.shardkeep_charter_creation_money(lid,true) THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PAIRING';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.charter_creation_funding_posts'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_OWNER' USING ERRCODE='42501';END IF;
END $$;

-- Historical proof does NOT compare current balance caches to old after values.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_money(lid uuid,committing boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.charter_creation_funding_posts%ROWTYPE;t public.ledger_transactions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM public.charter_creation_funding_posts WHERE ledger_id=lid;
 SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=lid;
 IF p.original_transaction IS DISTINCT FROM to_jsonb(t) OR t.type<>'clan.charter.reserve'
 OR t.idempotency_key IS DISTINCT FROM 'charter-create:'||(t.metadata->'consent'->>'creationIntentId')
 OR t.metadata IS DISTINCT FROM jsonb_build_object('version',1,'consent',t.metadata->'consent')
 OR p.amount IS DISTINCT FROM (t.metadata->'consent'->'price'->>'shards')::bigint
 OR p.source_before<p.amount OR p.escrow_before<0
 OR (SELECT count(*) FROM public.ledger_entries WHERE txn_id=lid)<>2
 OR (SELECT count(*) FROM public.charter_creation_funding_entries WHERE ledger_id=lid)<>2
 OR EXISTS(SELECT 1 FROM public.charter_creation_funding_entries w LEFT JOIN public.ledger_entries e ON e.id=w.entry_id
 LEFT JOIN public.accounts a ON a.id=e.account_id WHERE w.ledger_id=lid AND
 (e.id IS NULL OR e.txn_id<>lid OR w.tx_key<>p.tx_key OR w.original_entry IS DISTINCT FROM to_jsonb(e)
 OR w.account_identity IS DISTINCT FROM to_jsonb(a)-'balance'))
 OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 WHERE e.txn_id=lid AND e.account_id=p.source_account_id AND e.delta=-p.amount AND e.balance_after=p.source_before-p.amount
 AND to_jsonb(a)-'balance'=p.source_identity AND a.kind='base_shards' AND a.currency='SHARDS'
 AND a.owner_wallet IS NULL AND a.base_id::text=t.metadata->'consent'->'funding'->>'baseId')
 OR NOT EXISTS(SELECT 1 FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id
 WHERE e.txn_id=lid AND e.account_id=p.escrow_account_id AND e.delta=p.amount AND e.balance_after=p.escrow_before+p.amount
 AND to_jsonb(a)-'balance'=p.escrow_identity AND a.kind='charter_creation_escrow' AND a.currency='SHARDS'
 AND a.owner_wallet IS NULL AND a.base_id IS NULL) THEN RETURN false;END IF;
 IF committing AND (p.tx_key<>pg_current_xact_id()::text OR NOT EXISTS(
 SELECT 1 FROM public.accounts s,public.accounts e WHERE s.id=p.source_account_id AND e.id=p.escrow_account_id
 AND s.balance=p.source_before-p.amount AND e.balance=p.escrow_before+p.amount)) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE t public.ledger_transactions%ROWTYPE;p public.charter_creation_funding_posts%ROWTYPE;e public.ledger_entries%ROWTYPE;
 s public.accounts%ROWTYPE;a public.accounts%ROWTYPE;c jsonb;b public.bases%ROWTYPE;proof jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.charter_creation_funding_posts'::regclass,'public.charter_creation_funding_entries'::regclass,'public.charter_creation_reservations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
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
--> statement-breakpoint
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
DECLARE p public.charter_creation_funding_posts%ROWTYPE;protected boolean;before_value bigint;after_value bigint;
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
 IF protected OR OLD.kind='charter_creation_escrow' THEN
  PERFORM public.shardkeep_charter_creation_hooks();
  IF TG_OP='DELETE' OR to_jsonb(NEW)-'balance' IS DISTINCT FROM to_jsonb(OLD)-'balance'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_IMMUTABLE';END IF;
 ELSIF TG_OP='UPDATE' AND NEW.kind='charter_creation_escrow' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_MONEY';
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

CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE protected boolean;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_READ_COMMITTED';END IF;
 IF TG_RELID NOT IN ('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_charter_creation_no_truncate' ELSE '_charter_creation_source' END))
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT')
 OR(TG_OP<>'TRUNCATE' AND(TG_OP NOT IN ('UPDATE','DELETE') OR TG_LEVEL<>'ROW'))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN protected:=EXISTS(SELECT 1 FROM public.charter_creation_funding_posts);
 ELSIF TG_RELID='public.ledger_transactions'::regclass THEN
  protected:=OLD.type='clan.charter.reserve' OR EXISTS(SELECT 1 FROM public.charter_creation_funding_posts WHERE ledger_id=OLD.id)
   OR(TG_OP='UPDATE' AND NEW.type='clan.charter.reserve');
 ELSIF TG_RELID='public.ledger_entries'::regclass THEN
  protected:=EXISTS(SELECT 1 FROM public.charter_creation_funding_posts WHERE ledger_id=OLD.txn_id)
   OR EXISTS(SELECT 1 FROM public.accounts WHERE id=OLD.account_id AND kind='charter_creation_escrow')
   OR(TG_OP='UPDATE' AND(EXISTS(SELECT 1 FROM public.charter_creation_funding_posts WHERE ledger_id=NEW.txn_id)
    OR EXISTS(SELECT 1 FROM public.accounts WHERE id=NEW.account_id AND kind='charter_creation_escrow')));
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 IF protected THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_IMMUTABLE';END IF;
 IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
--> statement-breakpoint
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
END $$;


--> statement-breakpoint
-- Original reads use immutable source money facts, never today's cached amount.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_read(w text,intent uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;c jsonb;e public.charter_custody_epochs%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_creation_owner();PERFORM public.shardkeep_charter_creation_hooks();
 SELECT * INTO r FROM public.charter_creation_reservations WHERE intent_id=intent;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.payer IS DISTINCT FROM w THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PAYER';END IF;
 c:=r.consent;SELECT * INTO e FROM public.charter_custody_epochs WHERE id=r.epoch_id;
 IF r.state<>'reserved' OR NOT isfinite(r.accepted_at) OR e.id IS NULL
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

-- Existing legacy creation/join/rename paths stay untouched in TypeScript.
-- These fresh RC database barriers are S5-held even for unenrolled non-RC work.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_creation_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_READ_COMMITTED';END IF;
 IF TG_RELID NOT IN ('public.clans'::regclass,'public.clan_members'::regclass) OR TG_NAME<>(TG_TABLE_NAME||'_charter_creation_pending')
 OR TG_WHEN<>'BEFORE' OR TG_OP NOT IN('INSERT','UPDATE') OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_creation_hooks();
 IF TG_RELID='public.clans'::regclass THEN
  IF EXISTS(SELECT 1 FROM public.charter_creation_reservations r WHERE state='reserved' AND
   (r.clan_id=NEW.id OR r.name=NEW.name OR r.tag=NEW.tag OR r.payer=NEW.leader_wallet))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PENDING';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.charter_creation_reservations r WHERE state='reserved' AND(r.payer=NEW.player_wallet OR r.clan_id=NEW.clan_id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CREATION_PENDING';END IF;
 END IF;RETURN NEW;
END $$;
--> statement-breakpoint
DO $$DECLARE t text;fn record;BEGIN
 FOREACH t IN ARRAY ARRAY['charter_creation_funding_posts','charter_creation_funding_entries','charter_creation_reservations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_creation_private()',t||'_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_creation_private()',t||'_no_truncate',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_creation_complete()',t||'_complete',t);END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_creation_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_creation_capture()',t||'_charter_creation_capture',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_creation_source') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_creation_source()',t||'_charter_creation_source',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_creation_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_creation_source()',t||'_charter_creation_no_truncate',t);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounts'::regclass AND tgname='accounts_charter_creation_guard') THEN
  CREATE TRIGGER accounts_charter_creation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_creation_account();END IF;
 FOREACH t IN ARRAY ARRAY['clans','clan_members'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_creation_pending') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_creation_pending()',t||'_charter_creation_pending',t);END IF;
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_creation_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
 PERFORM public.shardkeep_charter_creation_hooks();
END $$;
