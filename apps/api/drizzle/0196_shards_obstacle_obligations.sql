-- Prospective, owner-only capture. No runtime issuer, migration backfill or
-- earning-wallet authority. Existing-table fences remain held under S5 until
-- a separately reviewed transition journal can replace these conservative holds.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS shards_obstacle_obligations (
 id uuid PRIMARY KEY,job_id uuid NOT NULL UNIQUE REFERENCES builder_jobs(id),
 base_id uuid NOT NULL REFERENCES bases(id),obstacle_id uuid NOT NULL REFERENCES obstacles(id),
 wallet text NOT NULL REFERENCES players(wallet),deed_asset_id text,
 captured_at timestamptz NOT NULL CHECK(isfinite(captured_at)),
 started_at timestamptz NOT NULL CHECK(isfinite(started_at)),
 scheduled_finish_at timestamptz NOT NULL CHECK(isfinite(scheduled_finish_at)),
 gross bigint NOT NULL CHECK(gross>0),evidence_sha256 text NOT NULL CHECK(evidence_sha256~'^[0-9a-f]{64}$'),
 CHECK(started_at<=captured_at AND captured_at<scheduled_finish_at)
);
CREATE INDEX IF NOT EXISTS shards_obstacle_wallet_due_idx ON shards_obstacle_obligations(wallet,scheduled_finish_at);
CREATE INDEX IF NOT EXISTS shards_obstacle_base_idx ON shards_obstacle_obligations(base_id);
CREATE INDEX IF NOT EXISTS shards_obstacle_obstacle_idx ON shards_obstacle_obligations(obstacle_id);
--> statement-breakpoint
-- VOLATILE deliberately takes a fresh READ COMMITTED snapshot after a wallet
-- mutex wait. This invoker function never locks another actor's parents.
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_pending(actor_wallet text,term_start timestamptz) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h
 LEFT JOIN public.builder_jobs j ON j.id=h.job_id LEFT JOIN public.bases b ON b.id=h.base_id LEFT JOIN public.obstacles o ON o.id=h.obstacle_id
 WHERE (h.wallet=actor_wallet OR b.owner_wallet=actor_wallet) AND
 (j.id IS NULL OR b.id IS NULL OR o.id IS NULL OR j.kind<>'clear_obstacle'
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,h.scheduled_finish_at)
 OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id
 OR h.scheduled_finish_at<term_start))
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_capture_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.bases%ROWTYPE;j public.builder_jobs%ROWTYPE;o public.obstacles%ROWTYPE;
 touched_base public.bases%ROWTYPE;touched_job public.builder_jobs%ROWTYPE;touched_obstacle public.obstacles%ROWTYPE;floor_start timestamptz;
BEGIN
 IF TG_RELID<>'public.shards_obstacle_obligations'::regclass OR TG_WHEN<>'BEFORE'
 OR (TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR (TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_IMMUTABLE';END IF;
 IF session_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 OR current_user IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ISOLATION';END IF;
 PERFORM 1 FROM public.players WHERE wallet=NEW.wallet FOR UPDATE;
 SELECT * INTO STRICT b FROM public.bases WHERE id=NEW.base_id FOR UPDATE;
 SELECT * INTO STRICT j FROM public.builder_jobs WHERE id=NEW.job_id FOR UPDATE;
 SELECT * INTO STRICT o FROM public.obstacles WHERE id=NEW.obstacle_id FOR UPDATE;
 -- 0072 normalizes this legacy inconsistency on any base UPDATE; refuse it
 -- before its AFTER triggers could publish history or take unrelated locks.
 IF b.deed_asset_id IS NOT NULL AND b.deed_mint_asset_id IS NULL THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_DEED_RESERVATION_HELD';END IF;
 -- Version the already-locked parents without changing their values. A writer
 -- whose repeatable-read snapshot predates capture must serialize instead of
 -- missing this new header. These unchanged fields take no history locks;
 -- updated_at deliberately avoids the league UPDATE-OF columns.
 UPDATE public.bases SET updated_at=updated_at WHERE id=b.id RETURNING * INTO STRICT touched_base;
 IF to_jsonb(touched_base) IS DISTINCT FROM to_jsonb(b) THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_PARENT_CHANGED';END IF;
 UPDATE public.builder_jobs SET finishes_at=finishes_at WHERE id=j.id RETURNING * INTO STRICT touched_job;
 IF to_jsonb(touched_job) IS DISTINCT FROM to_jsonb(j) THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_PARENT_CHANGED';END IF;
 UPDATE public.obstacles SET cleared_at=cleared_at WHERE id=o.id RETURNING * INTO STRICT touched_obstacle;
 IF to_jsonb(touched_obstacle) IS DISTINCT FROM to_jsonb(o) THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_PARENT_CHANGED';END IF;
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(NEW.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=NEW.wallet FOR UPDATE;
 IF b.owner_wallet IS DISTINCT FROM NEW.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM NEW.deed_asset_id
 OR j.kind<>'clear_obstacle' OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(NEW.base_id,NEW.obstacle_id,NEW.started_at,NEW.scheduled_finish_at)
 OR o.base_id IS DISTINCT FROM NEW.base_id OR o.cleared_at IS NOT NULL
 OR NOT(NEW.started_at<=NEW.captured_at AND NEW.captured_at<NEW.scheduled_finish_at)
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_CAPTURE_MISMATCH';END IF;
 SELECT (s.snapshot->>'startsAt')::timestamptz INTO floor_start FROM public.shards_tax_all_assessments a
 JOIN public.expedition_term_snapshots s ON s.term_id=a.term_id AND s.snapshot_hash=a.term_hash
 WHERE a.wallet=NEW.wallet AND a.lineage='d150-resource-tax-v1' ORDER BY a.wallet_sequence DESC LIMIT 1;
 IF NEW.scheduled_finish_at<floor_start THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ORDER_HELD';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.shards_obstacle_obligations'::regclass OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF EXISTS(SELECT 1 FROM public.shards_obstacle_obligations h
 LEFT JOIN public.builder_jobs j ON j.id=h.job_id LEFT JOIN public.bases b ON b.id=h.base_id LEFT JOIN public.obstacles o ON o.id=h.obstacle_id
 WHERE h.id=NEW.id AND (j.id IS NULL OR b.id IS NULL OR o.id IS NULL OR j.kind<>'clear_obstacle'
 OR ROW(j.base_id,j.obstacle_id,j.started_at,j.finishes_at) IS DISTINCT FROM ROW(h.base_id,h.obstacle_id,h.started_at,h.scheduled_finish_at)
 OR j.completed_at IS NOT NULL OR j.cancelled_at IS NOT NULL OR o.base_id IS DISTINCT FROM h.base_id OR o.cleared_at IS NOT NULL
 OR b.owner_wallet IS DISTINCT FROM h.wallet OR b.status<>'active' OR b.deed_asset_id IS DISTINCT FROM h.deed_asset_id))
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_CAPTURE_MISMATCH';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;enrolled boolean;
BEGIN
 IF TG_RELID NOT IN ('public.builder_jobs'::regclass,'public.bases'::regclass,'public.obstacles'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_shards_obstacle_transition' OR TG_WHEN<>'BEFORE' OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF TG_RELID='public.builder_jobs'::regclass THEN
  changed:=ROW(NEW.id,NEW.player_wallet,NEW.base_id,NEW.kind,NEW.building_id,NEW.obstacle_id,NEW.started_at,NEW.finishes_at,NEW.completed_at,NEW.cancelled_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.player_wallet,OLD.base_id,OLD.kind,OLD.building_id,OLD.obstacle_id,OLD.started_at,OLD.finishes_at,OLD.completed_at,OLD.cancelled_at);
 ELSIF TG_RELID='public.bases'::regclass THEN
  changed:=ROW(NEW.id,NEW.owner_wallet,NEW.status,NEW.deed_asset_id) IS DISTINCT FROM ROW(OLD.id,OLD.owner_wallet,OLD.status,OLD.deed_asset_id);
 ELSIF TG_RELID='public.obstacles'::regclass THEN
  changed:=ROW(NEW.id,NEW.player_wallet,NEW.base_id,NEW.sprite_key,NEW.tx,NEW.ty,NEW.cleared_at) IS DISTINCT FROM ROW(OLD.id,OLD.player_wallet,OLD.base_id,OLD.sprite_key,OLD.tx,OLD.ty,OLD.cleared_at);
 ELSE RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF NOT changed THEN RETURN NEW;END IF;
 IF TG_RELID='public.builder_jobs'::regclass THEN SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE job_id=OLD.id) INTO enrolled;
 ELSIF TG_RELID='public.bases'::regclass THEN SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE base_id=OLD.id) INTO enrolled;
 ELSE SELECT EXISTS(SELECT 1 FROM public.shards_obstacle_obligations WHERE obstacle_id=OLD.id) INTO enrolled;END IF;
 IF enrolled THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRANSITION_HELD';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_shards_obstacle_transition_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shardkeep_shards_obstacle_assessment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE term_start timestamptz;
BEGIN
 IF TG_RELID NOT IN ('public.shards_tax_assessments'::regclass,'public.shards_cache_assessments'::regclass)
 OR TG_WHEN<>'BEFORE' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ISOLATION';END IF;
 INSERT INTO public.shards_tax_wallet_locks(wallet) VALUES(NEW.wallet) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.shards_tax_wallet_locks WHERE wallet=NEW.wallet FOR UPDATE;
 SELECT (snapshot->>'startsAt')::timestamptz INTO STRICT term_start FROM public.expedition_term_snapshots WHERE term_id=NEW.term_id AND snapshot_hash=NEW.term_hash;
 IF public.shardkeep_shards_obstacle_pending(NEW.wallet,term_start) THEN RAISE EXCEPTION 'SHARDS_OBSTACLE_ORDER_HELD';END IF;
 RETURN NEW;
END $$;
DO $$DECLARE t text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_obstacle_obligations'::regclass AND tgname='shards_obstacle_capture_guard') THEN CREATE TRIGGER shards_obstacle_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON shards_obstacle_obligations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_capture_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_obstacle_obligations'::regclass AND tgname='shards_obstacle_obligations_no_truncate') THEN CREATE TRIGGER shards_obstacle_obligations_no_truncate BEFORE TRUNCATE ON shards_obstacle_obligations FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_shards_obstacle_capture_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shards_obstacle_obligations'::regclass AND tgname='shards_obstacle_commit_guard') THEN CREATE CONSTRAINT TRIGGER shards_obstacle_commit_guard AFTER INSERT ON shards_obstacle_obligations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_commit_guard();END IF;
 FOREACH t IN ARRAY ARRAY['builder_jobs','bases','obstacles'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_shards_obstacle_transition') THEN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_transition_guard()',t||'_shards_obstacle_transition',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['shards_tax_assessments','shards_cache_assessments'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_obstacle_order_guard') THEN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_shards_obstacle_assessment_guard()',t||'_obstacle_order_guard',t);END IF;
 END LOOP;
END $$;
