-- Private prospective retirement preparation only. No permit issuer grant,
-- dissolution projection, fence release, replacement candidate or old-source rewrite.
SET LOCAL lock_timeout='10s';
CREATE TABLE public.charter_retirements(
 id uuid PRIMARY KEY,actor text NOT NULL,idempotency_key uuid NOT NULL,clan_id uuid NOT NULL UNIQUE REFERENCES public.charter_sale_births(clan_id),
 fence_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_member_fences(id),original jsonb NOT NULL,source jsonb NOT NULL,created_at timestamptz NOT NULL,tx_key text NOT NULL,
 UNIQUE(actor,idempotency_key)
);
CREATE TABLE public.charter_retirement_attempts(
 retirement_id uuid PRIMARY KEY REFERENCES public.charter_retirements(id),id uuid NOT NULL UNIQUE,permit_id text NOT NULL UNIQUE,record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE public.charter_retirement_preparations(retirement_id uuid PRIMARY KEY REFERENCES public.charter_retirement_attempts(retirement_id),record jsonb NOT NULL,tx_key text NOT NULL);
CREATE TABLE public.charter_retirement_wires(retirement_id uuid PRIMARY KEY REFERENCES public.charter_retirement_preparations(retirement_id),record jsonb NOT NULL,tx_key text NOT NULL);
CREATE TABLE public.charter_retirement_contract(singleton boolean PRIMARY KEY CHECK(singleton),source_sha256 text NOT NULL);
REVOKE ALL ON public.charter_retirements,public.charter_retirement_attempts,public.charter_retirement_preparations,public.charter_retirement_wires,public.charter_retirement_contract FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_retirement_fingerprint() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,p.prosrc,p.proowner,p.prosecdef,p.proconfig,p.proargtypes::text,
  CASE WHEN p.proname LIKE 'shardkeep_charter_retirement_%' THEN p.proacl::text ELSE NULL END) ORDER BY p.proname,p.proargtypes::text)
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(p.proname LIKE 'shardkeep_charter_%' OR p.proname LIKE 'shardkeep_clan_charter_%')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,CASE WHEN c.relname LIKE 'charter_retirement%' THEN c.relacl::text ELSE NULL END,
  (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid)) ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts'))),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace
   AND(c.relname LIKE 'charter_%' OR c.relname LIKE 'clan_charter_%' OR c.relname IN('clans','clan_members','raids','ledger_transactions','ledger_entries','accounts')))
 )::text,'UTF8')),'hex')
$$;
CREATE FUNCTION public.shardkeep_charter_retirement_source() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin' OR public.shardkeep_charter_retirement_fingerprint() IS DISTINCT FROM
  (SELECT source_sha256 FROM public.charter_retirement_contract WHERE singleton) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();PERFORM public.shardkeep_charter_tournament_hooks();
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_retirements'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_OWNER' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_clearance(actor text,fid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;c public.clans%ROWTYPE;h public.charter_sale_heads%ROWTYPE;
 creation jsonb;payment jsonb;raids jsonb:='[]';sales jsonb:='[]';prefix jsonb:=NULL;events jsonb:='[]';terms jsonb;terminal jsonb;v record;initial_head jsonb;
BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();
 -- An absent draft/entry/raid must remain absent through the immutable capture.
 LOCK TABLE public.charter_sales,public.charter_tournament_entries,public.charter_tournament_operations,public.clans,public.clan_members,public.raids IN SHARE MODE NOWAIT;
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid FOR UPDATE NOWAIT;
 SELECT * INTO c FROM public.clans WHERE id=f.clan_id FOR UPDATE NOWAIT;
 SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=f.clan_id FOR UPDATE NOWAIT;
 IF f.id IS NULL OR c.id IS NULL OR h.clan_id IS NULL OR f.actor_wallet IS DISTINCT FROM actor OR c.leader_wallet IS DISTINCT FROM actor
  OR h.leader_wallet IS DISTINCT FROM actor OR h.revision>=4294967295 OR c.chest_shards<>0
  OR public.shardkeep_charter_sale_released(fid) OR EXISTS(SELECT 1 FROM public.charter_sale_acceptances WHERE fence_id=fid)
  OR EXISTS(SELECT 1 FROM public.charter_sales s WHERE s.clan_id=f.clan_id AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals t WHERE t.sale_id=s.id))
  OR public.shardkeep_charter_tournament_fenced(f.clan_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_HELD';END IF;
 creation:=public.shardkeep_charter_sale_birth(f.clan_id);payment:=public.shardkeep_charter_member_payment_read(fid,actor);
 IF payment IS NULL OR payment->>'totalShards' IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_UNPAID';END IF;
 FOR v IN SELECT raid_id FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id ORDER BY clan_ordinal LOOP
  raids:=raids||jsonb_build_array(public.shardkeep_charter_sale_ante_proof(v.raid_id,true));
 END LOOP;
 IF jsonb_array_length(raids)<>f.raid_ordinal THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 FOR v IN SELECT s.id,t.outcome,t.source FROM public.charter_sales s JOIN public.charter_sale_terminals t ON t.sale_id=s.id
  WHERE s.clan_id=f.clan_id ORDER BY s.created_at,s.id LOOP
  PERFORM public.shardkeep_charter_sale_terminal_history(v.id,false);sales:=sales||jsonb_build_array(to_jsonb(v));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.charter_tournament_adoptions WHERE clan_id=f.clan_id) THEN
  prefix:=public.shardkeep_charter_tournament_prefix(f.clan_id);
  -- A released lock does not end the winner's occupation. Retain the original
  -- authenticated event rights, and use the database clock only for expiry.
  FOR v IN SELECT event_id,original->'event' original_terms FROM public.charter_tournament_entries WHERE clan_id=f.clan_id ORDER BY event_id LOOP
   terms:=public.charter_tournament_event_terms(v.event_id);terminal:=public.charter_tournament_event_terminal(v.event_id);
   IF terms IS DISTINCT FROM v.original_terms THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
   IF clock_timestamp()<(terms->>'occupationEndsAt')::timestamptz AND EXISTS(SELECT 1 FROM jsonb_array_elements(terminal->'occupations') o WHERE o->>'clanId'=f.clan_id::text)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_HELD';END IF;
   events:=events||jsonb_build_array(jsonb_build_object('terms',terms,'terminal',terminal));
  END LOOP;
  prefix:=prefix||jsonb_build_object('events',events);
 ELSE
  initial_head:=jsonb_build_object('clan_id',f.clan_id,'leader_wallet',creation->>'payer','revision',0,'last_sale_id',NULL);
  FOR v IN SELECT fx.before_row,fx.after_row FROM public.charter_sale_effects fx JOIN public.charter_sales s ON s.id=fx.sale_id
   WHERE s.clan_id=f.clan_id AND fx.kind='charter_sale_heads' ORDER BY(fx.after_row->>'revision')::bigint LOOP
   IF v.before_row IS DISTINCT FROM initial_head OR(v.after_row->>'revision')::bigint<>(initial_head->>'revision')::bigint+1
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;initial_head:=v.after_row;
  END LOOP;
  IF initial_head IS DISTINCT FROM to_jsonb(h) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 END IF;
 RETURN jsonb_build_object('creation',creation,'head',to_jsonb(h),'fence',to_jsonb(f),'payment',payment,'raids',raids,'sales',sales,'tournament',prefix);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_retirement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_retirements%ROWTYPE;q jsonb;candidate text;programs jsonb;epoch public.charter_sale_epochs%ROWTYPE;artifact jsonb;pid text;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_retirement_owner();
 IF TG_TABLE_NAME='charter_retirement_contract' THEN
  IF EXISTS(SELECT 1 FROM public.charter_retirement_contract) OR NEW.singleton IS DISTINCT FROM true OR NEW.source_sha256 IS DISTINCT FROM public.shardkeep_charter_retirement_fingerprint()
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;RETURN NEW;
 END IF;
 PERFORM public.shardkeep_charter_retirement_source();
 IF TG_TABLE_NAME='charter_retirements' THEN
  NEW.source:=public.shardkeep_charter_retirement_clearance(NEW.actor,NEW.fence_id);NEW.clan_id:=(NEW.source->'fence'->>'clan_id')::uuid;
  NEW.id:=gen_random_uuid();NEW.created_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;
  NEW.original:=jsonb_build_object('creation',NEW.source->'creation','retirement',jsonb_build_object('id',NEW.id,'fenceId',NEW.fence_id,'clanId',NEW.clan_id,'leader',NEW.actor,
   'expectedRevision',(NEW.source->'head'->>'revision')::bigint,'clearanceHash',encode(sha256(convert_to('SHARDKEEP_CHARTER_RETIREMENT_CLEARANCE_V1'||NEW.source::text,'UTF8')),'hex')));RETURN NEW;
 END IF;
 SELECT * INTO r FROM public.charter_retirements WHERE id=NEW.retirement_id FOR UPDATE NOWAIT;
 IF r.id IS NULL OR r.source IS DISTINCT FROM public.shardkeep_charter_retirement_clearance(r.actor,r.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 NEW.tx_key:=pg_current_xact_id()::text;
 IF TG_TABLE_NAME='charter_retirement_attempts' THEN
  q:=NEW.record->'quote';candidate:=q->'packetInput'->>'candidateHex';SELECT * INTO epoch FROM public.charter_sale_epochs;
  SELECT original_terminal->'observation'->'mint'->'source'->'programs' INTO programs FROM public.charter_sale_births WHERE clan_id=r.clan_id;
  IF q->'packetInput'->'original' IS DISTINCT FROM r.original OR q->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR q->>'retirementAuthorized' IS DISTINCT FROM 'false' OR q->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   OR q->'observation'->>'registryRevision' IS DISTINCT FROM r.original->'retirement'->>'expectedRevision'
   OR q->'observation'->>'registryLeader' IS DISTINCT FROM r.actor OR q->'observation'->>'lockKind' IS DISTINCT FROM '0'
   OR q->'observation'->>'lockId' IS DISTINCT FROM repeat('0',32) OR q->'observation'->>'admissionPaused' IS DISTINCT FROM 'false' OR q->'observation'->>'craftPaused' IS DISTINCT FROM 'false'
   OR q->'observation'->'source'->>'genesisHash' IS DISTINCT FROM r.original->'creation'->'chain'->>'genesisHash'
   OR jsonb_build_array(q->'observation'->'source'->'programs'->'economy',q->'observation'->'source'->'programs'->'craft',q->'observation'->'source'->'programs'->'core') IS DISTINCT FROM programs
   OR length(coalesce(candidate,''))<>322 OR coalesce(candidate,'')!~'^[0-9a-f]+$' OR substr(candidate,145,2)<>'09'
   OR NEW.record->>'elapsedMs' IS NULL OR(NEW.record->>'elapsedMs')::double precision<0 OR(NEW.record->>'elapsedMs')::double precision>(epoch.policy->>'observationMaxAgeMs')::double precision
   OR(NEW.record->>'elapsedMs')::double precision='NaN'::double precision THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_QUOTE';END IF;
  PERFORM public.shardkeep_charter_sale_expiry(candidate);pid:=substr(candidate,147,32);
  LOCK TABLE public.charter_creation_permit_messages,public.charter_sale_attempts,public.charter_tournament_attempts IN SHARE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.charter_creation_permit_messages WHERE encode(substring(message_bytes from 74 for 16),'hex')=pid)
   OR EXISTS(SELECT 1 FROM public.charter_sale_attempts WHERE substr(record->>'candidateHex',147,32)=pid)
   OR EXISTS(SELECT 1 FROM public.charter_tournament_attempts WHERE permit_id=pid) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_PERMIT_REUSE';END IF;
  NEW.id:=gen_random_uuid();NEW.permit_id:=pid;NEW.record:=jsonb_build_object('id',NEW.id,'candidateHex',candidate,'policySigner',q->'packetInput'->'policySigner','quote',q);
 ELSIF TG_TABLE_NAME='charter_retirement_preparations' THEN
  IF NEW.record IS DISTINCT FROM jsonb_build_object('policySignatureHex',NEW.record->'policySignatureHex','packet',NEW.record->'packet')
   OR coalesce(NEW.record->>'policySignatureHex','')!~'^[0-9a-f]{128}$' OR NEW.record->'packet'->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR NEW.record->'packet'->>'relayAuthorized' IS DISTINCT FROM 'false' OR NEW.record->'packet'->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->'packet'->>'messageHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ARTIFACT';END IF;
 ELSIF TG_TABLE_NAME='charter_retirement_wires' THEN
  SELECT record INTO artifact FROM public.charter_retirement_preparations WHERE retirement_id=r.id;
  IF NEW.record IS DISTINCT FROM jsonb_build_object('signedTransactionHex',NEW.record->'signedTransactionHex','signature',NEW.record->'signature','wireSha256',NEW.record->'wireSha256','messageSha256',NEW.record->'messageSha256')
   OR NEW.record->>'messageSha256' IS DISTINCT FROM artifact->'packet'->>'messageSha256'
   OR NEW.record->>'wireSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->>'signedTransactionHex','hex')),'hex') THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_ARTIFACT';END IF;
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_sale_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_READ_COMMITTED';END IF;
 IF TG_RELID<>'public.charter_sales'::regclass OR TG_NAME<>'charter_sales_retirement_barrier' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 PERFORM 1 FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.charter_retirements WHERE clan_id=NEW.clan_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_HELD';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER charter_sales_retirement_barrier BEFORE INSERT ON public.charter_sales FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_sale_barrier();
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_charter_retirement_read(actor text,rid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.charter_retirements%ROWTYPE;a jsonb;p jsonb;w jsonb;BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO r FROM public.charter_retirements WHERE id=rid;
 IF r.id IS NULL OR r.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_NOT_FOUND';END IF;
 IF r.source IS DISTINCT FROM public.shardkeep_charter_retirement_clearance(actor,r.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 SELECT record INTO a FROM public.charter_retirement_attempts WHERE retirement_id=rid;SELECT record INTO p FROM public.charter_retirement_preparations WHERE retirement_id=rid;SELECT record INTO w FROM public.charter_retirement_wires WHERE retirement_id=rid;
 RETURN jsonb_build_object('version',1,'original',r.original,'status',CASE WHEN w IS NOT NULL THEN 'signed' WHEN p IS NOT NULL THEN 'prepared' WHEN a IS NOT NULL THEN 'issuing' ELSE 'cleared' END,
  'source',r.source,'memberPayment',jsonb_build_object('id',r.source->'payment'->'id','totalShards',r.source->'payment'->'totalShards'),'attempt',a,'preparation',p,'signed',w,
  'inventory',jsonb_build_object('version',1,'revision',CASE WHEN a IS NULL THEN '0' ELSE '1' END,'count',CASE WHEN a IS NULL THEN 0 ELSE 1 END,'messages',CASE WHEN a IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(a->'candidateHex') END));
END $$;
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_retirements','charter_retirement_attempts','charter_retirement_preparations','charter_retirement_wires','charter_retirement_contract'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_retirement_guard()',tab||'_no_truncate',tab);
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'shardkeep_charter_retirement_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
INSERT INTO public.charter_retirement_contract VALUES(true,public.shardkeep_charter_retirement_fingerprint());
