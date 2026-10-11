/** D-118: durable action evidence belongs to the actor at commit time, never
 * to the current owner of a deed. These tables contain no private feedback. */
import { sql } from 'drizzle-orm';
import { boolean, date, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { players } from './schema';

export const playerActionEvents = pgTable('player_action_events', {
  id: text('id').primaryKey(),
  wallet: text('wallet').notNull(),
  sourceKey: text('source_key').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  baseId: uuid('base_id'),
  active: boolean('active').notNull(),
  fought: boolean('fought').notNull().default(false),
  sourceTable: text('source_table').notNull(),
  sourceId: text('source_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  invalidatedForScoringAt: timestamp('invalidated_for_scoring_at', { withTimezone: true }),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ name: 'player_action_events_wallet_fkey', columns: [t.wallet], foreignColumns: [players.wallet] }),
  index('player_action_events_wallet_time_idx').on(t.wallet, t.occurredAt),
  index('player_action_events_time_idx').on(t.occurredAt),
  index('player_action_events_source_idx').on(t.sourceTable, t.sourceId),
  index('player_action_events_state_idx').on(t.sourceKey, t.baseId, t.occurredAt.desc(), t.capturedAt.desc(), t.id)]);

export const playerActivityDays = pgTable('player_activity_days', {
  wallet: text('wallet').notNull(), day: date('day').notNull(),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull(),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
  fought: boolean('fought').notNull(),
}, t => [primaryKey({ name: 'player_activity_days_pkey', columns: [t.wallet, t.day] }),
  foreignKey({ name: 'player_activity_days_wallet_fkey', columns: [t.wallet], foreignColumns: [players.wallet] }),
  index('player_activity_days_day_idx').on(t.day)]);

export const playtestActivityCoverage = pgTable('playtest_activity_coverage', {
  key: text('key').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
});
