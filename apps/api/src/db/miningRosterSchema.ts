/** No FK to mutable source identities: historical facts survive their removal. */
import { bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
export const miningRosterTransactions=pgTable('mining_roster_transactions',{
 txKey:text('tx_key').primaryKey(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
});
export const miningRosterBaselines=pgTable('mining_roster_baselines',{
 wallet:text('wallet').primaryKey(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
 effectiveFrom:timestamp('effective_from',{withTimezone:true}).notNull(),
 bases:jsonb('bases').$type<Record<string,unknown>[]>().notNull(),slots:jsonb('slots').$type<Record<string,unknown>[]>().notNull(),
});
export const miningRosterEvents=pgTable('mining_roster_events',{
 id:bigserial('id',{mode:'bigint'}).primaryKey(),wallet:text('wallet').notNull(),txKey:text('tx_key').notNull(),
 observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),sourceTable:text('source_table').notNull(),sourceId:text('source_id').notNull(),
 beforeState:jsonb('before_state'),afterState:jsonb('after_state'),
});
