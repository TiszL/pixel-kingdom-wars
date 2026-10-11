-- D153.263/D153.290; 6672bf72 reserves this tag. Journal idx/when assigned by integrator.
CREATE TABLE devnet_skr_faucet_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet text NOT NULL REFERENCES players(wallet),
 base_id uuid NOT NULL REFERENCES bases(id), deed_asset_id text NOT NULL, day date NOT NULL, mint text NOT NULL,
 decimals integer NOT NULL CONSTRAINT devnet_skr_faucet_decimals_ck CHECK (decimals BETWEEN 0 AND 19),
 amount_raw numeric(20,0) NOT NULL CONSTRAINT devnet_skr_faucet_amount_ck CHECK (amount_raw > 0 AND amount_raw <= 18446744073709551615),
 status text NOT NULL DEFAULT 'requested' CONSTRAINT devnet_skr_faucet_status_ck CHECK (status IN ('requested','sent','failed')),
 error text CONSTRAINT devnet_skr_faucet_error_ck CHECK (error IS NULL OR error ~ '^[a-z_]{1,64}$'),
 requested_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 CONSTRAINT devnet_skr_faucet_wallet_day_uq UNIQUE(wallet,day),
 CONSTRAINT devnet_skr_faucet_deed_day_uq UNIQUE(deed_asset_id,day),
 CONSTRAINT devnet_skr_faucet_day_ck CHECK(day=(requested_at AT TIME ZONE 'UTC')::date),
 CONSTRAINT devnet_skr_faucet_sent_ck CHECK((status='sent')=(sent_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX devnet_skr_faucet_pending_idx ON devnet_skr_faucet_grants(status,requested_at);
--> statement-breakpoint
CREATE TABLE devnet_skr_faucet_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grant_id uuid NOT NULL REFERENCES devnet_skr_faucet_grants(id),
 attempt_no integer NOT NULL CONSTRAINT devnet_skr_faucet_attempt_no_ck CHECK (attempt_no >= 1),
 phase text NOT NULL DEFAULT 'prepared' CONSTRAINT devnet_skr_faucet_phase_ck CHECK (phase IN ('prepared','player_signed','submitted','finalized','failed','expired','abandoned')),
 message bytea NOT NULL CONSTRAINT devnet_skr_faucet_message_ck CHECK(octet_length(message)>0 AND octet_length(message)<=1103),
 reference text NOT NULL UNIQUE, recent_blockhash text NOT NULL,
 last_valid_block_height bigint NOT NULL CONSTRAINT devnet_skr_faucet_height_ck CHECK(last_valid_block_height>0),
 player_wire bytea, signature text UNIQUE,
 mutation text CONSTRAINT devnet_skr_faucet_mutation_ck CHECK(mutation IS NULL OR mutation IN ('none','compute_budget_added')),
 faucet_wire bytea, landed_signature text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 CONSTRAINT devnet_skr_faucet_attempt_no_uq UNIQUE(grant_id,attempt_no),
 CONSTRAINT devnet_skr_faucet_wire_length_ck CHECK((player_wire IS NULL OR octet_length(player_wire)<=1232) AND (faucet_wire IS NULL OR octet_length(faucet_wire)<=1232)),
 CONSTRAINT devnet_skr_faucet_player_wire_ck CHECK((player_wire IS NULL)=(signature IS NULL) AND (player_wire IS NULL)=(mutation IS NULL)),
 CONSTRAINT devnet_skr_faucet_player_phase_ck CHECK(phase NOT IN ('player_signed','submitted','finalized','failed','expired') OR player_wire IS NOT NULL),
 CONSTRAINT devnet_skr_faucet_faucet_phase_ck CHECK((phase IN ('submitted','finalized','failed','expired'))=(faucet_wire IS NOT NULL)),
 CONSTRAINT devnet_skr_faucet_settled_ck CHECK((phase IN ('finalized','failed','expired','abandoned'))=(settled_at IS NOT NULL)),
 CONSTRAINT devnet_skr_faucet_landed_ck CHECK((phase IN ('finalized','failed'))=(landed_signature IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX devnet_skr_faucet_live_attempt_uq ON devnet_skr_faucet_attempts(grant_id) WHERE phase IN ('prepared','player_signed','submitted');
--> statement-breakpoint
CREATE FUNCTION shardkeep_devnet_skr_faucet_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'devnet SKR originals are retained'; END IF;
 IF TG_TABLE_NAME='devnet_skr_faucet_grants' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'requested' OR NEW.sent_at IS NOT NULL THEN RAISE EXCEPTION 'grant must begin requested'; END IF;
   RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.wallet,NEW.base_id,NEW.deed_asset_id,NEW.day,NEW.mint,NEW.decimals,NEW.amount_raw,NEW.requested_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.wallet,OLD.base_id,OLD.deed_asset_id,OLD.day,OLD.mint,OLD.decimals,OLD.amount_raw,OLD.requested_at)
    THEN RAISE EXCEPTION 'grant original is immutable'; END IF;
  IF OLD.status<>'requested' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal grant is immutable'; END IF;
  IF NEW.status='sent' AND NOT EXISTS(SELECT 1 FROM public.devnet_skr_faucet_attempts WHERE grant_id=NEW.id AND phase='finalized')
    THEN RAISE EXCEPTION 'sent grant needs a finalized attempt'; END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   IF NEW.phase<>'prepared' OR NEW.player_wire IS NOT NULL OR NEW.faucet_wire IS NOT NULL OR NEW.landed_signature IS NOT NULL
     THEN RAISE EXCEPTION 'attempt must begin prepared'; END IF;
   RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.grant_id,NEW.attempt_no,NEW.message,NEW.reference,NEW.recent_blockhash,NEW.last_valid_block_height,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.grant_id,OLD.attempt_no,OLD.message,OLD.reference,OLD.recent_blockhash,OLD.last_valid_block_height,OLD.created_at)
    THEN RAISE EXCEPTION 'attempt original is immutable'; END IF;
  IF (OLD.player_wire IS NOT NULL AND NEW.player_wire IS DISTINCT FROM OLD.player_wire)
    OR (OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature)
    OR (OLD.mutation IS NOT NULL AND NEW.mutation IS DISTINCT FROM OLD.mutation)
    OR (OLD.faucet_wire IS NOT NULL AND NEW.faucet_wire IS DISTINCT FROM OLD.faucet_wire)
    OR (OLD.landed_signature IS NOT NULL AND NEW.landed_signature IS DISTINCT FROM OLD.landed_signature)
    THEN RAISE EXCEPTION 'signed original is immutable'; END IF;
  IF OLD.phase IN ('finalized','failed','expired','abandoned') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal attempt is immutable'; END IF;
  IF NEW.phase<>OLD.phase AND NOT (
    OLD.phase='prepared' AND NEW.phase IN ('player_signed','abandoned') OR
    OLD.phase='player_signed' AND NEW.phase IN ('submitted','abandoned') OR
    OLD.phase='submitted' AND NEW.phase IN ('finalized','failed','expired'))
    THEN RAISE EXCEPTION 'attempt phase must advance'; END IF;
  IF NEW.phase=OLD.phase AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'attempt writes require a phase transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER devnet_skr_faucet_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON devnet_skr_faucet_grants
 FOR EACH ROW EXECUTE FUNCTION shardkeep_devnet_skr_faucet_guard();
--> statement-breakpoint
CREATE TRIGGER devnet_skr_faucet_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON devnet_skr_faucet_attempts
 FOR EACH ROW EXECUTE FUNCTION shardkeep_devnet_skr_faucet_guard();
