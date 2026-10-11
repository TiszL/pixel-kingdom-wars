-- D-109: additive wallet-private plans and atomic batch receipts. No balances
-- or historical queues are rewritten. Slot/name/input bounds live in shared
-- TRAINING_PRESETS and are checked at both HTTP and service boundaries.
CREATE TABLE army_presets (
  player_wallet text NOT NULL REFERENCES players(wallet),
  slot integer NOT NULL,
  name text NOT NULL,
  composition jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_wallet, slot)
);
--> statement-breakpoint
CREATE TABLE army_training_batches (
  player_wallet text NOT NULL REFERENCES players(wallet),
  idempotency_key text NOT NULL,
  base_id uuid REFERENCES bases(id),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_wallet, idempotency_key)
);
