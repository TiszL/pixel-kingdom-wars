-- D153.192 prospective Crystal Fragment issuer/custody. Policy literal is generated
-- from shared DIVINE_FRAGMENT_POLICY. Existing sponsor prizes are unchanged.
SET LOCAL lock_timeout='10s';
DO $$BEGIN
 IF to_regclass('public.divine_fragment_contract') IS NOT NULL THEN
  PERFORM public.shardkeep_divine_fragment_source();
 ELSIF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(ARRAY['divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims'])) THEN
  RAISE EXCEPTION 'DIVINE_FRAGMENT_PARTIAL_SOURCE';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.divine_fragment_periods(
 week_start timestamptz PRIMARY KEY CHECK(isfinite(week_start)),economic_lineage text NOT NULL CHECK(economic_lineage='shardkeep'),policy jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.divine_fragment_enrollments(
 event_id uuid PRIMARY KEY REFERENCES public.divine_trial_events(id),week_start timestamptz NOT NULL UNIQUE REFERENCES public.divine_fragment_periods(week_start),
 domain jsonb NOT NULL,earned_at timestamptz NOT NULL CHECK(isfinite(earned_at)),enrolled_at timestamptz NOT NULL CHECK(isfinite(enrolled_at))
);
CREATE TABLE IF NOT EXISTS public.divine_fragment_settlements(
 event_id uuid PRIMARY KEY REFERENCES public.divine_fragment_enrollments(event_id),term_id uuid NOT NULL,term_hash text NOT NULL,
 certificate_json text NOT NULL,certificate_hash text NOT NULL,source_hash text NOT NULL,record jsonb NOT NULL,
 settled_at timestamptz NOT NULL CHECK(isfinite(settled_at)),FOREIGN KEY(term_id,term_hash) REFERENCES public.expedition_term_snapshots(term_id,snapshot_hash)
);
CREATE TABLE IF NOT EXISTS public.divine_fragment_awards(
 event_id uuid NOT NULL REFERENCES public.divine_fragment_settlements(event_id),wallet text NOT NULL REFERENCES public.players(wallet),site text NOT NULL,
 record jsonb NOT NULL,PRIMARY KEY(event_id,wallet),UNIQUE(event_id,site)
);
CREATE TABLE IF NOT EXISTS public.crystal_fragment_stocks(
 base_id uuid PRIMARY KEY REFERENCES public.bases(id),available bigint NOT NULL DEFAULT 0 CHECK(available>=0)
);
CREATE TABLE IF NOT EXISTS public.divine_fragment_deliveries(
 id uuid PRIMARY KEY,event_id uuid NOT NULL,wallet text NOT NULL REFERENCES public.players(wallet),base_id uuid NOT NULL REFERENCES public.bases(id),
 quantity bigint NOT NULL CHECK(quantity>0),record jsonb NOT NULL,delivered_at timestamptz NOT NULL CHECK(isfinite(delivered_at)),
 UNIQUE(event_id,wallet),FOREIGN KEY(event_id,wallet) REFERENCES public.divine_fragment_awards(event_id,wallet)
);
CREATE TABLE IF NOT EXISTS public.seeker_fragment_claims(
 id uuid PRIMARY KEY,wallet text NOT NULL REFERENCES public.players(wallet),base_id uuid NOT NULL REFERENCES public.bases(id),
 term_id uuid NOT NULL,term_hash text NOT NULL,spot_id integer NOT NULL,quantity bigint NOT NULL CHECK(quantity>0),
 cumulative_total bigint NOT NULL CHECK(cumulative_total>0),record jsonb NOT NULL,claimed_at timestamptz NOT NULL CHECK(isfinite(claimed_at)),
 UNIQUE(term_id,spot_id,cumulative_total),FOREIGN KEY(term_id,term_hash) REFERENCES public.expedition_term_snapshots(term_id,snapshot_hash)
);
CREATE TABLE IF NOT EXISTS public.divine_fragment_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS divine_fragment_awards_wallet_idx ON public.divine_fragment_awards(wallet,event_id);
CREATE INDEX IF NOT EXISTS divine_fragment_settlements_term_idx ON public.divine_fragment_settlements(term_id,event_id);
CREATE INDEX IF NOT EXISTS divine_fragment_deliveries_base_idx ON public.divine_fragment_deliveries(base_id);
CREATE INDEX IF NOT EXISTS seeker_fragment_claims_base_idx ON public.seeker_fragment_claims(base_id);
CREATE INDEX IF NOT EXISTS seeker_fragment_claims_wallet_idx ON public.seeker_fragment_claims(wallet,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.divine_fragment_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT '{"version":1,"resourceId":"crystal_fragment","weeklyGross":"10000","periodDays":7,"individualGross":"7000","clanGross":"2000","salvageGross":"1000","individualSites":500,"grossPerSite":"14","basisPoints":10000,"playerBps":8000,"seekerBps":2000,"developerBps":0}'::jsonb
$$;
CREATE OR REPLACE FUNCTION public.divine_fragment_week(at_time timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT to_timestamp(floor(extract(epoch FROM at_time)/(86400*(public.divine_fragment_policy()->>'periodDays')::integer))*86400*(public.divine_fragment_policy()->>'periodDays')::integer)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['divine_fragment_policy','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard'])),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract'])))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_fragment_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE policy jsonb:=public.divine_fragment_policy();e jsonb;terminal jsonb;en public.divine_fragment_enrollments;term public.expedition_term_snapshots;cert jsonb;
 item jsonb;award jsonb;awards jsonb:='[]';before_carry bigint;after_carry bigint;tax bigint;net bigint;gross bigint;winners integer;total_tax bigint:=0;total_net bigint:=0;
 source_hash text;actor text;dest uuid;at_time timestamptz;before_stock bigint;total numeric;previous bigint;cumulative bigint;quantity bigint;
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_NARGS<>0 OR TG_TABLE_NAME NOT IN('divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','seeker_fragment_claims','divine_fragment_contract')
  OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='divine_fragment_contract' THEN
  IF NOT EXISTS(SELECT 1 FROM public.divine_fragment_contract) AND NEW.record=public.shardkeep_divine_fragment_contract() THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'DIVINE_FRAGMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 IF TG_TABLE_NAME='divine_fragment_periods' THEN
  IF NEW.economic_lineage IS DISTINCT FROM 'shardkeep' OR NEW.policy IS DISTINCT FROM policy OR NEW.week_start IS DISTINCT FROM public.divine_fragment_week(NEW.week_start) THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_POLICY';END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='divine_fragment_enrollments' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('shardkeep:crystal_fragment:lineage',0));
  e:=public.divine_trial_event_terms(NEW.event_id);
  IF NEW.domain IS DISTINCT FROM e->'domain' OR NEW.earned_at IS DISTINCT FROM (e->>'playEndsAt')::timestamptz
   OR NEW.week_start IS DISTINCT FROM public.divine_fragment_week(NEW.earned_at)
   OR NEW.enrolled_at IS NULL OR NEW.enrolled_at>=(e->>'entryStartsAt')::timestamptz
   OR EXISTS(SELECT 1 FROM public.divine_trial_entries WHERE event_id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM public.divine_trial_event_terminals WHERE event_id=NEW.event_id)
   OR EXISTS(SELECT 1 FROM public.divine_fragment_settlements s JOIN public.divine_fragment_enrollments n USING(event_id) WHERE n.earned_at>=NEW.earned_at)
  THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_ENROLLMENT';END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='divine_fragment_settlements' THEN
  SELECT * INTO STRICT en FROM public.divine_fragment_enrollments WHERE event_id=NEW.event_id;
  e:=public.divine_trial_event_terms(NEW.event_id);
  SELECT record INTO STRICT terminal FROM public.divine_trial_event_terminals WHERE event_id=NEW.event_id;
  -- Existing D184 source contract authenticates these immutable actual outcomes.
  PERFORM public.shardkeep_divine_trial_event_source();
  PERFORM p.wallet FROM public.players p WHERE p.wallet IN(SELECT value->>'wallet' FROM jsonb_array_elements(terminal->'occupations')) ORDER BY p.wallet COLLATE "C" FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('shardkeep:crystal_fragment:lineage',0));
  PERFORM week_start FROM public.divine_fragment_periods WHERE week_start=en.week_start FOR UPDATE;
  IF NEW.settled_at IS NULL OR NEW.settled_at<en.earned_at OR NEW.settled_at<(terminal->>'completedAt')::timestamptz
   OR EXISTS(SELECT 1 FROM public.divine_fragment_enrollments prior LEFT JOIN public.divine_fragment_settlements done USING(event_id) WHERE prior.earned_at<en.earned_at AND done.event_id IS NULL)
  THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_ORDER';END IF;
  SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash;
  IF octet_length(NEW.certificate_json)>262144 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_BOUNDS';END IF;
  cert:=NEW.certificate_json::jsonb;
  -- Shape checks precede casts: NULL must never turn this rejection into SQL
  -- unknown. The source bridge proves the RPC evidence; SQL binds every field.
  IF NOT coalesce(jsonb_typeof(cert)='object'
   AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(cert) k)=ARRAY['completedAt','completedSlot','deployment','finality','operatingAdmissionAuthorized','purpose','snapshot','termHash','version']
   AND jsonb_typeof(cert->'deployment')='object' AND jsonb_typeof(cert->'finality')='object'
   AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(cert->'deployment') k)=ARRAY['deployedSlot','programDataAddress','programDataSha256','upgradeAuthority']
   AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(cert->'finality') k)=ARRAY['commitment','contextSlot','observedAt']
   AND jsonb_typeof(cert->'completedAt')='string' AND cert->>'completedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   AND jsonb_typeof(cert#>'{finality,observedAt}')='string' AND cert#>>'{finality,observedAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   AND jsonb_typeof(cert->'completedSlot')='string' AND cert->>'completedSlot' ~ '^(0|[1-9][0-9]{0,19})$'
   AND jsonb_typeof(cert#>'{finality,contextSlot}')='string' AND cert#>>'{finality,contextSlot}' ~ '^(0|[1-9][0-9]{0,19})$'
   AND jsonb_typeof(cert#>'{deployment,deployedSlot}')='string' AND cert#>>'{deployment,deployedSlot}' ~ '^(0|[1-9][0-9]{0,19})$'
   AND jsonb_typeof(cert#>'{deployment,programDataAddress}')='string' AND cert#>>'{deployment,programDataAddress}' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   AND jsonb_typeof(cert#>'{deployment,programDataSha256}')='string' AND cert#>>'{deployment,programDataSha256}' ~ '^[0-9a-f]{64}$'
   AND (cert#>'{deployment,upgradeAuthority}'='null'::jsonb OR jsonb_typeof(cert#>'{deployment,upgradeAuthority}')='string' AND cert#>>'{deployment,upgradeAuthority}' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),false)
  THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TERM_SHAPE';END IF;
  IF (cert->>'completedSlot')::numeric>18446744073709551615 OR (cert#>>'{finality,contextSlot}')::numeric>18446744073709551615
   OR (cert#>>'{deployment,deployedSlot}')::numeric>(cert->>'completedSlot')::numeric OR (cert->>'completedSlot')::numeric>(cert#>>'{finality,contextSlot}')::numeric
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(term.snapshot->'spots') s WHERE (s->>'settlementSlot')::numeric<(cert#>>'{deployment,deployedSlot}')::numeric OR (s->>'settlementSlot')::numeric>(cert->>'completedSlot')::numeric)
   OR (SELECT max((s->>'settlementSlot')::numeric) FROM jsonb_array_elements(term.snapshot->'spots') s) IS DISTINCT FROM (cert->>'completedSlot')::numeric
  THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TERM_SLOT';END IF;
  IF cert->'version' IS DISTINCT FROM '1'::jsonb OR cert->>'purpose' IS DISTINCT FROM 'historical_shards_attribution'
   OR cert->'snapshot' IS DISTINCT FROM term.snapshot OR cert->>'termHash' IS DISTINCT FROM NEW.term_hash
   OR cert->'operatingAdmissionAuthorized' IS DISTINCT FROM 'false'::jsonb OR cert#>>'{finality,commitment}' IS DISTINCT FROM 'finalized'
   OR cert#>>'{snapshot,source,genesisHash}' IS DISTINCT FROM en.domain->>'genesisHash'
   OR (cert->>'completedAt')::timestamptz>en.earned_at OR (cert->>'completedAt')::timestamptz<term.starts_at
   OR en.earned_at<term.starts_at OR en.earned_at>=term.ends_at
   OR (cert#>>'{finality,observedAt}')::timestamptz>NEW.settled_at
   OR (cert#>>'{finality,observedAt}')::timestamptz<(cert->>'completedAt')::timestamptz
   OR NEW.certificate_hash IS DISTINCT FROM encode(sha256(convert_to('shardkeep:historical-shards-term-certificate:v1'||chr(10)||NEW.certificate_json,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TERM';END IF;
  SELECT count(*) INTO winners FROM jsonb_array_elements(term.snapshot->'spots') spot WHERE spot->>'ownerWallet' IS NOT NULL;
  source_hash:=encode(sha256(convert_to(public.divine_trial_canonical_json(jsonb_build_object('event',e,'terminal',terminal)),'UTF8')),'hex');
  IF NEW.source_hash IS DISTINCT FROM source_hash OR NEW.record IS DISTINCT FROM '{}'::jsonb THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE_BINDING';END IF;
  gross:=(policy->>'grossPerSite')::bigint;
  FOR item IN SELECT value FROM jsonb_array_elements(terminal->'occupations') ORDER BY value->>'wallet' COLLATE "C" LOOP
   SELECT (a.record->>'carryAfter')::bigint INTO before_carry FROM public.divine_fragment_awards a JOIN public.divine_fragment_enrollments n USING(event_id)
    WHERE a.wallet=item->>'wallet' ORDER BY n.earned_at DESC LIMIT 1;
   before_carry:=coalesce(before_carry,0);tax:=(gross*(policy->>'seekerBps')::bigint+before_carry)/(policy->>'basisPoints')::bigint;
   after_carry:=(gross*(policy->>'seekerBps')::bigint+before_carry)%(policy->>'basisPoints')::bigint;net:=gross-tax;
   award:=jsonb_build_object('version',1,'resourceId','crystal_fragment','eventId',NEW.event_id,'wallet',item->>'wallet','site',item->>'site','domain',en.domain,'economicLineage','shardkeep',
    'weekStart',to_char(en.week_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'earnedAt',to_char(en.earned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sourceHash',source_hash,'termId',NEW.term_id,'termHash',NEW.term_hash,'winnerCount',winners,'poolDisposition',CASE WHEN winners=0 THEN 'held_zero_winners' ELSE 'original_winning_spots' END,
    'gross',gross::text,'net',net::text,'tax',tax::text,'carryBefore',before_carry::text,'carryAfter',after_carry::text,'settledAt',to_char(NEW.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
   awards:=awards||jsonb_build_array(award);total_tax:=total_tax+tax;total_net:=total_net+net;
  END LOOP;
  IF jsonb_array_length(awards)>(policy->>'individualSites')::integer THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_BUDGET';END IF;
  NEW.record:=jsonb_build_object('awards',awards,'occupiedSites',jsonb_array_length(awards),'gross',(gross*jsonb_array_length(awards))::text,'net',total_net::text,'tax',total_tax::text,
   'unissuedIndividual',((policy->>'individualGross')::bigint-gross*jsonb_array_length(awards))::text,'unissuedGlobal',((policy->>'weeklyGross')::bigint-gross*jsonb_array_length(awards))::text);
  RETURN NEW;
 ELSIF TG_TABLE_NAME='divine_fragment_awards' THEN
  IF NOT EXISTS(SELECT 1 FROM public.divine_fragment_settlements s CROSS JOIN LATERAL jsonb_array_elements(s.record->'awards') a WHERE s.event_id=NEW.event_id AND a=NEW.record
   AND a->>'wallet'=NEW.wallet AND a->>'site'=NEW.site) THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_AWARD';END IF;
  RETURN NEW;
 END IF;
 -- Both claims and player deliveries credit protected stock under exact current
 -- destination authority. Source settlement never needs a player's current base.
 actor:=NEW.wallet;dest:=NEW.base_id;
 PERFORM wallet FROM public.players WHERE wallet=actor FOR UPDATE;
 PERFORM id FROM public.bases WHERE id=dest FOR UPDATE;
 PERFORM base_id FROM public.base_slots WHERE base_id=dest ORDER BY wallet FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id WHERE b.id=dest AND b.owner_wallet=actor AND b.status='active' AND s.wallet=actor AND s.active)
  OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=dest) THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_DESTINATION';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crystal_fragment_stocks WHERE base_id=dest) THEN INSERT INTO public.crystal_fragment_stocks(base_id,available) VALUES(dest,0);END IF;
 SELECT available INTO STRICT before_stock FROM public.crystal_fragment_stocks WHERE base_id=dest FOR UPDATE;
 IF TG_TABLE_NAME='divine_fragment_deliveries' THEN
  SELECT record INTO STRICT award FROM public.divine_fragment_awards WHERE event_id=NEW.event_id AND wallet=actor;
  quantity:=(award->>'net')::bigint;at_time:=NEW.delivered_at;
  IF NEW.record IS DISTINCT FROM '{}'::jsonb OR NEW.quantity IS NOT NULL OR at_time<(award->>'settledAt')::timestamptz THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_DELIVERY';END IF;
  NEW.quantity:=quantity;NEW.record:=jsonb_build_object('version',1,'resourceId','crystal_fragment','eventId',NEW.event_id,'wallet',actor,'idempotencyKey',NEW.id,'baseId',dest,
   'quantity',quantity::text,'stockBefore',before_stock::text,'stockAfter',(before_stock+quantity)::text,'deliveredAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 ELSE
  SELECT * INTO STRICT term FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id FOR UPDATE;
  SELECT count(*) INTO winners FROM jsonb_array_elements(term.snapshot->'spots') spot WHERE spot->>'ownerWallet' IS NOT NULL;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(term.snapshot->'spots') spot WHERE (spot->>'spotId')::integer=NEW.spot_id AND spot->>'ownerWallet'=actor) OR winners=0 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SPOT_OWNER';END IF;
  SELECT coalesce(sum((a.record->>'tax')::numeric),0) INTO total FROM public.divine_fragment_awards a JOIN public.divine_fragment_settlements s USING(event_id) WHERE s.term_id=NEW.term_id;
  IF total>9223372036854775807 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_POOL_OVERFLOW';END IF;
  SELECT coalesce(max(c.cumulative_total),0) INTO previous FROM public.seeker_fragment_claims c WHERE c.term_id=NEW.term_id AND c.spot_id=NEW.spot_id;
  cumulative:=total::bigint/winners;quantity:=cumulative-previous;at_time:=NEW.claimed_at;
  IF quantity<=0 OR NEW.quantity IS NOT NULL OR NEW.cumulative_total IS NOT NULL OR NEW.term_hash IS NOT NULL OR NEW.record IS DISTINCT FROM '{}'::jsonb
   OR EXISTS(SELECT 1 FROM public.divine_fragment_settlements WHERE term_id=NEW.term_id AND settled_at>at_time) THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_CLAIM';END IF;
  NEW.quantity:=quantity;NEW.cumulative_total:=cumulative;NEW.term_hash:=term.snapshot_hash;
  NEW.record:=jsonb_build_object('version',1,'resourceId','crystal_fragment','wallet',actor,'idempotencyKey',NEW.id,'baseId',dest,'termId',NEW.term_id,'termHash',term.snapshot_hash,
   'spotId',NEW.spot_id,'winnerCount',winners,'poolTotal',total::text,'previousTotal',previous::text,'cumulativeTotal',cumulative::text,'quantity',quantity::text,
   'stockBefore',before_stock::text,'stockAfter',(before_stock+quantity)::text,'claimedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a jsonb;BEGIN
 PERFORM public.shardkeep_divine_fragment_source();
 IF TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' OR TG_NAME<>TG_TABLE_NAME||'_effect' THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TRIGGER';END IF;
 IF TG_TABLE_NAME='divine_fragment_settlements' THEN
  FOR a IN SELECT value FROM jsonb_array_elements(NEW.record->'awards') LOOP
   INSERT INTO public.divine_fragment_awards(event_id,wallet,site,record) VALUES(NEW.event_id,a->>'wallet',a->>'site',a);
  END LOOP;
 ELSIF TG_TABLE_NAME IN('divine_fragment_deliveries','seeker_fragment_claims') THEN
  UPDATE public.crystal_fragment_stocks SET available=available+NEW.quantity WHERE base_id=NEW.base_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK';END IF;
 ELSE RAISE EXCEPTION 'DIVINE_FRAGMENT_TRIGGER';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_stock_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected numeric;BEGIN
 PERFORM public.shardkeep_divine_fragment_source();
 IF TG_RELID<>'public.crystal_fragment_stocks'::regclass OR TG_WHEN<>'BEFORE' OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'crystal_fragment_stocks_no_truncate' ELSE 'crystal_fragment_stocks_guard' END) THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_TRIGGER';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_IMMUTABLE';END IF;
 IF TG_OP='UPDATE' AND NEW.base_id IS DISTINCT FROM OLD.base_id THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_IDENTITY';END IF;
 SELECT coalesce(sum(q),0) INTO expected FROM(SELECT quantity::numeric q FROM public.divine_fragment_deliveries WHERE base_id=NEW.base_id UNION ALL SELECT quantity::numeric FROM public.seeker_fragment_claims WHERE base_id=NEW.base_id) x;
 IF NEW.available::numeric IS DISTINCT FROM expected THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_STOCK_CONSERVATION';END IF;
 RETURN NEW;
END $$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','seeker_fragment_claims','divine_fragment_contract'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_fragment_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_divine_fragment_guard()',tab||'_no_truncate',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['divine_fragment_settlements','divine_fragment_deliveries','seeker_fragment_claims'] LOOP
  EXECUTE format('CREATE OR REPLACE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_fragment_effect()',tab||'_effect',tab);
 END LOOP;
END $$;
CREATE OR REPLACE TRIGGER crystal_fragment_stocks_guard BEFORE INSERT OR UPDATE OR DELETE ON public.crystal_fragment_stocks FOR EACH ROW EXECUTE FUNCTION public.shardkeep_divine_fragment_stock_guard();
CREATE OR REPLACE TRIGGER crystal_fragment_stocks_no_truncate BEFORE TRUNCATE ON public.crystal_fragment_stocks FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_divine_fragment_stock_guard();
REVOKE ALL ON TABLE public.divine_fragment_periods,public.divine_fragment_enrollments,public.divine_fragment_settlements,public.divine_fragment_awards,public.divine_fragment_deliveries,public.crystal_fragment_stocks,public.seeker_fragment_claims,public.divine_fragment_contract FROM PUBLIC;
INSERT INTO public.divine_fragment_contract(record) SELECT public.shardkeep_divine_fragment_contract() WHERE NOT EXISTS(SELECT 1 FROM public.divine_fragment_contract);
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT oid::regprocedure name FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('divine_fragment_policy','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.name);END LOOP;END $$;
