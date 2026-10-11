-- D153.181 prospective tournament source. Existing guard replacement is S5-held.
-- No ordinary epoch, historical receipt, winner or money row is backfilled.
SET LOCAL lock_timeout='10s';
DO $$BEGIN
 IF to_regclass('public.charter_tournament_epochs') IS NOT NULL THEN
  IF to_regprocedure('public.shardkeep_charter_tournament_source_check()') IS NULL
   OR to_regclass('public.charter_tournament_source_contract') IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SCHEMA';END IF;
  PERFORM public.shardkeep_charter_tournament_source_check();
 ELSIF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(
  ARRAY['charter_tournament_adoptions','charter_tournament_entries','charter_tournament_operations','charter_tournament_attempts','charter_tournament_preparations',
  'charter_tournament_wires','charter_tournament_terminals','charter_tournament_entry_completions','charter_tournament_nonparticipations','charter_tournament_releases',
  'charter_tournament_revision_edges','charter_tournament_effects','charter_tournament_sale_sources','charter_tournament_source_contract']))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SCHEMA';END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.charter_tournament_epochs(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id uuid NOT NULL UNIQUE,
 ordinary_epoch_id uuid NOT NULL REFERENCES public.charter_sale_epochs(id),domain jsonb NOT NULL,
 contract text NOT NULL CHECK(contract='charter-tournament-v1'),enrolled_at timestamptz NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_adoptions(
 clan_id uuid PRIMARY KEY REFERENCES public.charter_sale_births(clan_id),id uuid NOT NULL UNIQUE,
 epoch_id uuid NOT NULL REFERENCES public.charter_tournament_epochs(id),original jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_entries(
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES public.charter_tournament_events(id),
 clan_id uuid NOT NULL REFERENCES public.charter_tournament_adoptions(clan_id),leader text NOT NULL,
 idempotency_key uuid NOT NULL,lock_id uuid NOT NULL UNIQUE,original jsonb NOT NULL,admitted_at timestamptz NOT NULL CHECK(isfinite(admitted_at)),tx_key text NOT NULL,
 UNIQUE(leader,idempotency_key)
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_operations(
 id uuid PRIMARY KEY,entry_id uuid NOT NULL REFERENCES public.charter_tournament_entries(id),
 action text NOT NULL CHECK(action IN('set','clear')),idempotency_key uuid NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),
 original jsonb NOT NULL,terms jsonb NOT NULL,created_at timestamptz NOT NULL,tx_key text NOT NULL,
 UNIQUE(entry_id,idempotency_key),UNIQUE(entry_id,ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS charter_tournament_set_once ON public.charter_tournament_operations(entry_id) WHERE action='set';
CREATE TABLE IF NOT EXISTS public.charter_tournament_attempts(
 operation_id uuid PRIMARY KEY REFERENCES public.charter_tournament_operations(id),id uuid NOT NULL UNIQUE,
 permit_id text NOT NULL UNIQUE CHECK(permit_id~'^[0-9a-f]{32}$'),record jsonb NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_preparations(
 operation_id uuid PRIMARY KEY REFERENCES public.charter_tournament_attempts(operation_id),record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_wires(
 operation_id uuid PRIMARY KEY REFERENCES public.charter_tournament_preparations(operation_id),record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_terminals(
 operation_id uuid PRIMARY KEY REFERENCES public.charter_tournament_operations(id),id uuid NOT NULL UNIQUE,
 outcome text NOT NULL CHECK(outcome IN('completed','cancelled')),record jsonb NOT NULL,
 inventory jsonb NOT NULL,head_before jsonb NOT NULL,head_after jsonb NOT NULL,completed_at timestamptz NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_entry_completions(
 entry_id uuid PRIMARY KEY REFERENCES public.charter_tournament_entries(id),roster jsonb NOT NULL,
 lock_terminal_id uuid NOT NULL UNIQUE REFERENCES public.charter_tournament_terminals(id),completed_at timestamptz NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_nonparticipations(
 entry_id uuid PRIMARY KEY REFERENCES public.charter_tournament_entries(id),terminal_id uuid NOT NULL UNIQUE REFERENCES public.charter_tournament_terminals(id),
 original jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_releases(
 entry_id uuid PRIMARY KEY REFERENCES public.charter_tournament_entries(id),terminal_id uuid NOT NULL UNIQUE REFERENCES public.charter_tournament_terminals(id),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_revision_edges(
 clan_id uuid NOT NULL REFERENCES public.charter_tournament_adoptions(clan_id),revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 4294967295),
 kind text NOT NULL CHECK(kind IN('set','clear','sale')),terminal_id uuid NOT NULL UNIQUE,
 before_row jsonb NOT NULL,after_row jsonb NOT NULL,tx_key text NOT NULL,PRIMARY KEY(clan_id,revision)
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_effects(
 terminal_id uuid PRIMARY KEY REFERENCES public.charter_tournament_terminals(id),before_row jsonb NOT NULL,after_row jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_tournament_sale_sources(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sales(id),epoch_id uuid NOT NULL REFERENCES public.charter_tournament_epochs(id),
 original jsonb NOT NULL,tx_key text NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_tournament_epochs'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_OWNER' USING ERRCODE='42501';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE v record;owner_id oid;BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 PERFORM public.shardkeep_charter_tournament_source_check();
 PERFORM public.shardkeep_charter_sale_hooks();
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_tournament_epochs'::regclass;
 FOR v IN
 SELECT tab,tab||suffix name,fn,typ,definer,deferred FROM
 unnest(ARRAY['charter_tournament_epochs','charter_tournament_adoptions','charter_tournament_entries','charter_tournament_operations',
 'charter_tournament_attempts','charter_tournament_preparations','charter_tournament_wires','charter_tournament_terminals',
 'charter_tournament_entry_completions','charter_tournament_nonparticipations','charter_tournament_releases','charter_tournament_revision_edges',
 'charter_tournament_effects','charter_tournament_sale_sources']) tab CROSS JOIN
 (VALUES('_guard','shardkeep_charter_tournament_private',31,false,false),('_no_truncate','shardkeep_charter_tournament_private',34,false,false),
 ('_complete','shardkeep_charter_tournament_complete',29,true,true)) defs(suffix,fn,typ,definer,deferred)
 UNION ALL SELECT tab,tab||'_tournament_capture','shardkeep_charter_tournament_capture',5,false,false FROM
 unnest(ARRAY['charter_tournament_entries','charter_tournament_terminals','charter_sales','charter_sale_terminals']) tab
 UNION ALL SELECT tab,tab||'_zz_tournament_boundary','shardkeep_charter_tournament_boundary',31,true,false FROM
 unnest(ARRAY['clans','clan_members','charter_sales','charter_sale_acceptances','charter_sale_attempts','charter_sale_terminals','clan_charter_member_fences']) tab
 UNION ALL SELECT 'charter_sale_heads','charter_sale_heads_tournament_effect','shardkeep_charter_tournament_effect',17,false,false
 UNION ALL SELECT tab,tab||'_tournament_permit_guard','shardkeep_charter_tournament_permit_guard',7,false,false FROM
 unnest(ARRAY['charter_creation_permit_messages','charter_sale_attempts']) tab
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=('public.'||v.tab)::regclass AND t.tgname=v.name
   AND t.tgtype=v.typ AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname=v.fn AND p.pronargs=0 AND p.proowner=owner_id AND c.relowner=owner_id
   AND p.prosecdef=v.definer AND t.tgdeferrable=v.deferred AND t.tginitdeferred=v.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) cfg WHERE replace(cfg,' ','')='search_path=pg_catalog,public,pg_temp'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_inventory(oid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('version',1,'revision',count(*)::text,'count',count(*),
 'messages',coalesce(jsonb_agg(record->'candidateHex'),'[]'::jsonb)) FROM public.charter_tournament_attempts WHERE operation_id=oid
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_projection(tab text,before_row jsonb,after_row jsonb) RETURNS boolean
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT tab='charter_sale_heads' AND EXISTS(SELECT 1 FROM public.charter_tournament_terminals t
 WHERE t.tx_key=pg_current_xact_id()::text AND t.outcome='completed' AND t.head_before=before_row AND t.head_after=after_row)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_fenced(cid uuid) RETURNS boolean
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.charter_tournament_entries e WHERE e.clan_id=cid
 AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_releases r WHERE r.entry_id=e.id))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_prefix(cid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_tournament_adoptions%ROWTYPE;h jsonb;edge record;entries jsonb;BEGIN
 SELECT * INTO a FROM public.charter_tournament_adoptions WHERE clan_id=cid;
 IF a.id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 h:=a.original->'head';
 FOR edge IN SELECT * FROM public.charter_tournament_revision_edges WHERE clan_id=cid ORDER BY revision LOOP
  IF edge.before_row IS DISTINCT FROM h OR edge.revision<>(h->>'revision')::bigint+1
   OR edge.after_row->>'revision' IS DISTINCT FROM edge.revision::text THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  IF edge.kind='sale' THEN PERFORM public.shardkeep_charter_sale_terminal_history((SELECT sale_id FROM public.charter_sale_terminals WHERE id=edge.terminal_id),false);
  ELSIF NOT EXISTS(SELECT 1 FROM public.charter_tournament_terminals t JOIN public.charter_tournament_effects fx ON fx.terminal_id=t.id
   WHERE t.id=edge.terminal_id AND t.outcome='completed' AND t.head_before=edge.before_row AND t.head_after=edge.after_row
   AND fx.before_row=edge.before_row AND fx.after_row=edge.after_row AND fx.tx_key=t.tx_key AND edge.tx_key=t.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  h:=edge.after_row;
 END LOOP;
 IF h IS DISTINCT FROM(SELECT to_jsonb(live) FROM public.charter_sale_heads live WHERE clan_id=cid)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('entry',to_jsonb(e),'completion',to_jsonb(c),'nonparticipation',to_jsonb(n),'release',to_jsonb(r)) ORDER BY e.id),'[]'::jsonb)
 INTO entries FROM public.charter_tournament_entries e LEFT JOIN public.charter_tournament_entry_completions c ON c.entry_id=e.id
 LEFT JOIN public.charter_tournament_nonparticipations n ON n.entry_id=e.id LEFT JOIN public.charter_tournament_releases r ON r.entry_id=e.id WHERE e.clan_id=cid;
 RETURN jsonb_build_object('contract','ordinary-with-tournament-prefix-v1','adoption',to_jsonb(a),'head',h,'entries',entries);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_clearance(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_entries%ROWTYPE;n jsonb;BEGIN
 SELECT * INTO e FROM public.charter_tournament_entries WHERE id=eid;
 SELECT original INTO n FROM public.charter_tournament_nonparticipations WHERE entry_id=eid;
 IF n IS NOT NULL THEN RETURN n;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_entry_completions WHERE entry_id=eid)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_PENDING';END IF;
 RETURN public.charter_tournament_event_terminal(e.event_id);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE ep public.charter_tournament_epochs%ROWTYPE;ordinary public.charter_sale_epochs%ROWTYPE;
 e public.charter_tournament_entries%ROWTYPE;o public.charter_tournament_operations%ROWTYPE;
 a public.charter_tournament_attempts%ROWTYPE;t public.charter_tournament_terminals%ROWTYPE;
 h public.charter_sale_heads%ROWTYPE;birth public.charter_sale_births%ROWTYPE;s public.charter_sales%ROWTYPE;
 c public.clans%ROWTYPE;event jsonb;roster jsonb;terms jsonb;creation jsonb;proof jsonb;wire jsonb;before_head jsonb;after_head jsonb;
BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_IMMUTABLE';END IF;
 IF TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_RELID<>to_regclass('public.'||TG_TABLE_NAME)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 IF TG_TABLE_NAME='charter_tournament_epochs' THEN
  LOCK TABLE public.charter_tournament_epochs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  SELECT * INTO ordinary FROM public.charter_sale_epochs;
  IF ordinary.id IS NULL OR NEW.domain IS DISTINCT FROM ordinary.domain THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CONFLICT';END IF;
  NEW.singleton:=true;NEW.id:=gen_random_uuid();NEW.ordinary_epoch_id:=ordinary.id;NEW.contract:='charter-tournament-v1';NEW.enrolled_at:=clock_timestamp();
 ELSIF TG_TABLE_NAME='charter_tournament_adoptions' THEN
  SELECT * INTO ep FROM public.charter_tournament_epochs;
  creation:=public.shardkeep_charter_sale_birth(NEW.clan_id);
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=NEW.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO birth FROM public.charter_sale_births WHERE clan_id=NEW.clan_id;
  IF ep.id IS NULL OR birth.epoch_id IS DISTINCT FROM ep.ordinary_epoch_id OR h.clan_id IS NULL
   OR EXISTS(SELECT 1 FROM public.charter_sales prior_sale WHERE prior_sale.clan_id=NEW.clan_id AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals prior_terminal WHERE prior_terminal.sale_id=prior_sale.id))
   OR EXISTS(SELECT 1 FROM public.clan_charter_member_fences f WHERE f.clan_id=NEW.clan_id AND NOT public.shardkeep_charter_sale_released(f.id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_PENDING';END IF;
  FOR s IN SELECT * FROM public.charter_sales WHERE clan_id=NEW.clan_id LOOP PERFORM public.shardkeep_charter_sale_terminal_history(s.id,false);END LOOP;
  NEW.id:=gen_random_uuid();NEW.epoch_id:=ep.id;NEW.original:=jsonb_build_object('birth',to_jsonb(birth),'head',to_jsonb(h),
   'raidHead',(SELECT to_jsonb(x) FROM public.clan_charter_event_heads x WHERE clan_id=NEW.clan_id),
   'chestHead',(SELECT to_jsonb(x) FROM public.clan_charter_raid_chest_heads x WHERE clan_id=NEW.clan_id));
 ELSIF TG_TABLE_NAME='charter_tournament_entries' THEN
  LOCK TABLE public.clan_members IN SHARE MODE NOWAIT;
  SELECT * INTO c FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=NEW.clan_id FOR UPDATE NOWAIT;
  IF c.id IS NULL OR c.leader_wallet IS DISTINCT FROM NEW.leader OR h.leader_wallet IS DISTINCT FROM NEW.leader OR h.revision>=4294967294
   OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=c.id AND player_wallet=NEW.leader)
   OR public.shardkeep_charter_tournament_fenced(c.id)
   OR EXISTS(SELECT 1 FROM public.charter_sales prior_sale WHERE prior_sale.clan_id=c.id AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals prior_terminal WHERE prior_terminal.sale_id=prior_sale.id))
   OR EXISTS(SELECT 1 FROM public.clan_charter_member_fences f WHERE f.clan_id=c.id AND NOT public.shardkeep_charter_sale_released(f.id))
   OR EXISTS(SELECT 1 FROM public.charter_tournament_entries prior WHERE prior.event_id=NEW.event_id AND prior.clan_id=c.id
    AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_operations op JOIN public.charter_tournament_terminals done ON done.operation_id=op.id
      WHERE op.entry_id=prior.id AND op.action='set' AND done.outcome='cancelled'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_FENCED';END IF;
  event:=public.charter_tournament_event_terms(NEW.event_id);SELECT * INTO ep FROM public.charter_tournament_epochs;
  IF event IS NULL OR ep.id IS NULL OR (SELECT domain FROM public.charter_tournament_events WHERE id=NEW.event_id) IS DISTINCT FROM ep.domain
   OR EXISTS(SELECT 1 FROM public.charter_tournament_event_terminals WHERE event_id=NEW.event_id)
   OR NEW.admitted_at IS NULL OR NOT isfinite(NEW.admitted_at)
   OR NEW.admitted_at<(event->>'entryStartsAt')::timestamptz OR NEW.admitted_at>=(event->>'playStartsAt')::timestamptz
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_WINDOW';END IF;
  creation:=public.shardkeep_charter_sale_birth(c.id);
  IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_adoptions WHERE clan_id=c.id) THEN
   INSERT INTO public.charter_tournament_adoptions(clan_id) VALUES(c.id);
  END IF;
  PERFORM public.shardkeep_charter_tournament_prefix(c.id);
  SELECT jsonb_agg(player_wallet ORDER BY player_wallet COLLATE "C") INTO roster FROM public.clan_members WHERE clan_id=c.id;
  SELECT * INTO ordinary FROM public.charter_sale_epochs;
  IF jsonb_array_length(roster) NOT BETWEEN 1 AND (ordinary.policy->>'rosterCap')::integer THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ROSTER';END IF;
  NEW.id:=gen_random_uuid();NEW.lock_id:=gen_random_uuid();NEW.original:=jsonb_build_object('epochId',ep.id,'creation',creation,'head',to_jsonb(h),'event',event,'roster',roster,'domain',ep.domain);
 ELSIF TG_TABLE_NAME='charter_tournament_operations' THEN
  SELECT * INTO e FROM public.charter_tournament_entries WHERE id=NEW.entry_id;
  PERFORM 1 FROM public.clans WHERE id=e.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=e.clan_id FOR UPDATE NOWAIT;
  IF e.id IS NULL OR h.leader_wallet IS DISTINCT FROM e.leader OR h.revision>=4294967295
   OR EXISTS(SELECT 1 FROM public.charter_tournament_releases WHERE entry_id=e.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  IF NEW.action='set' THEN
   IF pg_trigger_depth()<>2 OR e.tx_key IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ORIGIN';END IF;proof:=NULL;
  ELSIF NEW.action='clear' THEN
   IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_operations p JOIN public.charter_tournament_terminals done ON done.operation_id=p.id WHERE p.entry_id=e.id AND p.action='set' AND done.outcome='completed')
    OR EXISTS(SELECT 1 FROM public.charter_tournament_operations p WHERE p.entry_id=e.id AND p.action='clear' AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_terminals done WHERE done.operation_id=p.id AND done.outcome='cancelled'))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_PENDING';END IF;
   proof:=public.shardkeep_charter_tournament_clearance(e.id);
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INPUT';END IF;
  PERFORM public.shardkeep_charter_tournament_prefix(e.clan_id);
  IF NEW.created_at IS NULL OR NOT isfinite(NEW.created_at) THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CLOCK';END IF;
  NEW.id:=gen_random_uuid();SELECT coalesce(max(ordinal),0)+1 INTO NEW.ordinal FROM public.charter_tournament_operations WHERE entry_id=e.id;
  NEW.terms:=jsonb_build_object('version',1,'epochId',e.original->'epochId','entryId',e.id,'eventId',e.event_id,'clanId',e.clan_id,
   'leader',e.leader,'lockId',e.lock_id,'fenceId',e.id,'operationId',NEW.id,'action',NEW.action,'expectedRevision',h.revision,
   'domain',e.original->'domain','event',e.original->'event','roster',e.original->'roster','clearance',proof);
  NEW.original:=jsonb_build_object('creation',e.original->'creation','operation',jsonb_build_object('id',NEW.id,'fenceId',e.id,'eventId',e.event_id,
   'leader',e.leader,'lockId',e.lock_id,'expectedRevision',h.revision,'action',NEW.action,
   'termsHash',encode(sha256(convert_to('SHARDKEEP_CHARTER_TOURNAMENT_LOCK_TERMS_V1'||NEW.terms::text,'UTF8')),'hex')));
 ELSIF TG_TABLE_NAME IN('charter_tournament_attempts','charter_tournament_preparations','charter_tournament_wires','charter_tournament_terminals') THEN
  SELECT * INTO o FROM public.charter_tournament_operations WHERE id=NEW.operation_id FOR UPDATE NOWAIT;
  SELECT * INTO e FROM public.charter_tournament_entries WHERE id=o.entry_id;
  PERFORM 1 FROM public.clans WHERE id=e.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=e.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO a FROM public.charter_tournament_attempts WHERE operation_id=o.id;
  IF o.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_tournament_terminals WHERE operation_id=o.id)
   OR h.revision IS DISTINCT FROM(o.original->'operation'->>'expectedRevision')::bigint OR h.leader_wallet IS DISTINCT FROM e.leader
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  PERFORM public.shardkeep_charter_tournament_prefix(e.clan_id);
  IF TG_TABLE_NAME='charter_tournament_attempts' THEN
   proof:=NEW.record->'quote';SELECT * INTO ordinary FROM public.charter_sale_epochs;
   IF proof->'packetInput'->'original' IS DISTINCT FROM o.original OR proof->>'signingAuthorized' IS DISTINCT FROM 'false'
    OR proof->>'entryAuthorized' IS DISTINCT FROM 'false' OR proof->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
    OR proof->'observation'->>'registryRevision' IS DISTINCT FROM h.revision::text OR proof->'observation'->>'registryLeader' IS DISTINCT FROM e.leader
    OR proof->'observation'->>'lockKind' IS DISTINCT FROM (CASE WHEN o.action='set' THEN '0' ELSE '1' END)
    OR proof->'observation'->>'lockId' IS DISTINCT FROM (CASE WHEN o.action='set' THEN repeat('0',32) ELSE e.lock_id::text END)
    OR proof->'observation'->>'admissionPaused' IS DISTINCT FROM 'false' OR proof->'observation'->>'craftPaused' IS DISTINCT FROM 'false'
    OR proof->'observation'->'source'->>'genesisHash' IS DISTINCT FROM e.original->'domain'->>'genesisHash'
    OR proof->'observation'->'source'->'programs'->>'expectedGenesisHash' IS DISTINCT FROM e.original->'domain'->>'genesisHash'
    OR proof->'observation'->'source'->'programs'->>'stateProvenance' IS DISTINCT FROM 'fresh-reviewed-deployment'
    OR jsonb_build_array(proof->'observation'->'source'->'programs'->'economy',proof->'observation'->'source'->'programs'->'craft',proof->'observation'->'source'->'programs'->'core')
     IS DISTINCT FROM(SELECT original_terminal->'observation'->'mint'->'source'->'programs' FROM public.charter_sale_births WHERE clan_id=e.clan_id)
    OR NEW.record->>'elapsedMs' IS NULL OR (NEW.record->>'elapsedMs')::double precision<0
    OR (NEW.record->>'elapsedMs')::double precision>(ordinary.policy->>'observationMaxAgeMs')::double precision
    OR (NEW.record->>'elapsedMs')::double precision='NaN'::double precision
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
   IF NEW.recorded_at IS NULL OR NOT isfinite(NEW.recorded_at) OR NEW.recorded_at<o.created_at THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CLOCK';END IF;
   IF o.action='set' AND NEW.recorded_at>=(e.original->'event'->>'playStartsAt')::timestamptz THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_WINDOW';END IF;
   PERFORM public.shardkeep_charter_sale_expiry(proof->'packetInput'->>'candidateHex');
   NEW.permit_id:=substr(proof->'packetInput'->>'candidateHex',147,32);
   LOCK TABLE public.charter_creation_permit_messages,public.charter_sale_attempts,public.charter_tournament_attempts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   IF EXISTS(SELECT 1 FROM public.charter_creation_permit_messages WHERE encode(substring(message_bytes from 74 for 16),'hex')=NEW.permit_id)
    OR EXISTS(SELECT 1 FROM public.charter_sale_attempts WHERE substr(record->>'candidateHex',147,32)=NEW.permit_id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_PERMIT_REUSE';END IF;
   NEW.id:=gen_random_uuid();NEW.record:=jsonb_build_object('id',NEW.id,'candidateHex',proof->'packetInput'->'candidateHex','policySigner',proof->'packetInput'->'policySigner','quote',proof);
  ELSIF TG_TABLE_NAME='charter_tournament_preparations' THEN
   IF a.id IS NULL OR NEW.record IS DISTINCT FROM jsonb_build_object('policySignatureHex',NEW.record->'policySignatureHex','packet',NEW.record->'packet')
    OR coalesce(NEW.record->>'policySignatureHex','') !~ '^[0-9a-f]{128}$'
    OR NEW.record->'packet'->>'signingAuthorized' IS DISTINCT FROM 'false' OR NEW.record->'packet'->>'relayAuthorized' IS DISTINCT FROM 'false'
    OR NEW.record->'packet'->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->'packet'->>'messageHex','hex')),'hex')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  ELSIF TG_TABLE_NAME='charter_tournament_wires' THEN
   SELECT record INTO proof FROM public.charter_tournament_preparations WHERE operation_id=o.id;
   IF proof IS NULL OR NEW.record IS DISTINCT FROM jsonb_build_object('signedTransactionHex',NEW.record->'signedTransactionHex','signature',NEW.record->'signature','wireSha256',NEW.record->'wireSha256','messageSha256',NEW.record->'messageSha256')
    OR NEW.record->>'messageSha256' IS DISTINCT FROM proof->'packet'->>'messageSha256'
    OR NEW.record->>'wireSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->>'signedTransactionHex','hex')),'hex')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  ELSE
   -- Serialize new finalization with the immutable event terminal. Historical
   -- reads retain their original authority; a new completion cannot reopen a
   -- closed event even when a private test clock is backdated into entry time.
   PERFORM public.shardkeep_charter_tournament_event_source();
   PERFORM 1 FROM public.charter_tournament_events WHERE id=e.event_id FOR UPDATE NOWAIT;
   IF NEW.completed_at IS NULL OR NOT isfinite(NEW.completed_at) OR NEW.completed_at<o.created_at THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CLOCK';END IF;
   NEW.id:=gen_random_uuid();NEW.inventory:=public.shardkeep_charter_tournament_inventory(o.id);NEW.head_before:=to_jsonb(h);NEW.head_after:=to_jsonb(h);
   IF NEW.record->'original' IS DISTINCT FROM o.original OR NEW.record->>'entryAuthorized' IS DISTINCT FROM 'false' OR NEW.record->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
   IF NEW.outcome='completed' THEN
    SELECT record INTO wire FROM public.charter_tournament_wires WHERE operation_id=o.id;
    IF wire IS NULL OR NEW.record->>'signature' IS DISTINCT FROM wire->>'signature' OR NEW.record->>'wireSha256' IS DISTINCT FROM wire->>'wireSha256'
     OR NEW.record->>'messageSha256' IS DISTINCT FROM wire->>'messageSha256' OR NEW.record->>'finalizedTransitionObserved' IS DISTINCT FROM 'true'
     OR NEW.record->>'currentStateMatchesResult' IS DISTINCT FROM 'true' OR NEW.record->>'priorRevision' IS DISTINCT FROM h.revision::text
     OR NEW.record->>'revision' IS DISTINCT FROM(h.revision+1)::text OR NEW.record->>'action' IS DISTINCT FROM o.action
     OR NEW.record->>'leader' IS DISTINCT FROM e.leader OR NEW.record->>'lockId' IS DISTINCT FROM e.lock_id::text
    THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
    IF o.action='clear' AND o.terms->'clearance' IS DISTINCT FROM public.shardkeep_charter_tournament_clearance(e.id) THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_PENDING';END IF;
    NEW.head_after:=jsonb_set(NEW.head_before,'{revision}',to_jsonb(h.revision+1));
   ELSIF NEW.outcome='cancelled' THEN
    IF NEW.record->'inventory' IS DISTINCT FROM NEW.inventory OR NEW.record->>'outcome' IS DISTINCT FROM 'absent-after-expiry'
     OR NEW.record->'source'->>'genesisHash' IS DISTINCT FROM e.original->'domain'->>'genesisHash'
     OR NEW.record->'source'->'programs'->>'expectedGenesisHash' IS DISTINCT FROM e.original->'domain'->>'genesisHash'
     OR NEW.record->'source'->'programs'->>'stateProvenance' IS DISTINCT FROM 'fresh-reviewed-deployment'
     OR jsonb_build_array(NEW.record->'source'->'programs'->'economy',NEW.record->'source'->'programs'->'craft',NEW.record->'source'->'programs'->'core')
      IS DISTINCT FROM(SELECT original_terminal->'observation'->'mint'->'source'->'programs' FROM public.charter_sale_births WHERE clan_id=e.clan_id)
     OR coalesce(NEW.record->>'unixTimestamp','') !~ '^[1-9][0-9]*$'
     OR(a.id IS NOT NULL AND(NEW.record->>'unixTimestamp')::numeric<=public.shardkeep_charter_sale_expiry(a.record->>'candidateHex'))
    THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
   ELSE RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INPUT';END IF;
  END IF;
 ELSIF TG_TABLE_NAME IN('charter_tournament_entry_completions','charter_tournament_nonparticipations','charter_tournament_releases') THEN
  SELECT * INTO e FROM public.charter_tournament_entries WHERE id=NEW.entry_id;
  IF TG_TABLE_NAME='charter_tournament_entry_completions' THEN SELECT * INTO t FROM public.charter_tournament_terminals WHERE id=NEW.lock_terminal_id;
  ELSE SELECT * INTO t FROM public.charter_tournament_terminals WHERE id=NEW.terminal_id;END IF;
  SELECT * INTO o FROM public.charter_tournament_operations WHERE id=t.operation_id;
  IF pg_trigger_depth()<>2 OR t.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR o.entry_id IS DISTINCT FROM e.id THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ORIGIN';END IF;
  IF TG_TABLE_NAME='charter_tournament_entry_completions' THEN
   SELECT jsonb_agg(player_wallet ORDER BY player_wallet COLLATE "C") INTO roster FROM public.clan_members WHERE clan_id=e.clan_id;
   IF o.action<>'set' OR t.outcome<>'completed' OR roster IS DISTINCT FROM e.original->'roster'
    OR EXISTS(SELECT 1 FROM public.charter_tournament_event_terminals WHERE event_id=e.event_id)
    OR t.completed_at<(e.original->'event'->>'entryStartsAt')::timestamptz OR t.completed_at>=(e.original->'event'->>'playStartsAt')::timestamptz
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_WINDOW';END IF;
   NEW.roster:=roster;NEW.completed_at:=t.completed_at;
  ELSIF TG_TABLE_NAME='charter_tournament_nonparticipations' THEN
   IF o.action<>'set' OR t.outcome<>'completed' OR (t.completed_at<(e.original->'event'->>'playStartsAt')::timestamptz
    AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_event_terminals WHERE event_id=e.event_id)) THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
   NEW.original:=jsonb_build_object('version',1,'kind','late-entry-nonparticipation','entryId',e.id,'eventId',e.event_id,'terminalId',t.id,'lockId',e.lock_id,'awards','[]'::jsonb);
  ELSE
   IF NOT((o.action='set' AND t.outcome='cancelled') OR(o.action='clear' AND t.outcome='completed')) THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='charter_tournament_effects' THEN
  SELECT * INTO t FROM public.charter_tournament_terminals WHERE id=NEW.terminal_id;
  IF pg_trigger_depth()<>3 OR t.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR t.outcome<>'completed'
   OR NEW.before_row IS DISTINCT FROM t.head_before OR NEW.after_row IS DISTINCT FROM t.head_after
   OR NOT EXISTS(SELECT 1 FROM public.charter_sale_heads live_head WHERE to_jsonb(live_head)=NEW.after_row)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ORIGIN';END IF;
 ELSIF TG_TABLE_NAME='charter_tournament_revision_edges' THEN
  IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ORIGIN';END IF;
  IF NEW.kind='sale' THEN
   SELECT * INTO s FROM public.charter_sales WHERE id=(SELECT sale_id FROM public.charter_sale_terminals WHERE id=NEW.terminal_id);
   SELECT source->'head',jsonb_set(jsonb_set(jsonb_set(source->'head','{leader_wallet}',to_jsonb(s.buyer)),'{revision}',to_jsonb((s.original->>'expectedRevision')::bigint+1)),'{last_sale_id}',to_jsonb(s.id)),tx_key
    INTO before_head,after_head,NEW.tx_key FROM public.charter_sale_terminals WHERE id=NEW.terminal_id AND outcome='completed';
  ELSE
   SELECT head_before,head_after,tx_key INTO before_head,after_head,NEW.tx_key FROM public.charter_tournament_terminals WHERE id=NEW.terminal_id AND outcome='completed';
  END IF;
  IF before_head IS NULL OR NEW.before_row IS DISTINCT FROM before_head OR NEW.after_row IS DISTINCT FROM after_head
   OR NEW.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR NEW.clan_id::text IS DISTINCT FROM before_head->>'clan_id'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ORIGIN';END IF;
  NEW.revision:=(after_head->>'revision')::bigint;
 ELSIF TG_TABLE_NAME='charter_tournament_sale_sources' THEN
  SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id;SELECT * INTO ep FROM public.charter_tournament_epochs;
  IF pg_trigger_depth()<>2 OR s.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR s.original->>'epochId' IS DISTINCT FROM ep.id::text
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_ORIGIN';END IF;
  NEW.epoch_id:=ep.id;NEW.original:=public.shardkeep_charter_tournament_prefix(s.clan_id);
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE cid uuid;s public.charter_sales%ROWTYPE;ep public.charter_tournament_epochs%ROWTYPE;terms jsonb;affected uuid[];
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_READ_COMMITTED';END IF;
 IF TG_NAME<>TG_TABLE_NAME||'_zz_tournament_boundary' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_epochs) THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 PERFORM public.shardkeep_charter_tournament_hooks();
 IF TG_TABLE_NAME='clans' THEN affected:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.id] WHEN TG_OP='DELETE' THEN ARRAY[OLD.id] ELSE ARRAY[OLD.id,NEW.id] END;
 ELSIF TG_TABLE_NAME='clan_members' THEN affected:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.clan_id] WHEN TG_OP='DELETE' THEN ARRAY[OLD.clan_id] ELSE ARRAY[OLD.clan_id,NEW.clan_id] END;
 ELSIF TG_TABLE_NAME IN('charter_sales','clan_charter_member_fences') THEN affected:=ARRAY[NEW.clan_id];
 ELSE SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id;affected:=ARRAY[s.clan_id];END IF;
 FOR cid IN SELECT DISTINCT value FROM unnest(affected) value WHERE value IS NOT NULL ORDER BY value LOOP
  PERFORM 1 FROM public.clans WHERE id=cid FOR UPDATE NOWAIT;
  IF public.shardkeep_charter_tournament_fenced(cid) THEN
   IF TG_TABLE_NAME='clans' AND TG_OP='UPDATE' THEN
    IF NEW.chest_shards>OLD.chest_shards AND to_jsonb(NEW)-'chest_shards'=to_jsonb(OLD)-'chest_shards' THEN CONTINUE;END IF;
   END IF;
   RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_FENCED';
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='charter_sales' AND TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM public.charter_tournament_adoptions WHERE clan_id=NEW.clan_id) THEN
  SELECT * INTO ep FROM public.charter_tournament_epochs;
  PERFORM public.shardkeep_charter_tournament_prefix(NEW.clan_id);
  terms:=(NEW.original-ARRAY['creation','termsHash'])||jsonb_build_object('version',1,'epochId',ep.id,
   'royaltyBps',(SELECT policy->'royaltyBps' FROM public.charter_sale_epochs));
  NEW.original:=jsonb_set(jsonb_set(NEW.original,'{epochId}',to_jsonb(ep.id)),'{termsHash}',
   to_jsonb(encode(sha256(convert_to('SHARDKEEP_CHARTER_SALE_TERMS_V1'||terms::text,'UTF8')),'hex')));
  END IF;
 ELSIF TG_TABLE_NAME IN('charter_sale_acceptances','charter_sale_attempts','charter_sale_terminals') AND TG_OP='INSERT'
  AND EXISTS(SELECT 1 FROM public.charter_tournament_adoptions WHERE clan_id=s.clan_id) THEN
  SELECT * INTO ep FROM public.charter_tournament_epochs;
  IF s.original->>'epochId' IS DISTINCT FROM ep.id::text OR NOT EXISTS(SELECT 1 FROM public.charter_tournament_sale_sources source
   WHERE source.sale_id=s.id AND source.epoch_id=ep.id AND source.original=public.shardkeep_charter_tournament_prefix(s.clan_id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_entries%ROWTYPE;o public.charter_tournament_operations%ROWTYPE;s public.charter_sales%ROWTYPE;after_head jsonb;
BEGIN
 IF TG_NAME<>TG_TABLE_NAME||'_tournament_capture' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 IF TG_TABLE_NAME='charter_tournament_entries' THEN
  INSERT INTO public.charter_tournament_operations(entry_id,action,idempotency_key,created_at) VALUES(NEW.id,'set',NEW.idempotency_key,NEW.admitted_at);
 ELSIF TG_TABLE_NAME='charter_tournament_terminals' THEN
  SELECT * INTO o FROM public.charter_tournament_operations WHERE id=NEW.operation_id;
  SELECT * INTO e FROM public.charter_tournament_entries WHERE id=o.entry_id;
  IF NEW.outcome='completed' THEN
   UPDATE public.charter_sale_heads SET revision=revision+1 WHERE clan_id=e.clan_id;
   INSERT INTO public.charter_tournament_revision_edges(clan_id,kind,terminal_id,before_row,after_row)
    VALUES(e.clan_id,o.action,NEW.id,NEW.head_before,NEW.head_after);
   IF o.action='set' THEN
    IF NEW.completed_at<(e.original->'event'->>'playStartsAt')::timestamptz
     AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_event_terminals WHERE event_id=e.event_id) THEN
     INSERT INTO public.charter_tournament_entry_completions(entry_id,lock_terminal_id) VALUES(e.id,NEW.id);
    ELSE INSERT INTO public.charter_tournament_nonparticipations(entry_id,terminal_id) VALUES(e.id,NEW.id);END IF;
   ELSE INSERT INTO public.charter_tournament_releases(entry_id,terminal_id) VALUES(e.id,NEW.id);END IF;
  ELSIF o.action='set' THEN INSERT INTO public.charter_tournament_releases(entry_id,terminal_id) VALUES(e.id,NEW.id);END IF;
 ELSIF TG_TABLE_NAME='charter_sales' THEN
  IF EXISTS(SELECT 1 FROM public.charter_tournament_adoptions WHERE clan_id=NEW.clan_id) THEN
   INSERT INTO public.charter_tournament_sale_sources(sale_id) VALUES(NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='charter_sale_terminals' AND NEW.outcome='completed' THEN
  SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id;
  IF EXISTS(SELECT 1 FROM public.charter_tournament_adoptions WHERE clan_id=s.clan_id) THEN
   after_head:=jsonb_set(jsonb_set(jsonb_set(NEW.source->'head','{leader_wallet}',to_jsonb(s.buyer)),
    '{revision}',to_jsonb((s.original->>'expectedRevision')::bigint+1)),'{last_sale_id}',to_jsonb(s.id));
   INSERT INTO public.charter_tournament_revision_edges(clan_id,kind,terminal_id,before_row,after_row)
    VALUES(s.clan_id,'sale',NEW.id,NEW.source->'head',after_head);
  END IF;
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE tid uuid;BEGIN
 IF TG_NAME<>'charter_sale_heads_tournament_effect' OR TG_OP<>'UPDATE' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_RELID<>'public.charter_sale_heads'::regclass
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 SELECT id INTO tid FROM public.charter_tournament_terminals WHERE tx_key=pg_current_xact_id()::text AND outcome='completed'
  AND head_before=to_jsonb(OLD) AND head_after=to_jsonb(NEW);
 IF tid IS NOT NULL THEN INSERT INTO public.charter_tournament_effects(terminal_id,before_row,after_row) VALUES(tid,to_jsonb(OLD),to_jsonb(NEW));END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_permit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE permit text;BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 IF TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_NAME<>TG_TABLE_NAME||'_tournament_permit_guard'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 LOCK TABLE public.charter_creation_permit_messages,public.charter_sale_attempts,public.charter_tournament_attempts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 IF TG_TABLE_NAME='charter_creation_permit_messages' THEN permit:=encode(substring(NEW.message_bytes from 74 for 16),'hex');
 ELSIF TG_TABLE_NAME='charter_sale_attempts' THEN permit:=substr(NEW.record->>'candidateHex',147,32);
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_TRIGGER';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_tournament_attempts WHERE permit_id=permit) THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_PERMIT_REUSE';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e record;t record;o record;BEGIN
 PERFORM public.shardkeep_charter_tournament_hooks();
 FOR e IN SELECT * FROM public.charter_tournament_entries WHERE tx_key=pg_current_xact_id()::text LOOP
  IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_operations WHERE entry_id=e.id AND action='set' AND tx_key=e.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INCOMPLETE';END IF;
 END LOOP;
 FOR t IN SELECT * FROM public.charter_tournament_terminals WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO o FROM public.charter_tournament_operations WHERE id=t.operation_id;
  IF t.outcome='completed' THEN
   IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_effects fx WHERE fx.terminal_id=t.id AND fx.tx_key=t.tx_key AND fx.before_row=t.head_before AND fx.after_row=t.head_after)
    OR NOT EXISTS(SELECT 1 FROM public.charter_tournament_revision_edges x WHERE x.terminal_id=t.id AND x.before_row=t.head_before AND x.after_row=t.head_after AND x.tx_key=t.tx_key)
    OR t.head_after IS DISTINCT FROM(SELECT to_jsonb(h) FROM public.charter_sale_heads h WHERE clan_id=(t.head_after->>'clan_id')::uuid)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INCOMPLETE';END IF;
   IF o.action='set' AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_entry_completions WHERE entry_id=o.entry_id AND lock_terminal_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_nonparticipations WHERE entry_id=o.entry_id AND terminal_id=t.id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INCOMPLETE';END IF;
  END IF;
  IF((o.action='clear' AND t.outcome='completed') OR(o.action='set' AND t.outcome='cancelled'))
   AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_releases WHERE entry_id=o.entry_id AND terminal_id=t.id AND tx_key=t.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INCOMPLETE';END IF;
 END LOOP;
 FOR e IN SELECT s.* FROM public.charter_sales s JOIN public.charter_tournament_adoptions a ON a.clan_id=s.clan_id WHERE s.tx_key=pg_current_xact_id()::text LOOP
  IF NOT EXISTS(SELECT 1 FROM public.charter_tournament_sale_sources WHERE sale_id=e.id AND tx_key=e.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INCOMPLETE';END IF;
 END LOOP;RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_read(actor text,oid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE o public.charter_tournament_operations%ROWTYPE;e public.charter_tournament_entries%ROWTYPE;a jsonb;p jsonb;w jsonb;t public.charter_tournament_terminals%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 SELECT * INTO o FROM public.charter_tournament_operations WHERE id=oid;SELECT * INTO e FROM public.charter_tournament_entries WHERE id=o.entry_id;
 IF o.id IS NULL OR e.leader IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_NOT_FOUND';END IF;
 PERFORM public.shardkeep_charter_sale_birth(e.clan_id);
 SELECT record INTO a FROM public.charter_tournament_attempts WHERE operation_id=oid;
 SELECT record INTO p FROM public.charter_tournament_preparations WHERE operation_id=oid;
 SELECT record INTO w FROM public.charter_tournament_wires WHERE operation_id=oid;
 SELECT * INTO t FROM public.charter_tournament_terminals WHERE operation_id=oid;
 IF t.outcome='completed' AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_effects fx WHERE fx.terminal_id=t.id AND fx.before_row=t.head_before AND fx.after_row=t.head_after AND fx.tx_key=t.tx_key)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 RETURN jsonb_build_object('version',1,'original',o.original,'operationTerms',o.terms,'entryId',e.id,
  'status',coalesce(t.outcome,CASE WHEN w IS NOT NULL THEN 'signed' WHEN p IS NOT NULL THEN 'prepared' WHEN a IS NOT NULL THEN 'issuing' ELSE 'draft' END),
  'attempt',a,'preparation',p,'signed',w,'terminal',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'outcome',t.outcome,'record',t.record) END,
  'inventory',public.shardkeep_charter_tournament_inventory(oid));
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_entry_read(actor text,eid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_entries%ROWTYPE;set_id uuid;clear_id uuid;status text;BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 SELECT * INTO e FROM public.charter_tournament_entries WHERE id=eid;
 IF e.id IS NULL OR e.leader IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_NOT_FOUND';END IF;
 SELECT id INTO set_id FROM public.charter_tournament_operations WHERE entry_id=eid AND action='set';
 SELECT id INTO clear_id FROM public.charter_tournament_operations WHERE entry_id=eid AND action='clear' ORDER BY ordinal DESC LIMIT 1;
 status:=CASE WHEN EXISTS(SELECT 1 FROM public.charter_tournament_releases r JOIN public.charter_tournament_terminals t ON t.id=r.terminal_id WHERE r.entry_id=eid AND t.outcome='cancelled') THEN 'cancelled'
  WHEN EXISTS(SELECT 1 FROM public.charter_tournament_releases WHERE entry_id=eid) THEN 'released'
  WHEN EXISTS(SELECT 1 FROM public.charter_tournament_entry_completions WHERE entry_id=eid) THEN 'entered'
  WHEN EXISTS(SELECT 1 FROM public.charter_tournament_nonparticipations WHERE entry_id=eid) THEN 'nonparticipating' ELSE 'pending' END;
 RETURN jsonb_build_object('version',1,'id',e.id,'eventId',e.event_id,'clanId',e.clan_id,'leader',e.leader,'epochId',e.original->'epochId','lockId',e.lock_id,
  'roster',e.original->'roster','status',status,'set',public.shardkeep_charter_tournament_read(actor,set_id),
  'clear',CASE WHEN clear_id IS NULL THEN NULL ELSE public.shardkeep_charter_tournament_read(actor,clear_id) END);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_epoch(domain_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_epochs%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 LOCK TABLE public.charter_tournament_epochs IN SHARE ROW EXCLUSIVE MODE NOWAIT;SELECT * INTO e FROM public.charter_tournament_epochs;
 IF e.id IS NULL THEN INSERT INTO public.charter_tournament_epochs(domain) VALUES(domain_value) RETURNING * INTO e;
 ELSIF e.domain IS DISTINCT FROM domain_value THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CONFLICT';END IF;
 RETURN jsonb_build_object('version',1,'id',e.id,'ordinaryEpochId',e.ordinary_epoch_id,'domain',e.domain);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_enter(actor text,event_id_value uuid,clan_id_value uuid,key_value uuid,at_value timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_entries%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 SELECT * INTO e FROM public.charter_tournament_entries WHERE leader=actor AND idempotency_key=key_value;
 IF e.id IS NOT NULL THEN
  IF e.event_id<>event_id_value OR e.clan_id<>clan_id_value THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CONFLICT';END IF;
 ELSE
  PERFORM 1 FROM public.players WHERE wallet=actor FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.charter_creation_reservations WHERE clan_id=clan_id_value FOR UPDATE NOWAIT;
  INSERT INTO public.charter_tournament_entries(event_id,clan_id,leader,idempotency_key,admitted_at) VALUES(event_id_value,clan_id_value,actor,key_value,at_value) RETURNING * INTO e;
 END IF;RETURN public.shardkeep_charter_tournament_entry_read(actor,e.id);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_clear(actor text,eid uuid,key_value uuid,at_value timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_tournament_entries%ROWTYPE;o public.charter_tournament_operations%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();PERFORM public.shardkeep_charter_tournament_hooks();
 SELECT * INTO e FROM public.charter_tournament_entries WHERE id=eid;
 IF e.id IS NULL OR e.leader IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_NOT_FOUND';END IF;
 SELECT * INTO o FROM public.charter_tournament_operations WHERE entry_id=eid AND idempotency_key=key_value;
 IF o.id IS NOT NULL THEN IF o.action<>'clear' THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CONFLICT';END IF;
 ELSE INSERT INTO public.charter_tournament_operations(entry_id,action,idempotency_key,created_at) VALUES(eid,'clear',key_value,at_value) RETURNING * INTO o;END IF;
 RETURN public.shardkeep_charter_tournament_read(actor,o.id);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_record(actor text,oid uuid,kind text,value jsonb,at_value timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE state jsonb;current_value jsonb;BEGIN
 state:=public.shardkeep_charter_tournament_read(actor,oid);
 PERFORM 1 FROM public.players WHERE wallet=actor FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_tournament_operations WHERE id=oid FOR UPDATE NOWAIT;
 state:=public.shardkeep_charter_tournament_read(actor,oid);
 IF state->'terminal'<>'null'::jsonb THEN RETURN state;END IF;
 IF kind='attempt' THEN
  IF state->'attempt'='null'::jsonb THEN INSERT INTO public.charter_tournament_attempts(operation_id,record,recorded_at) VALUES(oid,value,at_value);END IF;
 ELSIF kind='preparation' THEN
  current_value:=state->'preparation';IF current_value='null'::jsonb THEN INSERT INTO public.charter_tournament_preparations(operation_id,record) VALUES(oid,value);
  ELSIF current_value IS DISTINCT FROM value THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CONFLICT';END IF;
 ELSIF kind='wire' THEN
  current_value:=state->'signed';IF current_value='null'::jsonb THEN INSERT INTO public.charter_tournament_wires(operation_id,record) VALUES(oid,value);
  ELSIF current_value IS DISTINCT FROM value THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_CONFLICT';END IF;
 ELSIF kind IN('completed','cancelled') THEN INSERT INTO public.charter_tournament_terminals(operation_id,outcome,record,completed_at) VALUES(oid,kind,value,at_value);
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_INPUT';END IF;
 RETURN public.shardkeep_charter_tournament_read(actor,oid);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_entries(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE result jsonb;BEGIN
 PERFORM public.shardkeep_charter_tournament_hooks();
 IF EXISTS(SELECT 1 FROM public.charter_tournament_entry_completions c JOIN public.charter_tournament_entries e ON e.id=c.entry_id
  LEFT JOIN public.charter_tournament_terminals t ON t.id=c.lock_terminal_id LEFT JOIN public.charter_tournament_effects fx ON fx.terminal_id=t.id
  WHERE e.event_id=eid AND(t.id IS NULL OR t.outcome<>'completed' OR fx.terminal_id IS NULL OR c.roster IS DISTINCT FROM e.original->'roster'
   OR fx.before_row IS DISTINCT FROM t.head_before OR fx.after_row IS DISTINCT FROM t.head_after OR c.tx_key IS DISTINCT FROM t.tx_key))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('entryId',e.id,'clanId',e.clan_id,'leader',e.leader,'roster',c.roster,'lockId',e.lock_id,'lockTerminalId',c.lock_terminal_id) ORDER BY e.clan_id),'[]'::jsonb)
 INTO result FROM public.charter_tournament_entries e JOIN public.charter_tournament_entry_completions c ON c.entry_id=e.id WHERE e.event_id=eid;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_entry_for_wallet(eid uuid,actor text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE entries jsonb;result jsonb;n integer;BEGIN
 entries:=public.shardkeep_charter_tournament_entries(eid);
 SELECT count(*) INTO n FROM jsonb_array_elements(entries) x WHERE x->'roster' ? actor;
 IF n=0 THEN RETURN NULL;ELSIF n<>1 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SOURCE';END IF;
 SELECT x INTO result FROM jsonb_array_elements(entries) x WHERE x->'roster' ? actor;RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_assert_closable(eid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 PERFORM public.shardkeep_charter_tournament_hooks();
 LOCK TABLE public.charter_tournament_entries,public.charter_tournament_operations,public.charter_tournament_terminals IN SHARE MODE NOWAIT;
 -- Only successfully completed admissions participate. Unresolved set permits
 -- keep their original private fence and may still require exact-wire recovery;
 -- they cannot prevent unrelated clans' canonical terminal. These SHARE locks
 -- remain held through that terminal INSERT, making every later completion
 -- permanently nonparticipating without inventing cancellation or release.
 PERFORM public.shardkeep_charter_tournament_entries(eid);
END $$;
--> statement-breakpoint
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_tournament_epochs','charter_tournament_adoptions','charter_tournament_entries','charter_tournament_operations',
 'charter_tournament_attempts','charter_tournament_preparations','charter_tournament_wires','charter_tournament_terminals',
 'charter_tournament_entry_completions','charter_tournament_nonparticipations','charter_tournament_releases','charter_tournament_revision_edges','charter_tournament_effects','charter_tournament_sale_sources'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',tab);
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_private()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_tournament_private()',tab||'_no_truncate',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_complete()',tab||'_complete',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['charter_tournament_entries','charter_tournament_terminals','charter_sales','charter_sale_terminals'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_tournament_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_capture()',tab||'_tournament_capture',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['clans','clan_members','charter_sales','charter_sale_acceptances','charter_sale_attempts','charter_sale_terminals','clan_charter_member_fences'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_zz_tournament_boundary') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_boundary()',tab||'_zz_tournament_boundary',tab);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_sale_heads'::regclass AND tgname='charter_sale_heads_tournament_effect') THEN
  CREATE TRIGGER charter_sale_heads_tournament_effect AFTER UPDATE ON public.charter_sale_heads FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_effect();END IF;
 FOREACH tab IN ARRAY ARRAY['charter_creation_permit_messages','charter_sale_attempts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_tournament_permit_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_permit_guard()',tab||'_tournament_permit_guard',tab);END IF;
 END LOOP;
END $$;

--> statement-breakpoint
-- Exact D176 guard, with only the independently authenticated head projection added.
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

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.charter_tournament_source_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_source_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['charter_tournament_epochs','charter_tournament_adoptions','charter_tournament_entries','charter_tournament_operations','charter_tournament_attempts','charter_tournament_preparations','charter_tournament_wires','charter_tournament_terminals','charter_tournament_entry_completions','charter_tournament_nonparticipations','charter_tournament_releases','charter_tournament_revision_edges','charter_tournament_effects','charter_tournament_sale_sources','charter_tournament_source_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_charter_tournament_owner','shardkeep_charter_tournament_hooks','shardkeep_charter_tournament_inventory','shardkeep_charter_tournament_projection','shardkeep_charter_tournament_fenced','shardkeep_charter_tournament_prefix','shardkeep_charter_tournament_clearance','shardkeep_charter_tournament_private','shardkeep_charter_tournament_boundary','shardkeep_charter_tournament_capture','shardkeep_charter_tournament_effect','shardkeep_charter_tournament_permit_guard','shardkeep_charter_tournament_complete','shardkeep_charter_tournament_read','shardkeep_charter_tournament_entry_read','shardkeep_charter_tournament_epoch','shardkeep_charter_tournament_enter','shardkeep_charter_tournament_clear','shardkeep_charter_tournament_record','shardkeep_charter_tournament_entries','shardkeep_charter_tournament_entry_for_wallet','shardkeep_charter_tournament_assert_closable','shardkeep_charter_sale_private','shardkeep_charter_tournament_source_snapshot','shardkeep_charter_tournament_source_check','shardkeep_charter_tournament_source_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'
 AND(c.relname=ANY(ARRAY['charter_tournament_epochs','charter_tournament_adoptions','charter_tournament_entries','charter_tournament_operations','charter_tournament_attempts','charter_tournament_preparations','charter_tournament_wires','charter_tournament_terminals','charter_tournament_entry_completions','charter_tournament_nonparticipations','charter_tournament_releases','charter_tournament_revision_edges','charter_tournament_effects','charter_tournament_sale_sources','charter_tournament_source_contract']) OR t.tgname IN('clans_zz_tournament_boundary','clan_members_zz_tournament_boundary','charter_sales_zz_tournament_boundary',
 'charter_sale_acceptances_zz_tournament_boundary','charter_sale_attempts_zz_tournament_boundary','charter_sale_terminals_zz_tournament_boundary',
 'charter_creation_permit_messages_tournament_permit_guard','charter_sale_attempts_tournament_permit_guard','clan_charter_member_fences_zz_tournament_boundary','charter_sales_tournament_capture','charter_sale_terminals_tournament_capture','charter_sale_heads_tournament_effect'))))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_source_check() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF(SELECT record FROM public.charter_tournament_source_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_charter_tournament_source_snapshot()
 THEN RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_SCHEMA';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_tournament_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 PERFORM public.shardkeep_charter_tournament_owner();
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.charter_tournament_source_contract)
  AND NEW.record=public.shardkeep_charter_tournament_source_snapshot() THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'CLAN_CHARTER_TOURNAMENT_IMMUTABLE';
END $$;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_tournament_source_contract'::regclass AND tgname='charter_tournament_source_contract_guard') THEN
  CREATE TRIGGER charter_tournament_source_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.charter_tournament_source_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_tournament_source_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_tournament_source_contract'::regclass AND tgname='charter_tournament_source_contract_no_truncate') THEN
  CREATE TRIGGER charter_tournament_source_contract_no_truncate BEFORE TRUNCATE ON public.charter_tournament_source_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_tournament_source_guard();END IF;
END $$;
INSERT INTO public.charter_tournament_source_contract(record) SELECT public.shardkeep_charter_tournament_source_snapshot() WHERE NOT EXISTS(SELECT 1 FROM public.charter_tournament_source_contract);
REVOKE ALL ON TABLE public.charter_tournament_source_contract FROM PUBLIC;
DO $$DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure AS name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY(ARRAY['shardkeep_charter_tournament_owner','shardkeep_charter_tournament_hooks','shardkeep_charter_tournament_inventory','shardkeep_charter_tournament_projection','shardkeep_charter_tournament_fenced','shardkeep_charter_tournament_prefix','shardkeep_charter_tournament_clearance','shardkeep_charter_tournament_private','shardkeep_charter_tournament_boundary','shardkeep_charter_tournament_capture','shardkeep_charter_tournament_effect','shardkeep_charter_tournament_permit_guard','shardkeep_charter_tournament_complete','shardkeep_charter_tournament_read','shardkeep_charter_tournament_entry_read','shardkeep_charter_tournament_epoch','shardkeep_charter_tournament_enter','shardkeep_charter_tournament_clear','shardkeep_charter_tournament_record','shardkeep_charter_tournament_entries','shardkeep_charter_tournament_entry_for_wallet','shardkeep_charter_tournament_assert_closable','shardkeep_charter_sale_private','shardkeep_charter_tournament_source_snapshot','shardkeep_charter_tournament_source_check','shardkeep_charter_tournament_source_guard']) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.name);
 END LOOP;
END $$;
