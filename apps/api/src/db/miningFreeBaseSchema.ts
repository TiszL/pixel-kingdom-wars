/** Wallet-lifetime purchase evidence survives custody changes and live-row removal. */
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
export const miningFreeBasePurchases = pgTable('mining_free_base_purchases', {
  wallet: text('wallet').primaryKey(),
  requestKey: text('request_key').notNull(),
  sourceBaseId: uuid('source_base_id').notNull(),
  baseId: uuid('base_id').notNull().unique(),
  slot: integer('slot').notNull(),
  policyVersion: integer('policy_version').notNull(),
  shardsCharged: bigint('shards_charged', { mode: 'bigint' }).notNull(),
  debitTransactionId: uuid('debit_transaction_id').notNull().unique(),
  development: jsonb('development').$type<{ keepId: string; keepLevel: number; workshopId: string; workshopLevel: number; goldForgeId: string; goldForgeLevel: number }>().notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
});
