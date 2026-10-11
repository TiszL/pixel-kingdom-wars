-- Prospective physical Mine source history; no legacy backfill or early mint.
CREATE TABLE IF NOT EXISTS shards_mine_admissions (
 id uuid PRIMARY KEY,wallet text NOT NULL REFERENCES players(wallet),base_id uuid NOT NULL REFERENCES bases(id),
 admitted_at timestamptz NOT NULL,term_id uuid NOT NULL,term_hash text NOT NULL,observation jsonb NOT NULL,
 mine_ids uuid[] NOT NULL,CHECK(isfinite(admitted_at)),
 FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash)
);
CREATE TABLE IF NOT EXISTS shards_mine_eras (
 mine_id uuid PRIMARY KEY REFERENCES buildings(id),base_id uuid NOT NULL REFERENCES bases(id),
 admitted_at timestamptz NOT NULL,legacy_gross bigint NOT NULL CHECK(legacy_gross>=0),CHECK(isfinite(admitted_at))
);
CREATE TABLE IF NOT EXISTS shards_mine_heads (
 mine_id uuid PRIMARY KEY REFERENCES shards_mine_eras(mine_id),admission_id uuid NOT NULL REFERENCES shards_mine_admissions(id),quota bigint NOT NULL CHECK(quota>=0)
);
CREATE TABLE IF NOT EXISTS shards_mine_closures (
 admission_id uuid NOT NULL REFERENCES shards_mine_admissions(id),mine_id uuid NOT NULL REFERENCES shards_mine_eras(mine_id),
 closed_at timestamptz NOT NULL,reason text NOT NULL CHECK(reason IN ('replacement','custody_change')),
 PRIMARY KEY(admission_id,mine_id),CHECK(isfinite(closed_at))
);
CREATE TABLE IF NOT EXISTS shards_mine_segments (
 id uuid PRIMARY KEY,mine_id uuid NOT NULL REFERENCES shards_mine_eras(mine_id),base_id uuid NOT NULL REFERENCES bases(id),
 admission_id uuid REFERENCES shards_mine_admissions(id),wallet text REFERENCES players(wallet),
 ownership_status text NOT NULL DEFAULT 'confirmed' CHECK(ownership_status IN ('confirmed','custody_unresolved')),
 source_key text NOT NULL UNIQUE,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 quota bigint NOT NULL CHECK(quota>=0),anchor_at timestamptz,first_unit bigint,last_unit bigint,
 gross bigint NOT NULL CHECK(gross>0),
 buffer bigint NOT NULL CHECK(buffer>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),
 issued bigint NOT NULL DEFAULT 0 CHECK(issued>=0),discarded bigint NOT NULL DEFAULT 0 CHECK(discarded>=0),
 CHECK(buffer::numeric+reserved+issued+discarded=gross),CHECK(isfinite(starts_at) AND isfinite(ends_at) AND ends_at>=starts_at),
 CHECK(admission_id IS NULL OR (wallet IS NOT NULL AND ownership_status='confirmed')),
 CHECK((wallet IS NULL AND anchor_at IS NULL AND first_unit IS NULL AND last_unit IS NULL) OR
 (wallet IS NOT NULL AND anchor_at IS NOT NULL AND first_unit IS NOT NULL AND last_unit IS NOT NULL AND isfinite(anchor_at) AND first_unit>0 AND last_unit>=first_unit AND last_unit-first_unit+1=gross))
);
CREATE INDEX IF NOT EXISTS shards_mine_segments_buffer ON shards_mine_segments(mine_id,starts_at,id) WHERE buffer>0;
CREATE TABLE IF NOT EXISTS shards_mine_custody_boundaries (
 id text PRIMARY KEY,base_id uuid NOT NULL REFERENCES bases(id),recorded_wallet text NOT NULL,
 observed_wallet text NOT NULL,event_at timestamptz NOT NULL,observed_at timestamptz NOT NULL,
 observed_slot bigint,source text NOT NULL,proven_transfer_at timestamptz,
 CHECK(isfinite(event_at) AND isfinite(observed_at)),CHECK(observed_slot IS NULL OR observed_slot>=0),
 CHECK(proven_transfer_at IS NULL)
);
CREATE TABLE IF NOT EXISTS shards_mine_held_projections (
 mine_id uuid NOT NULL REFERENCES shards_mine_eras(mine_id),state_version integer NOT NULL,at timestamptz NOT NULL,
 wallet text NOT NULL REFERENCES players(wallet),anchor_at timestamptz NOT NULL,quota bigint NOT NULL CHECK(quota>=0),
 previous_gross bigint NOT NULL CHECK(previous_gross>=0),projected_gross bigint NOT NULL CHECK(projected_gross>=previous_gross),
 PRIMARY KEY(mine_id,state_version,at),CHECK(isfinite(at) AND isfinite(anchor_at))
);
CREATE TABLE IF NOT EXISTS shards_mine_raid_eras (raid_id uuid NOT NULL REFERENCES raid_loot_reservations(raid_id),mine_id uuid NOT NULL REFERENCES shards_mine_eras(mine_id),gross bigint NOT NULL CHECK(gross>=0),PRIMARY KEY(raid_id,mine_id));
CREATE TABLE IF NOT EXISTS shards_mine_reservations (
 raid_id uuid NOT NULL REFERENCES raid_loot_reservations(raid_id),segment_id uuid NOT NULL REFERENCES shards_mine_segments(id),
 gross bigint NOT NULL CHECK(gross>0),restored bigint,awarded bigint,discarded bigint,
 PRIMARY KEY(raid_id,segment_id),CHECK((restored IS NULL AND awarded IS NULL AND discarded IS NULL) OR
 (restored IS NOT NULL AND awarded IS NOT NULL AND discarded IS NOT NULL AND restored>=0 AND awarded>=0 AND discarded>=0 AND restored::numeric+awarded+discarded=gross))
);
CREATE TABLE IF NOT EXISTS shards_mine_dispositions (
 operation_key text NOT NULL,segment_id uuid NOT NULL REFERENCES shards_mine_segments(id),
 kind text NOT NULL CHECK(kind IN ('capacity_discard')),gross bigint NOT NULL CHECK(gross>0),
 at timestamptz NOT NULL CHECK(isfinite(at)),PRIMARY KEY(operation_key,segment_id)
);
CREATE TABLE IF NOT EXISTS shards_tax_wallet_locks(wallet text PRIMARY KEY REFERENCES players(wallet));
CREATE TABLE IF NOT EXISTS shards_mine_deliveries (
 operation_key text NOT NULL,segment_id uuid NOT NULL REFERENCES shards_mine_segments(id),
 destination_base_id uuid NOT NULL REFERENCES bases(id),gross bigint NOT NULL CHECK(gross>0),
 net bigint NOT NULL CHECK(net>=0),tax bigint NOT NULL CHECK(tax>=0),ledger_id uuid NOT NULL REFERENCES ledger_transactions(id),
 PRIMARY KEY(operation_key,segment_id),CHECK(net::numeric+tax=gross)
);
CREATE TABLE IF NOT EXISTS shards_tax_assessments (
 operation_key text NOT NULL,segment_id uuid NOT NULL REFERENCES shards_mine_segments(id),
 wallet text NOT NULL REFERENCES players(wallet),wallet_sequence bigint NOT NULL CHECK(wallet_sequence>0),
 lineage text NOT NULL,gross bigint NOT NULL CHECK(gross>0),net bigint NOT NULL CHECK(net>=0),tax bigint NOT NULL CHECK(tax>=0),
 carry_before bigint NOT NULL CHECK(carry_before>=0),carry_after bigint NOT NULL CHECK(carry_after>=0),
 term_id uuid NOT NULL,term_hash text NOT NULL,ledger_id uuid NOT NULL REFERENCES ledger_transactions(id),receipt jsonb NOT NULL,
 PRIMARY KEY(operation_key,segment_id),UNIQUE(wallet,lineage,wallet_sequence),CHECK(net::numeric+tax=gross),
 FOREIGN KEY(term_id,term_hash) REFERENCES expedition_term_snapshots(term_id,snapshot_hash),
 FOREIGN KEY(operation_key,segment_id) REFERENCES shards_mine_deliveries(operation_key,segment_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shardkeep_shards_mine_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SHARDS_MINE_HISTORY_IMMUTABLE';END $$;
CREATE OR REPLACE FUNCTION shardkeep_shards_mine_segment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SHARDS_MINE_HISTORY_IMMUTABLE';END IF;
 IF (to_jsonb(NEW)-ARRAY['buffer','reserved','issued','discarded']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['buffer','reserved','issued','discarded'])
 OR NEW.issued<OLD.issued OR NEW.discarded<OLD.discarded THEN RAISE EXCEPTION 'SHARDS_MINE_ORIGINAL_CHANGED';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION shardkeep_shards_mine_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.restored IS NOT NULL OR (to_jsonb(NEW)-ARRAY['restored','awarded','discarded']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['restored','awarded','discarded'])
 THEN RAISE EXCEPTION 'SHARDS_MINE_RESERVATION_CHANGED';END IF;RETURN NEW;
END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['shards_mine_custody_boundaries','shards_mine_held_projections','shards_mine_admissions','shards_mine_eras','shards_mine_closures','shards_mine_raid_eras','shards_mine_dispositions','shards_mine_deliveries','shards_tax_assessments'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_immutable') THEN EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION shardkeep_shards_mine_immutable()',t||'_immutable',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['shards_mine_custody_boundaries','shards_mine_held_projections','shards_mine_admissions','shards_mine_eras','shards_mine_closures','shards_mine_raid_eras','shards_mine_segments','shards_mine_reservations','shards_mine_dispositions','shards_mine_deliveries','shards_tax_assessments'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_no_truncate') THEN EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION shardkeep_shards_mine_immutable()',t||'_no_truncate',t);END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='shards_mine_segments'::regclass AND tgname='shards_mine_segments_guard') THEN CREATE TRIGGER shards_mine_segments_guard BEFORE UPDATE OR DELETE ON shards_mine_segments FOR EACH ROW EXECUTE FUNCTION shardkeep_shards_mine_segment_guard();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='shards_mine_reservations'::regclass AND tgname='shards_mine_reservations_guard') THEN CREATE TRIGGER shards_mine_reservations_guard BEFORE UPDATE OR DELETE ON shards_mine_reservations FOR EACH ROW EXECUTE FUNCTION shardkeep_shards_mine_reservation_guard();END IF;
END $$;
