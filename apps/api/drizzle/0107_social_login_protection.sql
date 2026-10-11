-- D-109: additive identity binding and optional login protection. No existing
-- account is enrolled automatically, and balances/game identities do not move.
ALTER TABLE players ADD COLUMN login_totp_required boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN scope text NOT NULL DEFAULT 'full';
ALTER TABLE sessions ADD COLUMN login_mfa_at timestamptz;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_ck CHECK (scope IN ('full', 'login_pending'));
CREATE TABLE privy_identities (
  subject text PRIMARY KEY,
  wallet text NOT NULL UNIQUE REFERENCES players(wallet),
  created_at timestamptz NOT NULL DEFAULT now()
);
