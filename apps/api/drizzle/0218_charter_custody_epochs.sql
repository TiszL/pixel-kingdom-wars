-- D-153.155 prospective trusted DB custody, not continuous chain proof.
-- S5-held source hooks require RC before enrollment visibility. No backfill,
-- money, issuer or live application. Base deletion must not erase history.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.charter_custody_sources (
 base_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,wallet text NOT NULL,
 freshness_ms integer NOT NULL CHECK(freshness_ms>0),recorded_at timestamptz NOT NULL,
 evidence jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_custody_epochs (
 id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES public.charter_custody_sources(id),
 base_id uuid NOT NULL,deed_asset_id text NOT NULL,owner_wallet text NOT NULL,
 ordinal bigint NOT NULL CHECK(ordinal>0),predecessor_id uuid REFERENCES public.charter_custody_epochs(id),
 kind text NOT NULL CHECK(kind IN('observed','invalidated')),evidence jsonb NOT NULL,
 evidence_commitment text NOT NULL CHECK(evidence_commitment~'^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),UNIQUE(base_id,ordinal),
 CHECK((ordinal=1)=(predecessor_id IS NULL))
);
CREATE TABLE IF NOT EXISTS public.charter_custody_heads (
 base_id uuid PRIMARY KEY,epoch_id uuid NOT NULL REFERENCES public.charter_custody_epochs(id),
 ordinal bigint NOT NULL CHECK(ordinal>0),floor_asset text NOT NULL,
 floor_slot bigint NOT NULL CHECK(floor_slot BETWEEN 0 AND 9007199254740991),floor_owner text NOT NULL,floor_eligible boolean NOT NULL,
 base_state jsonb NOT NULL,observation_state jsonb NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_custody_sources'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_READ_COMMITTED';END IF;
END $$;
--> statement-breakpoint
-- Compute transitions from the protected previous source and the actual current
-- rows. Caller JSON and trigger nesting are never custody-transition authority.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_transition(bid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.bases%ROWTYPE;o public.deed_ownership_observations%ROWTYPE;h public.charter_custody_heads%ROWTYPE;e public.charter_custody_epochs%ROWTYPE;s public.charter_custody_sources%ROWTYPE;
 bs jsonb;os jsonb;t jsonb;k text;v jsonb;d text;w text;deleted boolean;
BEGIN
 SELECT * INTO STRICT s FROM public.charter_custody_sources WHERE base_id=bid;
 SELECT * INTO b FROM public.bases WHERE id=bid;
 SELECT * INTO o FROM public.deed_ownership_observations WHERE base_id=bid ORDER BY checked_at DESC,id DESC LIMIT 1;
 SELECT * INTO h FROM public.charter_custody_heads WHERE base_id=bid;
 bs:=CASE WHEN b.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',b.id,'owner_wallet',b.owner_wallet,'deed_asset_id',b.deed_asset_id,'deed_mint_asset_id',b.deed_mint_asset_id) END;
 os:=CASE WHEN o.id IS NULL THEN 'null'::jsonb ELSE to_jsonb(o) END;
 IF h.epoch_id IS NULL THEN
  IF s.evidence->'observation' IS DISTINCT FROM os OR s.evidence->'base'->>'id' IS DISTINCT FROM bid::text
  OR s.wallet IS DISTINCT FROM b.owner_wallet OR NOT public.shardkeep_charter_custody_proof(o)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
  RETURN jsonb_build_object('base_state',bs,'observation_state',os,'floor_asset',o.asset_id,'floor_slot',o.slot,'floor_owner',o.owner,'floor_eligible',true,
   'kind','observed','evidence',s.evidence,'deed',o.asset_id,'owner',s.wallet);
 END IF;
 SELECT * INTO STRICT e FROM public.charter_custody_epochs WHERE id=h.epoch_id;
 t:=jsonb_build_object('base_state',bs,'observation_state',os,'floor_asset',h.floor_asset,'floor_slot',h.floor_slot,'floor_owner',h.floor_owner,'floor_eligible',h.floor_eligible);
 d:=e.deed_asset_id;w:=e.owner_wallet;
 deleted:=h.observation_state<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.deed_ownership_observations WHERE id=(h.observation_state->>'id')::bigint AND base_id=bid);
 IF deleted THEN
  k:='invalidated';v:=jsonb_build_object('reason','observation_deleted','base',bs,'observation',h.observation_state);
 ELSIF os IS DISTINCT FROM h.observation_state AND o.status<>'unavailable' THEN
  IF NOT public.shardkeep_charter_custody_proof(o) OR o.asset_id IS DISTINCT FROM b.deed_asset_id
  OR(h.floor_asset=o.asset_id AND(o.slot<h.floor_slot OR(o.slot=h.floor_slot AND(o.owner<>h.floor_owner OR(o.status<>'ineligible')<>h.floor_eligible))))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
  t:=t||jsonb_build_object('floor_asset',o.asset_id,'floor_slot',o.slot,'floor_owner',o.owner,'floor_eligible',o.status<>'ineligible');
  IF e.owner_wallet<>o.owner OR e.deed_asset_id<>o.asset_id OR e.kind<>(CASE WHEN o.status='ineligible' THEN 'invalidated' ELSE 'observed' END) THEN
   IF o.checked_at>clock_timestamp() OR clock_timestamp()-o.checked_at>s.freshness_ms*interval '1 millisecond' THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
   k:=CASE WHEN o.status='ineligible' THEN 'invalidated' ELSE 'observed' END;d:=o.asset_id;w:=o.owner;
   v:=jsonb_build_object('reason','observation','base',bs,'observation',os);
  END IF;
 END IF;
 IF bs IS DISTINCT FROM h.base_state THEN
  IF NOT coalesce(b.id IS NOT NULL AND b.owner_wallet=e.owner_wallet AND b.deed_asset_id=e.deed_asset_id AND e.kind='observed'
   AND bs->'deed_asset_id' IS NOT DISTINCT FROM h.base_state->'deed_asset_id' AND bs->'deed_mint_asset_id' IS NOT DISTINCT FROM h.base_state->'deed_mint_asset_id'
   AND public.shardkeep_charter_custody_proof(o) AND o.status IN('owned','mismatch') AND o.owner=e.owner_wallet AND o.asset_id=e.deed_asset_id,false) THEN
   k:='invalidated';d:=e.deed_asset_id;w:=e.owner_wallet;v:=jsonb_build_object('reason','base_identity','before',h.base_state,'after',bs,'observation',os);
  END IF;
 END IF;
 RETURN t||jsonb_build_object('kind',k,'evidence',v,'deed',d,'owner',w);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.bases%ROWTYPE;o public.deed_ownership_observations%ROWTYPE;h public.charter_custody_heads%ROWTYPE;e public.charter_custody_epochs%ROWTYPE;t jsonb;bid uuid;
BEGIN
 IF TG_RELID NOT IN('public.charter_custody_sources'::regclass,'public.charter_custody_epochs'::regclass,'public.charter_custody_heads'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END) OR TG_WHEN<>'BEFORE'
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_TRIGGER';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') OR(TG_OP='UPDATE' AND TG_TABLE_NAME<>'charter_custody_heads') THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_custody_owner();
 IF NOT public.shardkeep_charter_custody_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_HELD';END IF;
 IF TG_TABLE_NAME='charter_custody_sources' THEN
  PERFORM wallet FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
  SELECT * INTO b FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
  PERFORM base_id FROM public.base_slots WHERE base_id=NEW.base_id FOR UPDATE;
  SELECT * INTO o FROM public.deed_ownership_observations WHERE base_id=NEW.base_id ORDER BY checked_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF b.id IS NULL OR b.owner_wallet<>NEW.wallet OR b.deed_asset_id IS NULL OR b.land_paid_at IS NULL OR b.status<>'active'
  OR NOT EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=b.id AND wallet=NEW.wallet AND active)
  OR NOT public.shardkeep_charter_custody_proof(o) OR o.status<>'owned' OR o.owner<>NEW.wallet OR o.asset_id<>b.deed_asset_id
  OR NEW.freshness_ms<=0 OR o.checked_at>clock_timestamp() OR clock_timestamp()-o.checked_at>NEW.freshness_ms*interval '1 millisecond'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_UNAVAILABLE';END IF;
  NEW.id:=gen_random_uuid();NEW.recorded_at:=clock_timestamp();
  NEW.evidence:=jsonb_build_object('reason','enrollment','base',to_jsonb(b),'observation',to_jsonb(o));RETURN NEW;
 END IF;
 IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_ORIGIN' USING ERRCODE='42501';END IF;
 bid:=NEW.base_id;
 SELECT * INTO h FROM public.charter_custody_heads WHERE base_id=bid FOR UPDATE;
 t:=public.shardkeep_charter_custody_transition(bid);
 IF TG_TABLE_NAME='charter_custody_epochs' THEN
  IF t->>'kind' IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
  NEW.id:=gen_random_uuid();SELECT id INTO STRICT NEW.source_id FROM public.charter_custody_sources WHERE base_id=bid;
  NEW.ordinal:=coalesce(h.ordinal,0)+1;NEW.predecessor_id:=h.epoch_id;
  NEW.kind:=t->>'kind';NEW.deed_asset_id:=t->>'deed';NEW.owner_wallet:=t->>'owner';NEW.evidence:=t->'evidence';
  NEW.recorded_at:=clock_timestamp();NEW.evidence_commitment:=public.shardkeep_charter_custody_commit(NEW);
  RETURN NEW;
 END IF;
 SELECT * INTO e FROM public.charter_custody_epochs WHERE id=NEW.epoch_id;
 IF e.id IS NULL OR e.base_id<>bid OR e.ordinal<>NEW.ordinal
 OR(TG_OP='UPDATE' AND NEW.base_id<>OLD.base_id)
 OR (t->>'kind' IS NULL AND(NEW.epoch_id IS DISTINCT FROM h.epoch_id OR NEW.ordinal IS DISTINCT FROM h.ordinal))
 OR (t->>'kind' IS NOT NULL AND(e.ordinal<>coalesce(h.ordinal,0)+1 OR e.predecessor_id IS DISTINCT FROM h.epoch_id
  OR e.kind IS DISTINCT FROM t->>'kind' OR e.owner_wallet IS DISTINCT FROM t->>'owner' OR e.deed_asset_id IS DISTINCT FROM t->>'deed'
  OR e.evidence IS DISTINCT FROM t->'evidence' OR e.evidence_commitment<>public.shardkeep_charter_custody_commit(e)))
 OR NEW.base_state IS DISTINCT FROM t->'base_state' OR NEW.observation_state IS DISTINCT FROM t->'observation_state'
 OR NEW.floor_asset IS DISTINCT FROM t->>'floor_asset' OR NEW.floor_slot IS DISTINCT FROM (t->>'floor_slot')::bigint
 OR NEW.floor_owner IS DISTINCT FROM t->>'floor_owner' OR NEW.floor_eligible IS DISTINCT FROM (t->>'floor_eligible')::boolean
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_advance(bid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE h public.charter_custody_heads%ROWTYPE;e public.charter_custody_epochs%ROWTYPE;t jsonb;
BEGIN
 PERFORM public.shardkeep_charter_custody_owner();
 IF pg_trigger_depth()<>1 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_ORIGIN' USING ERRCODE='42501';END IF;
 PERFORM id FROM public.bases WHERE id=bid FOR UPDATE NOWAIT;
 SELECT * INTO h FROM public.charter_custody_heads WHERE base_id=bid FOR UPDATE;
 IF FOUND THEN PERFORM public.shardkeep_charter_custody_graph(bid);END IF;
 t:=public.shardkeep_charter_custody_transition(bid);
 IF t->>'kind' IS NOT NULL THEN
  -- The BEFORE guard derives every private field from the same protected source.
  INSERT INTO public.charter_custody_epochs(base_id) VALUES(bid) RETURNING * INTO e;
 ELSE SELECT * INTO STRICT e FROM public.charter_custody_epochs WHERE id=h.epoch_id;END IF;
 INSERT INTO public.charter_custody_heads(base_id,epoch_id,ordinal,floor_asset,floor_slot,floor_owner,floor_eligible,base_state,observation_state)
 VALUES(bid,e.id,e.ordinal,t->>'floor_asset',(t->>'floor_slot')::bigint,t->>'floor_owner',(t->>'floor_eligible')::boolean,t->'base_state',t->'observation_state')
 ON CONFLICT(base_id) DO UPDATE SET epoch_id=EXCLUDED.epoch_id,ordinal=EXCLUDED.ordinal,floor_asset=EXCLUDED.floor_asset,
 floor_slot=EXCLUDED.floor_slot,floor_owner=EXCLUDED.floor_owner,floor_eligible=EXCLUDED.floor_eligible,base_state=EXCLUDED.base_state,observation_state=EXCLUDED.observation_state;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 IF TG_RELID<>'public.charter_custody_sources'::regclass OR TG_NAME<>'charter_custody_sources_capture' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_custody_advance(NEW.base_id);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_commit(e public.charter_custody_epochs) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to((to_jsonb(e)-'evidence_commitment')::text,'UTF8')),'hex')
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_proof(o public.deed_ownership_observations) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT coalesce(o.id IS NOT NULL AND o.asset_id~'^[1-9A-HJ-NP-Za-km-z]{32,44}$'
 AND o.owner~'^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND o.owner<>'11111111111111111111111111111111'
 AND o.slot BETWEEN 0 AND 9007199254740991 AND o.status IN('owned','mismatch','ineligible')
 AND length(o.source) BETWEEN 1 AND 128 AND isfinite(o.checked_at) AND o.checked_at=date_trunc('milliseconds',o.checked_at)
 AND o.audit_hash=encode(sha256(convert_to(o.asset_id,'UTF8')||decode('00','hex')||convert_to(o.owner,'UTF8')||decode('00','hex')
 ||convert_to(o.status::text,'UTF8')||decode('00','hex')||convert_to(o.slot::text,'UTF8')||decode('00','hex')
 ||convert_to(to_char(o.checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'UTF8')),'hex'),false)
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_hooks() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM (VALUES
 ('bases','bases_charter_custody','shardkeep_charter_custody_base()',29),
 ('deed_ownership_observations','deed_observations_charter_custody','shardkeep_charter_custody_observation()',29),
 ('bases','bases_charter_custody_no_truncate','shardkeep_charter_custody_truncate()',34),
 ('deed_ownership_observations','deed_ownership_observations_charter_custody_no_truncate','shardkeep_charter_custody_truncate()',34),
 ('charter_custody_epochs','charter_custody_epochs_complete','shardkeep_charter_custody_complete()',5),
 ('charter_custody_sources','charter_custody_sources_capture','shardkeep_charter_custody_source()',5),
 ('charter_custody_sources','charter_custody_sources_guard','shardkeep_charter_custody_guard()',31),
 ('charter_custody_epochs','charter_custody_epochs_guard','shardkeep_charter_custody_guard()',31),
 ('charter_custody_heads','charter_custody_heads_guard','shardkeep_charter_custody_guard()',31),
 ('charter_custody_sources','charter_custody_sources_no_truncate','shardkeep_charter_custody_guard()',34),
 ('charter_custody_epochs','charter_custody_epochs_no_truncate','shardkeep_charter_custody_guard()',34),
 ('charter_custody_heads','charter_custody_heads_no_truncate','shardkeep_charter_custody_guard()',34)
 ) required(rel,name,fn,bits) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=('public.'||required.rel)::regclass
 AND t.tgname=required.name AND t.tgfoid=to_regprocedure('public.'||required.fn) AND t.tgenabled='O' AND t.tgtype=required.bits
 AND(required.name<>'charter_custody_epochs_complete' OR(t.tgdeferrable AND t.tginitdeferred AND t.tgconstraint<>0))))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_graph(bid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_custody_sources%ROWTYPE;h public.charter_custody_heads%ROWTYPE;n bigint;
BEGIN
 IF NOT public.shardkeep_charter_custody_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_HELD';END IF;
 SELECT * INTO s FROM public.charter_custody_sources WHERE base_id=bid;
 SELECT * INTO h FROM public.charter_custody_heads WHERE base_id=bid;
 SELECT count(*) INTO n FROM public.charter_custody_epochs WHERE base_id=bid;
 IF s.id IS NULL AND h.epoch_id IS NULL AND n=0 THEN RETURN;END IF;
 IF s.id IS NULL OR h.epoch_id IS NULL OR n<>h.ordinal OR NOT EXISTS(SELECT 1 FROM public.charter_custody_epochs e WHERE e.id=h.epoch_id AND e.base_id=bid AND e.ordinal=h.ordinal)
 OR EXISTS(SELECT 1 FROM public.charter_custody_epochs e LEFT JOIN public.charter_custody_epochs p ON p.id=e.predecessor_id
 WHERE e.base_id=bid AND(e.source_id<>s.id OR e.evidence_commitment<>public.shardkeep_charter_custody_commit(e)
 OR(e.ordinal=1 AND(e.predecessor_id IS NOT NULL OR e.evidence<>s.evidence OR e.owner_wallet<>s.wallet))
 OR(e.ordinal>1 AND(p.id IS NULL OR p.base_id<>bid OR p.source_id<>s.id OR p.ordinal<>e.ordinal-1))))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_HELD';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_observation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE bid uuid;
BEGIN
 IF TG_RELID<>'public.deed_ownership_observations'::regclass OR TG_NAME<>'deed_observations_charter_custody' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_READ_COMMITTED';END IF;
 IF TG_OP='UPDATE' AND NEW.base_id<>OLD.base_id AND EXISTS(SELECT 1 FROM public.charter_custody_sources WHERE base_id IN(NEW.base_id,OLD.base_id))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
 bid:=CASE WHEN TG_OP='DELETE' THEN OLD.base_id ELSE NEW.base_id END;
 IF NOT EXISTS(SELECT 1 FROM public.charter_custody_sources WHERE base_id=bid) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND(NEW.id<>OLD.id OR NEW.asset_id<>OLD.asset_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
 PERFORM public.shardkeep_charter_custody_advance(bid);RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_base() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE bid uuid;
BEGIN
 IF TG_RELID<>'public.bases'::regclass OR TG_NAME<>'bases_charter_custody' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_READ_COMMITTED';END IF;
 bid:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
 IF NOT EXISTS(SELECT 1 FROM public.charter_custody_sources WHERE base_id=bid) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND NEW.id<>OLD.id THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE';END IF;
 PERFORM public.shardkeep_charter_custody_advance(bid);RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_RELID NOT IN('public.bases'::regclass,'public.deed_ownership_observations'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||'_charter_custody_no_truncate') OR TG_OP<>'TRUNCATE' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'STATEMENT'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_READ_COMMITTED';END IF;
 IF NOT public.shardkeep_charter_custody_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_HELD';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_custody_sources) THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_SOURCE_TRUNCATE';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_read(bid uuid,freshness_ms integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.bases%ROWTYPE;o public.deed_ownership_observations%ROWTYPE;e public.charter_custody_epochs%ROWTYPE;h public.charter_custody_heads%ROWTYPE;available boolean;t jsonb;
BEGIN
 PERFORM public.shardkeep_charter_custody_owner();
 SELECT * INTO b FROM public.bases WHERE id=bid FOR UPDATE NOWAIT;
 PERFORM public.shardkeep_charter_custody_graph(bid);
 SELECT * INTO h FROM public.charter_custody_heads WHERE base_id=bid;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO STRICT e FROM public.charter_custody_epochs WHERE id=h.epoch_id;
 SELECT * INTO o FROM public.deed_ownership_observations WHERE base_id=bid ORDER BY checked_at DESC,id DESC LIMIT 1 FOR UPDATE NOWAIT;
 t:=public.shardkeep_charter_custody_transition(bid);
 IF t->>'kind' IS NOT NULL OR h.base_state IS DISTINCT FROM t->'base_state' OR h.observation_state IS DISTINCT FROM t->'observation_state'
 OR h.floor_asset IS DISTINCT FROM t->>'floor_asset' OR h.floor_slot IS DISTINCT FROM (t->>'floor_slot')::bigint
 OR h.floor_owner IS DISTINCT FROM t->>'floor_owner' OR h.floor_eligible IS DISTINCT FROM (t->>'floor_eligible')::boolean
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_HELD';END IF;
 available:=e.kind='observed' AND b.owner_wallet=e.owner_wallet AND b.deed_asset_id=e.deed_asset_id AND b.land_paid_at IS NOT NULL AND b.status='active'
 AND EXISTS(SELECT 1 FROM public.base_slots WHERE base_id=bid AND wallet=e.owner_wallet AND active)
 AND public.shardkeep_charter_custody_proof(o) AND o.status='owned' AND o.owner=e.owner_wallet AND o.asset_id=e.deed_asset_id
 AND o.slot=h.floor_slot AND o.owner=h.floor_owner AND h.floor_eligible AND freshness_ms>0
 AND o.checked_at<=clock_timestamp() AND clock_timestamp()-o.checked_at<=freshness_ms*interval '1 millisecond';
 RETURN jsonb_build_object('id',e.id,'evidenceCommitment',e.evidence_commitment,'baseId',e.base_id,'deedAssetId',e.deed_asset_id,
 'ownerWallet',e.owner_wallet,'ordinal',e.ordinal::text,'authority',CASE WHEN coalesce(available,false) THEN 'current' ELSE 'unavailable' END);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_enroll(w text,bid uuid,freshness_ms integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE saved jsonb;
BEGIN
 PERFORM public.shardkeep_charter_custody_owner();
 PERFORM wallet FROM public.players WHERE wallet=w FOR UPDATE;
 PERFORM id FROM public.bases WHERE id=bid FOR UPDATE;
 PERFORM public.shardkeep_charter_custody_graph(bid);
 IF EXISTS(SELECT 1 FROM public.charter_custody_sources WHERE base_id=bid) THEN
  saved:=public.shardkeep_charter_custody_read(bid,freshness_ms);
  IF saved->>'ownerWallet'<>w THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_UNAVAILABLE';END IF;RETURN saved;
 END IF;
 INSERT INTO public.charter_custody_sources(base_id,wallet,freshness_ms) VALUES(bid,w,freshness_ms);
 RETURN public.shardkeep_charter_custody_read(bid,freshness_ms);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_custody_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE freshness integer;
BEGIN
 IF TG_RELID<>'public.charter_custody_epochs'::regclass OR TG_NAME<>'charter_custody_epochs_complete' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_CUSTODY_TRIGGER';END IF;
 SELECT freshness_ms INTO STRICT freshness FROM public.charter_custody_sources WHERE base_id=NEW.base_id;
 -- Deferred validation prevents an isolated nested epoch INSERT from committing
 -- without its exact head/snapshot transition, even under the table-owner role.
 PERFORM public.shardkeep_charter_custody_read(NEW.base_id,freshness);
 RETURN NULL;
END $$;
DO $$DECLARE t text;fn record;BEGIN
 FOREACH t IN ARRAY ARRAY['charter_custody_sources','charter_custody_epochs','charter_custody_heads'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_custody_guard()',t||'_guard',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_custody_guard()',t||'_no_truncate',t);
  END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_custody_sources'::regclass AND tgname='charter_custody_sources_capture') THEN
  CREATE TRIGGER charter_custody_sources_capture AFTER INSERT ON public.charter_custody_sources FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_custody_source();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.bases'::regclass AND tgname='bases_charter_custody') THEN
  CREATE TRIGGER bases_charter_custody AFTER INSERT OR UPDATE OR DELETE ON public.bases FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_custody_base();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.deed_ownership_observations'::regclass AND tgname='deed_observations_charter_custody') THEN
  CREATE TRIGGER deed_observations_charter_custody AFTER INSERT OR UPDATE OR DELETE ON public.deed_ownership_observations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_custody_observation();END IF;
 FOREACH t IN ARRAY ARRAY['bases','deed_ownership_observations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_custody_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_custody_truncate()',t||'_charter_custody_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.charter_custody_epochs'::regclass AND tgname='charter_custody_epochs_complete') THEN
  CREATE CONSTRAINT TRIGGER charter_custody_epochs_complete AFTER INSERT ON public.charter_custody_epochs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_custody_complete();
 END IF;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_custody_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
