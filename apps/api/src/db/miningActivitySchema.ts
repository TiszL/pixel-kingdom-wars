/** Immutable observed battle evidence. Never a mining allocation authority. */
import { sql } from 'drizzle-orm';
import { date, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const miningActivityEvidence = pgTable('mining_activity_evidence', {
  day: date('day').notNull(),
  policyVersion: text('policy_version').notNull(),
  coverageStartedAt: timestamp('coverage_started_at', { withTimezone: true }).notNull(),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  evidenceHash: text('evidence_hash').notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
}, t => [primaryKey({ columns: [t.day, t.policyVersion] })]);
