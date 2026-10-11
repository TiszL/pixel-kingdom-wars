-- D153.199 dedicated protected SHARDS; label commits before dependent DDL. S5 HELD.
ALTER TYPE public.account_kind ADD VALUE IF NOT EXISTS 'mining_contribution_escrow';
