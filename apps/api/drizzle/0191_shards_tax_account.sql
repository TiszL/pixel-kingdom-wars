-- D-150 SHARDS pool backing. Commit enum before the dependent additive schema.
ALTER TYPE account_kind ADD VALUE IF NOT EXISTS 'shards_tax_escrow';
