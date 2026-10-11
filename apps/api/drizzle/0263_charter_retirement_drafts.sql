-- D153.204 ordinary, recoverable pre-payment drafts. Existing source and
-- projection seals remain immutable; this contract explicitly succeeds0262.
SET LOCAL lock_timeout='10s';
DO $$BEGIN PERFORM public.shardkeep_charter_retirement_source();END $$;
CREATE TABLE public.charter_retirement_drafts(
 id uuid PRIMARY KEY,actor text NOT NULL,idempotency_key uuid NOT NULL,clan_id uuid NOT NULL REFERENCES public.charter_sale_births(clan_id),
 fence_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_member_fences(id),source jsonb NOT NULL,created_at timestamptz NOT NULL,tx_key text NOT NULL,UNIQUE(actor,idempotency_key)
);
CREATE TABLE public.charter_retirement_draft_cancellations(
 draft_id uuid PRIMARY KEY REFERENCES public.charter_retirement_drafts(id),id uuid NOT NULL UNIQUE,source jsonb NOT NULL,
 clan_before jsonb NOT NULL,payment_source jsonb,tx_key text NOT NULL,created_at timestamptz NOT NULL
);
CREATE TABLE public.charter_retirement_draft_contract(singleton boolean PRIMARY KEY CHECK(singleton),previous_sha256 text NOT NULL,source_sha256 text NOT NULL);
REVOKE ALL ON public.charter_retirement_drafts,public.charter_retirement_draft_cancellations,public.charter_retirement_draft_contract FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_source() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS(SELECT 1 FROM public.charter_retirement_draft_contract next
  JOIN public.charter_retirement_projection_contract previous ON previous.singleton=next.singleton
  JOIN public.charter_retirement_contract first ON first.singleton=previous.singleton
  WHERE next.singleton AND previous.previous_sha256=first.source_sha256 AND next.previous_sha256=previous.source_sha256
   AND next.source_sha256=public.shardkeep_charter_retirement_fingerprint()) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 PERFORM public.shardkeep_charter_army_disposition_source();PERFORM public.shardkeep_charter_tournament_hooks();
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_clearance(actor text,fid uuid) RETURNS jsonb
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
  OR h.leader_wallet IS DISTINCT FROM actor OR h.revision>=4294967295
  OR public.shardkeep_charter_sale_released(fid) OR EXISTS(SELECT 1 FROM public.charter_sale_acceptances WHERE fence_id=fid)
  OR EXISTS(SELECT 1 FROM public.charter_sales s WHERE s.clan_id=f.clan_id AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals t WHERE t.sale_id=s.id))
  OR public.shardkeep_charter_tournament_fenced(f.clan_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_HELD';END IF;
 creation:=public.shardkeep_charter_sale_birth(f.clan_id);
 SELECT source INTO payment FROM public.clan_charter_member_payments WHERE fence_id=fid;
 payment:=public.shardkeep_charter_member_payment_source(fid,payment);
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
 RETURN jsonb_build_object('creation',creation,'head',to_jsonb(h),'fence',to_jsonb(f),'paymentPlan',payment,'raids',raids,'sales',sales,'tournament',prefix);
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_history(did uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.charter_retirement_drafts%ROWTYPE;x public.charter_retirement_draft_cancellations%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO d FROM public.charter_retirement_drafts WHERE id=did;SELECT * INTO x FROM public.charter_retirement_draft_cancellations WHERE draft_id=did;
 IF d.id IS NULL OR x.id IS NULL OR x.source IS DISTINCT FROM d.source
  OR EXISTS(SELECT 1 FROM public.charter_retirements WHERE fence_id=d.fence_id)
  OR d.source->'fence' IS DISTINCT FROM(SELECT to_jsonb(f) FROM public.clan_charter_member_fences f WHERE id=d.fence_id)
  OR d.source->'paymentPlan'->'roster' IS DISTINCT FROM(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY member_wallet COLLATE "C"),'[]'::jsonb) FROM public.clan_charter_member_roster m WHERE fence_id=d.fence_id)
  OR x.payment_source IS DISTINCT FROM(SELECT source FROM public.clan_charter_member_payments WHERE fence_id=d.fence_id)
  OR(x.payment_source IS NOT NULL AND x.payment_source IS DISTINCT FROM d.source->'paymentPlan')
  OR x.clan_before IS DISTINCT FROM (CASE WHEN x.payment_source IS NULL THEN d.source->'paymentPlan'->'headBefore'->'clan_state'
    ELSE jsonb_set(d.source->'paymentPlan'->'headBefore'->'clan_state','{chest_shards}','0'::jsonb) END)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_SOURCE';END IF;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_released(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE did uuid;BEGIN
 SELECT d.id INTO did FROM public.charter_retirement_drafts d JOIN public.charter_retirement_draft_cancellations x ON x.draft_id=d.id WHERE d.fence_id=fid;
 IF did IS NULL THEN RETURN false;END IF;PERFORM public.shardkeep_charter_retirement_draft_history(did);RETURN true;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_historical_fence(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE d public.charter_retirement_drafts%ROWTYPE;BEGIN
 SELECT * INTO d FROM public.charter_retirement_drafts WHERE fence_id=fid;
 IF d.id IS NULL OR NOT public.shardkeep_charter_retirement_draft_released(fid) THEN RETURN false;END IF;
 PERFORM public.shardkeep_charter_member_payment_read(fid,d.actor);RETURN true;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.charter_retirement_drafts%ROWTYPE;BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_guard' OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_IMMUTABLE';END IF;
 PERFORM public.shardkeep_charter_retirement_owner();
 IF TG_TABLE_NAME='charter_retirement_draft_contract' THEN
  IF EXISTS(SELECT 1 FROM public.charter_retirement_draft_contract) OR NEW.singleton IS DISTINCT FROM true
   OR NEW.previous_sha256 IS DISTINCT FROM(SELECT source_sha256 FROM public.charter_retirement_projection_contract WHERE singleton)
   OR NEW.source_sha256 IS DISTINCT FROM public.shardkeep_charter_retirement_fingerprint() THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;RETURN NEW;
 END IF;
 PERFORM public.shardkeep_charter_retirement_source();
 -- Absent original/payment rows remain absent until this transaction finishes;
 -- the existing fence/clan mutex serializes settlement and original creation.
 LOCK TABLE public.charter_retirements,public.clan_charter_member_payments IN SHARE MODE NOWAIT;
 IF TG_TABLE_NAME='charter_retirement_drafts' THEN
  IF NOT EXISTS(SELECT 1 FROM public.clan_charter_member_fences f WHERE f.id=NEW.fence_id AND f.actor_wallet=NEW.actor AND f.clan_id=NEW.clan_id
   AND f.idempotency_key='retirement-draft:'||NEW.id::text AND f.xmin=pg_current_xact_id()::text::xid)
   OR EXISTS(SELECT 1 FROM public.charter_retirements WHERE fence_id=NEW.fence_id)
   OR EXISTS(SELECT 1 FROM public.clan_charter_member_payments WHERE fence_id=NEW.fence_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_SOURCE';END IF;
  NEW.source:=public.shardkeep_charter_retirement_draft_clearance(NEW.actor,NEW.fence_id);
 ELSIF TG_TABLE_NAME='charter_retirement_draft_cancellations' THEN
  SELECT * INTO d FROM public.charter_retirement_drafts WHERE id=NEW.draft_id FOR UPDATE NOWAIT;
  IF d.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_retirements WHERE fence_id=d.fence_id)
   OR d.source IS DISTINCT FROM public.shardkeep_charter_retirement_draft_clearance(d.actor,d.fence_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_HELD';END IF;
  NEW.id:=gen_random_uuid();NEW.source:=d.source;SELECT to_jsonb(c) INTO STRICT NEW.clan_before FROM public.clans c WHERE id=d.clan_id;
  SELECT source INTO NEW.payment_source FROM public.clan_charter_member_payments WHERE fence_id=d.fence_id;
  IF NEW.payment_source IS NOT NULL THEN PERFORM public.shardkeep_charter_member_payment_read(d.fence_id,d.actor);END IF;
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_SOURCE';END IF;
 NEW.tx_key:=pg_current_xact_id()::text;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_read(actor text,did uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.charter_retirement_drafts%ROWTYPE;cancelled boolean;rid uuid;p jsonb;shares jsonb;BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO d FROM public.charter_retirement_drafts WHERE id=did;
 IF d.id IS NULL OR d.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_NOT_FOUND';END IF;
 cancelled:=EXISTS(SELECT 1 FROM public.charter_retirement_draft_cancellations WHERE draft_id=did);SELECT id INTO rid FROM public.charter_retirements WHERE fence_id=d.fence_id;
 IF cancelled THEN PERFORM public.shardkeep_charter_retirement_draft_history(did);
 ELSIF rid IS NOT NULL THEN PERFORM public.shardkeep_charter_retirement_read(actor,rid);
 ELSIF d.source IS DISTINCT FROM public.shardkeep_charter_retirement_draft_clearance(actor,d.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_SOURCE';END IF;
 p:=public.shardkeep_charter_member_payment_read(d.fence_id,actor);
 IF p IS NOT NULL AND(p->>'totalShards' IS DISTINCT FROM d.source->'paymentPlan'->>'totalShards'
  OR(SELECT source FROM public.clan_charter_member_payments WHERE fence_id=d.fence_id) IS DISTINCT FROM d.source->'paymentPlan') THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_SOURCE';END IF;
 SELECT jsonb_agg(jsonb_build_object('wallet',m->>'member_wallet','shards',coalesce((SELECT a->>'shards' FROM jsonb_array_elements(d.source->'paymentPlan'->'allocations') a WHERE a->>'wallet'=m->>'member_wallet'),'0')) ORDER BY m->>'member_wallet' COLLATE "C")
 INTO shares FROM jsonb_array_elements(d.source->'paymentPlan'->'roster') m;
 RETURN jsonb_build_object('version',1,'id',d.id,'actor',actor,'request',jsonb_build_object('clanId',d.clan_id,'idempotencyKey',d.idempotency_key),
  'clan',jsonb_build_object('id',d.clan_id,'name',d.source->'fence'->'original_clan'->'name','tag',d.source->'fence'->'original_clan'->'tag'),
  'fenceId',d.fence_id,'totalShards',d.source->'paymentPlan'->'totalShards','shares',shares,
  'memberPayment',CASE WHEN p IS NULL THEN NULL ELSE jsonb_build_object('id',p->'id','totalShards',p->'totalShards') END,'retirementId',rid,'cancelled',cancelled);
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_create(actor text,cid uuid,request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE d public.charter_retirement_drafts%ROWTYPE;did uuid:=gen_random_uuid();fid uuid;BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();
 SELECT * INTO d FROM public.charter_retirement_drafts WHERE charter_retirement_drafts.actor=shardkeep_charter_retirement_draft_create.actor AND idempotency_key=request_key;
 IF d.id IS NOT NULL THEN
  IF d.clan_id IS DISTINCT FROM cid THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_CONFLICT';END IF;RETURN public.shardkeep_charter_retirement_draft_read(actor,d.id);
 END IF;
 LOCK TABLE public.charter_sales,public.charter_tournament_entries,public.charter_tournament_operations,public.clans,public.clan_members,public.raids IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.clans WHERE id=cid FOR UPDATE NOWAIT;
 INSERT INTO public.clan_charter_member_fences(clan_id,actor_wallet,idempotency_key) VALUES(cid,actor,'retirement-draft:'||did::text) RETURNING id INTO fid;
 INSERT INTO public.charter_retirement_drafts(id,actor,idempotency_key,clan_id,fence_id) VALUES(did,actor,request_key,cid,fid);
 RETURN public.shardkeep_charter_retirement_draft_read(actor,did);
END $$;
CREATE FUNCTION public.shardkeep_charter_retirement_draft_cancel(actor text,did uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE d public.charter_retirement_drafts%ROWTYPE;BEGIN
 PERFORM public.shardkeep_charter_retirement_owner();PERFORM public.shardkeep_charter_retirement_source();SELECT * INTO d FROM public.charter_retirement_drafts WHERE id=did FOR UPDATE NOWAIT;
 IF d.id IS NULL OR d.actor IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_retirement_draft_cancellations WHERE draft_id=did) OR EXISTS(SELECT 1 FROM public.charter_retirements WHERE fence_id=d.fence_id)
 THEN RETURN public.shardkeep_charter_retirement_draft_read(actor,did);END IF;
 INSERT INTO public.charter_retirement_draft_cancellations(draft_id) VALUES(did);RETURN public.shardkeep_charter_retirement_draft_read(actor,did);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_released(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_sale_fence_releases%ROWTYPE;t public.charter_sale_terminals%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 -- Shared legacy fence predicate: a distinct authenticated retirement cancellation
 -- releases its own fence without inventing a sale or a sale release row.
 IF NOT FOUND THEN RETURN public.shardkeep_charter_retirement_released(fid) OR public.shardkeep_charter_retirement_draft_released(fid);END IF;
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=r.sale_id;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=r.sale_id;
 IF t.id IS NULL OR t.id IS DISTINCT FROM r.terminal_id OR a.fence_id IS DISTINCT FROM fid OR r.tx_key IS DISTINCT FROM t.tx_key
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_retirement_historical_fence(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$DECLARE r public.charter_retirements%ROWTYPE;BEGIN
 SELECT r0.* INTO r FROM public.charter_retirements r0 JOIN public.charter_retirement_terminals t ON t.retirement_id=r0.id WHERE r0.fence_id=fid;
 IF r.id IS NULL THEN RETURN public.shardkeep_charter_retirement_draft_historical_fence(fid);END IF;
 PERFORM public.shardkeep_charter_retirement_history(r.id,false);PERFORM public.shardkeep_charter_member_payment_read(fid,r.actor);RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_source(fid uuid,paid_source jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;h public.clan_charter_raid_chest_heads%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;e public.clan_charter_raid_events%ROWTYPE;
 c jsonb;prehead jsonb;state jsonb;revision bigint;total bigint;roster jsonb;eligible text[];allocations jsonb;
 retirement public.charter_retirement_terminals%ROWTYPE;draft_cancel public.charter_retirement_draft_cancellations%ROWTYPE;
 historical boolean:=false;release public.charter_sale_fence_releases%ROWTYPE;terminal public.charter_sale_terminals%ROWTYPE;
 witnesses jsonb:='[]'::jsonb;events jsonb:='[]'::jsonb;proof jsonb;n bigint;result jsonb;preview jsonb;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
 SELECT * INTO release FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 IF release.fence_id IS NOT NULL AND paid_source IS NOT NULL THEN
  IF NOT public.shardkeep_charter_sale_released(fid) OR release.payment_source IS DISTINCT FROM paid_source
   OR paid_source->'fence' IS DISTINCT FROM to_jsonb(f)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=release.sale_id;
  historical:=true;
 END IF;
 SELECT t.* INTO retirement FROM public.charter_retirement_terminals t JOIN public.charter_retirements r ON r.id=t.retirement_id WHERE r.fence_id=fid;
 IF retirement.id IS NOT NULL AND paid_source IS NOT NULL THEN
  PERFORM public.shardkeep_charter_retirement_history(retirement.retirement_id,false);
  IF retirement.payment_source IS DISTINCT FROM paid_source OR paid_source->'fence' IS DISTINCT FROM to_jsonb(f) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  historical:=true;terminal.clan_before:=retirement.clan_before;
 END IF;
 SELECT x.* INTO draft_cancel FROM public.charter_retirement_draft_cancellations x JOIN public.charter_retirement_drafts d ON d.id=x.draft_id WHERE d.fence_id=fid;
 IF draft_cancel.id IS NOT NULL THEN
  IF paid_source IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_CANCELLED';END IF;
  PERFORM public.shardkeep_charter_retirement_draft_history(draft_cancel.draft_id);
  IF draft_cancel.payment_source IS DISTINCT FROM paid_source OR paid_source->'fence' IS DISTINCT FROM to_jsonb(f)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  historical:=true;terminal.clan_before:=draft_cancel.clan_before;
 END IF;
 SELECT to_jsonb(live) INTO c FROM public.clans live WHERE id=f.clan_id;
 SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=f.clan_id;
 IF historical THEN
  IF (paid_source->'headBefore')-ARRAY['revision','clan_state'] IS DISTINCT FROM to_jsonb(h)-ARRAY['revision','clan_state']
   OR h.revision<(paid_source->'headBefore'->>'revision')::bigint
   OR terminal.clan_before IS DISTINCT FROM jsonb_set(paid_source->'headBefore'->'clan_state','{chest_shards}','0'::jsonb)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  h:=jsonb_populate_record(NULL::public.clan_charter_raid_chest_heads,paid_source->'headBefore');
  c:=terminal.clan_before;h.clan_state:=c;h.revision:=h.revision+CASE WHEN(paid_source->>'totalShards')::bigint>0 THEN 1 ELSE 0 END;
 END IF;
 IF h.clan_id IS NULL OR c IS NULL OR h.clan_state IS DISTINCT FROM c OR h.clan_state IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=f.source_id)
 OR f.original_clan->>'id' IS DISTINCT FROM f.clan_id::text OR f.original_clan->>'leader_wallet' IS DISTINCT FROM f.actor_wallet
 OR(f.original_clan->>'chest_shards')::bigint IS DISTINCT FROM f.chest_shards
 OR f.original_clan-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR NOT(EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
  AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id) OR(h.first_raid_id IS NULL AND EXISTS(SELECT 1 FROM public.charter_sale_births b
   JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id
   WHERE b.clan_id=h.clan_id AND ep.rule_id=h.rule_id AND ep.source_id=f.source_id AND ci.epoch_id=b.epoch_id AND ci.tx_key=b.tx_key)))
 OR f.raid_ordinal IS DISTINCT FROM(SELECT count(*) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND(NOT historical OR clan_ordinal<=f.raid_ordinal))
 OR f.raid_ordinal IS DISTINCT FROM coalesce((SELECT max(clan_ordinal) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND(NOT historical OR clan_ordinal<=f.raid_ordinal)),0)
 OR(NOT historical AND f.raid_ordinal IS DISTINCT FROM coalesce((SELECT ordinal FROM public.clan_charter_event_heads WHERE clan_id=f.clan_id),0))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 prehead:=coalesce(paid_source->'headBefore',to_jsonb(h));state:=prehead->'clan_state';revision:=(prehead->>'revision')::bigint;
 total:=(state->>'chest_shards')::bigint;
 IF total IS NULL OR total<f.chest_shards OR revision IS NULL OR revision<0
 OR prehead-ARRAY['clan_state','revision'] IS DISTINCT FROM to_jsonb(h)-ARRAY['clan_state','revision']
 OR state-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR(paid_source IS NOT NULL AND(h.revision IS DISTINCT FROM revision+CASE WHEN total>0 THEN 1 ELSE 0 END
  OR c IS DISTINCT FROM jsonb_set(state,'{chest_shards}','0'::jsonb)))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.member_wallet COLLATE "C"),'[]'::jsonb),
  coalesce(array_agg(m.member_wallet ORDER BY m.member_wallet COLLATE "C") FILTER(WHERE m.eligible),'{}'::text[])
 INTO roster,eligible FROM public.clan_charter_member_roster m WHERE m.fence_id=fid;
 IF jsonb_array_length(roster)<>f.roster_count OR cardinality(eligible)<>f.eligible_count
 OR(NOT historical AND f.roster_count<>(SELECT count(*) FROM public.clan_members WHERE clan_id=f.clan_id))
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_member_roster WHERE fence_id=fid AND member_wallet=f.actor_wallet)
 OR EXISTS(SELECT 1 FROM public.clan_charter_member_roster m LEFT JOIN public.clan_members live ON live.player_wallet=m.member_wallet
  WHERE m.fence_id=fid AND((NOT historical AND(m.original_membership IS DISTINCT FROM to_jsonb(live) OR live.clan_id IS DISTINCT FROM f.clan_id))
   OR m.original_membership->>'player_wallet' IS DISTINCT FROM m.member_wallet
   OR(m.eligible AND(m.original_base->>'id' IS DISTINCT FROM m.base_id::text OR m.base_id IS NULL OR m.slot IS NULL OR m.slot<=0
    OR m.original_base->>'owner_wallet' IS DISTINCT FROM m.member_wallet OR m.original_base->>'status' IS DISTINCT FROM 'active'
    OR m.original_base->>'land_paid_at' IS NULL OR m.original_slot->>'base_id' IS DISTINCT FROM m.base_id::text
    OR m.original_slot->>'wallet' IS DISTINCT FROM m.member_wallet OR m.original_slot->>'active' IS DISTINCT FROM 'true'
    OR m.original_slot->>'slot' IS DISTINCT FROM m.slot::text))
   OR(NOT m.eligible AND num_nonnulls(m.base_id,m.slot,m.original_base,m.original_slot)<>0)))
 OR(total>0 AND cardinality(eligible)=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 FOR e IN SELECT * FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND clan_ordinal<=f.raid_ordinal ORDER BY clan_ordinal LOOP
  proof:=public.shardkeep_clan_charter_raid_chest_proof(e.raid_id,true);
  IF e.source_id IS DISTINCT FROM f.source_id OR e.tithe_rule_id IS DISTINCT FROM h.rule_id
   OR proof->>'status' IS DISTINCT FROM 'reconciled' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  events:=events||jsonb_build_array(jsonb_build_object('event',to_jsonb(e),'proof',proof));
 END LOOP;
 WHILE state IS DISTINCT FROM f.original_clan LOOP
  IF revision<=0 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT * INTO w FROM public.clan_charter_chest_updates WHERE actual_clan_id=f.clan_id AND chest_predecessor_revision=revision-1;
  IF NOT FOUND OR w.source_id IS DISTINCT FROM f.source_id OR w.delta<=0 OR w.after_clan IS DISTINCT FROM state
   OR w.before_clan-'chest_shards' IS DISTINCT FROM state-'chest_shards'
   OR(w.after_clan->>'chest_shards')::bigint-(w.before_clan->>'chest_shards')::bigint IS DISTINCT FROM w.delta
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_loot_posts p JOIN public.clan_charter_raid_events r ON r.raid_id=p.raid_id
    WHERE p.ledger_id=w.ledger_id AND r.original_clan_id=f.clan_id AND r.clan_ordinal<=f.raid_ordinal
     AND public.shardkeep_clan_charter_raid_chest_proof(r.raid_id,true)->>'status'='reconciled')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  witnesses:=witnesses||jsonb_build_array(to_jsonb(w));state:=w.before_clan;revision:=revision-1;
 END LOOP;
 n:=cardinality(eligible);
 IF n=0 THEN
  -- The zero-chest/empty-eligible case is valid. Do not rely on an empty
  -- unnest to prevent PostgreSQL from evaluating division by zero.
  allocations:='[]'::jsonb;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',wallet,'shards',
   (total/n+CASE WHEN position<=total%n THEN 1 ELSE 0 END)::text) ORDER BY position),'[]'::jsonb)
  INTO allocations FROM unnest(eligible) WITH ORDINALITY x(wallet,position);
 END IF;
 result:=jsonb_build_object('fence',to_jsonb(f),'roster',roster,'headBefore',prehead,'witnesses',witnesses,'events',events,
  'startRevision',revision::text,'totalShards',total::text,'allocations',allocations);
 SELECT source->'paymentPlan' INTO preview FROM public.charter_retirement_drafts WHERE fence_id=fid;
 IF preview IS NOT NULL AND preview IS DISTINCT FROM result THEN RAISE EXCEPTION 'CLAN_CHARTER_RETIREMENT_DRAFT_SOURCE';END IF;
 RETURN result;
END $$;
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_retirement_drafts','charter_retirement_draft_cancellations','charter_retirement_draft_contract'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_retirement_draft_guard()',tab||'_guard',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_retirement_draft_guard()',tab||'_no_truncate',tab);
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'shardkeep_charter_retirement_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);END LOOP;
END $$;
INSERT INTO public.charter_retirement_draft_contract SELECT true,source_sha256,public.shardkeep_charter_retirement_fingerprint() FROM public.charter_retirement_projection_contract WHERE singleton;
