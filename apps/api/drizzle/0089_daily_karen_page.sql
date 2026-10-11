SET lock_timeout = '10s';
--> statement-breakpoint
CREATE TABLE "economy_chain_identity" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"cluster" text NOT NULL,
	"keep_mint" text NOT NULL,
	"core_program" text NOT NULL,
	"config_pda" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economy_chain_identity_singleton_ck" CHECK ("economy_chain_identity"."singleton" = true),
	CONSTRAINT "economy_chain_identity_cluster_ck" CHECK ("economy_chain_identity"."cluster" IN ('devnet', 'mainnet-beta')),
	CONSTRAINT "economy_chain_identity_addresses_ck" CHECK (
    "economy_chain_identity"."keep_mint" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND "economy_chain_identity"."core_program" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND "economy_chain_identity"."config_pda" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_guard_economy_chain_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'database economy chain identity is immutable';
  END IF;
  NEW.bound_at := statement_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_economy_chain_identity() FROM PUBLIC;
CREATE TRIGGER economy_chain_identity_guard BEFORE INSERT OR UPDATE OR DELETE
ON economy_chain_identity FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_economy_chain_identity();
--> statement-breakpoint
CREATE TABLE "withdrawal_authorizations" (
	"withdrawal_id" uuid PRIMARY KEY NOT NULL,
	"challenge_token" text NOT NULL,
	"wallet_signature" text NOT NULL,
	"cluster" text NOT NULL,
	"keep_mint" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_digest" text,
	"validated_at" timestamp with time zone,
	CONSTRAINT "withdrawal_authorizations_validated_digest_unique" UNIQUE("validated_digest"),
	CONSTRAINT "withdrawal_authorizations_challenge_size_ck" CHECK (
    length("withdrawal_authorizations"."challenge_token") BETWEEN 32 AND 4096
  ),
	CONSTRAINT "withdrawal_authorizations_signature_shape_ck" CHECK (
    length("withdrawal_authorizations"."wallet_signature") BETWEEN 80 AND 100
    AND "withdrawal_authorizations"."wallet_signature" ~ '^[1-9A-HJ-NP-Za-km-z]+$'
  ),
	CONSTRAINT "withdrawal_authorizations_cluster_ck" CHECK ("withdrawal_authorizations"."cluster" IN ('devnet', 'mainnet-beta')),
	CONSTRAINT "withdrawal_authorizations_mint_shape_ck" CHECK (
    length("withdrawal_authorizations"."keep_mint") BETWEEN 32 AND 44
    AND "withdrawal_authorizations"."keep_mint" ~ '^[1-9A-HJ-NP-Za-km-z]+$'
  ),
	CONSTRAINT "withdrawal_authorizations_validation_pair_ck" CHECK (
    ("withdrawal_authorizations"."validated_digest" IS NULL AND "withdrawal_authorizations"."validated_at" IS NULL)
    OR ("withdrawal_authorizations"."validated_digest" ~ '^[0-9a-f]{64}$' AND "withdrawal_authorizations"."validated_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "withdrawal_payout_reservations" (
	"withdrawal_id" uuid PRIMARY KEY NOT NULL,
	"player_wallet" text NOT NULL,
	"gross_keep" bigint NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_payout_reservations_gross_positive_ck" CHECK ("withdrawal_payout_reservations"."gross_keep" > 0),
	CONSTRAINT "withdrawal_payout_reservations_status_ck" CHECK (
    "withdrawal_payout_reservations"."status" IN ('reserved', 'sent', 'released')
  )
);
--> statement-breakpoint
ALTER TABLE "withdrawal_authorizations" ADD CONSTRAINT "withdrawal_authorizations_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_payout_reservations" ADD CONSTRAINT "withdrawal_payout_reservations_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_payout_reservations" ADD CONSTRAINT "withdrawal_payout_reservations_player_wallet_players_wallet_fk" FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawal_payout_reservations_wallet_window_idx" ON "withdrawal_payout_reservations" USING btree ("player_wallet","reserved_at","status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_guard_withdrawal_authorization()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'withdrawal authorization evidence is append-only'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.submitted_at := statement_timestamp();
    NEW.validated_digest := NULL; NEW.validated_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id
     OR NEW.challenge_token IS DISTINCT FROM OLD.challenge_token
     OR NEW.wallet_signature IS DISTINCT FROM OLD.wallet_signature
     OR NEW.cluster IS DISTINCT FROM OLD.cluster OR NEW.keep_mint IS DISTINCT FROM OLD.keep_mint
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'raw withdrawal authorization evidence is immutable';
  END IF;
  IF OLD.validated_digest IS NOT NULL OR NEW.validated_digest IS NULL OR NEW.validated_at IS NULL THEN
    RAISE EXCEPTION 'withdrawal authorization may be validated exactly once';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_withdrawal_authorization() FROM PUBLIC;
CREATE TRIGGER withdrawal_authorization_guard BEFORE INSERT OR UPDATE OR DELETE
ON withdrawal_authorizations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_withdrawal_authorization();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_guard_withdrawal_payout_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'withdrawal payout reservation evidence is append-only'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' THEN RAISE EXCEPTION 'new payout reservation must be reserved'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id
     OR NEW.player_wallet IS DISTINCT FROM OLD.player_wallet
     OR NEW.gross_keep IS DISTINCT FROM OLD.gross_keep
     OR NOT (
       (OLD.status = 'reserved' AND NEW.status IN ('sent', 'released')
         AND NEW.reserved_at IS NOT DISTINCT FROM OLD.reserved_at
         AND NEW.updated_at >= OLD.updated_at)
       OR (OLD.status = 'reserved' AND NEW.status = 'reserved'
         AND NEW.reserved_at >= OLD.reserved_at AND NEW.updated_at >= OLD.updated_at)
       OR (OLD.status = 'released' AND NEW.status = 'reserved'
         AND NEW.reserved_at >= OLD.reserved_at AND NEW.updated_at >= OLD.updated_at
         AND EXISTS (SELECT 1 FROM public.withdrawals w WHERE w.id = OLD.withdrawal_id
           AND w.status::text = 'unbonding')
         AND NOT EXISTS (SELECT 1 FROM public.withdrawal_attempts a
           WHERE a.withdrawal_id = OLD.withdrawal_id))
     ) THEN
    RAISE EXCEPTION 'invalid payout reservation transition';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_guard_withdrawal_payout_reservation() FROM PUBLIC;
CREATE TRIGGER withdrawal_payout_reservation_guard BEFORE INSERT OR UPDATE OR DELETE
ON withdrawal_payout_reservations FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_withdrawal_payout_reservation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_reserve_withdrawal_allowance(
  p_withdrawal_id uuid, p_wallet text, p_gross bigint, p_cap bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  trusted_now constant timestamptz := pg_catalog.statement_timestamp();
  existing public.withdrawal_payout_reservations%ROWTYPE;
  existing_found boolean;
  frozen public.withdrawals%ROWTYPE;
  used bigint;
BEGIN
  IF p_gross <= 0 OR p_cap <= 0 THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('withdrawal-cap:' || p_wallet, 0));
  SELECT * INTO frozen FROM public.withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR frozen.status::text <> 'unbonding' OR frozen.player_wallet <> p_wallet
     OR frozen.amount <> p_gross THEN RETURN false; END IF;
  SELECT * INTO existing FROM public.withdrawal_payout_reservations WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;
  existing_found := FOUND;
  IF existing_found AND (existing.player_wallet <> p_wallet OR existing.gross_keep <> p_gross) THEN RETURN false; END IF;
  IF existing_found AND existing.status = 'sent' THEN RETURN true; END IF;
  IF existing_found AND existing.status = 'reserved'
     AND existing.reserved_at > trusted_now - interval '24 hours'
     AND existing.reserved_at <= trusted_now THEN RETURN true; END IF;
  IF existing_found AND existing.status = 'reserved' AND existing.reserved_at > trusted_now THEN RETURN false; END IF;
  SELECT COALESCE(pg_catalog.sum(gross_keep), 0) INTO used FROM public.withdrawal_payout_reservations
  WHERE player_wallet = p_wallet AND status IN ('reserved', 'sent')
    AND withdrawal_id <> p_withdrawal_id
    -- Count future-dated rows fail-closed. statement_timestamp() is fixed when
    -- this statement starts, before the advisory lock is acquired; a later
    -- statement can win the lock and commit a reservation whose timestamp is
    -- newer than this call's trusted_now.
    AND reserved_at > trusted_now - interval '24 hours';
  IF used + p_gross > p_cap THEN RETURN false; END IF;
  IF existing_found AND existing.status IN ('released', 'reserved') THEN
    UPDATE public.withdrawal_payout_reservations
      SET status = 'reserved', reserved_at = trusted_now, updated_at = trusted_now
      WHERE withdrawal_id = p_withdrawal_id;
    RETURN true;
  END IF;
  INSERT INTO public.withdrawal_payout_reservations(
    withdrawal_id, player_wallet, gross_keep, status, reserved_at, updated_at
  ) VALUES (p_withdrawal_id, p_wallet, p_gross, 'reserved', trusted_now, trusted_now);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_finalize_withdrawal_allowance(p_withdrawal_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status FROM public.withdrawal_payout_reservations
    WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF current_status = 'sent' THEN RETURN true; END IF;
  IF current_status <> 'reserved' THEN RETURN false; END IF;
  UPDATE public.withdrawal_payout_reservations SET status = 'sent', updated_at = pg_catalog.statement_timestamp()
    WHERE withdrawal_id = p_withdrawal_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_finalize_withdrawal_allowance(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_release_withdrawal_allowance(p_withdrawal_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE current_status text;
BEGIN
  SELECT status INTO current_status FROM public.withdrawal_payout_reservations
    WHERE withdrawal_id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR current_status = 'released' THEN RETURN true; END IF;
  IF current_status <> 'reserved' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.withdrawal_attempts WHERE withdrawal_id = p_withdrawal_id
       AND status::text <> 'finalized_error')
     OR NOT EXISTS (SELECT 1 FROM public.withdrawals WHERE id = p_withdrawal_id
       AND status::text IN ('unbonding', 'failed', 'cancelled', 'refunded')) THEN RETURN false; END IF;
  UPDATE public.withdrawal_payout_reservations SET status = 'released', updated_at = pg_catalog.statement_timestamp()
    WHERE withdrawal_id = p_withdrawal_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_release_withdrawal_allowance(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_release_terminal_withdrawal_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status::text IN ('cancelled', 'refunded', 'failed')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT EXISTS (SELECT 1 FROM public.withdrawal_attempts
       WHERE withdrawal_id = NEW.id AND status::text <> 'finalized_error') THEN
    UPDATE public.withdrawal_payout_reservations
      SET status = 'released', updated_at = pg_catalog.statement_timestamp()
      WHERE withdrawal_id = NEW.id AND status = 'reserved';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_release_terminal_withdrawal_reservation() FROM PUBLIC;
CREATE TRIGGER withdrawal_terminal_reservation_release AFTER UPDATE OF status ON withdrawals
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_release_terminal_withdrawal_reservation();
--> statement-breakpoint
INSERT INTO withdrawal_payout_reservations(
  withdrawal_id, player_wallet, gross_keep, status, reserved_at, updated_at
)
SELECT w.id, w.player_wallet, w.amount, 'reserved', a.created_at, statement_timestamp()
FROM withdrawals w JOIN withdrawal_attempts a ON a.withdrawal_id = w.id
WHERE w.status::text = 'processing' AND w.amount > 0
  AND a.status::text IN ('prepared', 'broadcast')
ON CONFLICT (withdrawal_id) DO NOTHING;
--> statement-breakpoint
-- Preserve the rolling payout window across the upgrade. Request timestamps
-- are deliberately irrelevant here: a standard request may be a day old by
-- the time its transfer finalizes.
INSERT INTO withdrawal_payout_reservations(
  withdrawal_id, player_wallet, gross_keep, status, reserved_at, updated_at
)
SELECT w.id, w.player_wallet, w.amount, 'reserved', w.completed_at, statement_timestamp()
FROM withdrawals w
WHERE w.status::text = 'sent' AND w.amount > 0 AND w.tx_signature IS NOT NULL
  AND w.completed_at > statement_timestamp() - interval '24 hours'
  AND w.completed_at <= statement_timestamp()
ON CONFLICT (withdrawal_id) DO NOTHING;
UPDATE withdrawal_payout_reservations r SET status = 'sent', updated_at = statement_timestamp()
FROM withdrawals w
WHERE r.withdrawal_id = w.id AND r.status = 'reserved'
  AND w.status::text = 'sent' AND w.tx_signature IS NOT NULL
  AND w.completed_at > statement_timestamp() - interval '24 hours'
  AND w.completed_at <= statement_timestamp();
--> statement-breakpoint
SET lock_timeout = '0';
