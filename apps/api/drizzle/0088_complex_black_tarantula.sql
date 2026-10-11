SET lock_timeout = '10s';--> statement-breakpoint
CREATE TYPE "public"."withdrawal_attempt_status" AS ENUM('prepared', 'broadcast', 'finalized_success', 'finalized_error');--> statement-breakpoint
CREATE TABLE "withdrawal_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"withdrawal_id" uuid NOT NULL,
	"status" "withdrawal_attempt_status" DEFAULT 'prepared' NOT NULL,
	"tx_signature" text NOT NULL,
	"signed_transaction" "bytea" NOT NULL,
	"recent_blockhash" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"transfer_snapshot" jsonb NOT NULL,
	"broadcast_count" integer DEFAULT 0 NOT NULL,
	"first_broadcast_at" timestamp with time zone,
	"last_broadcast_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"absence_proof_sources" jsonb,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_attempts_withdrawal_id_unique" UNIQUE("withdrawal_id"),
	CONSTRAINT "withdrawal_attempts_tx_signature_unique" UNIQUE("tx_signature"),
	CONSTRAINT "withdrawal_attempts_broadcast_count_nonnegative" CHECK ("withdrawal_attempts"."broadcast_count" >= 0),
	CONSTRAINT "withdrawal_attempts_last_valid_height_nonnegative" CHECK ("withdrawal_attempts"."last_valid_block_height" >= 0),
	CONSTRAINT "withdrawal_attempts_terminal_finalized_at" CHECK (
    "withdrawal_attempts"."status" NOT IN ('finalized_success', 'finalized_error')
    OR "withdrawal_attempts"."finalized_at" IS NOT NULL
  )
);
--> statement-breakpoint
ALTER TABLE "withdrawal_attempts" ADD CONSTRAINT "withdrawal_attempts_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawal_attempts_status_idx" ON "withdrawal_attempts" USING btree ("status","updated_at");--> statement-breakpoint

-- Signed payout evidence is append-only. Application bugs and older binaries
-- may update retry diagnostics, but cannot replace the canonical wire bytes,
-- signature, blockhash or decoded economic intent after first persistence.
CREATE OR REPLACE FUNCTION guard_withdrawal_attempt_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'withdrawal attempt evidence is append-only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id
     OR NEW.tx_signature IS DISTINCT FROM OLD.tx_signature
     OR NEW.signed_transaction IS DISTINCT FROM OLD.signed_transaction
     OR NEW.recent_blockhash IS DISTINCT FROM OLD.recent_blockhash
     OR NEW.last_valid_block_height IS DISTINCT FROM OLD.last_valid_block_height
     OR NEW.transfer_snapshot IS DISTINCT FROM OLD.transfer_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'withdrawal attempt signed evidence is immutable';
  END IF;
  IF NEW.broadcast_count < OLD.broadcast_count THEN
    RAISE EXCEPTION 'withdrawal attempt broadcast count cannot decrease';
  END IF;
  IF OLD.first_broadcast_at IS NOT NULL
     AND NEW.first_broadcast_at IS DISTINCT FROM OLD.first_broadcast_at THEN
    RAISE EXCEPTION 'withdrawal attempt first broadcast time is immutable';
  END IF;
  IF OLD.status IN ('finalized_success', 'finalized_error')
     AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
       OR NEW.absence_proof_sources IS DISTINCT FROM OLD.absence_proof_sources) THEN
    RAISE EXCEPTION 'withdrawal attempt terminal evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION guard_withdrawal_attempt_evidence() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER withdrawal_attempt_evidence_guard
BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_attempts
FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_attempt_evidence();
--> statement-breakpoint
SET lock_timeout = '0';
