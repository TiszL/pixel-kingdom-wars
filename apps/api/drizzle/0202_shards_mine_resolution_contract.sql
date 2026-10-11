-- D-153 / B4bu: S5-held existing segment and assessment contract replacements.
-- Local registration/testing is authorized; merge/live migration remains S5-held.
-- No grants, recovery mount, policy activation or backfill. SQL checks consistency;
-- the private original-source verifier and strict replay remain mandatory.
DO $$DECLARE old_name text;n integer;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.shards_mine_segments'::regclass AND conname='shards_mine_segments_resolved_conservation_ck') THEN
  SELECT min(conname),count(*) INTO old_name,n FROM pg_constraint
  WHERE conrelid='public.shards_mine_segments'::regclass AND contype='c'
   AND pg_get_constraintdef(oid)~'buffer.*reserved.*issued.*discarded.*gross';
  IF n<>1 THEN RAISE EXCEPTION 'MINE_RESOLUTION_OLD_CONSERVATION_AMBIGUOUS';END IF;
  EXECUTE format('ALTER TABLE public.shards_mine_segments DROP CONSTRAINT %I',old_name);
  ALTER TABLE public.shards_mine_segments ADD CONSTRAINT shards_mine_segments_resolved_conservation_ck
   CHECK(buffer::numeric+reserved+issued+discarded+resolved=gross);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_mine_segment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORY_IMMUTABLE';END IF;
 IF (to_jsonb(NEW)-ARRAY['buffer','reserved','issued','discarded','resolved']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['buffer','reserved','issued','discarded','resolved'])
 OR NEW.issued<OLD.issued OR NEW.discarded<OLD.discarded OR NEW.resolved<OLD.resolved
 THEN RAISE EXCEPTION 'SHARDS_MINE_ORIGINAL_CHANGED';END IF;
 IF NEW.resolved IS DISTINCT FROM OLD.resolved THEN
  IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'MINE_RESOLUTION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
  IF OLD.recovery_parent_id IS NOT NULL OR OLD.resolved<>0 OR OLD.buffer<>OLD.gross
  OR OLD.reserved<>0 OR OLD.issued<>0 OR OLD.discarded<>0 OR NEW.resolved<>OLD.gross
  OR NEW.buffer<>0 OR NEW.reserved<>0 OR NEW.issued<>0 OR NEW.discarded<>0
  OR NOT EXISTS(SELECT 1 FROM public.shards_mine_resolutions WHERE parent_id=OLD.id)
  THEN RAISE EXCEPTION 'MINE_RESOLUTION_CONSERVATION';END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_shards_assessment_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source public.shards_cache_sources%ROWTYPE;mine record;entry_count bigint;good_count bigint;expected_count bigint;delta_total numeric;historical record;
BEGIN
 IF TG_RELID NOT IN ('public.shards_tax_assessments'::regclass,'public.shards_cache_assessments'::regclass)
 OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_TAX_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_TAX_ISOLATION';END IF;
 -- Service writers already take this mutex before custody/ledger locks. Direct
 -- inserts must still serialize across both assessment relations.
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(NEW.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=NEW.wallet FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.shards_tax_all_assessments WHERE wallet=NEW.wallet AND lineage=NEW.lineage AND wallet_sequence=NEW.wallet_sequence)
 THEN RAISE EXCEPTION 'SHARDS_TAX_SEQUENCE_DUPLICATE';END IF;
 IF NEW.lineage<>'d150-resource-tax-v1' OR NEW.carry_before>=10000 OR NEW.carry_after>=10000
 OR NEW.tax::numeric<>div(NEW.gross::numeric*2000+NEW.carry_before,10000)
 OR NEW.carry_after::numeric<>mod(NEW.gross::numeric*2000+NEW.carry_before,10000)
 THEN RAISE EXCEPTION 'SHARDS_TAX_ARITHMETIC';END IF;
 IF TG_RELID='public.shards_cache_assessments'::regclass THEN
  SELECT * INTO STRICT source FROM public.shards_cache_sources WHERE operation_key=NEW.operation_key;
  IF ROW(NEW.wallet,NEW.gross,NEW.term_id,NEW.term_hash,NEW.ledger_id)
  IS DISTINCT FROM ROW(source.wallet,source.gross,source.term_id,source.term_hash,source.ledger_id)
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'daily_cache'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM source.base_id::text
  OR NEW.receipt#>'{source,earning}' IS DISTINCT FROM jsonb_build_object('kind','instant','at',to_char(source.earned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  OR NEW.receipt->'term' IS DISTINCT FROM source.observation THEN RAISE EXCEPTION 'SHARDS_CACHE_ASSESSMENT_SOURCE';END IF;
  expected_count:=1+(CASE WHEN NEW.net>0 THEN 1 ELSE 0 END)+(CASE WHEN NEW.tax>0 THEN 1 ELSE 0 END);
  SELECT count(*),count(*) FILTER(WHERE a.currency='SHARDS' AND a.owner_wallet IS NULL AND
   ((a.kind='shard_genesis' AND a.base_id IS NULL AND e.delta=-NEW.gross)
   OR (a.kind='base_shards' AND a.base_id=source.base_id AND NEW.net>0 AND e.delta=NEW.net)
   OR (a.kind='shards_tax_escrow' AND a.base_id IS NULL AND NEW.tax>0 AND e.delta=NEW.tax))),sum(e.delta::numeric)
  INTO entry_count,good_count,delta_total FROM public.ledger_entries e JOIN public.accounts a ON a.id=e.account_id WHERE e.txn_id=NEW.ledger_id;
  IF entry_count<>expected_count OR good_count<>expected_count OR delta_total IS DISTINCT FROM 0::numeric
  THEN RAISE EXCEPTION 'SHARDS_CACHE_ASSESSMENT_LEDGER';END IF;
 -- BEGIN HISTORICAL MINE CHILD
 ELSIF EXISTS(SELECT 1 FROM public.shards_mine_segments WHERE id=NEW.segment_id AND recovery_parent_id IS NOT NULL) THEN
  -- Private committed source evidence, never the receipt's copied authority.
  -- Server reconstruction/replay verifies custody and hashes before money.
  SELECT s.*,p.id AS parent_id,p.gross AS parent_gross,p.first_unit AS parent_first,p.last_unit AS parent_last,
   (ROW(s.mine_id,s.base_id,s.wallet,s.anchor_at,s.quota) IS NOT DISTINCT FROM ROW(p.mine_id,p.base_id,p.wallet,p.anchor_at,p.quota)
    AND p.recovery_parent_id IS NULL AND p.admission_id IS NULL AND p.wallet IS NOT NULL
    AND p.buffer=0 AND p.reserved=0 AND p.issued=0 AND p.discarded=0 AND p.resolved=p.gross
    AND (to_jsonb(p)-ARRAY['buffer','reserved','issued','discarded','resolved'])=(h.parent_original-ARRAY['buffer','reserved','issued','discarded','resolved'])
    AND h.parent_original->>'buffer'=h.parent_original->>'gross' AND h.parent_original->>'reserved'='0'
    AND h.parent_original->>'issued'='0' AND h.parent_original->>'discarded'='0' AND h.parent_original->>'resolved'='0') IS TRUE AS original_matches,
   h.verified_at,h.term_source,h.custody,c.term_id,c.term_hash,c.certificate,t.snapshot,t.starts_at AS term_start,t.ends_at AS term_end,
   d.gross AS delivered_gross,d.net AS delivered_net,d.tax AS delivered_tax,d.ledger_id,d.destination_base_id,
   l.idempotency_key AS ledger_key,l.type AS ledger_type,l.metadata AS ledger_metadata,
   (SELECT count(*) FROM jsonb_array_elements(t.snapshot->'spots') spot WHERE spot->>'ownerWallet' IS NOT NULL) AS winners
  INTO historical FROM public.shards_mine_segments s
   JOIN public.shards_mine_resolutions h ON h.parent_id=s.recovery_parent_id
   JOIN public.shards_mine_segments p ON p.id=h.parent_id
   JOIN public.shards_mine_resolution_terms c ON c.segment_id=s.id AND c.parent_id=p.id
   JOIN public.expedition_term_snapshots t ON t.term_id=c.term_id AND t.snapshot_hash=c.term_hash
   JOIN public.shards_mine_deliveries d ON d.segment_id=s.id AND d.operation_key=NEW.operation_key
   JOIN public.ledger_transactions l ON l.id=d.ledger_id WHERE s.id=NEW.segment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORICAL_SOURCE';END IF;
  IF NOT historical.original_matches OR historical.admission_id IS NOT NULL OR historical.ownership_status<>'confirmed'
  OR historical.resolved<>0 OR historical.quota<=0 OR historical.first_unit<historical.parent_first OR historical.last_unit>historical.parent_last
  OR historical.gross<>historical.last_unit-historical.first_unit+1 OR NEW.gross>historical.gross
  OR historical.source_key IS DISTINCT FROM 'mine-recovered:'||historical.parent_id::text||':u'||historical.first_unit::text
  OR historical.starts_at IS DISTINCT FROM historical.anchor_at+(ceil(historical.first_unit::numeric*86400000/historical.quota)::text||' milliseconds')::interval
  OR historical.ends_at IS DISTINCT FROM historical.anchor_at+(ceil(historical.last_unit::numeric*86400000/historical.quota)::text||' milliseconds')::interval
  OR ROW(NEW.wallet,NEW.gross,NEW.net,NEW.tax,NEW.term_id,NEW.term_hash,NEW.ledger_id)
   IS DISTINCT FROM ROW(historical.wallet,historical.delivered_gross,historical.delivered_net,historical.delivered_tax,historical.term_id,historical.term_hash,historical.ledger_id)
  OR historical.custody->>'wallet' IS DISTINCT FROM historical.wallet OR historical.custody->>'baseId' IS DISTINCT FROM historical.base_id::text
  OR historical.custody#>>'{evidence,segment,id}' IS DISTINCT FROM historical.parent_id::text
  OR (historical.snapshot->'source')-ARRAY['kind','round'] IS DISTINCT FROM historical.term_source
  OR historical.certificate->'snapshot' IS DISTINCT FROM historical.snapshot OR historical.certificate->>'termHash' IS DISTINCT FROM historical.term_hash
  OR historical.certificate->>'purpose' IS DISTINCT FROM 'historical_shards_attribution'
  OR historical.certificate->'operatingAdmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR historical.starts_at<historical.term_start OR historical.ends_at>=historical.term_end
  OR NOT coalesce((historical.certificate->>'completedAt')::timestamptz<=historical.starts_at
   AND (historical.certificate#>>'{finality,observedAt}')::timestamptz>=historical.ends_at
   AND (historical.certificate#>>'{finality,observedAt}')::timestamptz<=historical.verified_at,false)
  OR NEW.receipt->'version' IS DISTINCT FROM '2'::jsonb OR NEW.receipt->>'purpose' IS DISTINCT FROM 'historical_physical_mine'
  OR NEW.receipt->'sourceVerified' IS DISTINCT FROM 'false'::jsonb OR NEW.receipt->'postingAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR NEW.receipt->'payoutAuthorized' IS DISTINCT FROM 'false'::jsonb OR NEW.receipt->'operatingAdmissionAuthorized' IS DISTINCT FROM 'false'::jsonb
  OR NEW.receipt->'term' IS DISTINCT FROM historical.certificate
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'physical_mine'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM historical.source_key||':'||NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM historical.base_id::text
  OR NEW.receipt#>>'{source,authority,classification}' IS DISTINCT FROM 'new_earning'
  OR NEW.receipt#>>'{source,authority,decisionRef}' IS DISTINCT FROM 'physical-mine-historical-source-v1'
  OR NOT coalesce(NEW.receipt#>>'{source,authority,evidenceSha256}'~'^[0-9a-f]{64}$' AND NEW.receipt->>'historicalCertificateHash'~'^[0-9a-f]{64}$',false)
  OR NEW.receipt#>'{source,earning}' IS DISTINCT FROM (CASE WHEN historical.starts_at=historical.ends_at
   THEN jsonb_build_object('kind','instant','at',to_char(historical.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   ELSE jsonb_build_object('kind','interval','startsAt',to_char(historical.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char((historical.ends_at+interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)
  OR NEW.receipt->'policy' IS DISTINCT FROM jsonb_build_object('lineage','d150-resource-tax-v1','version',1,'basisPoints',10000,'islandPoolBps',2000)
  OR NEW.receipt#>>'{carryBefore,wallet}' IS DISTINCT FROM NEW.wallet OR NEW.receipt#>>'{carryAfter,wallet}' IS DISTINCT FROM NEW.wallet
  OR NEW.receipt#>>'{carryBefore,currency}' IS DISTINCT FROM 'SHARDS' OR NEW.receipt#>>'{carryAfter,currency}' IS DISTINCT FROM 'SHARDS'
  OR NEW.receipt#>>'{carryBefore,lineage}' IS DISTINCT FROM NEW.lineage OR NEW.receipt#>>'{carryAfter,lineage}' IS DISTINCT FROM NEW.lineage
  OR NEW.receipt#>>'{pool,termHash}' IS DISTINCT FROM NEW.term_hash OR NEW.receipt#>>'{pool,amount}' IS DISTINCT FROM NEW.tax::text
  OR NEW.receipt#>>'{pool,winnerCount}' IS DISTINCT FROM historical.winners::text
  OR NEW.receipt#>>'{pool,disposition}' IS DISTINCT FROM (CASE WHEN historical.winners=0 THEN 'held_zero_winners' ELSE 'original_winning_spots' END)
  THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORICAL_SOURCE';END IF;
  -- One posting may contain several source parts and raid-liquid legs. The
  -- application verifies its complete entry group; SQL binds this delivery to
  -- that actual operation/destination without pretending one part is the group.
  IF historical.ledger_key IS DISTINCT FROM NEW.operation_key OR historical.ledger_type NOT IN ('mine.collect','raid.loot.settle')
  OR (historical.ledger_type='mine.collect' AND (historical.ledger_metadata->>'baseId' IS DISTINCT FROM historical.destination_base_id::text
   OR historical.ledger_metadata->>'mineBuildingId' IS DISTINCT FROM historical.mine_id::text))
  OR (historical.ledger_type='raid.loot.settle' AND (historical.ledger_metadata->>'defenderBaseId' IS DISTINCT FROM historical.base_id::text
   OR historical.ledger_metadata->>'attackerBaseId' IS DISTINCT FROM historical.destination_base_id::text))
  THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORICAL_LEDGER';END IF;
 -- END HISTORICAL MINE CHILD
 ELSE
  SELECT s.wallet,s.base_id,s.source_key,s.ownership_status,m.wallet AS admitted_wallet,m.term_id,m.term_hash,
   d.gross,d.net,d.tax,d.ledger_id INTO STRICT mine FROM public.shards_mine_segments s
   JOIN public.shards_mine_admissions m ON m.id=s.admission_id
   JOIN public.shards_mine_deliveries d ON d.segment_id=s.id AND d.operation_key=NEW.operation_key WHERE s.id=NEW.segment_id;
  IF mine.ownership_status<>'confirmed' OR mine.wallet IS DISTINCT FROM mine.admitted_wallet
  OR ROW(NEW.wallet,NEW.gross,NEW.net,NEW.tax,NEW.term_id,NEW.term_hash,NEW.ledger_id)
  IS DISTINCT FROM ROW(mine.wallet,mine.gross,mine.net,mine.tax,mine.term_id,mine.term_hash,mine.ledger_id)
  OR NEW.receipt#>>'{source,kind}' IS DISTINCT FROM 'physical_mine'
  OR NEW.receipt#>>'{source,key}' IS DISTINCT FROM mine.source_key||':'||NEW.operation_key
  OR NEW.receipt#>>'{source,baseId}' IS DISTINCT FROM mine.base_id::text THEN RAISE EXCEPTION 'SHARDS_MINE_ASSESSMENT_SOURCE';END IF;
 END IF;
 IF NEW.receipt#>>'{source,wallet}' IS DISTINCT FROM NEW.wallet OR NEW.receipt#>>'{source,gross}' IS DISTINCT FROM NEW.gross::text
 OR NEW.receipt#>>'{source,ledger,transactionId}' IS DISTINCT FROM NEW.ledger_id::text
 OR NEW.receipt#>>'{source,ledger,idempotencyKey}' IS DISTINCT FROM NEW.operation_key
 OR NEW.receipt#>>'{carryBefore,sequence}' IS DISTINCT FROM (NEW.wallet_sequence-1)::text
 OR NEW.receipt#>>'{carryAfter,sequence}' IS DISTINCT FROM NEW.wallet_sequence::text
 OR NEW.receipt#>>'{carryBefore,value}' IS DISTINCT FROM NEW.carry_before::text
 OR NEW.receipt#>>'{carryAfter,value}' IS DISTINCT FROM NEW.carry_after::text
 OR NEW.receipt->>'net' IS DISTINCT FROM NEW.net::text OR NEW.receipt->>'tax' IS DISTINCT FROM NEW.tax::text
 OR NEW.receipt->>'termHash' IS DISTINCT FROM NEW.term_hash
 OR NEW.receipt#>>'{pool,termId}' IS DISTINCT FROM NEW.term_id::text
 THEN RAISE EXCEPTION 'SHARDS_TAX_ASSESSMENT_RECEIPT';END IF;
 RETURN NEW;
END $$;
