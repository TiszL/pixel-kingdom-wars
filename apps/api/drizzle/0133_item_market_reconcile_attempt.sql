-- Reconciler starvation fix (security review 2026-09-17 #1, KNOWN_ISSUES): the
-- market-reconcile worker ordered by reserved_until and took 25 rows, so 25
-- permanently uncertain reservations filled every batch and newer lapsed ones
-- were never read. Each reserved row now records the worker's last attempt on
-- its CURRENT generation; rows tried within MARKETPLACE.itemMarket.reconcileRetrySec
-- are skipped and never-attempted rows are read first. Nullable, no default:
-- every existing reservation is "never attempted" and is read on the next pass.
-- No custody, price or receipt changes.
ALTER TABLE "item_listings" ADD COLUMN "reconcile_attempted_at" timestamp with time zone;
