-- B6a prospective attribution only. Existing raids hook remains S5-held.
-- No backfill, reconciliation, ready-cutover claim, membership policy or payout.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.clan_charter_event_source (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 source_id uuid NOT NULL UNIQUE,started_at timestamptz NOT NULL CHECK(isfinite(started_at))
);
CREATE TABLE IF NOT EXISTS public.clan_charter_event_heads (
 clan_id uuid PRIMARY KEY,ordinal bigint NOT NULL CHECK(ordinal>0)
);
CREATE TABLE IF NOT EXISTS public.clan_charter_raid_events (
 raid_id uuid PRIMARY KEY REFERENCES public.raids(id),
 source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),
 attacker_wallet text NOT NULL,attacker_base_id uuid,defender_wallet text,defender_base_id uuid,
 pve_camp_id uuid,campaign_stage integer,kind text NOT NULL CHECK(kind IN('deed_pvp','legacy_pvp','campaign','pve')),
 original_clan_id uuid,original_leader_wallet text,clan_ordinal bigint,
 admitted_at timestamptz NOT NULL CHECK(isfinite(admitted_at)),
 UNIQUE(original_clan_id,clan_ordinal),
 CHECK((original_clan_id IS NULL AND original_leader_wallet IS NULL AND clan_ordinal IS NULL)
  OR(original_clan_id IS NOT NULL AND original_leader_wallet IS NOT NULL AND clan_ordinal IS NOT NULL AND clan_ordinal>0))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.raids%ROWTYPE;expected_kind text;
BEGIN
 IF TG_RELID NOT IN('public.clan_charter_event_source'::regclass,'public.clan_charter_event_heads'::regclass,'public.clan_charter_raid_events'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_TRIGGER';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') OR(TG_OP='UPDATE' AND TG_TABLE_NAME<>'clan_charter_event_heads') THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_READ_COMMITTED';END IF;
 IF TG_TABLE_NAME='clan_charter_event_source' THEN
  -- Every owner INSERT enforces the barrier; a direct INSERT cannot bypass the
  -- initializer. Generated source/time identify enrollment, never historical coverage.
  LOCK TABLE public.raids IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.raids WHERE status NOT IN('resolved','expired')) THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_PENDING_RAIDS' USING ERRCODE='23514';END IF;
  NEW.singleton:=true;NEW.source_id:=gen_random_uuid();NEW.started_at:=clock_timestamp();RETURN NEW;
 END IF;
 -- Only the exact installed raids trigger can enter as a privileged nested
 -- writer. Copied source triggers fail their own relation/name/function check;
 -- accidental table/function grants do not make an ordinary role the owner.
 IF pg_trigger_depth()<>2 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.raids'::regclass
  AND tgname='raids_clan_charter_capture' AND tgfoid='public.shardkeep_clan_charter_capture_raid()'::regprocedure AND tgenabled='O')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_ORIGIN' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='clan_charter_event_heads' THEN
  IF(TG_OP='INSERT' AND NEW.ordinal<>1) OR(TG_OP='UPDATE' AND(NEW.clan_id IS DISTINCT FROM OLD.clan_id OR NEW.ordinal<>OLD.ordinal+1))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_COUNTER';END IF;RETURN NEW;
 END IF;
 SELECT * INTO STRICT r FROM public.raids WHERE id=NEW.raid_id;
 expected_kind:=CASE WHEN r.campaign_stage IS NOT NULL THEN 'campaign' WHEN r.pve_camp_id IS NOT NULL THEN 'pve'
  WHEN r.attacker_base_id IS NOT NULL AND r.defender_base_id IS NOT NULL THEN 'deed_pvp' ELSE 'legacy_pvp' END;
 IF(NEW.attacker_wallet,NEW.attacker_base_id,NEW.defender_wallet,NEW.defender_base_id,NEW.pve_camp_id,NEW.campaign_stage,NEW.admitted_at,NEW.kind)
 IS DISTINCT FROM(r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,r.pve_camp_id,r.campaign_stage,r.created_at,expected_kind)
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=NEW.source_id)
 OR(NEW.original_clan_id IS NULL AND EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=r.attacker_wallet))
 OR(NEW.original_clan_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clan_members m JOIN public.clans c ON c.id=m.clan_id JOIN public.clan_charter_event_heads h ON h.clan_id=c.id
  WHERE m.player_wallet=r.attacker_wallet AND c.id=NEW.original_clan_id AND c.leader_wallet=NEW.original_leader_wallet AND h.ordinal=NEW.clan_ordinal))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_SOURCE';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_event_source_initialize() RETURNS public.clan_charter_event_source
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE saved public.clan_charter_event_source%ROWTYPE;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.clan_charter_event_source'::regclass) THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_READ_COMMITTED';END IF;
 SELECT * INTO saved FROM public.clan_charter_event_source;IF FOUND THEN RETURN saved;END IF;
 LOCK TABLE public.raids IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT * INTO saved FROM public.clan_charter_event_source;IF FOUND THEN RETURN saved;END IF;
 INSERT INTO public.clan_charter_event_source(singleton,source_id,started_at) VALUES(true,gen_random_uuid(),clock_timestamp()) RETURNING * INTO saved;
 RETURN saved;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_capture_raid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source uuid;member_clan uuid;captured_clan uuid;leader text;next_ordinal bigint;event_kind text;
BEGIN
 IF TG_RELID<>'public.raids'::regclass OR TG_NAME<>'raids_clan_charter_capture' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_capture_raid()'::regprocedure AND tgenabled='O')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_TRIGGER';END IF;
 -- Check isolation before source visibility: a pre-enrollment RR snapshot
 -- must not silently miss the durable singleton after enrollment commits.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_READ_COMMITTED';END IF;
 SELECT source_id INTO source FROM public.clan_charter_event_source;IF NOT FOUND THEN RETURN NULL;END IF;
 IF (CASE WHEN NEW.defender_wallet IS NULL THEN 0 ELSE 1 END)+(CASE WHEN NEW.pve_camp_id IS NULL THEN 0 ELSE 1 END)+(CASE WHEN NEW.campaign_stage IS NULL THEN 0 ELSE 1 END)<>1
 OR(NEW.defender_wallet IS NULL AND NEW.defender_base_id IS NOT NULL) OR(NEW.campaign_stage IS NOT NULL AND NEW.campaign_stage<=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_TARGET';END IF;
 event_kind:=CASE WHEN NEW.campaign_stage IS NOT NULL THEN 'campaign' WHEN NEW.pve_camp_id IS NOT NULL THEN 'pve'
  WHEN NEW.attacker_base_id IS NOT NULL AND NEW.defender_base_id IS NOT NULL THEN 'deed_pvp' ELSE 'legacy_pvp' END;
 -- Absence has no row to lock. This short NOWAIT barrier also serializes the
 -- captured-none case with existing membership writers without changing them.
 LOCK TABLE public.clan_members IN SHARE MODE NOWAIT;
 SELECT clan_id INTO member_clan FROM public.clan_members WHERE player_wallet=NEW.attacker_wallet;
 IF FOUND THEN
  SELECT id,leader_wallet INTO captured_clan,leader FROM public.clans WHERE id=member_clan FOR UPDATE NOWAIT;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=NEW.attacker_wallet AND clan_id=captured_clan)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_EVENT_MEMBERSHIP';END IF;
  INSERT INTO public.clan_charter_event_heads(clan_id,ordinal) VALUES(captured_clan,1)
   ON CONFLICT(clan_id) DO UPDATE SET ordinal=public.clan_charter_event_heads.ordinal+1 RETURNING ordinal INTO next_ordinal;
 END IF;
 INSERT INTO public.clan_charter_raid_events(raid_id,source_id,attacker_wallet,attacker_base_id,defender_wallet,defender_base_id,pve_camp_id,campaign_stage,kind,original_clan_id,original_leader_wallet,clan_ordinal,admitted_at)
 VALUES(NEW.id,source,NEW.attacker_wallet,NEW.attacker_base_id,NEW.defender_wallet,NEW.defender_base_id,NEW.pve_camp_id,NEW.campaign_stage,event_kind,captured_clan,leader,next_ordinal,NEW.created_at);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_clan_charter_event_guard(),public.shardkeep_clan_charter_event_source_initialize(),public.shardkeep_clan_charter_capture_raid() FROM PUBLIC;
REVOKE ALL ON public.clan_charter_event_source,public.clan_charter_event_heads,public.clan_charter_raid_events FROM PUBLIC;
--> statement-breakpoint
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['clan_charter_event_source','clan_charter_event_heads','clan_charter_raid_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_event_guard()',t||'_guard',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_clan_charter_event_guard()',t||'_no_truncate',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.raids'::regclass AND tgname='raids_clan_charter_capture') THEN
  CREATE TRIGGER raids_clan_charter_capture AFTER INSERT ON public.raids FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_capture_raid();
 END IF;
END $$;
