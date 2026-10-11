/** Diagnostic history never substitutes for the current completeness receipt. */
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { MintInventoryDiagnostics } from '@shardkeep/chain';
export const playtestMintStatus = pgTable('playtest_mint_status', {
  id: text('id').primaryKey(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  state: text('state').$type<'complete' | 'unavailable'>().notNull(),
  reason: text('reason'),
  diagnostics: jsonb('diagnostics').$type<MintInventoryDiagnostics | { reason: 'proof_unresolved'; assetCount: number; attempts: number }>().notNull(),
}, t => [check('playtest_mint_status_id_check', sql`${t.id} = 'land-deeds'`),
  check('playtest_mint_status_state_check', sql`${t.state} in ('complete','unavailable')`)]);
