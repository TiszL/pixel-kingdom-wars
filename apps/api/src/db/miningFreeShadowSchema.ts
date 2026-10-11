/** Sealed measured inputs only; never a mining allocation or stock movement. */
import { date, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const miningFreeWalletShadows = pgTable('mining_free_wallet_shadows', {
  wallet: text('wallet').notNull(),
  day: date('day').notNull(),
  policyVersion: text('policy_version').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  evidenceHash: text('evidence_hash').notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
}, t => [primaryKey({ columns: [t.wallet, t.day, t.policyVersion] })]);
