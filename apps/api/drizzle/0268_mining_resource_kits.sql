-- D153.208: prospective ordinary-kit mining. Empty cutover; no activation.
-- Authenticate the preceding0267 contract before changing its successors.
SET LOCAL lock_timeout='10s';
SELECT public.shardkeep_divine_fragment_source();
CREATE TABLE public.mining_resource_v3_cutover (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 first_day date NOT NULL CHECK(isfinite(first_day)),
 policy_version integer NOT NULL CHECK(policy_version=3) REFERENCES public.mining_contribution_policies(version),
 installed_at timestamptz NOT NULL CHECK(isfinite(installed_at))
);
CREATE TABLE public.divine_fragment_resource_kits_contract(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),record jsonb NOT NULL);
REVOKE ALL ON public.mining_resource_v3_cutover,public.divine_fragment_resource_kits_contract FROM PUBLIC;
CREATE UNIQUE INDEX mining_resource_single_day ON public.mining_ingot_epochs((right(epoch_key,10))) WHERE epoch_key LIKE 'resource-mining-v%';

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_resource_day_policy(target date) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE first date;
BEGIN
 IF target IS NULL OR NOT isfinite(target) THEN RAISE EXCEPTION 'MINING_RESOURCE_DAY';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 -- VOLATILE ensures a new READ COMMITTED snapshot after an epoch writer waited
 -- for the installer's table lock. STABLE here would admit a stale v2 epoch.
 SELECT first_day INTO first FROM public.mining_resource_v3_cutover WHERE singleton;
 RETURN CASE WHEN first IS NOT NULL AND target>=first THEN 3 ELSE 2 END;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_resource_cutover_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.mining_resource_v3_cutover'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 OR TG_NAME<>'mining_resource_v3_cutover_guard' OR TG_NARGS<>0 THEN RAISE EXCEPTION 'MINING_RESOURCE_CUTOVER_IMMUTABLE';END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'MINING_RESOURCE_CUTOVER_OWNER';END IF;
 LOCK TABLE public.mining_ingot_epochs IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.mining_resource_v3_cutover) OR NEW.installed_at IS NOT NULL
 OR NEW.first_day<=(clock_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'MINING_RESOURCE_CUTOVER_FUTURE';END IF;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_epochs WHERE epoch_key LIKE 'resource-mining%'
  AND (epoch_key !~ '^resource-mining-v[23]:[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR right(epoch_key,10)::date>=NEW.first_day))
 THEN RAISE EXCEPTION 'MINING_RESOURCE_CUTOVER_EXISTING_EPOCH';END IF;
 NEW.installed_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER mining_resource_v3_cutover_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mining_resource_v3_cutover FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_resource_cutover_guard();
CREATE TRIGGER mining_resource_v3_cutover_no_truncate BEFORE TRUNCATE ON public.mining_resource_v3_cutover FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_resource_cutover_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_resource_epoch_day_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE day date; version integer;
BEGIN
 IF TG_RELID<>'public.mining_ingot_epochs'::regclass OR TG_NAME<>'mining_resource_epoch_day_guard' OR TG_OP<>'INSERT'
 OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN RAISE EXCEPTION 'MINING_RESOURCE_EPOCH_TRIGGER';END IF;
 IF NEW.epoch_key NOT LIKE 'resource-mining%' THEN RETURN NEW;END IF;
 PERFORM public.shardkeep_divine_fragment_source();
 IF NEW.epoch_key !~ '^resource-mining-v[23]:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'MINING_RESOURCE_EPOCH_POLICY';END IF;
 day:=right(NEW.epoch_key,10)::date;version:=substring(NEW.epoch_key FROM 18 FOR 1)::integer;
 IF to_char(day,'YYYY-MM-DD')<>right(NEW.epoch_key,10) OR version<>public.shardkeep_mining_resource_day_policy(day)
 THEN RAISE EXCEPTION 'MINING_RESOURCE_EPOCH_POLICY';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mining_resource_epoch_day_guard BEFORE INSERT ON public.mining_ingot_epochs FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_resource_epoch_day_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_resource_prior_decided(target date) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Serialize newly accepted earlier sources with the prospective publication.
 -- NOWAIT keeps the established epoch/source lock ordering bounded.
 LOCK TABLE public.mining_ingot_epochs,public.mining_contribution_receipts IN SHARE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_epochs e WHERE e.epoch_key LIKE 'resource-mining-v%'
  AND right(e.epoch_key,10)::date<target AND EXISTS(SELECT 1 FROM public.mining_contribution_receipts r WHERE r.epoch_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM public.mining_ingot_aborts a WHERE a.epoch_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM public.mining_publication_settlements s WHERE s.epoch_id=e.id))
 THEN RAISE EXCEPTION 'MINING_RESOURCE_PRIOR_UNDECIDED';END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_contribution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.mining_contribution_receipts;policy public.mining_contribution_policies;b public.bases;prior numeric;k text;plan jsonb;
BEGIN
 IF TG_RELID NOT IN('public.mining_contribution_policies'::regclass,'public.mining_contribution_receipts'::regclass,'public.mining_contribution_lines'::regclass,'public.mining_contribution_terminals'::regclass,'public.divine_fragment_mining_contract'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END))
 OR TG_WHEN<>'BEFORE' OR TG_NARGS<>0 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_IMMUTABLE';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_OWNER_ISOLATION';END IF;
 IF TG_TABLE_NAME='divine_fragment_mining_contract' THEN
  IF EXISTS(SELECT 1 FROM public.divine_fragment_mining_contract) OR NEW.record IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_SEAL';END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='mining_contribution_policies' THEN
  -- Fingerprints derive from constants.ts through miningContributionResourceIds;
  -- they authenticate immutable catalogue snapshots without copying tuning here.
  IF NEW.version NOT IN(2,3) OR encode(sha256(convert_to(public.shardkeep_mining_resource_canonical(jsonb_build_object('catalogue',NEW.catalogue,'freeValue',NEW.free_value::text)),'UTF8')),'hex')
   IS DISTINCT FROM (CASE NEW.version WHEN 2 THEN '7da0a499a83936964c424925521179ca58c9aceb5a662f929cd5346d9f7ab6db' WHEN 3 THEN 'd212860b80d1578c42b9debab7e63044141e618dd59374044dd5e7696b3602c6' END)
  THEN RAISE EXCEPTION 'MINING_RESOURCE_POLICY_CONFLICT';END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='mining_contribution_receipts' THEN
  PERFORM 1 FROM public.players WHERE wallet=NEW.actor_wallet FOR UPDATE;
  SELECT * INTO STRICT b FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  IF b.owner_wallet IS DISTINCT FROM NEW.actor_wallet OR b.status<>'active'
   OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.actor_wallet AND active)
   OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id)
  THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_CUSTODY';END IF;
  PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id AND epoch_key='resource-mining-v'||NEW.policy_version||':'||NEW.day::text FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id)
   OR EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=NEW.epoch_id)
   OR EXISTS(SELECT 1 FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_EPOCH';END IF;
  IF NEW.request->>'idempotencyKey' IS DISTINCT FROM NEW.id::text OR NEW.request->>'baseId' IS DISTINCT FROM NEW.base_id::text
   OR NEW.request->>'expectedDay' IS DISTINCT FROM NEW.day::text OR NEW.request->>'policyVersion' IS DISTINCT FROM NEW.policy_version::text
   OR (NEW.created_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM NEW.day OR jsonb_typeof(NEW.request->'lines') IS DISTINCT FROM 'array'
   OR NEW.pool IS DISTINCT FROM (CASE WHEN b.land_paid_at IS NOT NULL AND b.deed_asset_id IS NOT NULL THEN 'deed' ELSE 'free' END)
  THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_ORIGINAL';END IF;
  IF NEW.policy_version<>public.shardkeep_mining_resource_day_policy(NEW.day) THEN RAISE EXCEPTION 'MINING_RESOURCE_POLICY_CONFLICT';END IF;
  SELECT * INTO STRICT policy FROM public.mining_contribution_policies WHERE version=NEW.policy_version;
  IF jsonb_array_length(NEW.request->'lines')<1 OR jsonb_array_length(NEW.request->'lines')>(SELECT count(*) FROM jsonb_object_keys(policy.catalogue))
   OR (SELECT count(DISTINCT v->>'resourceId') FROM jsonb_array_elements(NEW.request->'lines') v)<>jsonb_array_length(NEW.request->'lines') THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_ORIGINAL';END IF;
  IF NEW.pool='free' THEN
   SELECT coalesce(sum(total_value),0) INTO prior FROM public.mining_contribution_receipts WHERE actor_wallet=NEW.actor_wallet AND day=NEW.day AND pool='free';
   IF prior+NEW.total_value>policy.free_value THEN RAISE EXCEPTION 'MINING_FREE_CAP_EXCEEDED';END IF;
  END IF;
 ELSE
  SELECT * INTO STRICT r FROM public.mining_contribution_receipts WHERE id=NEW.receipt_id;
  PERFORM 1 FROM public.mining_ingot_epochs WHERE id=r.epoch_id FOR UPDATE NOWAIT;
  IF TG_TABLE_NAME='mining_contribution_lines' THEN
   IF EXISTS(SELECT 1 FROM public.mining_contribution_terminals WHERE receipt_id=r.id)
    OR EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=r.epoch_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_FROZEN';END IF;
   SELECT * INTO STRICT policy FROM public.mining_contribution_policies WHERE version=r.policy_version;
   IF NOT(policy.catalogue ? NEW.resource_id) OR NEW.unit_value IS DISTINCT FROM (policy.catalogue->>NEW.resource_id)::numeric
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.request->'lines') v WHERE v->>'resourceId'=NEW.resource_id AND v->>'quantity'=NEW.quantity::text)
   THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_VALUE';END IF;
  ELSE
   IF NEW.epoch_id<>r.epoch_id OR NEW.settled_at<r.created_at THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TERMINAL';END IF;
   IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=r.epoch_id) THEN
    IF NEW.outcome<>'returned' OR EXISTS(SELECT 1 FROM public.mining_publication_attempts WHERE epoch_id=r.epoch_id) THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TERMINAL';END IF;
   ELSE
    SELECT m.manifest_json::jsonb INTO STRICT plan FROM public.mining_publication_manifests m JOIN public.mining_publication_settlements s USING(epoch_id) WHERE m.epoch_id=r.epoch_id;
    IF (plan->>'version' IN ('5','6','7','8')) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'contributions') v WHERE v->>'id'=r.id::text AND v->>'outcome'=NEW.outcome)
    THEN RAISE EXCEPTION 'MINING_CONTRIBUTION_TERMINAL';END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_publication_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_count integer; source_rows jsonb; source_total bigint;resource_key text;
BEGIN
 IF TG_RELID<>'public.mining_publication_attempts'::regclass THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_TRIGGER_IDENTITY' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_PUBLICATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid=TG_RELID) THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
 IF NEW.intent_sha256 IS NOT NULL OR NEW.reservations IS NOT NULL OR NEW.reservations_sha256 IS NOT NULL
  OR NEW.reservation_count IS NOT NULL OR NEW.reserved_ingots IS NOT NULL OR NEW.prepared_at IS NOT NULL OR NEW.contributions IS NOT NULL OR NEW.contributions_sha256 IS NOT NULL OR NEW.contribution_count IS NOT NULL OR NEW.reserved_value IS NOT NULL THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_DERIVED_FIELDS' USING ERRCODE='23514'; END IF;
 PERFORM id FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_PUBLICATION_EPOCH_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id) THEN
  RAISE EXCEPTION 'MINING_PUBLICATION_ABORTED' USING ERRCODE='23514'; END IF;
 SELECT epoch_key INTO STRICT resource_key FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id;
 IF resource_key LIKE 'resource-mining-v%' THEN
  PERFORM public.shardkeep_divine_fragment_source();
  IF resource_key <> 'resource-mining-v'||public.shardkeep_mining_resource_day_policy(right(resource_key,10)::date)||':'||right(resource_key,10) THEN RAISE EXCEPTION 'MINING_RESOURCE_POLICY_CONFLICT';END IF;
  IF resource_key LIKE 'resource-mining-v3:%' THEN PERFORM public.shardkeep_mining_resource_prior_decided(right(resource_key,10)::date);END IF;
  IF EXISTS(SELECT 1 FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id) OR EXISTS(SELECT 1 FROM public.mining_contribution_terminals WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_RESOURCE_SOURCE_CONFLICT';END IF;
  SELECT count(*) INTO source_count FROM(SELECT id FROM public.mining_contribution_receipts WHERE epoch_id=NEW.epoch_id LIMIT 1001) bounded;
  IF source_count=0 THEN RAISE EXCEPTION 'MINING_PUBLICATION_EMPTY';END IF;
  IF source_count>1000 THEN RAISE EXCEPTION 'MINING_PUBLICATION_TOO_LARGE';END IF;
  NEW.contributions:=public.shardkeep_mining_resource_originals(NEW.epoch_id);
  NEW.contributions_sha256:=encode(sha256(convert_to(public.shardkeep_mining_resource_canonical(NEW.contributions),'UTF8')),'hex');
  NEW.contribution_count:=source_count;
  SELECT sum(total_value) INTO NEW.reserved_value FROM public.mining_contribution_receipts WHERE epoch_id=NEW.epoch_id;
  NEW.intent_sha256:=encode(sha256(NEW.intent_bytes),'hex');NEW.prepared_at:=clock_timestamp();
  RETURN NEW;
 END IF;
 -- The epoch lock is also taken by reservation/abort INSERT guards. Count a
 -- bounded indexed prefix before creating JSON; never trust caller aggregates.
 SELECT count(*) INTO source_count FROM (SELECT id FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id LIMIT 10001) bounded;
 IF source_count=0 THEN RAISE EXCEPTION 'MINING_PUBLICATION_EMPTY' USING ERRCODE='23514'; END IF;
 IF source_count>10000 THEN RAISE EXCEPTION 'MINING_PUBLICATION_TOO_LARGE' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(jsonb_build_object('reservationId',id,'baseId',base_id,'actorWallet',actor_wallet,'ingots',qty) ORDER BY base_id,id),sum(qty)::bigint
  INTO source_rows,source_total FROM public.mining_ingot_reservations WHERE epoch_id=NEW.epoch_id;
 NEW.intent_sha256:=encode(sha256(NEW.intent_bytes),'hex');
 NEW.reservations:=source_rows; NEW.reservations_sha256:=encode(sha256(convert_to(source_rows::text,'UTF8')),'hex');
 NEW.reservation_count:=source_count; NEW.reserved_ingots:=source_total; NEW.prepared_at:=clock_timestamp();
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_settlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.mining_publication_attempts%ROWTYPE; m public.mining_publication_manifests%ROWTYPE;
 r public.mining_ingot_reservations%ROWTYPE; plan jsonb; planned jsonb; k text;
 previous_m public.mining_publication_manifests%ROWTYPE;
 previous_s public.mining_publication_settlements%ROWTYPE; reference jsonb;
BEGIN
 IF TG_RELID NOT IN ('public.mining_publication_manifests'::regclass,'public.mining_publication_settlements'::regclass,'public.mining_ingot_dispositions'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN
 RAISE EXCEPTION 'MINING_SETTLEMENT_TRIGGER_IDENTITY'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_IMMUTABLE'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
 RAISE EXCEPTION 'MINING_SETTLEMENT_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT a FROM public.mining_publication_attempts WHERE epoch_id=NEW.epoch_id;
 IF EXISTS(SELECT 1 FROM public.mining_ingot_aborts WHERE epoch_id=NEW.epoch_id) THEN RAISE EXCEPTION 'MINING_SETTLEMENT_ABORTED'; END IF;
 IF TG_TABLE_NAME='mining_publication_manifests' THEN
  IF NEW.source_hash IS NOT NULL OR NEW.intent_sha256 IS NOT NULL OR NEW.prepared_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_SETTLEMENT_DERIVED_FIELDS'; END IF;
  plan:=NEW.manifest_json::jsonb;
  IF ((plan->>'scope'='initial-free-virgin-config-keep-only' AND plan->>'version'='1')
    OR (plan->>'scope'='initial-free-cumulative-keep-only' AND plan->>'version'='2')
    OR (plan->>'scope'='ordinary-paid-and-deedless-v1' AND plan->>'version'='3')
    OR (plan->>'scope'='ordinary-paid-and-deedless-v2' AND plan->>'version'='4')
    OR (plan->>'scope'='ordinary-resource-mining-v2' AND plan->>'version'='5')
    OR (plan->>'scope'='ordinary-resource-mining-seeker-v2' AND plan->>'version'='6')
    OR (plan->>'scope'='ordinary-resource-mining-v3' AND plan->>'version'='7')
    OR (plan->>'scope'='ordinary-resource-mining-seeker-v3' AND plan->>'version'='8')) IS DISTINCT FROM true
   OR plan->>'projection' IS DISTINCT FROM 'READY'
   OR plan#>>'{input,epochId}' IS DISTINCT FROM NEW.epoch_id::text
   OR (plan->>'version' NOT IN ('5','6','7','8') AND (jsonb_typeof(plan->'reservations') IS DISTINCT FROM 'array' OR jsonb_array_length(plan->'reservations')<>a.reservation_count OR a.contributions IS NOT NULL))
   OR (plan->>'version' IN ('5','6','7','8') AND (jsonb_typeof(plan->'contributions') IS DISTINCT FROM 'array' OR jsonb_array_length(plan->'contributions')<>a.contribution_count OR a.contributions IS NULL)) THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
  -- V2 is admitted only against its distinct server-day epoch. Retained v1
  -- manifests continue through the exact historical branches below.
  IF plan->>'version' IN ('5','6','7','8') AND (plan#>'{input,policyVersion}' IS DISTINCT FROM to_jsonb(CASE WHEN plan->>'version' IN('7','8') THEN 3 ELSE 2 END)
   OR NOT EXISTS(SELECT 1 FROM public.mining_ingot_epochs e WHERE e.id=NEW.epoch_id AND e.epoch_key='resource-mining-v'||(plan#>>'{input,policyVersion}')||':'||(plan#>>'{input,day}') AND e.epoch_key=plan#>>'{epoch,key}')
   OR plan#>'{epoch,contributions}' IS DISTINCT FROM a.contributions OR plan#>>'{epoch,contributionSetSha256}' IS DISTINCT FROM a.contributions_sha256)
  THEN RAISE EXCEPTION 'MINING_FUNDED_POLICY_CONFLICT';END IF;
  IF plan->>'version' IN('7','8') THEN
   PERFORM public.shardkeep_divine_fragment_source();
   PERFORM public.shardkeep_mining_resource_prior_decided((plan#>>'{input,day}')::date);
   IF (plan#>>'{input,policyVersion}')::integer<>public.shardkeep_mining_resource_day_policy((plan#>>'{input,day}')::date)
    OR plan#>'{epoch,cutover}' IS DISTINCT FROM (SELECT source||jsonb_build_object('sha256',encode(sha256(convert_to(public.shardkeep_mining_resource_canonical(source),'UTF8')),'hex')) FROM (SELECT jsonb_build_object('firstDay',first_day::text,'policyVersion',policy_version,'installedAt',to_char(installed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) source FROM public.mining_resource_v3_cutover WHERE singleton) cutover)
   THEN RAISE EXCEPTION 'MINING_RESOURCE_CUTOVER_SOURCE';END IF;
  END IF;
  IF plan->>'version'='4' AND (plan#>'{input,policyVersion}' IS DISTINCT FROM '2'::jsonb
   OR NOT EXISTS(SELECT 1 FROM public.mining_ingot_epochs e WHERE e.id=NEW.epoch_id
    AND e.epoch_key='free-shadow-v2:'||(plan#>>'{input,day}')
    AND e.epoch_key=plan#>>'{epoch,key}')) THEN RAISE EXCEPTION 'MINING_FUNDED_POLICY_CONFLICT'; END IF;
  IF plan->>'version'='2' OR (plan->>'version' IN ('3','4','5','6','7','8') AND (NEW.publication->>'sequence')::numeric>1) THEN
   reference:=plan->'previousPublication';
   IF jsonb_typeof(reference) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   SELECT * INTO STRICT previous_m FROM public.mining_publication_manifests WHERE epoch_id=(reference->>'epochId')::uuid;
   SELECT * INTO STRICT previous_s FROM public.mining_publication_settlements WHERE epoch_id=previous_m.epoch_id;
   IF reference->>'sourceHash' IS DISTINCT FROM previous_m.source_hash
    OR reference->>'signature' IS DISTINCT FROM previous_s.signature
    OR reference->>'messageSha256' IS DISTINCT FROM previous_s.message_sha256
    OR reference->>'wireSha256' IS DISTINCT FROM previous_s.wire_sha256
    OR reference->>'publicationSlot' IS DISTINCT FROM previous_s.receipt->>'slot'
    OR ((NEW.publication->>'sequence')::numeric=(previous_m.publication->>'sequence')::numeric+1) IS DISTINCT FROM true
    OR ((NEW.publication->>'day')::numeric>(previous_m.publication->>'day')::numeric) IS DISTINCT FROM true
    OR ((NEW.publication->>'total')::numeric=(previous_m.publication->>'total')::numeric+(NEW.publication->>'playerNet')::numeric) IS DISTINCT FROM true
    OR plan#>>'{funding,source,genesisHash}' IS DISTINCT FROM previous_m.manifest_json::jsonb#>>'{funding,source,genesisHash}'
    OR plan#>>'{funding,config,address}' IS DISTINCT FROM previous_m.manifest_json::jsonb#>>'{funding,config,address}'
    THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   FOREACH k IN ARRAY ARRAY['sequence','day','root','total','leafCount'] LOOP
    IF reference->>k IS DISTINCT FROM previous_m.publication->>k THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   END LOOP;
   FOREACH k IN ARRAY ARRAY['programId','keepMint','reserveOwner'] LOOP
    IF NEW.publication->>k IS DISTINCT FROM previous_m.publication->>k THEN RAISE EXCEPTION 'MINING_SETTLEMENT_PREDECESSOR'; END IF;
   END LOOP;
  END IF;
  IF plan->>'version' IN ('3','4','5','6','7','8') THEN
   IF jsonb_typeof(plan->'captures') IS DISTINCT FROM 'array' OR jsonb_typeof(plan->'participants') IS DISTINCT FROM 'array'
    OR jsonb_array_length(plan->'captures') NOT BETWEEN 1 AND 32
    OR plan->'publicationAuthorized' IS DISTINCT FROM 'false'::jsonb OR plan->'consumptionAuthorized' IS DISTINCT FROM 'false'::jsonb
    OR plan->'renownAuthorized' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'MINING_FUNDED_SOURCE_CONFLICT'; END IF;
   -- Source locks never wait after the ordinary epoch/stock locks. In particular,
   -- an in-flight assignment cannot be inferred absent from an older snapshot.
   LOCK TABLE public.fantasy_land_claims,public.fantasy_world_catalog,public.fantasy_world_tiles,
    public.fantasy_migration_batches,public.deposits,public.bases,public.plot_reservations IN SHARE MODE NOWAIT;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'captures') capture
    CROSS JOIN LATERAL jsonb_array_elements(capture->'bases') b
    WHERE b->'ordinary'<>'null'::jsonb AND NOT EXISTS(
     SELECT 1 FROM public.fantasy_land_claims c JOIN public.fantasy_world_catalog w USING(world_id)
      JOIN public.fantasy_world_tiles t USING(world_id,tile_id)
      LEFT JOIN public.fantasy_migration_batches mb ON mb.manifest_hash=c.manifest_hash LEFT JOIN public.deposits d ON d.id=c.deposit_id
     WHERE c.id::text=b#>>'{ordinary,claimId}' AND c.base_id::text=b->>'baseId' AND c.base_id::text=b#>>'{ordinary,baseId}'
      AND c.world_id=b#>>'{ordinary,worldId}' AND c.tile_id::text=b#>>'{ordinary,tileId}'
      AND (c.source='purchase' AND c.expected_mint IS NULL OR c.source<>'purchase' AND c.expected_mint=b#>>'{ordinary,assetId}')
      AND c.state='assigned' AND t.allocation='ordinary' AND w.catalog_hash=b#>>'{ordinary,catalogHash}'
      AND c.source=b#>>'{ordinary,source}' AND coalesce(c.manifest_hash,c.deposit_id::text)=b#>>'{ordinary,sourceId}'
      AND public.shardkeep_mining_ordinary_source(c.id)=b#>'{ordinary,sourceEvidence}'
      AND encode(sha256(convert_to(public.shardkeep_mining_ordinary_source(c.id)::text,'UTF8')),'hex')=b#>>'{ordinary,sourceHash}'
      AND c.created_at=(b#>>'{ordinary,createdAt}')::timestamptz AND c.assigned_at=(b#>>'{ordinary,assignedAt}')::timestamptz
      AND c.assigned_at<(plan#>>'{input,day}')::date
      AND (c.source IN ('migration-active','migration-inactive') AND mb.manifest->>'catalogHash'=w.catalog_hash
        OR c.source='purchase' AND d.status='credited' AND d.payload->>'baseId'=c.base_id::text)))
    THEN RAISE EXCEPTION 'MINING_FUNDED_ASSIGNMENT_CHANGED'; END IF;
  END IF;
  IF plan->>'version' IN ('5','6','7','8') THEN
   IF (SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(plan->'contributions') v)<>a.contribution_count THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST';END IF;
   FOR planned IN SELECT value FROM jsonb_array_elements(plan->'contributions') LOOP
    IF planned->>'outcome' NOT IN('consumed','returned') OR planned->>'outcome' IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.contributions) original
     WHERE original->>'id'=planned->>'id' AND original->>'baseId'=planned->>'baseId' AND original->>'actorWallet'=planned->>'actorWallet' AND original->'lines'=planned->'lines' AND original->>'totalValue'=planned->>'totalValue') THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST';END IF;
   END LOOP;
  ELSE
  IF (SELECT count(DISTINCT v->>'reservationId') FROM jsonb_array_elements(plan->'reservations') v)<>a.reservation_count THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
  FOR planned IN SELECT value FROM jsonb_array_elements(plan->'reservations') LOOP
   SELECT * INTO STRICT r FROM public.mining_ingot_reservations WHERE id=(planned->>'reservationId')::uuid AND epoch_id=NEW.epoch_id;
   IF planned->>'baseId' IS DISTINCT FROM r.base_id::text OR planned->>'actorWallet' IS DISTINCT FROM r.actor_wallet
    OR (planned->>'reserved')::integer IS DISTINCT FROM r.qty OR (planned->>'proposedConsumed')::integer<0 OR (planned->>'proposedReturned')::integer<0
    OR (planned->>'proposedConsumed')::bigint+(planned->>'proposedReturned')::bigint IS DISTINCT FROM r.qty::bigint THEN RAISE EXCEPTION 'MINING_SETTLEMENT_MANIFEST'; END IF;
  END LOOP;
  END IF;
  NEW.source_hash:=encode(sha256(convert_to(NEW.manifest_json,'UTF8')),'hex');NEW.intent_sha256:=a.intent_sha256;NEW.prepared_at:=clock_timestamp();
 ELSIF TG_TABLE_NAME='mining_publication_settlements' THEN
  SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
  IF NEW.message_sha256 IS NOT NULL OR NEW.wire_sha256 IS NOT NULL OR NEW.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'MINING_SETTLEMENT_DERIVED_FIELDS'; END IF;
  NEW.message_sha256:=a.intent_sha256;NEW.wire_sha256:=encode(sha256(NEW.signed_transaction),'hex');NEW.finalized_at:=clock_timestamp();
  IF NEW.receipt->>'signature' IS DISTINCT FROM NEW.signature OR NEW.receipt->>'originalMessageSha256' IS DISTINCT FROM a.intent_sha256
   OR NEW.receipt->>'signedTransactionSha256' IS DISTINCT FROM NEW.wire_sha256 OR NEW.receipt->>'sourceHash' IS DISTINCT FROM m.source_hash
   OR NEW.receipt->>'currentClaimsAuthorized' IS DISTINCT FROM 'false' OR NEW.receipt->>'scoreFairnessVerified' IS DISTINCT FROM 'false'
   OR NEW.receipt->>'trust' IS DISTINCT FROM 'trusted-finalized-rpc-reviewed-program'
   OR NEW.receipt->>'totalCumulative' IS DISTINCT FROM m.publication->>'total'
   OR ((NEW.receipt->>'slot')::bigint >= (m.publication->>'blockhashContextSlot')::bigint) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_SETTLEMENT_RECEIPT'; END IF;
  FOREACH k IN ARRAY ARRAY['programId','day','sequence','root','budgetGross','freeGross','deedGross','playerNet','recycle','tax','taxCommitment','taxVersion','splitStart','splitEnd'] LOOP
   IF NEW.receipt->>k IS DISTINCT FROM m.publication->>k THEN RAISE EXCEPTION 'MINING_SETTLEMENT_RECEIPT'; END IF;
  END LOOP;
 ELSE
  SELECT * INTO STRICT r FROM public.mining_ingot_reservations WHERE id=NEW.reservation_id AND epoch_id=NEW.epoch_id;
  SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
  SELECT value INTO STRICT planned FROM jsonb_array_elements(m.manifest_json::jsonb->'reservations') WHERE value->>'reservationId'=NEW.reservation_id::text;
  IF NEW.consumed_qty::bigint+NEW.returned_qty::bigint<>r.qty OR NEW.consumed_qty IS DISTINCT FROM (planned->>'proposedConsumed')::integer
   OR NEW.returned_qty IS DISTINCT FROM (planned->>'proposedReturned')::integer
   OR EXISTS(SELECT 1 FROM public.mining_ingot_releases WHERE reservation_id=r.id) THEN RAISE EXCEPTION 'MINING_SETTLEMENT_DISPOSITION'; END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_entitlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.mining_publication_manifests%ROWTYPE; s public.mining_publication_settlements%ROWTYPE;
 h public.mining_claim_entitlement_headers%ROWTYPE; previous_h public.mining_claim_entitlement_headers%ROWTYPE;
 previous_s public.mining_publication_settlements%ROWTYPE; plan jsonb; reference jsonb; expected jsonb;
 i integer; v text; n numeric:=0; sequence_value numeric:=0; encoded text:='';
 alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
BEGIN
 IF TG_RELID NOT IN ('public.mining_claim_entitlement_headers'::regclass,'public.mining_claim_entitlement_leaves'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_immutable' END)) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_TRIGGER_IDENTITY'; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_IMMUTABLE'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 PERFORM 1 FROM public.mining_ingot_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 IF TG_TABLE_NAME='mining_claim_entitlement_headers' THEN
  IF EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(NEW)-'epoch_id') kv WHERE kv.value<>'null'::jsonb) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_DERIVED_FIELDS'; END IF;
  SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
  SELECT * INTO STRICT s FROM public.mining_publication_settlements WHERE epoch_id=NEW.epoch_id;
  IF octet_length(m.manifest_json)>4194304 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  plan:=m.manifest_json::jsonb;
  FOREACH v IN ARRAY ARRAY['sequence','day','total','playerNet'] LOOP
   IF jsonb_typeof(m.publication->v) IS DISTINCT FROM 'string'
    OR (m.publication->>v ~ '^[1-9][0-9]{0,19}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
   IF (m.publication->>v)::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  END LOOP;
  IF jsonb_typeof(m.publication->'leafCount') IS DISTINCT FROM 'number'
   OR (m.publication->>'leafCount' ~ '^[1-9][0-9]{0,4}$') IS DISTINCT FROM true
   OR jsonb_typeof(s.receipt->'slot') IS DISTINCT FROM 'number'
   OR (s.receipt->>'slot' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF (m.publication->>'leafCount')::integer>10000 OR (s.receipt->>'slot')::numeric>9007199254740991 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  NEW.genesis_hash:=s.receipt->>'genesisHash';NEW.program_id:=m.publication->>'programId';NEW.config_address:=s.receipt->>'config';
  NEW.keep_mint:=m.publication->>'keepMint';NEW.reserve_owner:=m.publication->>'reserveOwner';NEW.sequence:=(m.publication->>'sequence')::numeric;
  NEW.day:=(m.publication->>'day')::numeric;NEW.root:=m.publication->>'root';NEW.source_hash:=m.source_hash;NEW.total_cumulative:=(m.publication->>'total')::numeric;
  NEW.leaf_count:=(m.publication->>'leafCount')::integer;NEW.publication_signature:=s.signature;NEW.publication_slot:=(s.receipt->>'slot')::bigint;NEW.projected_at:=clock_timestamp();
  IF s.receipt->>'sourceHash' IS DISTINCT FROM NEW.source_hash OR s.receipt->>'root' IS DISTINCT FROM NEW.root
   OR s.receipt->>'totalCumulative' IS DISTINCT FROM NEW.total_cumulative::text OR s.receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text
   OR s.receipt->>'day' IS DISTINCT FROM NEW.day::text OR s.receipt->>'programId' IS DISTINCT FROM NEW.program_id
   OR s.receipt->>'mint' IS DISTINCT FROM NEW.keep_mint OR s.receipt->>'signature' IS DISTINCT FROM NEW.publication_signature
   OR s.receipt->>'originalMessageSha256' IS DISTINCT FROM m.intent_sha256 OR s.message_sha256 IS DISTINCT FROM m.intent_sha256
   OR plan#>>'{input,epochId}' IS DISTINCT FROM NEW.epoch_id::text OR plan->>'projection' IS DISTINCT FROM 'READY'
   OR plan#>>'{funding,source,genesisHash}' IS DISTINCT FROM NEW.genesis_hash
   OR plan#>>'{funding,source,programId}' IS DISTINCT FROM NEW.program_id
   OR plan#>>'{funding,config,address}' IS DISTINCT FROM NEW.config_address
   OR plan#>>'{funding,config,keepMint}' IS DISTINCT FROM NEW.keep_mint
   OR plan#>>'{funding,config,emissionReserveOwner}' IS DISTINCT FROM NEW.reserve_owner
   OR s.receipt->>'reviewedProgramDataSha256' IS DISTINCT FROM plan#>>'{funding,source,reviewedProgramDataSha256}'
   OR s.receipt->>'reviewedDeploymentSlot' IS DISTINCT FROM plan#>>'{funding,source,reviewedDeploymentSlot}'
   THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF NEW.sequence=1 THEN
   IF ((plan->'version'='1'::jsonb AND plan->>'scope'='initial-free-virgin-config-keep-only')
     OR (plan->'version'='3'::jsonb AND plan->>'scope'='ordinary-paid-and-deedless-v1')
     OR (plan->'version'='4'::jsonb AND plan->>'scope'='ordinary-paid-and-deedless-v2')
     OR (plan->'version'='5'::jsonb AND plan->>'scope'='ordinary-resource-mining-v2')
     OR (plan->'version'='6'::jsonb AND plan->>'scope'='ordinary-resource-mining-seeker-v2')
     OR (plan->'version'='7'::jsonb AND plan->>'scope'='ordinary-resource-mining-v3')
     OR (plan->'version'='8'::jsonb AND plan->>'scope'='ordinary-resource-mining-seeker-v3')) IS DISTINCT FROM true
    OR plan->'previousPublication' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  ELSE
   IF ((plan->'version'='2'::jsonb AND plan->>'scope'='initial-free-cumulative-keep-only')
     OR (plan->'version'='3'::jsonb AND plan->>'scope'='ordinary-paid-and-deedless-v1')
     OR (plan->'version'='4'::jsonb AND plan->>'scope'='ordinary-paid-and-deedless-v2')
     OR (plan->'version'='5'::jsonb AND plan->>'scope'='ordinary-resource-mining-v2')
     OR (plan->'version'='6'::jsonb AND plan->>'scope'='ordinary-resource-mining-seeker-v2')
     OR (plan->'version'='7'::jsonb AND plan->>'scope'='ordinary-resource-mining-v3')
     OR (plan->'version'='8'::jsonb AND plan->>'scope'='ordinary-resource-mining-seeker-v3')) IS DISTINCT FROM true
    OR jsonb_typeof(plan->'previousPublication') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
   SELECT * INTO previous_h FROM public.mining_claim_entitlement_headers WHERE genesis_hash=NEW.genesis_hash
    AND program_id=NEW.program_id AND config_address=NEW.config_address AND sequence=NEW.sequence-1;
   IF NOT FOUND THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
   SELECT * INTO STRICT previous_s FROM public.mining_publication_settlements WHERE epoch_id=previous_h.epoch_id;
   reference:=plan->'previousPublication';
   expected:=jsonb_build_object('epochId',previous_h.epoch_id::text,'sequence',previous_h.sequence::text,'day',previous_h.day::text,
    'root',previous_h.root,'total',previous_h.total_cumulative::text,'leafCount',previous_h.leaf_count,'sourceHash',previous_h.source_hash,
    'signature',previous_h.publication_signature,'publicationSlot',previous_h.publication_slot,
    'messageSha256',previous_s.message_sha256,'wireSha256',previous_s.wire_sha256);
   IF reference IS DISTINCT FROM expected OR previous_h.keep_mint IS DISTINCT FROM NEW.keep_mint
    OR previous_h.reserve_owner IS DISTINCT FROM NEW.reserve_owner OR NEW.day<=previous_h.day
    OR NEW.publication_slot<previous_h.publication_slot OR previous_h.publication_signature IS DISTINCT FROM previous_s.signature
    OR s.receipt->>'reviewedProgramDataSha256' IS DISTINCT FROM previous_s.receipt->>'reviewedProgramDataSha256'
    OR s.receipt->>'reviewedDeploymentSlot' IS DISTINCT FROM previous_s.receipt->>'reviewedDeploymentSlot'
    OR NEW.total_cumulative<>previous_h.total_cumulative+(m.publication->>'playerNet')::numeric
    THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
  END IF;
 ELSE
  -- Do not parse a multi-megabyte source manifest for each of 10,000 leaves.
  -- The single deferred header event proves recurrence and completeness below.
  SELECT * INTO STRICT h FROM public.mining_claim_entitlement_headers WHERE epoch_id=NEW.epoch_id;
  IF NEW.leaf_index IS NULL OR NEW.leaf_index<0 OR NEW.leaf_index>=h.leaf_count
   OR NEW.wallet IS NULL OR length(NEW.wallet) NOT BETWEEN 32 AND 44
   OR NEW.leaf_bytes IS NULL OR octet_length(NEW.leaf_bytes)<>65
   OR NEW.proof_bytes IS NULL OR octet_length(NEW.proof_bytes) NOT BETWEEN 4 AND 660
   OR (octet_length(NEW.proof_bytes)-4)%41<>0 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  IF get_byte(NEW.leaf_bytes,0)<>2 OR get_byte(NEW.proof_bytes,0)<>(octet_length(NEW.proof_bytes)-4)/41
   OR substring(NEW.proof_bytes FROM 2 FOR 3)<>decode('000000','hex') THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  FOR i IN 0..7 LOOP sequence_value:=sequence_value+get_byte(NEW.leaf_bytes,57+i)*power(256::numeric,i); END LOOP;
  IF sequence_value<>h.sequence THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  -- Fixed32-byte Base58 encoding; div avoids rounded large numeric quotients.
  FOR i IN 1..32 LOOP n:=n*256+get_byte(NEW.leaf_bytes,i); END LOOP;
  WHILE n>0 LOOP encoded:=substr(alphabet,mod(n,58)::integer+1,1)||encoded;n:=div(n,58); END LOOP;
  FOR i IN 1..32 LOOP EXIT WHEN get_byte(NEW.leaf_bytes,i)<>0;encoded:='1'||encoded; END LOOP;
  IF NEW.wallet IS DISTINCT FROM encoded THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  FOR i IN 0..get_byte(NEW.proof_bytes,0)-1 LOOP
   IF get_byte(NEW.proof_bytes,44+i*41) NOT IN (0,1) THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_LEAF'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_entitlement_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.mining_claim_entitlement_headers%ROWTYPE; previous_h public.mining_claim_entitlement_headers%ROWTYPE;
 m public.mining_publication_manifests%ROWTYPE; plan jsonb; award jsonb; previous_epoch uuid;
 wrong boolean; actual_count bigint; actual_total numeric; award_total numeric:=0;
BEGIN
 IF TG_RELID<>'public.mining_claim_entitlement_headers'::regclass OR TG_NAME<>'mining_claim_entitlement_headers_complete'
  OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_TRIGGER_IDENTITY'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_READ_COMMITTED_REQUIRED'; END IF;
 SELECT * INTO STRICT h FROM public.mining_claim_entitlement_headers WHERE epoch_id=NEW.epoch_id;
 SELECT * INTO STRICT m FROM public.mining_publication_manifests WHERE epoch_id=NEW.epoch_id;
 IF octet_length(m.manifest_json)>4194304 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 plan:=m.manifest_json::jsonb;
 IF jsonb_typeof(plan->'awards') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 IF jsonb_array_length(plan->'awards') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 FOR award IN SELECT value FROM jsonb_array_elements(plan->'awards') LOOP
  IF jsonb_typeof(award) IS DISTINCT FROM 'object' OR jsonb_typeof(award->'wallet') IS DISTINCT FROM 'string'
   OR (award->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
   OR jsonb_typeof(award->'net') IS DISTINCT FROM 'string'
   OR (award->>'net' ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF (award->>'net')::numeric>18446744073709551615 THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
  IF plan->>'version' IN ('3','4','5','6','7','8') THEN
   IF jsonb_typeof(award->'renown') IS DISTINCT FROM 'string' OR jsonb_typeof(award->'days') IS DISTINCT FROM 'string'
    OR (award->>'renown' ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true OR (award->>'days' ~ '^(0|[1-9][0-9]{0,19})$') IS DISTINCT FROM true
    OR (award->>'renown')::numeric IS DISTINCT FROM (CASE WHEN (award->>'net')::numeric>0 THEN (plan#>>'{policy,participation,renownPerQualifiedDay}')::numeric ELSE 0 END)
    OR (award->>'days')::numeric IS DISTINCT FROM (CASE WHEN (award->>'net')::numeric>0 THEN (plan#>>'{policy,participation,daysPerQualifiedDay}')::numeric ELSE 0 END)
    THEN RAISE EXCEPTION 'MINING_FUNDED_PARTICIPATION_CONFLICT'; END IF;
  END IF;
  award_total:=award_total+(award->>'net')::numeric;
 END LOOP;
 IF (SELECT count(DISTINCT a->>'wallet') FROM jsonb_array_elements(plan->'awards') a)<>jsonb_array_length(plan->'awards')
  OR award_total<>(m.publication->>'playerNet')::numeric THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_SOURCE_CONFLICT'; END IF;
 IF h.sequence>1 THEN
  SELECT * INTO previous_h FROM public.mining_claim_entitlement_headers WHERE genesis_hash=h.genesis_hash
   AND program_id=h.program_id AND config_address=h.config_address AND sequence=h.sequence-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
  previous_epoch:=previous_h.epoch_id;
  IF previous_epoch::text IS DISTINCT FROM plan#>>'{previousPublication,epochId}'
   OR (SELECT count(*) FROM public.mining_claim_entitlement_leaves WHERE epoch_id=previous_epoch)<>previous_h.leaf_count
   THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_PREDECESSOR'; END IF;
 END IF;
 -- All rows are bounded by unique indices < their immutable header's count.
 -- Parse each fixed leaf once. Byte ordering matches the canonical chain tree.
 WITH current_rows AS MATERIALIZED (
  SELECT l.wallet,l.leaf_index,row_number() OVER(ORDER BY substring(l.leaf_bytes FROM 2 FOR 32))-1 canonical_index,
   d.keep,d.renown,d.days
  FROM public.mining_claim_entitlement_leaves l CROSS JOIN LATERAL (
   SELECT sum(get_byte(l.leaf_bytes,33+i)*power(256::numeric,i)) keep,
    sum(get_byte(l.leaf_bytes,41+i)*power(256::numeric,i)) renown,
    sum(get_byte(l.leaf_bytes,49+i)*power(256::numeric,i)) days FROM generate_series(0,7) i
  ) d WHERE l.epoch_id=h.epoch_id
 ), previous_rows AS MATERIALIZED (
  SELECT l.wallet,d.keep,d.renown,d.days FROM public.mining_claim_entitlement_leaves l CROSS JOIN LATERAL (
   SELECT sum(get_byte(l.leaf_bytes,33+i)*power(256::numeric,i)) keep,
    sum(get_byte(l.leaf_bytes,41+i)*power(256::numeric,i)) renown,
    sum(get_byte(l.leaf_bytes,49+i)*power(256::numeric,i)) days FROM generate_series(0,7) i
  ) d WHERE l.epoch_id=previous_epoch
 ), awards AS MATERIALIZED (
  SELECT a->>'wallet' wallet,(a->>'net')::numeric net,
   CASE WHEN plan->>'version' IN ('3','4','5','6','7','8') THEN (a->>'renown')::numeric ELSE 0 END renown,
   CASE WHEN plan->>'version' IN ('3','4','5','6','7','8') THEN (a->>'days')::numeric ELSE 0 END days FROM jsonb_array_elements(plan->'awards') a
 ), expected_rows AS MATERIALIZED (
  SELECT coalesce(p.wallet,a.wallet) wallet,coalesce(p.keep,0)+coalesce(a.net,0) keep,
   coalesce(p.renown,0)+coalesce(a.renown,0) renown,coalesce(p.days,0)+coalesce(a.days,0) days
  FROM previous_rows p FULL JOIN awards a USING(wallet) WHERE p.wallet IS NOT NULL OR a.net>0
 )
 SELECT coalesce(bool_or(c.wallet IS NULL OR e.wallet IS NULL OR c.leaf_index<>c.canonical_index
  OR c.keep<>e.keep OR c.renown<>e.renown OR c.days<>e.days OR e.keep>18446744073709551615 OR e.renown>18446744073709551615 OR e.days>18446744073709551615),true),
  count(*),coalesce(sum(c.keep),0) INTO wrong,actual_count,actual_total
 FROM current_rows c FULL JOIN expected_rows e USING(wallet);
 IF wrong OR actual_count<>h.leaf_count OR actual_total<>h.total_cumulative
  OR h.total_cumulative<>coalesce(previous_h.total_cumulative,0)+award_total THEN RAISE EXCEPTION 'MINING_ENTITLEMENT_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shardkeep_mining_resource_day_policy(date),public.shardkeep_mining_resource_cutover_guard(),public.shardkeep_mining_resource_epoch_day_guard(),public.shardkeep_mining_resource_prior_decided(date) FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tables',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('owner',c.relowner,'acl',to_jsonb(c.relacl),'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])),
 'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('owner',p.proowner,'acl',to_jsonb(p.proacl),'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),'definition',pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shardkeep_assert_ordinary_crafting_shards','shardkeep_ordinary_crafting_shards_guard','shardkeep_ordinary_crafting_shards_complete','shardkeep_ordinary_crafting_guard','shardkeep_ordinary_crafting_proof','shardkeep_ordinary_kits_seal_guard','shardkeep_mining_resource_kits_seal_guard','shardkeep_mining_resource_day_policy','shardkeep_mining_resource_cutover_guard','shardkeep_mining_resource_epoch_day_guard','shardkeep_mining_resource_prior_decided','divine_fragment_policy','shardkeep_mining_contribution_guard','shardkeep_mining_resource_canonical','shardkeep_mining_resource_originals','shardkeep_mining_publication_attempt_guard','shardkeep_mining_settlement_guard','shardkeep_mining_entitlement_guard','shardkeep_mining_entitlement_complete','shardkeep_mining_settlement_complete','shardkeep_mining_resource_publication_seal_guard','shardkeep_mining_seeker_publication_seal_guard','shardkeep_mining_resource_publication_source_guard','shardkeep_mining_contribution_effect','shardkeep_mining_pending_stock_guard','shardkeep_mining_contribution_complete','shardkeep_assert_mining_contribution_money','shardkeep_mining_contribution_money_guard','shardkeep_mining_contribution_epoch_guard','divine_fragment_week','shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_divine_fragment_guard','shardkeep_divine_fragment_effect','shardkeep_divine_fragment_stock_guard','divine_fragment_source_event','divine_fragment_clan_policy','shardkeep_keep_equipment_market_guard','shardkeep_keep_equipment_market_stock','shardkeep_keep_equipment_payment_guard','shardkeep_keep_equipment_payment_effect','shardkeep_keep_equipment_release_guard','shardkeep_keep_equipment_release_effect','shardkeep_keep_equipment_payment_release_guard','shardkeep_claim_payment_signature','shardkeep_payment_signature_guard'])),
 'ingredientLedgerTriggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass) AND t.tgname IN('ordinary_crafting_shards_guard','ordinary_crafting_shards_complete')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','crafting_stocks','divine_fragment_ordinary_kits_contract','divine_fragment_resource_kits_contract','mining_resource_v3_cutover','mining_ingot_epochs','divine_fragment_periods','divine_fragment_enrollments','divine_fragment_settlements','divine_fragment_awards','divine_fragment_deliveries','crystal_fragment_stocks','seeker_fragment_claims','divine_fragment_contract','divine_fragment_clan_contract','divine_fragment_market_contract','divine_fragment_mining_contract','divine_fragment_resource_publication_contract','divine_fragment_seeker_publication_contract','mining_publication_attempts','mining_publication_manifests','mining_publication_settlements','mining_contribution_policies','mining_contribution_receipts','mining_contribution_lines','mining_contribution_terminals','keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries','keep_equipment_fill_releases','payment_signature_claims'])))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source() RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_isolation')<>'read committed'
  OR current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.divine_fragment_contract'::regclass))
 THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_OWNER_ISOLATION';END IF;
 IF (SELECT record FROM public.divine_fragment_resource_kits_contract WHERE singleton) IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'DIVINE_FRAGMENT_SOURCE';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_mining_resource_kits_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF TG_RELID<>'public.divine_fragment_resource_kits_contract'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NAME<>'divine_fragment_resource_kits_contract_guard'
 OR current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID)
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM public.divine_fragment_resource_kits_contract)
 OR NEW.record IS DISTINCT FROM public.shardkeep_divine_fragment_contract() THEN RAISE EXCEPTION 'MINING_RESOURCE_KITS_SEAL_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER divine_fragment_resource_kits_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.divine_fragment_resource_kits_contract FOR EACH ROW EXECUTE FUNCTION public.shardkeep_mining_resource_kits_seal_guard();
CREATE TRIGGER divine_fragment_resource_kits_contract_no_truncate BEFORE TRUNCATE ON public.divine_fragment_resource_kits_contract FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_mining_resource_kits_seal_guard();
REVOKE ALL ON FUNCTION public.shardkeep_mining_resource_kits_seal_guard() FROM PUBLIC;
INSERT INTO public.divine_fragment_resource_kits_contract(record) SELECT public.shardkeep_divine_fragment_contract();
SELECT public.shardkeep_divine_fragment_source();
