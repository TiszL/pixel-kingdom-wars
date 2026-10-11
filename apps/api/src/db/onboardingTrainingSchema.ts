/** Owner 2026-09-08: a training tutorial benefit belongs to a wallet, not a deed. */
import type { TrainingFreeFinishReceipt } from '@shardkeep/shared';
import { foreignKey, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bases, players } from './schema';

export const onboardingTrainingWallets = pgTable('onboarding_training_wallets', {
  wallet: text('wallet').primaryKey(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** Unresolved historical actors are review holds, never claimed completions. */
  reviewEvidence: jsonb('review_evidence').$type<Array<Record<string, unknown>>>(),
}); // No wallet FK: canonical actor history must not invert base/player locks.

export const onboardingTrainingFinishes = pgTable('onboarding_training_finishes', {
  wallet: text('wallet').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  baseId: uuid('base_id'),
  consent: jsonb('consent').$type<TrainingFreeFinishReceipt['consent']>().notNull(),
  completed: jsonb('completed').$type<TrainingFreeFinishReceipt['completed']>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.wallet], foreignColumns: [players.wallet] }),
  foreignKey({ columns: [t.baseId], foreignColumns: [bases.id] })]);
