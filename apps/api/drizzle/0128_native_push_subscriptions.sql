-- D-134: delivery consent only. Existing push_events remains the sole event ledger.
CREATE TABLE native_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL REFERENCES players(wallet),
  token text NOT NULL UNIQUE,
  binding_id uuid NOT NULL,
  package_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  CONSTRAINT native_push_subscriptions_failures_ck CHECK (failures >= 0),
  CONSTRAINT native_push_subscriptions_token_ck CHECK (length(token) BETWEEN 1 AND 2048 AND token ~ '^[!-~]+$'),
  CONSTRAINT native_push_subscriptions_package_ck CHECK (package_name IN ('gg.pixelkingdomwars.twa', 'gg.pixelkingdomwars.twa.debug'))
);
--> statement-breakpoint
CREATE INDEX native_push_subscriptions_live_wallet_idx ON native_push_subscriptions(wallet, enabled_at) WHERE disabled_at IS NULL;
--> statement-breakpoint
-- A token row cannot remember DELETE-before-first-POST or an old binding after
-- that token changes binding. Tombstones belong to the wallet's consent UUID.
CREATE TABLE native_push_revocations (
  wallet text NOT NULL REFERENCES players(wallet),
  binding_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, binding_id)
);
--> statement-breakpoint
-- Retired capabilities stay owned. Even an accidental future upsert must not
-- turn possession of another wallet's token into permission to read its events.
CREATE FUNCTION guard_native_push_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.wallet IS DISTINCT FROM OLD.wallet OR NEW.token IS DISTINCT FROM OLD.token THEN
      RAISE EXCEPTION 'native push capability identity is immutable';
    END IF;
  END IF;
  IF NEW.disabled_at IS NULL AND EXISTS (
    SELECT 1 FROM native_push_revocations WHERE wallet = NEW.wallet AND binding_id = NEW.binding_id
  ) THEN
    RAISE EXCEPTION 'native push binding consent is revoked';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER native_push_owner_guard BEFORE INSERT OR UPDATE ON native_push_subscriptions
FOR EACH ROW EXECUTE FUNCTION guard_native_push_owner();
