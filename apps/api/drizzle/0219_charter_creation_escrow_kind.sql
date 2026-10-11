-- Separate committed enum phase. No account/balance is created or funded here.
ALTER TYPE public.account_kind ADD VALUE IF NOT EXISTS 'charter_creation_escrow';
