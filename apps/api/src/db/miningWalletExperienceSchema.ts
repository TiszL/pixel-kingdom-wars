import { sql } from 'drizzle-orm';
import { date,integer,jsonb,pgTable,primaryKey,text,timestamp,uuid } from 'drizzle-orm/pg-core';
export const miningWalletExperienceDays=pgTable('mining_wallet_experience_days',{
 day:date('day').notNull(),policyVersion:integer('policy_version').notNull(),sourcePolicy:text('source_policy').notNull(),sourceHash:text('source_hash').notNull(),
 sourceCoverageStartedAt:timestamp('source_coverage_started_at',{withTimezone:true}).notNull(),sealedAt:timestamp('sealed_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
 resultHash:text('result_hash').notNull(),result:jsonb('result').$type<Record<string,unknown>>().notNull(),
},t=>[primaryKey({columns:[t.day,t.policyVersion]})]);
export const miningWalletExperienceAwards=pgTable('mining_wallet_experience_awards',{
 raidId:uuid('raid_id').primaryKey(),day:date('day').notNull(),policyVersion:integer('policy_version').notNull(),wallet:text('wallet').notNull(),baseId:uuid('base_id').notNull(),
 firstAcceptedAt:timestamp('first_accepted_at',{withTimezone:true}).notNull(),points:integer('points').notNull(),sourceHash:text('source_hash').notNull(),
});
