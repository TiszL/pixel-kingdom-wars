-- An explicit wallet-confirmed close excludes all delayed batch acceptance.
-- Existing receipts, queues and balances are unchanged. Both writers serialize
-- on players FOR UPDATE, including the first insert of an absent key.
CREATE TABLE army_training_batch_closures (
  player_wallet text NOT NULL REFERENCES players(wallet),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_wallet, idempotency_key)
);
--> statement-breakpoint
-- Old API binaries do not check closures before enqueueing. They still insert
-- the batch receipt in the SAME transaction as every unit/debit. Rejecting that
-- receipt rolls the entire purchase back, including during API rollback.
CREATE FUNCTION guard_training_batch_terminal_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM wallet FROM players WHERE wallet = NEW.player_wallet FOR UPDATE;
  IF TG_TABLE_NAME = 'army_training_batches' THEN
    IF EXISTS (SELECT 1 FROM army_training_batch_closures
      WHERE player_wallet = NEW.player_wallet AND idempotency_key = NEW.idempotency_key) THEN
      RAISE EXCEPTION 'training request key is permanently closed'
        USING ERRCODE = '23514', CONSTRAINT = 'training_batch_key_closed';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM army_training_batches
      WHERE player_wallet = NEW.player_wallet AND idempotency_key = NEW.idempotency_key) THEN
      RAISE EXCEPTION 'accepted training request cannot be closed'
        USING ERRCODE = '23514', CONSTRAINT = 'training_batch_key_accepted';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER training_batch_acceptance_guard BEFORE INSERT ON army_training_batches
FOR EACH ROW EXECUTE FUNCTION guard_training_batch_terminal_key();
--> statement-breakpoint
CREATE TRIGGER training_batch_closure_guard BEFORE INSERT ON army_training_batch_closures
FOR EACH ROW EXECUTE FUNCTION guard_training_batch_terminal_key();
