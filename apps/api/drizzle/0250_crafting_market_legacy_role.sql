-- Phase E integration repair, S5 HELD: preserve ordinary stock writes by
-- existing roles without exposing private market rows. The installed guard
-- validates only the authentic crafting_stocks trigger and performs no writes.
-- Preserve its owner, pinned search_path, body and revoked PUBLIC execution.
SET LOCAL lock_timeout='10s';
ALTER FUNCTION public.shardkeep_crafting_market_stock_guard() SECURITY DEFINER;
