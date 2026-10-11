-- D-153.142, S5 HELD: immutable service application and derived lifecycle.
-- Shared PHASE_E_VEHICLES and the owner application enforce gameplay limits.
-- SQL binds original state, structural transitions and frozen proof fields; it
-- cannot authenticate arbitrary privileged RPC JSON or supply game authority.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.vehicle_service_consumptions (
 intent_id uuid PRIMARY KEY REFERENCES public.vehicle_service_burn_preparations(intent_id),
 asset_id text NOT NULL UNIQUE,wallet text NOT NULL,
 signature text NOT NULL UNIQUE CHECK(signature~'^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
 signed_transaction_sha256 text NOT NULL UNIQUE CHECK(signed_transaction_sha256~'^[0-9a-f]{64}$'),
 original_message_sha256 text NOT NULL CHECK(original_message_sha256~'^[0-9a-f]{64}$'),
 slot bigint NOT NULL CHECK(slot BETWEEN 0 AND 9007199254740991),
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=1048576),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE IF NOT EXISTS public.vehicle_service_applications (
 intent_id uuid PRIMARY KEY REFERENCES public.vehicle_service_consumptions(intent_id),
 installation_id uuid NOT NULL REFERENCES public.advanced_vehicle_installations(reservation_id),
 revision_after bigint NOT NULL CHECK(revision_after>0),tier_after integer NOT NULL CHECK(tier_after>0),
 completed_total bigint NOT NULL CHECK(completed_total>=0),allowance_start_after bigint NOT NULL CHECK(allowance_start_after>=0),
 applied_at timestamptz NOT NULL CHECK(isfinite(applied_at)),UNIQUE(installation_id,revision_after)
);
ALTER TABLE public.vehicle_service_intents DROP CONSTRAINT IF EXISTS vehicle_service_intents_revision_check;
ALTER TABLE public.vehicle_service_intents ADD CONSTRAINT vehicle_service_intents_revision_check CHECK(revision>=0);
ALTER TABLE public.vehicle_service_intents DROP CONSTRAINT IF EXISTS vehicle_service_intents_allowance_start_check;
ALTER TABLE public.vehicle_service_intents ADD CONSTRAINT vehicle_service_intents_allowance_start_check CHECK(allowance_start>=0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_state_v214(r public.vehicle_service_intents) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('operation',r.operation,'installationId',r.installation_id::text,'baseId',r.base_id::text,'berthId',r.berth_id::text,'revision',r.revision,'family',r.family,'tier',r.tier,'completedTotal',r.completed_total::text,'allowanceStart',r.allowance_start::text)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_effect_v214(r public.vehicle_service_intents,remaining_uses bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.shardkeep_vehicle_service_state_v214(r)||jsonb_build_object('version',1,'tierAfter',CASE WHEN r.operation='upgrade' THEN r.tier+1 ELSE r.tier END,'revisionAfter',r.revision::bigint+1,'allowanceStartAfter',CASE WHEN r.operation='restore_uses' THEN r.completed_total ELSE r.allowance_start END::text,'remainingUses',remaining_uses,'serviceAuthorized',false)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_proof_valid_v214(c public.vehicle_service_consumptions) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_service_intents%ROWTYPE;p public.vehicle_service_burn_preparations%ROWTYPE;m public.vehicle_mint_registry%ROWTYPE;q jsonb;s jsonb;canonical text;h jsonb;last_slot numeric;last_index numeric:=-1;seen text[]:=ARRAY[]::text[];
BEGIN
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=c.intent_id;
 SELECT * INTO STRICT p FROM public.vehicle_service_burn_preparations WHERE intent_id=r.id;
 SELECT * INTO STRICT m FROM public.vehicle_mint_registry WHERE asset_id=r.asset_id;
 q:=c.proof;
 -- Strict saved wire field, not SQL game authority: the TS reader independently
 -- rebuilds remainingUses from the shared rules and original signed state.
 IF jsonb_typeof(q#>'{service,remainingUses}') IS DISTINCT FROM 'number'
 OR (q#>>'{service,remainingUses}'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR (q#>>'{service,remainingUses}')::numeric>9007199254740991 THEN RETURN false;END IF;
 s:=public.shardkeep_vehicle_service_effect_v214(r,(q#>>'{service,remainingUses}')::bigint);
 IF r.tier<1 OR r.allowance_start<0 OR r.completed_total<r.allowance_start
 OR p.wallet IS DISTINCT FROM r.wallet OR p.plan->'service' IS DISTINCT FROM public.shardkeep_vehicle_service_state_v214(r)
 OR p.plan->'identity' IS DISTINCT FROM jsonb_build_object('assetId',r.asset_id,'collection',m.collection,'family',r.family,'tier',r.tier)
 OR p.plan->>'wallet' IS DISTINCT FROM r.wallet OR p.plan->>'reservationId' IS DISTINCT FROM r.id::text
 OR p.message_sha256 IS DISTINCT FROM encode(sha256(p.message_bytes),'hex') OR m.family IS DISTINCT FROM r.family OR m.tier IS DISTINCT FROM r.tier
 OR jsonb_typeof(q) IS DISTINCT FROM 'object' OR octet_length(q::text)>1048576 OR (SELECT count(*) FROM jsonb_object_keys(q))<>25
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(q) k WHERE k<>ALL(ARRAY['version','reservationId','wallet','identity','signature','slot','blockTime','originalMessageSha256','signedTransactionSha256','feeLamports','assetRefundLamports','transactionEvidenceVerified','finalityVerified','preBurnOwnershipVerified','registryMembershipVerified','installationAuthorized','preBurnOwner','finalizedThroughSlot','anchorSlot','history','source','purpose','service','serviceSha256','serviceAuthorized']))
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['reservationId','wallet','preBurnOwner','originalMessageSha256','signedTransactionSha256','signature','feeLamports','assetRefundLamports','purpose','serviceSha256']) field WHERE jsonb_typeof(q->field) IS DISTINCT FROM 'string')
 OR q->'version' IS DISTINCT FROM '2'::jsonb OR q->>'purpose' IS DISTINCT FROM 'vehicle_service' OR q->'serviceAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR q->'service' IS DISTINCT FROM s OR q->>'reservationId' IS DISTINCT FROM r.id::text OR q->>'wallet' IS DISTINCT FROM r.wallet OR q->'identity' IS DISTINCT FROM p.plan->'identity'
 OR q->>'preBurnOwner' IS DISTINCT FROM r.wallet OR q->>'originalMessageSha256' IS DISTINCT FROM p.message_sha256
 OR q->'transactionEvidenceVerified' IS DISTINCT FROM 'true'::jsonb OR q->'finalityVerified' IS DISTINCT FROM 'true'::jsonb OR q->'preBurnOwnershipVerified' IS DISTINCT FROM 'true'::jsonb
 OR q->'registryMembershipVerified' IS DISTINCT FROM 'false'::jsonb OR q->'installationAuthorized' IS DISTINCT FROM 'false'::jsonb
 OR q->'anchorSlot' IS DISTINCT FROM p.owner_anchor->'slot' OR p.owner_anchor->'identity' IS DISTINCT FROM p.plan->'identity' OR p.owner_anchor->>'wallet' IS DISTINCT FROM r.wallet
 OR jsonb_typeof(q->'source') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(q->'source'))<>6
 OR q#>'{source,genesisHash}' IS DISTINCT FROM p.owner_anchor->'genesisHash' OR q#>'{source,reviewedDeploymentSlot}' IS DISTINCT FROM p.owner_anchor->'reviewedDeploymentSlot'
 OR q#>'{source,reviewedProgramDataSha256}' IS DISTINCT FROM p.owner_anchor->'reviewedProgramDataSha256'
 OR (q#>'{source,upgradeAuthority}' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(q#>'{source,upgradeAuthority}') IS DISTINCT FROM 'string' OR (q#>>'{source,upgradeAuthority}'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true))
 OR q#>>'{source,addressIndexCompleteness}' IS DISTINCT FROM 'configured-provider-trust' OR q#>>'{source,savedAnchorAuthority}' IS DISTINCT FROM 'private-application-reservation'
 OR (q->>'signature'~'^[1-9A-HJ-NP-Za-km-z]{64,88}$') IS DISTINCT FROM true OR (q->>'signedTransactionSha256'~'^[0-9a-f]{64}$') IS DISTINCT FROM true
 OR jsonb_typeof(q->'slot') IS DISTINCT FROM 'number' OR (q->>'slot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR jsonb_typeof(q->'finalizedThroughSlot') IS DISTINCT FROM 'number' OR (q->>'finalizedThroughSlot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR length(q->>'feeLamports')>20 OR length(q->>'assetRefundLamports')>20
 OR (q->>'feeLamports'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true OR (q->>'assetRefundLamports'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR (q->'blockTime' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(q->'blockTime') IS DISTINCT FROM 'number' OR (q->>'blockTime'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true OR (q->>'blockTime')::numeric>9007199254740991))
 OR jsonb_typeof(q->'history') IS DISTINCT FROM 'array' OR jsonb_array_length(q->'history')>2000
 OR c.asset_id IS DISTINCT FROM r.asset_id OR c.wallet IS DISTINCT FROM r.wallet OR c.signature IS DISTINCT FROM q->>'signature'
 OR c.signed_transaction_sha256 IS DISTINCT FROM q->>'signedTransactionSha256' OR c.original_message_sha256 IS DISTINCT FROM p.message_sha256 OR c.slot IS DISTINCT FROM (q->>'slot')::bigint THEN RETURN false;END IF;
 IF (q->>'slot')::numeric<=(q->>'anchorSlot')::numeric OR (q->>'finalizedThroughSlot')::numeric<(q->>'slot')::numeric OR (q->>'finalizedThroughSlot')::numeric>9007199254740991 THEN RETURN false;END IF;
 -- Identical fixed field order to vehicleServiceBurnMessage; all strings here
 -- are validated identifiers/enums/decimal integers, containing no whitespace.
 canonical:=regexp_replace(json_build_object('version',1,'operation',r.operation,'installationId',r.installation_id::text,'baseId',r.base_id::text,'berthId',r.berth_id::text,'revision',r.revision,'family',r.family,'tier',r.tier,'completedTotal',r.completed_total::text,'allowanceStart',r.allowance_start::text,'tierAfter',s->'tierAfter','revisionAfter',s->'revisionAfter','allowanceStartAfter',s->'allowanceStartAfter','remainingUses',s->'remainingUses')::text,'\s','','g');
 IF q->>'serviceSha256' IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex') THEN RETURN false;END IF;
 last_slot:=(q->>'anchorSlot')::numeric;
 FOR h IN SELECT value FROM jsonb_array_elements(q->'history') LOOP
  IF jsonb_typeof(h) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(h))<>4
  OR jsonb_typeof(h->'signature') IS DISTINCT FROM 'string' OR (h->>'signature'~'^[1-9A-HJ-NP-Za-km-z]{64,88}$') IS DISTINCT FROM true
  OR jsonb_typeof(h->'ownerAfter') IS DISTINCT FROM 'string' OR (h->>'ownerAfter'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
  OR jsonb_typeof(h->'slot') IS DISTINCT FROM 'number' OR (h->>'slot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
  OR jsonb_typeof(h->'transactionIndex') IS DISTINCT FROM 'number' OR (h->>'transactionIndex'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
  OR (h->>'slot')::numeric<=(q->>'anchorSlot')::numeric OR (h->>'slot')::numeric>(q->>'slot')::numeric
  OR (h->>'transactionIndex')::numeric>9007199254740991 OR (h->>'slot')::numeric<last_slot
  OR ((h->>'slot')::numeric=last_slot AND (h->>'transactionIndex')::numeric<=last_index)
  OR h->>'signature'=ANY(seen) THEN RETURN false;END IF;
  last_slot:=(h->>'slot')::numeric;last_index:=(h->>'transactionIndex')::numeric;seen:=array_append(seen,h->>'signature');
 END LOOP;RETURN true;
EXCEPTION WHEN data_exception OR no_data_found THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_lifecycle(wanted uuid)
RETURNS TABLE(installation_id uuid,base_id uuid,berth_id uuid,berth_completed_at timestamptz,family text,tier integer,revision bigint,completed_total bigint,allowance_start bigint,pending_intent_id uuid,away boolean)
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.advanced_vehicle_installations%ROWTYPE;r public.vehicle_activation_reservations%ROWTYPE;c public.vehicle_burn_consumptions%ROWTYPE;
 p public.vehicle_burn_preparations%ROWTYPE;a public.vehicle_service_applications%ROWTYPE;s public.vehicle_service_intents%ROWTYPE;sc public.vehicle_service_consumptions%ROWTYPE;n bigint;checkpoint bigint:=0;pending bigint;e record;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.advanced_vehicle_installations'::regclass) THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_READ_COMMITTED';END IF;
 SELECT * INTO i FROM public.advanced_vehicle_installations x WHERE x.reservation_id=wanted FOR UPDATE NOWAIT;IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO STRICT r FROM public.vehicle_activation_reservations WHERE id=i.reservation_id;
 SELECT * INTO STRICT c FROM public.vehicle_burn_consumptions WHERE reservation_id=r.id;
 SELECT * INTO STRICT p FROM public.vehicle_burn_preparations WHERE reservation_id=r.id;
 IF (i.asset_id,i.base_id,i.berth_id,i.family,i.tier,i.installed_wallet,i.completed_build_job_id,i.berth_completed_at) IS DISTINCT FROM (r.asset_id,r.base_id,r.berth_id,r.family,r.tier,r.wallet,r.completed_build_job_id,r.berth_completed_at)
 OR c.asset_id IS DISTINCT FROM r.asset_id OR c.wallet IS DISTINCT FROM r.wallet OR c.original_message_sha256 IS DISTINCT FROM p.message_sha256 OR p.message_sha256 IS DISTINCT FROM encode(sha256(p.message_bytes),'hex')
 OR c.proof->'identity' IS DISTINCT FROM p.plan->'identity' OR c.proof->>'reservationId' IS DISTINCT FROM r.id::text OR c.proof->>'wallet' IS DISTINCT FROM r.wallet OR c.proof->>'originalMessageSha256' IS DISTINCT FROM p.message_sha256
 OR c.proof->>'signature' IS DISTINCT FROM c.signature OR c.proof->>'signedTransactionSha256' IS DISTINCT FROM c.signed_transaction_sha256 OR c.proof->'version' IS DISTINCT FROM '1'::jsonb OR c.proof->'finalityVerified' IS DISTINCT FROM 'true'::jsonb OR c.proof->'preBurnOwnershipVerified' IS DISTINCT FROM 'true'::jsonb
 OR i.tier<1 THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_SOURCE';END IF;
 SELECT count(*) INTO n FROM public.advanced_expedition_returns ret JOIN public.advanced_expeditions x ON x.id=ret.expedition_id WHERE x.installation_id=wanted;
 IF EXISTS(SELECT 1 FROM (SELECT ret.completed_total,x.completed_before,row_number() OVER(ORDER BY ret.completed_total) ordinal FROM public.advanced_expedition_returns ret JOIN public.advanced_expeditions x ON x.id=ret.expedition_id WHERE x.installation_id=wanted) q WHERE q.completed_total<>q.ordinal OR q.completed_before<>q.ordinal-1) THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_RETURNS';END IF;
 installation_id:=i.reservation_id;base_id:=i.base_id;berth_id:=i.berth_id;berth_completed_at:=i.berth_completed_at;family:=i.family;tier:=i.tier;revision:=0;completed_total:=n;allowance_start:=0;away:=false;
 FOR a IN SELECT * FROM public.vehicle_service_applications x WHERE x.installation_id=wanted ORDER BY x.revision_after LOOP
  SELECT * INTO STRICT s FROM public.vehicle_service_intents WHERE id=a.intent_id;SELECT * INTO STRICT sc FROM public.vehicle_service_consumptions WHERE intent_id=a.intent_id;
  IF NOT public.shardkeep_vehicle_service_proof_valid_v214(sc) OR (s.installation_id,s.base_id,s.berth_id,s.family,s.tier,s.revision::bigint,s.allowance_start) IS DISTINCT FROM (installation_id,base_id,berth_id,family,tier,revision,allowance_start)
  OR s.completed_total<checkpoint OR s.completed_total>n OR s.allowance_start<0 OR s.completed_total<s.allowance_start
  OR (a.revision_after,a.tier_after,a.completed_total,a.allowance_start_after) IS DISTINCT FROM (revision+1,CASE WHEN s.operation='upgrade' THEN tier+1 ELSE tier END,s.completed_total,CASE WHEN s.operation='restore_uses' THEN s.completed_total ELSE allowance_start END)
  THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_APPLICATION';END IF;
  tier:=a.tier_after;revision:=a.revision_after;allowance_start:=a.allowance_start_after;checkpoint:=a.completed_total;
 END LOOP;
 IF allowance_start<0 OR n<allowance_start THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_USES';END IF;
 -- Discover every header: a missing return never silently becomes completion.
 FOR e IN SELECT x.*,ret.id return_id,ret.returned_at,(SELECT count(*) FROM public.advanced_expedition_inflight f WHERE f.expedition_id=x.id AND f.installation_id=wanted AND f.base_id=x.base_id) flight_count FROM public.advanced_expeditions x LEFT JOIN public.advanced_expedition_returns ret ON ret.expedition_id=x.id WHERE x.installation_id=wanted LOOP
  -- A header owns the vehicle immediately, before its flight/supply INSERTs.
  -- No return means away, never a completed use;0209's deferred guard still
  -- requires the complete flight graph at commit. Corrupt orphan headers hold.
  IF e.return_id IS NULL THEN away:=true;CONTINUE;END IF;
  IF e.base_id<>i.base_id OR e.route_snapshot->>'family' IS DISTINCT FROM i.family OR (e.route_snapshot->>'tier')::integer IS DISTINCT FROM coalesce((SELECT applied.tier_after FROM public.vehicle_service_applications applied WHERE applied.installation_id=wanted AND applied.completed_total<=e.completed_before ORDER BY applied.revision_after DESC LIMIT 1),i.tier) OR jsonb_typeof(e.route_snapshot->'supplies') IS DISTINCT FROM 'array'
  OR e.flight_count<>0 OR e.returned_at<e.returns_at
  OR (SELECT count(*) FROM public.advanced_expedition_supplies saved_supply WHERE saved_supply.expedition_id=e.id)<>jsonb_array_length(e.route_snapshot->'supplies') THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_RETURNS';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(e.route_snapshot->'supplies') item
   LEFT JOIN public.advanced_expedition_supplies supply ON supply.expedition_id=e.id AND supply.resource_id=item->>'resourceId'
   LEFT JOIN public.resource_stock_operations reserve ON reserve.id=supply.reserve_id
   LEFT JOIN public.resource_stock_operations consume ON consume.id=supply.consume_id
   WHERE (reserve.kind,reserve.reservation_id,consume.kind,consume.reservation_id,reserve.base_id,consume.base_id,reserve.custody_wallet,consume.custody_wallet,reserve.resource_id,consume.resource_id,reserve.quantity,consume.quantity)
    IS DISTINCT FROM ('reserve'::text,NULL::uuid,'consume'::text,reserve.id,e.base_id,e.base_id,e.actor_wallet,e.actor_wallet,item->>'resourceId',item->>'resourceId',(item->>'quantity')::bigint,(item->>'quantity')::bigint)
   OR (SELECT count(*) FROM public.resource_stock_entries en WHERE en.operation_id=reserve.id)<>2
   OR (SELECT count(*) FROM public.resource_stock_entries en WHERE en.operation_id=consume.id)<>2
   OR NOT EXISTS(SELECT 1 FROM public.resource_stock_entries WHERE operation_id=reserve.id AND bucket='available' AND delta=-reserve.quantity)
   OR NOT EXISTS(SELECT 1 FROM public.resource_stock_entries WHERE operation_id=reserve.id AND bucket='reserved' AND delta=reserve.quantity)
   OR NOT EXISTS(SELECT 1 FROM public.resource_stock_entries WHERE operation_id=consume.id AND bucket='reserved' AND delta=-consume.quantity)
   OR NOT EXISTS(SELECT 1 FROM public.resource_stock_entries WHERE operation_id=consume.id AND bucket='consumed' AND delta=consume.quantity)) THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_SUPPLIES';END IF;
  IF (SELECT count(*) FROM public.advanced_expedition_entries en WHERE en.return_id=e.return_id)<>3 OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_entries WHERE return_id=e.return_id AND bucket='issued' AND delta=-e.gross) OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_entries WHERE return_id=e.return_id AND bucket='base_stock' AND delta=e.net) OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_entries WHERE return_id=e.return_id AND bucket='island_pool' AND delta=e.tax) THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_RETURNS';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.vehicle_service_applications applied JOIN public.vehicle_service_intents reserved ON reserved.id=applied.intent_id WHERE reserved.installation_id=wanted AND applied.installation_id<>wanted) THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_APPLICATION';END IF;
 SELECT count(*),min(reserved.id::text)::uuid INTO pending,pending_intent_id FROM public.vehicle_service_intents reserved WHERE reserved.installation_id=wanted AND NOT EXISTS(SELECT 1 FROM public.vehicle_service_applications applied WHERE applied.intent_id=reserved.id);
 IF pending>1 THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_PENDING';END IF;
 IF pending=1 THEN SELECT * INTO STRICT s FROM public.vehicle_service_intents WHERE id=pending_intent_id;
  IF (s.base_id,s.berth_id,s.family,s.tier,s.revision::bigint,s.completed_total,s.allowance_start) IS DISTINCT FROM (base_id,berth_id,family,tier,revision,n,allowance_start) OR away THEN RAISE EXCEPTION 'VEHICLE_LIFECYCLE_PENDING';END IF;
 END IF;RETURN NEXT;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_application_guard_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_service_intents%ROWTYPE;p public.vehicle_service_burn_preparations%ROWTYPE;c public.vehicle_service_consumptions%ROWTYPE;l record;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_service_consumptions'::regclass,'public.vehicle_service_applications'::regclass) OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END) OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_READ_COMMITTED';END IF;
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=NEW.intent_id;
 SELECT * INTO STRICT l FROM public.shardkeep_vehicle_lifecycle(r.installation_id);
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=NEW.intent_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT p FROM public.vehicle_service_burn_preparations WHERE intent_id=r.id FOR UPDATE NOWAIT;
 IF l.pending_intent_id IS DISTINCT FROM r.id OR l.away OR (r.base_id,r.berth_id,r.family,r.tier,r.revision::bigint,r.completed_total,r.allowance_start) IS DISTINCT FROM (l.base_id,l.berth_id,l.family,l.tier,l.revision,l.completed_total,l.allowance_start) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_STATE';END IF;
 IF TG_TABLE_NAME='vehicle_service_consumptions' THEN
  IF NEW.asset_id IS NOT NULL OR NEW.wallet IS NOT NULL OR NEW.signature IS NOT NULL OR NEW.signed_transaction_sha256 IS NOT NULL OR NEW.original_message_sha256 IS NOT NULL OR NEW.slot IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_DERIVED';END IF;
  NEW.asset_id:=r.asset_id;NEW.wallet:=r.wallet;NEW.signature:=NEW.proof->>'signature';NEW.signed_transaction_sha256:=NEW.proof->>'signedTransactionSha256';NEW.original_message_sha256:=p.message_sha256;NEW.slot:=(NEW.proof->>'slot')::bigint;NEW.recorded_at:=clock_timestamp();
  IF NOT public.shardkeep_vehicle_service_proof_valid_v214(NEW) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_SOURCE';END IF;
 ELSE
  IF NEW.installation_id IS NOT NULL OR NEW.revision_after IS NOT NULL OR NEW.tier_after IS NOT NULL OR NEW.completed_total IS NOT NULL OR NEW.allowance_start_after IS NOT NULL OR NEW.applied_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_DERIVED';END IF;
  SELECT * INTO STRICT c FROM public.vehicle_service_consumptions WHERE intent_id=r.id;
  IF NOT public.shardkeep_vehicle_service_proof_valid_v214(c) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_SOURCE';END IF;
  NEW.installation_id:=r.installation_id;NEW.revision_after:=r.revision::bigint+1;NEW.tier_after:=CASE WHEN r.operation='upgrade' THEN r.tier+1 ELSE r.tier END;NEW.completed_total:=r.completed_total;NEW.allowance_start_after:=CASE WHEN r.operation='restore_uses' THEN r.completed_total ELSE r.allowance_start END;NEW.applied_at:=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_application_complete_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted uuid;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_service_consumptions'::regclass,'public.vehicle_service_applications'::regclass) OR TG_NAME<>(TG_TABLE_NAME||'_complete') OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_TRIGGER';END IF;
 SELECT a.installation_id INTO wanted FROM public.vehicle_service_applications a JOIN public.vehicle_service_consumptions c USING(intent_id) WHERE a.intent_id=NEW.intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_SERVICE_APPLICATION_INCOMPLETE';END IF;
 PERFORM 1 FROM public.shardkeep_vehicle_lifecycle(wanted);RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_consumption_fence_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k bigint;duplicate boolean;
BEGIN
 IF TG_RELID NOT IN('public.vehicle_burn_consumptions'::regclass,'public.vehicle_service_consumptions'::regclass) OR TG_NAME<>(TG_TABLE_NAME||'_cross_consumption') OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_CONSUMPTION_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_CONSUMPTION_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_CONSUMPTION_READ_COMMITTED';END IF;
 FOR k IN SELECT DISTINCT hashtextextended(v,0) FROM unnest(ARRAY['vehicle-consumption:asset:'||NEW.asset_id,'vehicle-consumption:signature:'||NEW.signature,'vehicle-consumption:wire:'||NEW.signed_transaction_sha256]) v ORDER BY 1 LOOP
  IF NOT pg_try_advisory_xact_lock(k) THEN RAISE EXCEPTION 'VEHICLE_CONSUMPTION_BUSY' USING ERRCODE='55P03';END IF;
 END LOOP;
 -- Separate query after locks: READ COMMITTED observes the committed winner.
 IF TG_TABLE_NAME='vehicle_burn_consumptions' THEN SELECT EXISTS(SELECT 1 FROM public.vehicle_service_consumptions c WHERE c.asset_id=NEW.asset_id OR c.signature=NEW.signature OR c.signed_transaction_sha256=NEW.signed_transaction_sha256) INTO duplicate;
 ELSE SELECT EXISTS(SELECT 1 FROM public.vehicle_burn_consumptions c WHERE c.asset_id=NEW.asset_id OR c.signature=NEW.signature OR c.signed_transaction_sha256=NEW.signed_transaction_sha256) INTO duplicate;END IF;
 IF duplicate THEN RAISE EXCEPTION 'VEHICLE_CONSUMPTION_DUPLICATE' USING ERRCODE='23505';END IF;RETURN NULL;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_intent_guard_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.advanced_vehicle_installations%ROWTYPE;m public.vehicle_mint_registry%ROWTYPE;b public.bases%ROWTYPE;n bigint;l record;
BEGIN
 IF TG_RELID<>'public.vehicle_service_intents'::regclass OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_SERVICE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_READ_COMMITTED';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_IMMUTABLE';END IF;
 IF NEW.base_id IS NOT NULL OR NEW.berth_id IS NOT NULL OR NEW.family IS NOT NULL OR NEW.tier IS NOT NULL OR NEW.revision IS NOT NULL OR NEW.completed_total IS NOT NULL OR NEW.allowance_start IS NOT NULL OR NEW.reserved_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_DERIVED';END IF;
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE NOWAIT;
 SELECT * INTO STRICT i FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id;
 SELECT * INTO STRICT b FROM public.bases WHERE id=i.base_id FOR UPDATE NOWAIT;
 IF b.owner_wallet<>NEW.wallet OR b.status<>'active' OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_BASE';END IF;
 PERFORM 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=b.id) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_BASE';END IF;
 SELECT * INTO STRICT i FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT m FROM public.vehicle_mint_registry WHERE asset_id=NEW.asset_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT l FROM public.shardkeep_vehicle_lifecycle(i.reservation_id);
 IF m.family<>l.family OR m.tier<>l.tier THEN RAISE EXCEPTION 'VEHICLE_SERVICE_IDENTITY';END IF;
 IF EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE asset_id=m.asset_id)
 OR EXISTS(SELECT 1 FROM public.vehicle_service_intents WHERE asset_id=m.asset_id OR (installation_id=i.reservation_id AND NOT EXISTS(SELECT 1 FROM public.vehicle_service_applications a WHERE a.intent_id=vehicle_service_intents.id))) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_RESERVED';END IF;
 -- Header-first raw SQL must not hide an obligation by delaying its flight row.
 IF EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE installation_id=i.reservation_id)
 OR EXISTS(SELECT 1 FROM public.advanced_expeditions e WHERE e.installation_id=i.reservation_id AND NOT EXISTS(SELECT 1 FROM public.advanced_expedition_returns r WHERE r.expedition_id=e.id)) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_AWAY';END IF;
 SELECT count(*) INTO n FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id WHERE e.installation_id=i.reservation_id;
 NEW.base_id:=i.base_id;NEW.berth_id:=i.berth_id;NEW.family:=i.family;NEW.tier:=l.tier;NEW.revision:=l.revision;NEW.completed_total:=l.completed_total;NEW.allowance_start:=l.allowance_start;NEW.reserved_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_departure_exclusion_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l record;
BEGIN
 IF TG_RELID<>'public.advanced_expeditions'::regclass OR TG_NAME<>'advanced_vehicle_service_exclusion' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_TRIGGER';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_READ_COMMITTED';END IF;
 PERFORM 1 FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT l FROM public.shardkeep_vehicle_lifecycle(NEW.installation_id);
 IF l.pending_intent_id IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_RESERVED';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_vehicle_service_preparation_guard_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.vehicle_service_intents%ROWTYPE;i public.advanced_vehicle_installations%ROWTYPE;
 m public.vehicle_mint_registry%ROWTYPE;identity jsonb;state jsonb;a jsonb;n bigint;l record;
BEGIN
 IF TG_RELID<>'public.vehicle_service_burn_preparations'::regclass OR TG_NAME<>(CASE WHEN TG_OP='TRUNCATE' THEN 'vehicle_service_burn_preparations_no_truncate' ELSE 'vehicle_service_burn_preparations_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_READ_COMMITTED';END IF;
 IF NEW.wallet IS NOT NULL OR NEW.message_sha256 IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_DERIVED';END IF;
 -- Discover immutable parent, then serialize in installation -> intent order.
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=NEW.intent_id;
 SELECT * INTO STRICT i FROM public.advanced_vehicle_installations WHERE reservation_id=r.installation_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT r FROM public.vehicle_service_intents WHERE id=NEW.intent_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT l FROM public.shardkeep_vehicle_lifecycle(r.installation_id);
 IF (r.base_id,r.berth_id,r.family,r.tier,r.revision::bigint,r.completed_total,r.allowance_start) IS DISTINCT FROM (l.base_id,l.berth_id,l.family,l.tier,l.revision,l.completed_total,l.allowance_start)
 OR l.pending_intent_id IS DISTINCT FROM r.id OR l.away OR r.asset_id=i.asset_id OR EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE asset_id=r.asset_id) THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_STATE';END IF;
 SELECT * INTO STRICT m FROM public.vehicle_mint_registry WHERE asset_id=r.asset_id;
 IF m.family IS DISTINCT FROM r.family OR m.tier IS DISTINCT FROM r.tier THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 state:=jsonb_build_object('operation',r.operation,'installationId',r.installation_id::text,'baseId',r.base_id::text,'berthId',r.berth_id::text,'revision',r.revision,'family',r.family,'tier',r.tier,'completedTotal',r.completed_total::text,'allowanceStart',r.allowance_start::text);
 identity:=jsonb_build_object('assetId',r.asset_id,'collection',m.collection,'family',r.family,'tier',r.tier);a:=NEW.owner_anchor;
 IF jsonb_typeof(NEW.plan) IS DISTINCT FROM 'object' OR octet_length(NEW.plan::text)>4096 OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR octet_length(a::text)>266240 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 IF NEW.plan IS DISTINCT FROM jsonb_build_object('wallet',r.wallet,'reservationId',r.id::text,'identity',identity,'blockhash',NEW.plan->>'blockhash','service',state)
 OR (NEW.plan->>'blockhash'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_object_keys(a))<>9
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k<>ALL(ARRAY['version','wallet','identity','slot','genesisHash','reviewedDeploymentSlot','reviewedProgramDataSha256','assetDataHex','collectionDataHex']))
 OR a->'version' IS DISTINCT FROM '1'::jsonb OR a->>'wallet' IS DISTINCT FROM r.wallet OR a->'identity' IS DISTINCT FROM identity
 OR jsonb_typeof(a->'slot') IS DISTINCT FROM 'number' OR (a->>'slot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR jsonb_typeof(a->'reviewedDeploymentSlot') IS DISTINCT FROM 'number' OR (a->>'reviewedDeploymentSlot'~'^(0|[1-9][0-9]*)$') IS DISTINCT FROM true
 OR (a->>'genesisHash'~'^[1-9A-HJ-NP-Za-km-z]{32,44}$') IS DISTINCT FROM true
 OR (a->>'reviewedProgramDataSha256'~'^[0-9a-f]{64}$') IS DISTINCT FROM true
 OR (a->>'assetDataHex'~'^([0-9a-f]{2})+$') IS DISTINCT FROM true OR length(a->>'assetDataHex')>131072
 OR (a->>'collectionDataHex'~'^([0-9a-f]{2})+$') IS DISTINCT FROM true OR length(a->>'collectionDataHex')>131072
 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 IF (a->>'slot')::numeric>NEW.blockhash_context_slot OR (a->>'reviewedDeploymentSlot')::numeric>(a->>'slot')::numeric OR (a->>'slot')::numeric>9007199254740991 THEN RAISE EXCEPTION 'VEHICLE_SERVICE_PREPARATION_SOURCE';END IF;
 NEW.wallet:=r.wallet;NEW.message_sha256:=encode(sha256(NEW.message_bytes),'hex');NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_advanced_expedition_guard_v214() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE lifecycle record;trip public.advanced_expeditions%ROWTYPE;inst public.advanced_vehicle_installations%ROWTYPE;eid uuid;n bigint;custody text;
BEGIN
 IF TG_RELID NOT IN ('public.advanced_expeditions'::regclass,'public.advanced_expedition_inflight'::regclass,'public.advanced_expedition_returns'::regclass,'public.advanced_expedition_entries'::regclass,'public.advanced_expedition_supplies'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END) OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'ADVANCED_TRIGGER_IDENTITY';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'ADVANCED_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ADVANCED_READ_COMMITTED';END IF;
 IF TG_OP<>'INSERT' AND NOT(TG_OP='DELETE' AND TG_TABLE_NAME='advanced_expedition_inflight') THEN RAISE EXCEPTION 'ADVANCED_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='advanced_expeditions' THEN
  SELECT * INTO STRICT inst FROM public.advanced_vehicle_installations WHERE reservation_id=NEW.installation_id FOR UPDATE NOWAIT;
  SELECT * INTO STRICT lifecycle FROM public.shardkeep_vehicle_lifecycle(NEW.installation_id);
  IF lifecycle.away OR lifecycle.pending_intent_id IS NOT NULL THEN RAISE EXCEPTION 'ADVANCED_EXPEDITION_SOURCE';END IF;
  SELECT count(*) INTO n FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id WHERE e.installation_id=inst.reservation_id;
  IF NEW.completed_before IS NOT NULL AND NEW.completed_before<>n THEN RAISE EXCEPTION 'ADVANCED_COUNTER';END IF;NEW.completed_before:=n;
  IF jsonb_typeof(NEW.route_snapshot->'supplies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'ADVANCED_SUPPLY';END IF;
  IF jsonb_array_length(NEW.route_snapshot->'supplies')<>(SELECT count(DISTINCT s->>'resourceId') FROM jsonb_array_elements(NEW.route_snapshot->'supplies') s) THEN RAISE EXCEPTION 'ADVANCED_SUPPLY';END IF;
  IF inst.base_id<>NEW.base_id OR EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE base_id=NEW.base_id)
  OR NOT EXISTS(SELECT 1 FROM public.bases b JOIN public.base_slots s ON s.base_id=b.id WHERE b.id=NEW.base_id AND b.owner_wallet=NEW.actor_wallet AND b.status='active' AND s.wallet=NEW.actor_wallet AND s.active)
  OR NOT EXISTS(SELECT 1 FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash AND starts_at<=NEW.departed_at AND NEW.departed_at<ends_at)
  OR (NEW.route_snapshot->>'family'=inst.family AND (NEW.route_snapshot->>'tier')::integer=lifecycle.tier
   AND NEW.home_evidence->>'baseId'=NEW.base_id::text AND NEW.home_evidence->>'custodyWallet'=NEW.actor_wallet
   AND NEW.route_snapshot->>'routeId'=NEW.route_id AND (NEW.route_snapshot->>'policyVersion')::integer=NEW.policy_version
   AND NEW.route_snapshot->>'resourceId'=NEW.resource_id AND (NEW.route_snapshot->>'grossQuantity')::bigint=NEW.gross
   AND (NEW.route_snapshot->>'netQuantity')::bigint=NEW.net AND (NEW.route_snapshot->>'islandPoolQuantity')::bigint=NEW.tax
   AND NEW.returns_at-NEW.departed_at=(NEW.route_snapshot->>'durationSec')::bigint*interval '1 second'
   AND NEW.finality->>'commitment'='finalized' AND (NEW.finality->>'observedAt')::timestamptz<=NEW.departed_at) IS NOT TRUE
  THEN RAISE EXCEPTION 'ADVANCED_SOURCE';END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='advanced_expedition_entries' THEN SELECT expedition_id INTO STRICT eid FROM public.advanced_expedition_returns WHERE id=NEW.return_id;
 ELSIF TG_OP='DELETE' THEN eid:=OLD.expedition_id;ELSE eid:=NEW.expedition_id;END IF;
 SELECT * INTO STRICT trip FROM public.advanced_expeditions WHERE id=eid;
 SELECT * INTO STRICT inst FROM public.advanced_vehicle_installations WHERE reservation_id=trip.installation_id FOR UPDATE NOWAIT;
 IF TG_TABLE_NAME='advanced_expedition_returns' THEN
  SELECT owner_wallet INTO STRICT custody FROM public.bases WHERE id=trip.base_id FOR UPDATE NOWAIT;
  SELECT count(*)+1 INTO n FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id=r.expedition_id WHERE e.installation_id=trip.installation_id;
  IF (NEW.completed_total IS NOT NULL AND NEW.completed_total<>n) OR n<>trip.completed_before+1 OR NEW.custody_wallet<>custody OR NEW.returned_at<trip.returns_at
  OR NOT EXISTS(SELECT 1 FROM public.advanced_expedition_inflight WHERE expedition_id=trip.id AND installation_id=trip.installation_id) THEN RAISE EXCEPTION 'ADVANCED_RETURN';END IF;
  NEW.completed_total:=n;
 ELSIF TG_TABLE_NAME='advanced_expedition_inflight' THEN
  IF TG_OP='DELETE' THEN IF NOT EXISTS(SELECT 1 FROM public.advanced_expedition_returns WHERE expedition_id=trip.id) THEN RAISE EXCEPTION 'ADVANCED_RETURN_REQUIRED';END IF;RETURN OLD;END IF;
  IF NEW.installation_id<>trip.installation_id OR NEW.base_id<>trip.base_id THEN RAISE EXCEPTION 'ADVANCED_FLIGHT';END IF;
 ELSIF TG_TABLE_NAME='advanced_expedition_supplies' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(trip.route_snapshot->'supplies') s JOIN public.resource_stock_operations r ON r.id=NEW.reserve_id
   JOIN public.resource_stock_operations c ON c.id=NEW.consume_id WHERE s->>'resourceId'=NEW.resource_id AND r.kind='reserve' AND r.reservation_id IS NULL
   AND c.kind='consume' AND c.reservation_id=r.id AND r.base_id=trip.base_id AND c.base_id=trip.base_id AND r.custody_wallet=trip.actor_wallet AND c.custody_wallet=trip.actor_wallet
   AND r.resource_id=NEW.resource_id AND c.resource_id=NEW.resource_id AND r.quantity=(s->>'quantity')::bigint AND c.quantity=r.quantity)
  THEN RAISE EXCEPTION 'ADVANCED_SUPPLY';END IF;
 END IF;RETURN NEW;
END $$;

--> statement-breakpoint
DO $migration$ DECLARE t text;fn text;BEGIN
 FOREACH t IN ARRAY ARRAY['vehicle_service_consumptions','vehicle_service_applications'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_service_application_guard_v214()',t||'_guard',t);
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_vehicle_service_application_guard_v214()',t||'_no_truncate',t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_service_application_complete_v214()',t||'_complete',t);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['vehicle_burn_consumptions','vehicle_service_consumptions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_cross_consumption') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_consumption_fence_v214()',t||'_cross_consumption',t);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies','vehicle_service_intents','vehicle_service_burn_preparations'] LOOP
  fn:=CASE t WHEN 'vehicle_service_intents' THEN 'shardkeep_vehicle_service_intent_guard_v214' WHEN 'vehicle_service_burn_preparations' THEN 'shardkeep_vehicle_service_preparation_guard_v214' ELSE 'shardkeep_advanced_expedition_guard_v214' END;
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',t||'_guard',t);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',t||'_no_truncate',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',t||'_guard',t,fn);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.%I()',t||'_no_truncate',t,fn);
 END LOOP;
 DROP TRIGGER IF EXISTS advanced_vehicle_service_exclusion ON public.advanced_expeditions;
 CREATE TRIGGER advanced_vehicle_service_exclusion BEFORE INSERT ON public.advanced_expeditions FOR EACH ROW EXECUTE FUNCTION public.shardkeep_vehicle_service_departure_exclusion_v214();
END $migration$;
REVOKE ALL ON public.vehicle_service_consumptions,public.vehicle_service_applications FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shardkeep_vehicle_service_state_v214(public.vehicle_service_intents),public.shardkeep_vehicle_service_effect_v214(public.vehicle_service_intents,bigint),public.shardkeep_vehicle_service_proof_valid_v214(public.vehicle_service_consumptions),public.shardkeep_vehicle_lifecycle(uuid),public.shardkeep_vehicle_service_application_guard_v214(),public.shardkeep_vehicle_service_application_complete_v214(),public.shardkeep_vehicle_consumption_fence_v214(),public.shardkeep_vehicle_service_intent_guard_v214(),public.shardkeep_vehicle_service_departure_exclusion_v214(),public.shardkeep_vehicle_service_preparation_guard_v214(),public.shardkeep_advanced_expedition_guard_v214() FROM PUBLIC;
