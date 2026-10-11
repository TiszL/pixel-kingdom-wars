/** Prospective identity facts without foreign keys to abandonable live state. */
import { bigserial, boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
export const miningFreeCoverage = pgTable('mining_free_coverage', {
  id: boolean('id').primaryKey(), startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
});
export const miningFreeCohorts = pgTable('mining_free_cohorts', {
  wallet: text('wallet').primaryKey(), baseId: uuid('base_id').notNull().unique(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull(), effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  baseline: jsonb('baseline').$type<Record<string, unknown>>().notNull(),
});
export const miningFreeCohortEvents = pgTable('mining_free_cohort_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), wallet: text('wallet').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(), sourceTable: text('source_table').notNull(),
  sourceId: text('source_id').notNull(), operation: text('operation').notNull(),
  beforeState: jsonb('before_state'), afterState: jsonb('after_state'),
});
