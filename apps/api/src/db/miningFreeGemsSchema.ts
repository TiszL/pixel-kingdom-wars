import { bigint,bigserial,boolean,index,jsonb,pgTable,text,timestamp,uniqueIndex } from 'drizzle-orm/pg-core';
export const miningFreeGemsCoverage=pgTable('mining_free_gems_coverage',{
 id:boolean('id').primaryKey(),startedAt:timestamp('started_at',{withTimezone:true}).notNull(),
});
export const miningFreeGemsOrigins=pgTable('mining_free_gems_origins',{
 id:bigserial('id',{mode:'bigint'}).primaryKey(),ledgerEntryId:bigint('ledger_entry_id',{mode:'bigint'}).notNull(),
 originHash:text('origin_hash').notNull(),wallet:text('wallet').notNull(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
 operation:text('operation').notNull(),source:jsonb('source').$type<Record<string,unknown>>().notNull(),receipt:jsonb('receipt').$type<unknown[]>().notNull(),
},t=>[uniqueIndex('mining_free_gems_origin_identity').on(t.ledgerEntryId,t.originHash),index('mining_free_gems_origins_wallet_clock').on(t.wallet,t.observedAt,t.id)]);
