-- Hand-edited (0050/0084/0093 precedent). The repo migrator wraps pending
-- migrations in a transaction, where PostgreSQL cannot safely use an enum value
-- introduced by ALTER TYPE ADD VALUE. Recreate the one-column enum instead.
ALTER TYPE "public"."two_fa_purpose" RENAME TO "two_fa_purpose_old";
--> statement-breakpoint
CREATE TYPE "public"."two_fa_purpose" AS ENUM('enroll', 'withdraw', 'totp_recovery');
--> statement-breakpoint
ALTER TABLE "email_otps" ALTER COLUMN "purpose" TYPE "public"."two_fa_purpose"
  USING "purpose"::text::"public"."two_fa_purpose";
--> statement-breakpoint
DROP TYPE "public"."two_fa_purpose_old";
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "totp_reenrollment_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "delivery_lease_token" text;
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "delivery_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE TYPE "public"."totp_recovery_status" AS ENUM(
  'email_pending', 'holding', 'cancelled', 'completed', 'expired'
);
--> statement-breakpoint
CREATE TABLE "totp_recoveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "player_wallet" text NOT NULL,
  "started_session_id" uuid NOT NULL,
  "completed_session_id" uuid,
  "status" "totp_recovery_status" DEFAULT 'email_pending' NOT NULL,
  "target_email" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL,
  "confirmed_at" timestamp with time zone,
  "ready_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "cancelled_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_withdrawal_count" integer DEFAULT 0 NOT NULL,
  "in_flight_withdrawal_count" integer DEFAULT 0 NOT NULL,
  "refunded_keep" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "totp_recoveries_email_ck" CHECK (
    "target_email" = lower("target_email") AND length("target_email") BETWEEN 3 AND 254
  ),
  CONSTRAINT "totp_recoveries_refund_nonnegative_ck" CHECK (
    "cancelled_withdrawal_count" >= 0 AND "in_flight_withdrawal_count" >= 0
    AND "refunded_keep" >= 0
  ),
  CONSTRAINT "totp_recoveries_timeline_ck" CHECK (
    ("status" = 'email_pending'
      AND "confirmed_at" IS NULL AND "ready_at" IS NULL
      AND "expires_at" > "requested_at"
      AND "cancelled_at" IS NULL AND "completed_at" IS NULL
      AND "completed_session_id" IS NULL)
    OR ("status" = 'holding'
      AND "confirmed_at" >= "requested_at" AND "ready_at" > "confirmed_at"
      AND "expires_at" > "ready_at"
      AND "cancelled_at" IS NULL AND "completed_at" IS NULL
      AND "completed_session_id" IS NULL)
    OR ("status" = 'cancelled'
      AND "cancelled_at" >= "requested_at" AND "completed_at" IS NULL
      AND "completed_session_id" IS NULL)
    OR ("status" = 'completed'
      AND "confirmed_at" IS NOT NULL AND "ready_at" IS NOT NULL
      AND "expires_at" IS NOT NULL AND "completed_at" >= "ready_at"
      AND "completed_at" < "expires_at" AND "completed_session_id" IS NOT NULL
      AND "cancelled_at" IS NULL)
    OR ("status" = 'expired'
      AND "expires_at" IS NOT NULL AND "completed_at" IS NULL
      AND (("confirmed_at" IS NULL AND "ready_at" IS NULL)
        OR ("confirmed_at" IS NOT NULL AND "ready_at" IS NOT NULL))
      AND "cancelled_at" IS NULL AND "completed_session_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "totp_recoveries" ADD CONSTRAINT "totp_recoveries_player_wallet_players_wallet_fk"
  FOREIGN KEY ("player_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "totp_recoveries" ADD CONSTRAINT "totp_recoveries_started_session_id_sessions_id_fk"
  FOREIGN KEY ("started_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "totp_recoveries" ADD CONSTRAINT "totp_recoveries_completed_session_id_sessions_id_fk"
  FOREIGN KEY ("completed_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "totp_recoveries_one_active_wallet_uq"
  ON "totp_recoveries" USING btree ("player_wallet")
  WHERE "status" IN ('email_pending', 'holding');
--> statement-breakpoint
CREATE INDEX "totp_recoveries_wallet_requested_idx"
  ON "totp_recoveries" USING btree ("player_wallet", "requested_at");
--> statement-breakpoint
-- Recovery and payout must share one lock graph. The pre-0098 allowance
-- function began at its cap lock, while application recovery begins at the
-- wallet lock. Acquire the same wallet advisory lock first, then keep the
-- existing cap -> withdrawal -> reservation ordering and all fail-closed
-- ownership checks byte-for-byte.
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
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('shardkeep:withdrawal-wallet'), pg_catalog.hashtext(p_wallet)
  );
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
-- 0089 deliberately left a terminal row unchanged when it found prepared or
-- broadcast evidence. For recovery, silent success is unsafe: the API could
-- report a refund while the allowance remains reserved and signed bytes exist.
-- Preserve finalized-error recovery, but abort every other terminal transition
-- so the outer status+ledger transaction rolls back atomically.
CREATE OR REPLACE FUNCTION public.shardkeep_release_terminal_withdrawal_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status::text IN ('cancelled', 'refunded', 'failed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF EXISTS (SELECT 1 FROM public.withdrawal_attempts
      WHERE withdrawal_id = NEW.id AND status::text <> 'finalized_error') THEN
      RAISE EXCEPTION 'terminal withdrawal transition conflicts with active payout evidence'
        USING ERRCODE = '42501';
    END IF;
    UPDATE public.withdrawal_payout_reservations
      SET status = 'released', updated_at = pg_catalog.statement_timestamp()
      WHERE withdrawal_id = NEW.id AND status = 'reserved';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_release_terminal_withdrawal_reservation() FROM PUBLIC;
