-- B6c immutable preparation and eligibility-at-fence only, never payout-ready.
-- No release, backfill or monetary rewrite. Additive hooks on existing sources
-- remain S5-held, including RC refusal before unenrolled/fence visibility checks.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.clan_charter_member_fences(
 id uuid PRIMARY KEY,clan_id uuid NOT NULL UNIQUE,actor_wallet text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),
 raid_ordinal bigint NOT NULL CHECK(raid_ordinal>=0),original_clan jsonb NOT NULL,chest_shards bigint NOT NULL CHECK(chest_shards>=0),
 roster_count integer NOT NULL CHECK(roster_count>0),eligible_count integer NOT NULL CHECK(eligible_count>=0 AND eligible_count<=roster_count),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),UNIQUE(actor_wallet,idempotency_key)
);
CREATE TABLE IF NOT EXISTS public.clan_charter_member_roster(
 fence_id uuid NOT NULL REFERENCES public.clan_charter_member_fences(id),member_wallet text NOT NULL,original_membership jsonb NOT NULL,
 eligible boolean NOT NULL,base_id uuid,slot integer,original_base jsonb,original_slot jsonb,
 PRIMARY KEY(fence_id,member_wallet),
 CHECK((NOT eligible AND base_id IS NULL AND slot IS NULL AND original_base IS NULL AND original_slot IS NULL)
 OR(eligible AND base_id IS NOT NULL AND slot IS NOT NULL AND slot>0 AND original_base IS NOT NULL AND original_slot IS NOT NULL))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_member_fence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source uuid;c public.clans%ROWTYPE;h public.clan_charter_member_fences%ROWTYPE;
 n bigint;highest bigint;head bigint;selected_base uuid;selected_slot integer;selected_base_json jsonb;selected_slot_json jsonb;
BEGIN
 IF TG_RELID NOT IN('public.clan_charter_member_fences'::regclass,'public.clan_charter_member_roster'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_READ_COMMITTED';END IF;
 IF TG_TABLE_NAME='clan_charter_member_fences' THEN
  SELECT source_id INTO source FROM public.clan_charter_event_source;IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SOURCE_REQUIRED';END IF;
  -- Exact snapshot barriers precede the clan/head mutex. NOWAIT prevents lock
  -- inversion with existing gameplay writers; no player or provider work here.
  LOCK TABLE public.clan_members,public.bases,public.base_slots IN SHARE MODE NOWAIT;
  SELECT * INTO c FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR c.leader_wallet IS DISTINCT FROM NEW.actor_wallet OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=c.id AND player_wallet=NEW.actor_wallet)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_LEADER';END IF;
  SELECT ordinal INTO head FROM public.clan_charter_event_heads WHERE clan_id=c.id FOR UPDATE NOWAIT;
  SELECT count(*),coalesce(max(clan_ordinal),0) INTO n,highest FROM public.clan_charter_raid_events WHERE original_clan_id=c.id;
  IF coalesce(head,0)<>n OR highest<>n OR EXISTS(SELECT 1 FROM public.clan_charter_raid_events e LEFT JOIN public.raids r ON r.id=e.raid_id WHERE e.original_clan_id=c.id
   AND(e.source_id IS DISTINCT FROM source OR r.id IS NULL OR(e.attacker_wallet,e.attacker_base_id,e.defender_wallet,e.defender_base_id,e.pve_camp_id,e.campaign_stage,e.admitted_at)
    IS DISTINCT FROM(r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,r.pve_camp_id,r.campaign_stage,r.created_at)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_PREFIX';END IF;
  NEW.id:=gen_random_uuid();NEW.source_id:=source;NEW.raid_ordinal:=n;NEW.original_clan:=to_jsonb(c);NEW.chest_shards:=c.chest_shards;NEW.created_at:=clock_timestamp();
  SELECT count(*),count(*) FILTER(WHERE EXISTS(SELECT 1 FROM public.base_slots s JOIN public.bases b ON b.id=s.base_id
   WHERE s.wallet=m.player_wallet AND s.active AND b.owner_wallet=m.player_wallet AND b.status='active' AND b.land_paid_at IS NOT NULL))
   INTO NEW.roster_count,NEW.eligible_count FROM public.clan_members m WHERE m.clan_id=c.id;
  RETURN NEW;
 END IF;
 IF pg_trigger_depth()<>2 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_member_fences'::regclass AND tgname='clan_charter_member_fences_capture_roster'
  AND tgfoid='public.shardkeep_clan_charter_capture_member_roster()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ORIGIN' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT h FROM public.clan_charter_member_fences WHERE id=NEW.fence_id;
 IF NOT EXISTS(SELECT 1 FROM public.clan_members m WHERE m.player_wallet=NEW.member_wallet AND m.clan_id=h.clan_id AND to_jsonb(m)=NEW.original_membership) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ROSTER';END IF;
 SELECT b.id,s.slot,to_jsonb(b),to_jsonb(s) INTO selected_base,selected_slot,selected_base_json,selected_slot_json
 FROM public.base_slots s JOIN public.bases b ON b.id=s.base_id WHERE s.wallet=NEW.member_wallet AND s.active AND b.owner_wallet=NEW.member_wallet AND b.status='active' AND b.land_paid_at IS NOT NULL ORDER BY s.slot,b.id LIMIT 1;
 IF(NEW.eligible,NEW.base_id,NEW.slot,NEW.original_base,NEW.original_slot) IS DISTINCT FROM(selected_base IS NOT NULL,selected_base,selected_slot,selected_base_json,selected_slot_json) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ROSTER';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_capture_member_roster() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF TG_RELID<>'public.clan_charter_member_fences'::regclass OR TG_NAME<>'clan_charter_member_fences_capture_roster' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_capture_member_roster()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;
 INSERT INTO public.clan_charter_member_roster(fence_id,member_wallet,original_membership,eligible,base_id,slot,original_base,original_slot)
 SELECT NEW.id,m.player_wallet,to_jsonb(m),chosen.base_id IS NOT NULL,chosen.base_id,chosen.slot,chosen.original_base,chosen.original_slot
 FROM public.clan_members m LEFT JOIN LATERAL(SELECT b.id base_id,s.slot,to_jsonb(b) original_base,to_jsonb(s) original_slot
  FROM public.base_slots s JOIN public.bases b ON b.id=s.base_id WHERE s.wallet=m.player_wallet AND s.active AND b.owner_wallet=m.player_wallet AND b.status='active' AND b.land_paid_at IS NOT NULL ORDER BY s.slot,b.id LIMIT 1) chosen ON true
 WHERE m.clan_id=NEW.clan_id ORDER BY m.player_wallet;
 IF(SELECT count(*) FROM public.clan_charter_member_roster WHERE fence_id=NEW.id)<>NEW.roster_count OR(SELECT count(*) FROM public.clan_charter_member_roster WHERE fence_id=NEW.id AND eligible)<>NEW.eligible_count THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ROSTER';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_member_fence_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE affected uuid[];clan uuid;
BEGIN
 IF TG_RELID NOT IN('public.clans'::regclass,'public.clan_members'::regclass,'public.clan_charter_raid_events'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_charter_member_fence_truncate' ELSE '_charter_member_fence' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_member_fence_boundary()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;
 -- This must precede fence lookup: an old RR snapshot must never hide a newly
 -- committed fence, including while all feature flags are off.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_READ_COMMITTED';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_fences) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';END IF;RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='clan_charter_raid_events' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;affected:=ARRAY[NEW.original_clan_id];
 ELSIF TG_TABLE_NAME='clan_members' THEN
  IF TG_OP='INSERT' THEN affected:=ARRAY[NEW.clan_id];ELSIF TG_OP='DELETE' THEN affected:=ARRAY[OLD.clan_id];ELSE affected:=ARRAY[OLD.clan_id,NEW.clan_id];END IF;
 ELSE
  IF TG_OP='DELETE' THEN affected:=ARRAY[OLD.id];ELSE affected:=ARRAY[OLD.id,NEW.id];END IF;
 END IF;
 FOR clan IN SELECT DISTINCT id FROM unnest(affected) id WHERE id IS NOT NULL ORDER BY id LOOP
  PERFORM 1 FROM public.clans WHERE id=clan FOR UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_fences WHERE clan_id=clan) THEN
   -- Positive legacy credits remain observable by0216. They are NOT declared
   -- attributable to this frontier or available for payout by this exception.
   IF TG_TABLE_NAME='clans' AND TG_OP='UPDATE' THEN
    IF NEW.chest_shards>OLD.chest_shards AND to_jsonb(NEW)-'chest_shards'=to_jsonb(OLD)-'chest_shards' THEN CONTINUE;END IF;
   END IF;
   RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_clan_charter_member_fence_guard(),public.shardkeep_clan_charter_capture_member_roster(),public.shardkeep_clan_charter_member_fence_boundary() FROM PUBLIC;
REVOKE ALL ON public.clan_charter_member_fences,public.clan_charter_member_roster FROM PUBLIC;
--> statement-breakpoint
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['clan_charter_member_fences','clan_charter_member_roster'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_member_fence_guard()',t||'_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_clan_charter_member_fence_guard()',t||'_no_truncate',t);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_member_fences'::regclass AND tgname='clan_charter_member_fences_capture_roster') THEN CREATE TRIGGER clan_charter_member_fences_capture_roster AFTER INSERT ON public.clan_charter_member_fences FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_capture_member_roster();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clans'::regclass AND tgname='clans_charter_member_fence') THEN CREATE TRIGGER clans_charter_member_fence BEFORE UPDATE OR DELETE ON public.clans FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_member_fence_boundary();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_members'::regclass AND tgname='clan_members_charter_member_fence') THEN CREATE TRIGGER clan_members_charter_member_fence BEFORE INSERT OR UPDATE OR DELETE ON public.clan_members FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_member_fence_boundary();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_raid_events'::regclass AND tgname='clan_charter_raid_events_charter_member_fence') THEN CREATE TRIGGER clan_charter_raid_events_charter_member_fence BEFORE INSERT ON public.clan_charter_raid_events FOR EACH ROW EXECUTE FUNCTION public.shardkeep_clan_charter_member_fence_boundary();END IF;
 FOREACH t IN ARRAY ARRAY['clans','clan_members'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_member_fence_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_clan_charter_member_fence_boundary()',t||'_charter_member_fence_truncate',t);END IF;
 END LOOP;
END $$;
