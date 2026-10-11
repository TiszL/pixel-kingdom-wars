-- Existing-clan registration preserves the stable clan and every old balance.
-- The cutover snapshot proves current authority only, never unknown old history.
SET LOCAL lock_timeout='10s';
DO $$BEGIN PERFORM public.shardkeep_charter_retirement_source();END $$;
CREATE TABLE public.charter_migrations(
 id uuid PRIMARY KEY,actor text NOT NULL,idempotency_key uuid NOT NULL,clan_id uuid NOT NULL,
 original jsonb NOT NULL,source jsonb NOT NULL,snapshot_hash text NOT NULL,created_at timestamptz NOT NULL,tx_key text NOT NULL,
 UNIQUE(actor,idempotency_key)
);
CREATE INDEX charter_migrations_clan ON public.charter_migrations(clan_id);
CREATE TABLE public.charter_migration_attempts(
 migration_id uuid PRIMARY KEY REFERENCES public.charter_migrations(id),id uuid NOT NULL UNIQUE,permit_id text NOT NULL UNIQUE,record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE public.charter_migration_preparations(migration_id uuid PRIMARY KEY REFERENCES public.charter_migration_attempts(migration_id),record jsonb NOT NULL,tx_key text NOT NULL);
CREATE TABLE public.charter_migration_wires(migration_id uuid PRIMARY KEY REFERENCES public.charter_migration_preparations(migration_id),record jsonb NOT NULL,tx_key text NOT NULL);
CREATE TABLE public.charter_migration_terminals(
 migration_id uuid PRIMARY KEY REFERENCES public.charter_migrations(id),id uuid NOT NULL UNIQUE,outcome text NOT NULL CHECK(outcome IN('controlled','cancelled')),
 observation jsonb NOT NULL,source jsonb NOT NULL,inventory jsonb NOT NULL,tx_key text NOT NULL,created_at timestamptz NOT NULL
);
CREATE TABLE public.charter_migration_contract(
 singleton boolean PRIMARY KEY CHECK(singleton),previous_sha256 text NOT NULL,source_sha256 text NOT NULL,
 previous_tournament_sha256 text NOT NULL,tournament_sha256 text NOT NULL
);
ALTER TABLE public.charter_sale_births ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE public.charter_sale_births ALTER COLUMN terminal_id DROP NOT NULL;
ALTER TABLE public.charter_sale_births ADD COLUMN migration_id uuid UNIQUE REFERENCES public.charter_migration_terminals(migration_id);
ALTER TABLE public.charter_sale_births ADD CONSTRAINT charter_sale_birth_origin CHECK(
 (reservation_id IS NOT NULL AND terminal_id IS NOT NULL AND migration_id IS NULL)
 OR(reservation_id IS NULL AND terminal_id IS NULL AND migration_id IS NOT NULL));
REVOKE ALL ON public.charter_migrations,public.charter_migration_attempts,public.charter_migration_preparations,public.charter_migration_wires,public.charter_migration_terminals,public.charter_migration_contract FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_source() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS(SELECT 1 FROM public.charter_migration_contract next
  JOIN public.charter_retirement_draft_contract draft ON draft.singleton=next.singleton
  JOIN public.charter_retirement_projection_contract projection ON projection.singleton=next.singleton
  JOIN public.charter_retirement_contract first ON first.singleton=next.singleton
  WHERE next.singleton AND projection.previous_sha256=first.source_sha256 AND draft.previous_sha256=projection.source_sha256
   AND next.previous_sha256=draft.source_sha256 AND next.source_sha256=public.shardkeep_charter_retirement_fingerprint())
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();PERFORM public.shardkeep_charter_tournament_hooks();
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_source_check() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.charter_migration_contract next JOIN public.charter_tournament_source_contract previous ON previous.singleton=next.singleton
  WHERE next.singleton AND next.previous_tournament_sha256=encode(sha256(convert_to(previous.record::text,'UTF8')),'hex')
   AND next.tournament_sha256=encode(sha256(convert_to(public.shardkeep_charter_tournament_source_snapshot()::text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SCHEMA';END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_migrations'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_OWNER' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_snapshot(cid uuid,actor text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE c public.clans%ROWTYPE;roster jsonb;head jsonb;events jsonb;BEGIN
 PERFORM public.shardkeep_charter_migration_owner();PERFORM public.shardkeep_charter_retirement_source();
 -- Every relevant absent row stays absent until the pending original commits.
 LOCK TABLE public.clans,public.clan_members,public.raids,public.clan_charter_member_fences,public.charter_creation_reservations,public.charter_migrations IN SHARE MODE NOWAIT;
 SELECT * INTO c FROM public.clans WHERE id=cid FOR UPDATE NOWAIT;
 IF c.id IS NULL OR c.leader_wallet IS DISTINCT FROM actor OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=cid AND player_wallet=actor)
  OR EXISTS(SELECT 1 FROM public.charter_sale_births WHERE clan_id=cid)
  OR EXISTS(SELECT 1 FROM public.charter_creation_reservations WHERE clan_id=cid AND state='reserved')
  OR EXISTS(SELECT 1 FROM public.clan_charter_member_fences f WHERE clan_id=cid AND NOT public.shardkeep_charter_sale_released(f.id))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_HELD';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY player_wallet COLLATE "C"),'[]'::jsonb) INTO roster FROM public.clan_members m WHERE clan_id=cid;
 SELECT to_jsonb(h) INTO head FROM public.clan_charter_raid_chest_heads h WHERE clan_id=cid;
 IF head IS NOT NULL AND head->'clan_state' IS DISTINCT FROM to_jsonb(c) THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 -- Snapshot the authentic prospective admission inventory without asserting
 -- old or unresolved raid liabilities were paid or otherwise reconciled.
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY clan_ordinal),'[]'::jsonb) INTO events FROM public.clan_charter_raid_events e WHERE original_clan_id=cid;
 RETURN jsonb_build_object('version',1,'clan',to_jsonb(c),'roster',roster,'chestHead',head,'events',events,
  'eventHead',(SELECT to_jsonb(h) FROM public.clan_charter_event_heads h WHERE clan_id=cid),
  'source',(SELECT to_jsonb(s) FROM public.clan_charter_event_source s),
  'liabilityCoverage',CASE WHEN head IS NULL THEN 'unknown-before-cutover' ELSE 'existing-prospective-witnesses' END);
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_inventory(mid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('version',1,'revision',count(*)::text,'count',count(*),'messages',coalesce(jsonb_agg(record->'candidateHex'),'[]'::jsonb))
 FROM public.charter_migration_attempts WHERE migration_id=mid
$$;
CREATE FUNCTION public.shardkeep_charter_migration_current(mid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE m public.charter_migrations%ROWTYPE;BEGIN
 SELECT * INTO m FROM public.charter_migrations WHERE id=mid FOR UPDATE NOWAIT;
 IF m.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_migration_terminals WHERE migration_id=mid)
  OR m.source IS DISTINCT FROM public.shardkeep_charter_migration_snapshot(m.clan_id,m.actor)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_HELD';END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_observation(mid uuid,v jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.charter_migrations%ROWTYPE;a public.charter_migration_attempts%ROWTYPE;inventory jsonb;BEGIN
 SELECT * INTO m FROM public.charter_migrations WHERE id=mid;SELECT * INTO a FROM public.charter_migration_attempts WHERE migration_id=mid;
 -- Reuse registration observation consistency rules, with a genuine migration
 -- original and admission commitment. No funded reservation row is invented.
 inventory:=jsonb_build_object('reservation',jsonb_build_object('consent',m.original),
  'admission',jsonb_build_object('commitment',m.original->'admissionCommitment'),
  'message',CASE WHEN a.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('messageHex',a.record->'candidateHex') END);
 RETURN m.id IS NOT NULL AND public.shardkeep_charter_terminal_observation(v,inventory)
  AND(v->>'outcome'<>'minted' OR a.id IS NOT NULL)
  AND(v->'inventory'->'messages'->0->>'permitId' IS NOT DISTINCT FROM a.permit_id);
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE m public.charter_migrations%ROWTYPE;q jsonb;artifact jsonb;candidate text;ep public.charter_sale_epochs%ROWTYPE;BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_migration_owner();
 IF TG_TABLE_NAME='charter_migration_contract' THEN
  IF EXISTS(SELECT 1 FROM public.charter_migration_contract) OR NEW.singleton IS DISTINCT FROM true
   OR NEW.previous_sha256 IS DISTINCT FROM(SELECT source_sha256 FROM public.charter_retirement_draft_contract WHERE singleton)
   OR NEW.source_sha256 IS DISTINCT FROM public.shardkeep_charter_retirement_fingerprint()
   OR NEW.previous_tournament_sha256 IS DISTINCT FROM(SELECT encode(sha256(convert_to(record::text,'UTF8')),'hex') FROM public.charter_tournament_source_contract WHERE singleton)
   OR NEW.tournament_sha256 IS DISTINCT FROM encode(sha256(convert_to(public.shardkeep_charter_tournament_source_snapshot()::text,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;RETURN NEW;
 END IF;
 PERFORM public.shardkeep_charter_retirement_source();
 IF TG_TABLE_NAME='charter_migrations' THEN
  IF NEW.id IS NULL OR NEW.idempotency_key IS NULL OR NEW.actor IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_INPUT';END IF;
  NEW.source:=public.shardkeep_charter_migration_snapshot(NEW.clan_id,NEW.actor);SELECT * INTO ep FROM public.charter_sale_epochs;
  IF ep.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_migrations x WHERE x.clan_id=NEW.clan_id
   AND NOT EXISTS(SELECT 1 FROM public.charter_migration_terminals t WHERE t.migration_id=x.id AND t.outcome='cancelled'))
   OR NEW.original IS DISTINCT FROM jsonb_build_object('creationIntentId',NEW.id,'clanId',NEW.clan_id,'payer',NEW.actor,'metadata',NEW.original->'metadata','chain',NEW.original->'chain')
   OR NEW.original->'metadata'->>'name' IS DISTINCT FROM NEW.source->'clan'->>'name'
   OR jsonb_build_object('genesisHash',NEW.original->'chain'->'genesisHash','economyProgram',NEW.original->'chain'->'economyProgram','craftProgram',NEW.original->'chain'->'craftProgram') IS DISTINCT FROM ep.domain-'treasury'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_CONFLICT';END IF;
  NEW.snapshot_hash:=encode(sha256(convert_to(NEW.source::text,'UTF8')),'hex');
  NEW.original:=NEW.original||jsonb_build_object('admissionCommitment',encode(sha256(convert_to(jsonb_build_object('kind','existing-clan-migration-v1','id',NEW.id,'snapshotHash',NEW.snapshot_hash,'registration',NEW.original)::text,'UTF8')),'hex'));
  NEW.created_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 END IF;
 SELECT * INTO m FROM public.charter_migrations WHERE id=NEW.migration_id FOR UPDATE NOWAIT;
 PERFORM public.shardkeep_charter_migration_current(m.id);NEW.tx_key:=pg_current_xact_id()::text;
 IF TG_TABLE_NAME='charter_migration_attempts' THEN
  q:=NEW.record->'quote';candidate:=q->'packetInput'->>'candidateHex';SELECT * INTO ep FROM public.charter_sale_epochs;
  IF q->'packetInput'->'original' IS DISTINCT FROM m.original OR candidate IS NULL OR length(candidate)<>322 OR candidate!~'^[0-9a-f]+$'
   OR q->'observation'->'authority'->'currentPolicyKey' IS DISTINCT FROM q->'packetInput'->'policySigner'
   OR q->'observation'->'expectedCurrentSigner' IS DISTINCT FROM q->'packetInput'->'policySigner'
   OR q->'observation'->'authority'->>'admissionPaused' IS DISTINCT FROM 'false' OR q->'observation'->'craftControl'->>'admissionPaused' IS DISTINCT FROM 'false'
   OR NEW.record->>'elapsedMs' IS NULL OR(NEW.record->>'elapsedMs')::numeric<0 OR(NEW.record->>'elapsedMs')::numeric>(ep.policy->>'observationMaxAgeMs')::numeric
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
  NEW.id:=gen_random_uuid();NEW.permit_id:=substr(candidate,147,32);
  NEW.record:=jsonb_build_object('id',NEW.id,'candidateHex',candidate,'policySigner',q->'packetInput'->'policySigner','quote',q);
 ELSIF TG_TABLE_NAME='charter_migration_preparations' THEN
  IF NOT public.shardkeep_charter_preparation_artifact(NEW.record) THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_ARTIFACT';END IF;
 ELSIF TG_TABLE_NAME='charter_migration_wires' THEN
  SELECT record INTO artifact FROM public.charter_migration_preparations WHERE migration_id=m.id;
  IF NEW.record IS DISTINCT FROM jsonb_build_object('signedTransactionHex',NEW.record->'signedTransactionHex','signature',NEW.record->'signature','wireSha256',NEW.record->'wireSha256','messageSha256',NEW.record->'messageSha256')
   OR NEW.record->>'messageSha256' IS DISTINCT FROM artifact->'packet'->>'messageSha256'
   OR NEW.record->>'wireSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->>'signedTransactionHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_ARTIFACT';END IF;
 ELSIF TG_TABLE_NAME='charter_migration_terminals' THEN
  IF NEW.outcome IS DISTINCT FROM (CASE WHEN NEW.observation->>'outcome'='minted' THEN 'controlled' WHEN NEW.observation->>'outcome'='absent-after-expiry' THEN 'cancelled' END)
   OR public.shardkeep_charter_migration_observation(m.id,NEW.observation) IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_EVIDENCE';END IF;
  NEW.id:=gen_random_uuid();NEW.source:=m.source;NEW.inventory:=public.shardkeep_charter_migration_inventory(m.id);NEW.created_at:=clock_timestamp();
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;m public.charter_migrations%ROWTYPE;cid uuid;BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_migration_boundary' OR TG_WHEN<>'BEFORE'
  OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE') OR TG_TABLE_NAME NOT IN('clans','clan_members','raids')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_READ_COMMITTED';END IF;
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW);END IF;
 FOR m IN SELECT x.* FROM public.charter_migrations x WHERE NOT EXISTS(SELECT 1 FROM public.charter_migration_terminals t WHERE t.migration_id=x.id AND t.tx_key<>pg_current_xact_id()::text) ORDER BY x.clan_id LOOP
  IF(TG_TABLE_NAME='clans' AND m.clan_id::text IN(before_row->>'id',after_row->>'id'))
   OR(TG_TABLE_NAME='clan_members' AND m.clan_id::text IN(before_row->>'clan_id',after_row->>'clan_id'))
   OR(TG_TABLE_NAME='raids' AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.source->'roster') member WHERE member->>'player_wallet' IN(before_row->>'attacker_wallet',after_row->>'attacker_wallet')))
  THEN
   IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_READ_COMMITTED';END IF;
   PERFORM public.shardkeep_charter_retirement_source();PERFORM 1 FROM public.clans WHERE id=m.clan_id FOR UPDATE NOWAIT;
   RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_PENDING';
  END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_history(mid uuid,committing boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE m public.charter_migrations%ROWTYPE;t public.charter_migration_terminals%ROWTYPE;b public.charter_sale_births%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO m FROM public.charter_migrations WHERE id=mid;SELECT * INTO t FROM public.charter_migration_terminals WHERE migration_id=mid;
 IF m.id IS NULL OR t.id IS NULL OR t.source IS DISTINCT FROM m.source OR t.inventory IS DISTINCT FROM public.shardkeep_charter_migration_inventory(mid)
  OR public.shardkeep_charter_migration_observation(mid,t.observation) IS NOT TRUE
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 IF t.outcome='controlled' THEN
  SELECT * INTO b FROM public.charter_sale_births WHERE migration_id=mid;
  IF b.clan_id IS DISTINCT FROM m.clan_id OR b.reservation_id IS NOT NULL OR b.terminal_id IS NOT NULL OR b.tx_key IS DISTINCT FROM t.tx_key
   OR b.original_terminal IS DISTINCT FROM to_jsonb(t) OR b.creation IS DISTINCT FROM(m.original||jsonb_build_object('issuedPermitIds',jsonb_build_array(t.observation->'mint'->'permitId')))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 ELSIF EXISTS(SELECT 1 FROM public.charter_sale_births WHERE migration_id=mid) THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 IF committing THEN
  IF t.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR m.source->'clan' IS DISTINCT FROM(SELECT to_jsonb(c) FROM public.clans c WHERE id=m.clan_id)
   OR m.source->'roster' IS DISTINCT FROM(SELECT jsonb_agg(to_jsonb(member) ORDER BY player_wallet COLLATE "C") FROM public.clan_members member WHERE clan_id=m.clan_id)
   OR(t.outcome='controlled' AND NOT EXISTS(SELECT 1 FROM public.charter_sale_heads h WHERE clan_id=m.clan_id AND leader_wallet=m.actor AND revision=0 AND last_sale_id IS NULL))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_INCOMPLETE';END IF;
 END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_apply() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE m public.charter_migrations%ROWTYPE;BEGIN
 IF TG_RELID<>'public.charter_migration_terminals'::regclass OR TG_NAME<>'charter_migration_terminals_apply' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 IF NEW.outcome='controlled' THEN
  SELECT * INTO m FROM public.charter_migrations WHERE id=NEW.migration_id;
  INSERT INTO public.charter_sale_births(clan_id,migration_id) VALUES(m.clan_id,m.id);
  INSERT INTO public.charter_sale_heads(clan_id) VALUES(m.clan_id);
  IF NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_chest_heads WHERE clan_id=m.clan_id) THEN
   INSERT INTO public.clan_charter_raid_chest_heads(clan_id) VALUES(m.clan_id);
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.charter_migration_terminals'::regclass OR TG_NAME<>'charter_migration_terminals_complete' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
 PERFORM public.shardkeep_charter_migration_history(NEW.migration_id,true);RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_migration_read(actor text,mid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE m public.charter_migrations%ROWTYPE;a jsonb;p jsonb;w jsonb;t public.charter_migration_terminals%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_migration_owner();PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO m FROM public.charter_migrations WHERE id=mid;
 IF m.id IS NULL OR m.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_NOT_FOUND';END IF;
 SELECT * INTO t FROM public.charter_migration_terminals WHERE migration_id=mid;
 IF t.id IS NOT NULL THEN PERFORM public.shardkeep_charter_migration_history(mid,false);ELSE PERFORM public.shardkeep_charter_migration_current(mid);END IF;
 SELECT record INTO a FROM public.charter_migration_attempts WHERE migration_id=mid;SELECT record INTO p FROM public.charter_migration_preparations WHERE migration_id=mid;SELECT record INTO w FROM public.charter_migration_wires WHERE migration_id=mid;
 RETURN jsonb_build_object('version',1,'id',m.id,'actor',m.actor,'request',jsonb_build_object('clanId',m.clan_id,'idempotencyKey',m.idempotency_key),
  'clan',jsonb_build_object('id',m.clan_id,'name',m.source->'clan'->'name','tag',m.source->'clan'->'tag','inviteMode',m.source->'clan'->'invite_mode'),
  'snapshot',jsonb_build_object('memberCount',jsonb_array_length(m.source->'roster'),'chestShards',m.source->'clan'->>'chest_shards','capturedAt',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'commitment',m.original->'admissionCommitment'),
  'snapshotHash',m.snapshot_hash,'original',m.original,'status',coalesce(t.outcome,CASE WHEN w IS NOT NULL THEN 'signed' WHEN p IS NOT NULL THEN 'prepared' WHEN a IS NOT NULL THEN 'issuing' ELSE 'pending' END),
  'attempt',a,'preparation',p,'signed',w,'terminal',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'outcome',t.outcome,'record',t.observation) END,
  'inventory',public.shardkeep_charter_migration_inventory(mid));
END $$;

--> statement-breakpoint
-- Explicit successor copies change only the origin branches. Funded creation
-- remains tied to its real debit, terminal and same-transaction clan insert.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE ep public.charter_sale_epochs%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;t public.charter_creation_terminals%ROWTYPE;
 b public.charter_sale_births%ROWTYPE;h public.charter_sale_heads%ROWTYPE;s public.charter_sales%ROWTYPE;f public.clan_charter_member_fences%ROWTYPE;
 ledger public.ledger_transactions%ROWTYPE;leg public.ledger_entries%ROWTYPE;account public.accounts%ROWTYPE;
 ante_post public.charter_sale_ante_posts%ROWTYPE;ante_entry public.charter_sale_ante_entries%ROWTYPE;
 raid public.raids%ROWTYPE;event public.clan_charter_raid_events%ROWTYPE;expected_metadata jsonb;
 acceptance public.charter_sale_acceptances%ROWTYPE;attempt public.charter_sale_attempts%ROWTYPE;preparation public.charter_sale_preparations%ROWTYPE;
 wire public.charter_sale_wires%ROWTYPE;terminal public.charter_sale_terminals%ROWTYPE;payment public.clan_charter_member_payments%ROWTYPE;
 inventory_head public.charter_sale_inventory_heads%ROWTYPE;quote jsonb;receipt jsonb;expected_receipt jsonb;royalty numeric;actual jsonb;
 origin public.charter_sale_fence_origins%ROWTYPE;c public.clans%ROWTYPE;p public.charter_creation_terminal_posts%ROWTYPE;creation jsonb;terms jsonb;bid uuid;
BEGIN
 IF TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END) OR TG_WHEN<>'BEFORE'
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_READ_COMMITTED';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_sales'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_OWNER' USING ERRCODE='42501';END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='charter_sale_heads' THEN
   IF public.shardkeep_charter_sale_projection('charter_sale_heads',to_jsonb(OLD),to_jsonb(NEW))
    OR public.shardkeep_charter_tournament_projection('charter_sale_heads',to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
  ELSIF TG_TABLE_NAME='charter_sale_inventory_heads' THEN
   SELECT * INTO attempt FROM public.charter_sale_attempts WHERE sale_id=OLD.sale_id;
   IF OLD.revision=0 AND OLD.count=0 AND attempt.id IS NOT NULL AND attempt.tx_key=pg_current_xact_id()::text
    AND NEW.sale_id=OLD.sale_id AND NEW.revision=1 AND NEW.count=1 AND NEW.tx_key=attempt.tx_key THEN RETURN NEW;END IF;
  END IF;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='charter_sale_epochs' THEN
  LOCK TABLE public.clans,public.clan_members,public.raids,public.ledger_transactions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.raids WHERE status NOT IN('resolved','expired')) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  IF NEW.domain IS NULL OR NEW.domain IS DISTINCT FROM jsonb_build_object('genesisHash',NEW.domain->'genesisHash',
   'economyProgram',NEW.domain->'economyProgram','craftProgram',NEW.domain->'craftProgram','treasury',NEW.domain->'treasury')
   OR jsonb_typeof(NEW.policy) IS DISTINCT FROM 'object' OR NOT(NEW.policy ?& ARRAY['rosterCap','anteSchedule','royaltyBps','basisPoints','simVersion','batchGraceSeconds','observationMaxAgeMs','titheBps'])
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.singleton:=true;NEW.id:=gen_random_uuid();NEW.enrolled_at:=clock_timestamp();NEW.contract:='ordinary-monotone-d175-v1';
  SELECT source_id INTO STRICT NEW.source_id FROM public.clan_charter_event_source;
  SELECT id INTO STRICT NEW.rule_id FROM public.clan_charter_raid_tithe_rules WHERE source_id=NEW.source_id;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_clan_inserts' THEN
  SELECT * INTO ep FROM public.charter_sale_epochs;
  SELECT * INTO r FROM public.charter_creation_reservations WHERE clan_id=NEW.clan_id;
  SELECT * INTO p FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id AND operation='activate';
  IF ep.id IS NULL OR r.id IS NULL OR p.ledger_id IS NULL OR p.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR pg_trigger_depth()<>2 OR r.state<>'reserved' OR public.shardkeep_charter_terminal_money(p.ledger_id,true) IS NOT TRUE
   OR NEW.original_clan->>'id' IS DISTINCT FROM r.clan_id::text OR NEW.original_clan->>'leader_wallet' IS DISTINCT FROM r.payer
   OR NEW.original_clan->>'name' IS DISTINCT FROM r.name OR NEW.original_clan->>'tag' IS DISTINCT FROM r.tag
   OR EXISTS(SELECT 1 FROM public.clans WHERE id=NEW.clan_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.reservation_id:=r.id;NEW.epoch_id:=ep.id;NEW.post_id:=p.ledger_id;NEW.tx_key:=p.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_births' THEN
  IF NEW.migration_id IS NOT NULL THEN
   IF pg_trigger_depth()<>2 OR NEW.reservation_id IS NOT NULL OR NEW.terminal_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
   SELECT * INTO ep FROM public.charter_sale_epochs;
   SELECT jsonb_build_object('original',x.original,'source',x.source,'tx',mt.tx_key,'terminal',to_jsonb(mt)) INTO actual FROM public.charter_migrations x JOIN public.charter_migration_terminals mt ON mt.migration_id=x.id WHERE x.id=NEW.migration_id AND mt.outcome='controlled';
   IF actual IS NULL OR ep.id IS NULL OR actual->>'tx' IS DISTINCT FROM pg_current_xact_id()::text
    OR NEW.clan_id::text IS DISTINCT FROM actual->'original'->>'clanId'
    OR actual->'source'->'clan' IS DISTINCT FROM(SELECT to_jsonb(live_clan) FROM public.clans live_clan WHERE id=NEW.clan_id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_MIGRATION_SOURCE';END IF;
   NEW.epoch_id:=ep.id;NEW.tx_key:=actual->>'tx';NEW.original_terminal:=actual->'terminal';NEW.born_at:=(actual->'source'->'clan'->>'created_at')::timestamptz;
   NEW.creation:=actual->'original'||jsonb_build_object('issuedPermitIds',jsonb_build_array(actual->'terminal'->'observation'->'mint'->'permitId'));RETURN NEW;
  END IF;
  SELECT * INTO t FROM public.charter_creation_terminals WHERE id=NEW.terminal_id;
  SELECT * INTO r FROM public.charter_creation_reservations WHERE id=t.reservation_id;
  SELECT * INTO ep FROM public.charter_sale_epochs;
  IF pg_trigger_depth()<>2 OR t.id IS NULL OR t.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR t.outcome<>'activated'
   OR r.id IS NULL OR ep.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts ci WHERE ci.clan_id=r.clan_id
    AND ci.reservation_id=r.id AND ci.epoch_id=ep.id AND ci.tx_key=t.tx_key AND ci.original_clan=t.clan_snapshot)
   OR NOT EXISTS(SELECT 1 FROM public.clans live WHERE id=r.clan_id AND to_jsonb(live)=t.clan_snapshot)
   OR NOT EXISTS(SELECT 1 FROM public.clan_members live WHERE player_wallet=r.payer AND to_jsonb(live)=t.founder_snapshot)
   OR jsonb_build_object('genesisHash',r.consent->'chain'->'genesisHash','economyProgram',r.consent->'chain'->'economyProgram',
    'craftProgram',r.consent->'chain'->'craftProgram') IS DISTINCT FROM ep.domain-'treasury'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.clan_id:=r.clan_id;NEW.reservation_id:=r.id;NEW.epoch_id:=ep.id;NEW.tx_key:=t.tx_key;NEW.original_terminal:=to_jsonb(t);
  NEW.born_at:=(t.clan_snapshot->>'created_at')::timestamptz;
  NEW.creation:=jsonb_build_object('creationIntentId',r.intent_id,'clanId',r.clan_id,'payer',r.payer,'metadata',r.consent->'metadata',
   'chain',r.consent->'chain','admissionCommitment',t.observation->'mint'->'admissionCommitment',
   'issuedPermitIds',jsonb_build_array(t.observation->'mint'->'permitId'));RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_heads' THEN
  SELECT * INTO b FROM public.charter_sale_births WHERE clan_id=NEW.clan_id;
  IF b.clan_id IS NULL OR b.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR pg_trigger_depth()<>2
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.leader_wallet:=b.creation->>'payer';NEW.revision:=0;NEW.last_sale_id:=NULL;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sales' THEN
  PERFORM public.shardkeep_charter_sale_owner();
  IF NEW.request IS NULL OR NEW.request IS DISTINCT FROM jsonb_build_object('clanId',NEW.request->'clanId','buyer',NEW.request->'buyer',
   'priceLamports',NEW.request->'priceLamports','sellerLeaves',NEW.request->'sellerLeaves','idempotencyKey',NEW.request->'idempotencyKey')
   OR NEW.request->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key OR length(NEW.idempotency_key) NOT BETWEEN 1 AND 128
   OR jsonb_typeof(NEW.request->'sellerLeaves') IS DISTINCT FROM 'boolean' OR NEW.request->>'priceLamports' !~ '^[1-9][0-9]*$'
   OR(NEW.request->>'priceLamports')::numeric>18446744073709551615
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INPUT';END IF;
  NEW.clan_id:=(NEW.request->>'clanId')::uuid;NEW.buyer:=NEW.request->>'buyer';
  SELECT * INTO c FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=NEW.clan_id FOR UPDATE NOWAIT;
  creation:=public.shardkeep_charter_sale_birth(NEW.clan_id);SELECT * INTO ep FROM public.charter_sale_epochs;
  IF c.id IS NULL OR h.clan_id IS NULL OR c.leader_wallet IS DISTINCT FROM NEW.seller OR h.leader_wallet IS DISTINCT FROM NEW.seller
   OR NEW.buyer=NEW.seller OR NEW.buyer IS NULL OR NOT EXISTS(SELECT 1 FROM public.players WHERE wallet=NEW.buyer)
   OR h.revision>=4294967295 OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=c.id AND player_wallet=NEW.seller)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.id:=gen_random_uuid();NEW.created_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;
  terms:=jsonb_build_object('version',1,'id',NEW.id,'clanId',NEW.clan_id,'seller',NEW.seller,'buyer',NEW.buyer,
   'priceLamports',NEW.request->>'priceLamports','sellerLeaves',NEW.request->'sellerLeaves','domain',ep.domain,'expectedRevision',h.revision,
   'epochId',ep.id,'fenceId',gen_random_uuid(),'royaltyBps',ep.policy->'royaltyBps');
  NEW.original:=(terms-ARRAY['version','royaltyBps'])||jsonb_build_object('termsHash',encode(sha256(convert_to('SHARDKEEP_CHARTER_SALE_TERMS_V1'||terms::text,'UTF8')),'hex'),'creation',creation);
  RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_inventory_heads' THEN
  SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id;
  IF s.id IS NULL OR s.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR pg_trigger_depth()<>2
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.revision:=0;NEW.count:=0;NEW.tx_key:=s.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_fence_origins' THEN
  SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=NEW.fence_id;
  IF f.id IS NULL OR pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.original_fence:=to_jsonb(f);NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_acceptances' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
  SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=NEW.fence_id;
  SELECT * INTO origin FROM public.charter_sale_fence_origins WHERE fence_id=NEW.fence_id;
  IF s.id IS NULL OR origin.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR origin.original_fence IS DISTINCT FROM to_jsonb(f)
   OR f.clan_id IS DISTINCT FROM s.clan_id OR f.actor_wallet IS DISTINCT FROM s.seller OR f.idempotency_key IS DISTINCT FROM 'charter-sale:'||s.id::text
   OR NEW.terms_hash IS DISTINCT FROM s.original->>'termsHash' OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=s.id)
   OR EXISTS(SELECT 1 FROM public.charter_sale_acceptances prior JOIN public.charter_sales deal ON deal.id=prior.sale_id
    WHERE deal.buyer=s.buyer AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals done WHERE done.sale_id=deal.id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
  NEW.buyer_authority:=public.shardkeep_charter_member_payment_destination(s.buyer,NEW.buyer_base_id,NEW.freshness_ms);
  NEW.accepted_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_ante_posts' THEN
  SELECT * INTO ledger FROM public.ledger_transactions WHERE id=NEW.ledger_id;SELECT * INTO ep FROM public.charter_sale_epochs;
  IF pg_trigger_depth()<>2 OR ledger.id IS NULL OR ep.id IS NULL OR NOT((ledger.type='raid.ante' AND ledger.idempotency_key~'^raid-ante:raid:[0-9a-f]{64}:' AND length(ledger.idempotency_key)>80)
   OR(ledger.type='raid.ante.system_refund' AND ledger.idempotency_key~'^raid-ante-refund:[0-9a-f-]{36}$'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  NEW.epoch_id:=ep.id;NEW.original_transaction:=to_jsonb(ledger);NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_ante_entries' THEN
  SELECT * INTO leg FROM public.ledger_entries WHERE id=NEW.entry_id;
  SELECT * INTO ante_post FROM public.charter_sale_ante_posts WHERE ledger_id=leg.txn_id;
  SELECT * INTO account FROM public.accounts WHERE id=leg.account_id;
  IF pg_trigger_depth()<>2 OR ante_post.ledger_id IS NULL OR ante_post.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR leg.delta=0 OR account.currency<>'SHARDS' OR account.balance<0 OR leg.balance_after::numeric<>account.balance::numeric+leg.delta::numeric
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  NEW.ledger_id:=ante_post.ledger_id;NEW.original_entry:=to_jsonb(leg);NEW.account_identity:=to_jsonb(account)-'balance';
  NEW.before_balance:=account.balance;NEW.tx_key:=ante_post.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_ante_effects' THEN
  SELECT * INTO ante_entry FROM public.charter_sale_ante_entries WHERE entry_id=NEW.entry_id;
  SELECT * INTO account FROM public.accounts WHERE id=(ante_entry.original_entry->>'account_id')::uuid;
  IF pg_trigger_depth()<>2 OR ante_entry.entry_id IS NULL OR ante_entry.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR NEW.after_account IS DISTINCT FROM to_jsonb(account) OR NEW.before_account-'balance' IS DISTINCT FROM ante_entry.account_identity
   OR NEW.after_account-'balance' IS DISTINCT FROM ante_entry.account_identity
   OR(NEW.before_account->>'balance')::bigint IS DISTINCT FROM ante_entry.before_balance
   OR(NEW.after_account->>'balance')::bigint IS DISTINCT FROM(ante_entry.original_entry->>'balance_after')::bigint
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  NEW.tx_key:=ante_entry.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_raid_admissions' THEN
  SELECT * INTO event FROM public.clan_charter_raid_events WHERE raid_id=NEW.raid_id;
  SELECT * INTO raid FROM public.raids WHERE id=NEW.raid_id;SELECT * INTO ep FROM public.charter_sale_epochs;
  -- raids AFTER INSERT -> event AFTER INSERT -> this private admission.
  IF pg_trigger_depth()<>3 OR event.raid_id IS NULL OR event.source_id IS DISTINCT FROM ep.source_id
   OR event.chest_admission_tx IS DISTINCT FROM pg_current_xact_id()::text OR raid.status<>'pending_orders'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  IF raid.attacker_base_id IS NULL THEN SELECT keep_level INTO NEW.keep_level FROM public.players WHERE wallet=raid.attacker_wallet;
  ELSE SELECT keep_level INTO NEW.keep_level FROM public.bases WHERE id=raid.attacker_base_id;END IF;
  NEW.epoch_id:=ep.id;NEW.event:=to_jsonb(event);NEW.original_raid:=to_jsonb(raid);NEW.tx_key:=event.chest_admission_tx;
  NEW.ante_amount:=CASE WHEN event.kind IN('pve','campaign') THEN 0 ELSE
   (ep.policy->'anteSchedule'->>least(greatest(NEW.keep_level,1)-1,jsonb_array_length(ep.policy->'anteSchedule')-1))::bigint END;
  SELECT * INTO ante_post FROM public.charter_sale_ante_posts WHERE original_transaction->>'idempotency_key'='raid-ante:'||raid.idempotency_key;
  IF NEW.ante_amount>0 THEN
   -- createRaid persists raid:<sha256(wallet NUL pvp)>:<opaque client key>.
   -- The prospective epoch never adopts a pre-namespaced legacy charge.
   IF ante_post.ledger_id IS NULL OR ante_post.tx_key IS DISTINCT FROM NEW.tx_key
    OR left(raid.idempotency_key,70) IS DISTINCT FROM 'raid:'||encode(sha256(convert_to(raid.attacker_wallet,'UTF8')||decode('00','hex')||convert_to('pvp','UTF8')),'hex')||':'
    OR length(raid.idempotency_key)<=70 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
   expected_metadata:=jsonb_build_object('keepLevel',NEW.keep_level,'defender',raid.defender_wallet);
   IF raid.attacker_base_id IS NULL THEN expected_metadata:=expected_metadata||jsonb_build_object('wallet',raid.attacker_wallet);
   ELSE expected_metadata:=expected_metadata||jsonb_build_object('baseId',raid.attacker_base_id,'attackerBaseId',raid.attacker_base_id);END IF;
   IF raid.defender_base_id IS NOT NULL THEN expected_metadata:=expected_metadata||jsonb_build_object('defenderBaseId',raid.defender_base_id);END IF;
   IF ante_post.original_transaction->'metadata' IS DISTINCT FROM expected_metadata THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
   NEW.ante_post:=ante_post.ledger_id;
  ELSE
   IF ante_post.ledger_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;NEW.ante_post:=NULL;
  END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_raid_outcomes' THEN
  SELECT * INTO raid FROM public.raids WHERE id=NEW.raid_id;
  IF pg_trigger_depth()<>2 OR to_jsonb(raid) IS DISTINCT FROM NEW.after_raid OR raid.status NOT IN('expired','resolved')
   OR NEW.before_raid->>'id' IS DISTINCT FROM raid.id::text OR NEW.before_raid->>'status' NOT IN('pending_orders','resolving')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  SELECT to_jsonb(live) INTO NEW.live_state FROM public.raid_live_states live WHERE live.raid_id=raid.id;
  NEW.observed_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_attempts' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
  SELECT * INTO acceptance FROM public.charter_sale_acceptances WHERE sale_id=s.id;
  SELECT * INTO inventory_head FROM public.charter_sale_inventory_heads WHERE sale_id=s.id FOR UPDATE NOWAIT;
  SELECT * INTO ep FROM public.charter_sale_epochs;
  quote:=NEW.record->'quote';
  IF s.id IS NULL OR acceptance.sale_id IS NULL OR inventory_head.sale_id IS NULL OR inventory_head.revision<>0
   OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=s.id)
   OR quote->'packetInput'->'original' IS DISTINCT FROM public.shardkeep_charter_sale_chain_original(s.id)
   OR quote->>'version' IS DISTINCT FROM '1' OR quote->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR quote->>'transferAuthorized' IS DISTINCT FROM 'false' OR quote->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   OR quote->'observation'->>'registryRevision' IS DISTINCT FROM s.original->>'expectedRevision'
   OR quote->'observation'->>'registryLeader' IS DISTINCT FROM s.seller OR quote->'observation'->>'lockKind' IS DISTINCT FROM '0'
   OR quote->'observation'->>'admissionPaused' IS DISTINCT FROM 'false' OR quote->'observation'->>'craftPaused' IS DISTINCT FROM 'false'
   OR quote->'packetInput'->>'policySigner' IS DISTINCT FROM quote->'observation'->>'policySigner'
   OR public.shardkeep_charter_sale_pins(s.id,quote->'observation'->'source') IS NOT TRUE
   OR NEW.record->>'elapsedMs' IS NULL OR(NEW.record->>'elapsedMs')::double precision<0
   OR(NEW.record->>'elapsedMs')::double precision>(ep.policy->>'observationMaxAgeMs')::double precision
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  PERFORM public.shardkeep_charter_sale_expiry(quote->'packetInput'->>'candidateHex');
  NEW.source:=jsonb_build_object('clearance',public.shardkeep_charter_sale_clearance(s.id),'elapsedMs',NEW.record->'elapsedMs');
  NEW.buyer_authority:=public.shardkeep_charter_member_payment_destination(s.buyer,acceptance.buyer_base_id,NEW.freshness_ms);
  NEW.id:=gen_random_uuid();NEW.record:=jsonb_build_object('id',NEW.id,'candidateHex',quote->'packetInput'->'candidateHex',
   'policySigner',quote->'packetInput'->'policySigner','quote',quote);NEW.recorded_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_preparations' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO attempt FROM public.charter_sale_attempts WHERE sale_id=NEW.sale_id;
  IF attempt.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id)
   OR NEW.record IS DISTINCT FROM jsonb_build_object('policySignatureHex',NEW.record->'policySignatureHex','packet',NEW.record->'packet')
   OR coalesce(NEW.record->>'policySignatureHex','') !~ '^[0-9a-f]{128}$' OR NEW.record->'packet'->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR NEW.record->'packet'->>'relayAuthorized' IS DISTINCT FROM 'false' OR NEW.record->'packet'->>'version' IS DISTINCT FROM '1'
   OR NEW.record->'packet'->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->'packet'->>'messageHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_wires' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO preparation FROM public.charter_sale_preparations WHERE sale_id=NEW.sale_id;
  IF preparation.sale_id IS NULL OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id)
   OR NEW.record IS DISTINCT FROM jsonb_build_object('signedTransactionHex',NEW.record->'signedTransactionHex','signature',NEW.record->'signature',
    'wireSha256',NEW.record->'wireSha256','messageSha256',NEW.record->'messageSha256')
   OR NEW.record->>'messageSha256' IS DISTINCT FROM preparation.record->'packet'->>'messageSha256'
   OR NEW.record->>'wireSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->>'signedTransactionHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_terminals' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
  SELECT * INTO acceptance FROM public.charter_sale_acceptances WHERE sale_id=s.id;
  SELECT * INTO inventory_head FROM public.charter_sale_inventory_heads WHERE sale_id=s.id FOR UPDATE NOWAIT;
  SELECT * INTO attempt FROM public.charter_sale_attempts WHERE sale_id=s.id;
  SELECT * INTO wire FROM public.charter_sale_wires WHERE sale_id=s.id;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO c FROM public.clans WHERE id=s.clan_id FOR UPDATE NOWAIT;SELECT * INTO ep FROM public.charter_sale_epochs;
  IF s.id IS NULL OR inventory_head.sale_id IS NULL OR inventory_head.count<>(CASE WHEN attempt.id IS NULL THEN 0 ELSE 1 END)
   OR h.revision IS DISTINCT FROM(s.original->>'expectedRevision')::bigint OR h.leader_wallet IS DISTINCT FROM s.seller
   OR c.leader_wallet IS DISTINCT FROM s.seller THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.inventory:=jsonb_build_object('version',1,'revision',inventory_head.revision::text,'count',inventory_head.count,
   'messages',CASE WHEN attempt.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(attempt.record->'candidateHex') END);
  NEW.clan_before:=to_jsonb(c);NEW.clan_after:=to_jsonb(c);
  SELECT coalesce(jsonb_agg(to_jsonb(member) ORDER BY member.player_wallet COLLATE "C"),'[]'::jsonb) INTO NEW.roster_before FROM public.clan_members member WHERE clan_id=s.clan_id;
  NEW.roster_after:=NEW.roster_before;
  IF NEW.outcome='completed' THEN
   NEW.source:=public.shardkeep_charter_sale_clearance(s.id);receipt:=NEW.record->'receipt';
   royalty:=floor((s.original->>'priceLamports')::numeric*(ep.policy->>'royaltyBps')::numeric/(ep.policy->>'basisPoints')::numeric);
   expected_receipt:=jsonb_build_object('transferId',s.id,'fenceId',s.original->'fenceId','clanId',s.clan_id,'seller',s.seller,'buyer',s.buyer,
    'treasury',s.original->'domain'->'treasury','priceLamports',s.original->>'priceLamports','sellerLamports',((s.original->>'priceLamports')::numeric-royalty)::text,
    'royaltyLamports',royalty::text,'priorRevision',h.revision,'revision',h.revision+1,'termsHash',s.original->'termsHash','acceptedAt',receipt->'acceptedAt');
   IF wire.sale_id IS NULL OR receipt IS DISTINCT FROM expected_receipt OR coalesce(receipt->>'acceptedAt','') !~ '^(0|[1-9][0-9]*)$'
    OR NEW.record->>'version' IS DISTINCT FROM '1' OR NEW.record->>'signature' IS DISTINCT FROM wire.record->>'signature'
    OR NEW.record->>'wireSha256' IS DISTINCT FROM wire.record->>'wireSha256' OR NEW.record->>'messageSha256' IS DISTINCT FROM wire.record->>'messageSha256'
    OR NEW.record->>'finalizedTransferObserved' IS DISTINCT FROM 'true' OR NEW.record->>'backendClearanceVerified' IS DISTINCT FROM 'false'
    OR NEW.record->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
   NEW.clan_after:=jsonb_set(jsonb_set(NEW.clan_before,'{leader_wallet}',to_jsonb(s.buyer)),'{invite_code}',CASE WHEN c.invite_mode='invite' THEN to_jsonb(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')) ELSE 'null'::jsonb END);
   SELECT coalesce(jsonb_agg(member ORDER BY member->>'player_wallet' COLLATE "C"),'[]'::jsonb)
   INTO NEW.roster_after FROM jsonb_array_elements(NEW.roster_before) member
    WHERE NOT((s.original->>'sellerLeaves')::boolean AND member->>'player_wallet'=s.seller);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.roster_after) member WHERE member->>'player_wallet'=s.buyer) THEN
    NEW.roster_after:=NEW.roster_after||jsonb_build_array(jsonb_build_object('player_wallet',s.buyer,'clan_id',s.clan_id,'joined_at',clock_timestamp()));
   END IF;
   SELECT jsonb_agg(member ORDER BY member->>'player_wallet' COLLATE "C") INTO NEW.roster_after FROM jsonb_array_elements(NEW.roster_after) member;
   IF jsonb_array_length(NEW.roster_after)>(ep.policy->>'rosterCap')::integer THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
  ELSIF NEW.outcome='cancelled' THEN
   IF NEW.record->'original' IS DISTINCT FROM public.shardkeep_charter_sale_chain_original(s.id)
    OR NEW.record->'inventory' IS DISTINCT FROM NEW.inventory OR NEW.record->>'outcome' IS DISTINCT FROM 'absent-after-expiry'
    OR NEW.record->'receipt' IS DISTINCT FROM 'null'::jsonb OR NEW.record->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
    OR NEW.record->>'transferAuthorized' IS DISTINCT FROM 'false' OR public.shardkeep_charter_sale_pins(s.id,NEW.record->'source') IS NOT TRUE
    OR coalesce(NEW.record->>'unixTimestamp','') !~ '^[1-9][0-9]*$'
    OR(attempt.id IS NOT NULL AND(NEW.record->>'unixTimestamp')::numeric<=public.shardkeep_charter_sale_expiry(attempt.record->>'candidateHex'))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
   NEW.source:=jsonb_build_object('head',to_jsonb(h));
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_SALE_STATE';END IF;
  NEW.id:=gen_random_uuid();NEW.tx_key:=pg_current_xact_id()::text;NEW.completed_at:=clock_timestamp();RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_fence_releases' THEN
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id;
  SELECT * INTO acceptance FROM public.charter_sale_acceptances WHERE sale_id=NEW.sale_id;
  SELECT * INTO payment FROM public.clan_charter_member_payments WHERE fence_id=acceptance.fence_id;
  IF terminal.sale_id IS NULL OR terminal.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR pg_trigger_depth()<>2
   OR acceptance.fence_id IS DISTINCT FROM NEW.fence_id THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.terminal_id:=terminal.id;NEW.payment_source:=payment.source;NEW.tx_key:=terminal.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_effects' THEN
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id;
  IF terminal.sale_id IS NULL OR terminal.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR public.shardkeep_charter_sale_projection(NEW.kind,NEW.before_row,NEW.after_row) IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  IF NEW.kind='clans' THEN SELECT to_jsonb(live) INTO actual FROM public.clans live WHERE id=NEW.target::uuid;
  ELSIF NEW.kind='clan_members' THEN SELECT to_jsonb(live) INTO actual FROM public.clan_members live WHERE player_wallet=NEW.target;
  ELSIF NEW.kind='charter_sale_heads' THEN SELECT to_jsonb(live) INTO actual FROM public.charter_sale_heads live WHERE clan_id=NEW.target::uuid;
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  IF actual IS DISTINCT FROM NEW.after_row THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.tx_key:=terminal.tx_key;RETURN NEW;
 END IF;
 RAISE EXCEPTION 'CLAN_CHARTER_SALE_STATE';
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_birth(cid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.charter_sale_births%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;t public.charter_creation_terminals%ROWTYPE;
 e public.charter_sale_epochs%ROWTYPE;v jsonb;
BEGIN
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO b FROM public.charter_sale_births WHERE clan_id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 IF b.migration_id IS NOT NULL THEN PERFORM public.shardkeep_charter_migration_history(b.migration_id,false);RETURN b.creation;END IF;
 SELECT * INTO e FROM public.charter_sale_epochs WHERE id=b.epoch_id;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=b.reservation_id FOR UPDATE NOWAIT;
 SELECT * INTO t FROM public.charter_creation_terminals WHERE id=b.terminal_id;
 IF e.id IS NULL OR t.id IS NULL OR to_jsonb(t) IS DISTINCT FROM b.original_terminal OR t.outcome<>'activated'
 OR r.state<>'activated' OR r.clan_id IS DISTINCT FROM cid OR t.reservation_id IS DISTINCT FROM r.id
 OR b.tx_key IS DISTINCT FROM t.tx_key OR NOT EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts ci
  WHERE ci.clan_id=cid AND ci.reservation_id=r.id AND ci.epoch_id=e.id AND ci.tx_key=b.tx_key AND ci.original_clan=t.clan_snapshot)
 OR jsonb_build_object('genesisHash',r.consent->'chain'->'genesisHash','economyProgram',r.consent->'chain'->'economyProgram',
  'craftProgram',r.consent->'chain'->'craftProgram') IS DISTINCT FROM e.domain-'treasury'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 v:=public.shardkeep_charter_terminal_read(r.payer,r.intent_id,false);
 IF v IS NULL OR v->'result'->>'terminalId' IS DISTINCT FROM b.terminal_id::text
  OR v->'result'->>'state' IS DISTINCT FROM 'activated' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 RETURN b.creation;
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
  IF NEW.first_raid_id IS NULL THEN
   IF EXISTS(SELECT 1 FROM public.charter_sale_births b JOIN public.charter_migrations m ON m.id=b.migration_id JOIN public.charter_migration_terminals t ON t.migration_id=m.id
    WHERE b.clan_id=NEW.clan_id AND b.tx_key=pg_current_xact_id()::text AND t.tx_key=b.tx_key AND t.outcome='controlled' AND b.original_terminal=to_jsonb(t)
     AND m.source->'clan'=current_clan AND m.source->'chestHead'='null'::jsonb) THEN
    SELECT ep.rule_id INTO NEW.rule_id FROM public.charter_sale_births b JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id WHERE b.clan_id=NEW.clan_id;
    NEW.revision:=0;NEW.clan_state:=current_clan;RETURN NEW;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_births b JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id
    JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id WHERE b.clan_id=NEW.clan_id
    AND b.tx_key=pg_current_xact_id()::text AND ci.tx_key=b.tx_key AND ci.epoch_id=b.epoch_id
    AND b.original_terminal->'clan_snapshot'=current_clan AND ci.original_clan=current_clan)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_SOURCE';END IF;
   SELECT ep.rule_id INTO NEW.rule_id FROM public.charter_sale_births b JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id WHERE b.clan_id=NEW.clan_id;
   NEW.revision:=0;NEW.clan_state:=current_clan;RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.charter_sale_births%ROWTYPE;s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;h public.charter_sale_inventory_heads%ROWTYPE;x record;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_charter_sale_complete'
 OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_epochs) THEN RETURN NULL;END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 FOR b IN SELECT * FROM public.charter_sale_births WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_birth(b.clan_id);
  IF NOT EXISTS(SELECT 1 FROM public.charter_sale_heads WHERE clan_id=b.clan_id AND revision=0 AND leader_wallet=b.creation->>'payer')
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_chest_heads WHERE clan_id=b.clan_id AND(b.migration_id IS NOT NULL OR first_raid_id IS NULL))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts ci WHERE ci.tx_key=pg_current_xact_id()::text
  AND NOT EXISTS(SELECT 1 FROM public.charter_sale_births born WHERE born.clan_id=ci.clan_id AND born.epoch_id=ci.epoch_id AND born.tx_key=ci.tx_key))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 FOR s IN SELECT * FROM public.charter_sales WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO h FROM public.charter_sale_inventory_heads WHERE sale_id=s.id;
  IF h.sale_id IS NULL OR h.revision<>(SELECT count(*) FROM public.charter_sale_attempts WHERE sale_id=s.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.charter_sale_fence_origins f WHERE f.tx_key=pg_current_xact_id()::text
  AND NOT EXISTS(SELECT 1 FROM public.charter_sale_acceptances accepted WHERE accepted.fence_id=f.fence_id AND accepted.tx_key=f.tx_key))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 FOR a IN SELECT * FROM public.charter_sale_acceptances WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO s FROM public.charter_sales WHERE id=a.sale_id;
  IF a.buyer_authority IS DISTINCT FROM public.shardkeep_charter_member_payment_destination(s.buyer,a.buyer_base_id,a.freshness_ms)
   OR EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=s.buyer AND clan_id<>s.clan_id)
   OR NOT EXISTS(SELECT 1 FROM public.charter_sale_fence_origins f WHERE f.fence_id=a.fence_id AND f.tx_key=a.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 FOR x IN SELECT * FROM public.charter_sale_attempts WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO s FROM public.charter_sales WHERE id=x.sale_id;SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=x.sale_id;
  SELECT * INTO h FROM public.charter_sale_inventory_heads WHERE sale_id=x.sale_id;
  IF h.revision IS DISTINCT FROM 1 OR h.count IS DISTINCT FROM 1 OR h.tx_key IS DISTINCT FROM x.tx_key
   OR x.buyer_authority IS DISTINCT FROM public.shardkeep_charter_member_payment_destination(s.buyer,a.buyer_base_id,x.freshness_ms)
   OR x.source->'clearance' IS DISTINCT FROM public.shardkeep_charter_sale_clearance(s.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 FOR x IN SELECT * FROM public.charter_sale_inventory_heads WHERE tx_key=pg_current_xact_id()::text LOOP
  IF x.count<>(SELECT count(*) FROM public.charter_sale_attempts WHERE sale_id=x.sale_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 FOR x IN SELECT * FROM public.charter_sale_ante_posts WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_ante_post(x.ledger_id);
  IF x.original_transaction->>'type'='raid.ante' THEN
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_raid_admissions admission WHERE admission.ante_post=x.ledger_id AND admission.tx_key=x.tx_key)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_raid_outcomes outcome WHERE outcome.raid_id::text=x.original_transaction->'metadata'->>'raidId'
    AND outcome.tx_key=x.tx_key AND outcome.after_raid->>'status'='expired') THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
  END IF;
 END LOOP;
 FOR x IN SELECT raid_id FROM public.charter_sale_raid_admissions WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_ante_proof(x.raid_id,false);
 END LOOP;
 FOR x IN SELECT sale_id FROM public.charter_sale_terminals WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_terminal_history(x.sale_id,true);
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_migrations','charter_migration_attempts','charter_migration_preparations','charter_migration_wires','charter_migration_terminals','charter_migration_contract'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_migration_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_migration_guard()',tab||'_no_truncate',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['clans','clan_members','raids'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_migration_boundary()',tab||'_migration_boundary',tab);
 END LOOP;
 CREATE TRIGGER charter_migration_terminals_apply AFTER INSERT ON public.charter_migration_terminals FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_migration_apply();
 CREATE CONSTRAINT TRIGGER charter_migration_terminals_complete AFTER INSERT ON public.charter_migration_terminals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_migration_complete();
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'shardkeep_charter_migration_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
INSERT INTO public.charter_migration_contract SELECT true,source_sha256,public.shardkeep_charter_retirement_fingerprint(),
 (SELECT encode(sha256(convert_to(record::text,'UTF8')),'hex') FROM public.charter_tournament_source_contract WHERE singleton),
 encode(sha256(convert_to(public.shardkeep_charter_tournament_source_snapshot()::text,'UTF8')),'hex') FROM public.charter_retirement_draft_contract WHERE singleton;
