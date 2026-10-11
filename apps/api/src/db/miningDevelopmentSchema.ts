/** Prospective source evidence has no FK to deletable gameplay rows. */
import { bigserial, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
export const miningDevelopmentTransactions=pgTable('mining_development_transactions',{
 txKey:text('tx_key').primaryKey(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
});
export const miningDevelopmentBaselines=pgTable('mining_development_baselines',{
 baseId:uuid('base_id').primaryKey(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
 effectiveFrom:timestamp('effective_from',{withTimezone:true}).notNull(),baseState:jsonb('base_state').$type<Record<string,unknown>>().notNull(),
 buildings:jsonb('buildings').$type<Record<string,unknown>[]>().notNull(),jobs:jsonb('jobs').$type<Record<string,unknown>[]>().notNull(),
});
export const miningDevelopmentEvents=pgTable('mining_development_events',{
 id:bigserial('id',{mode:'bigint'}).primaryKey(),baseId:uuid('base_id').notNull(),txKey:text('tx_key').notNull(),
 observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),sourceTable:text('source_table').notNull(),sourceId:text('source_id').notNull(),
 beforeState:jsonb('before_state'),afterState:jsonb('after_state'),
});
