import { sql } from 'drizzle-orm';
import { check, customType, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { deposits } from './schema';
const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });
export const keepCustodySourceObservations = pgTable('keep_custody_source_observations', {
  depositId: uuid('deposit_id').notNull().references(() => deposits.id), commitment: text('commitment').notNull(),
  signature: text('signature').notNull(), observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  proof: jsonb('proof').notNull(), original: jsonb('original').notNull(), xid: xid8('xid').notNull(),
}, t => [primaryKey({ columns: [t.depositId, t.commitment] }), unique().on(t.signature, t.commitment),
  check('keep_custody_source_observations_commitment_check', sql`${t.commitment} in ('confirmed','finalized')`),
  check('keep_custody_source_observations_observed_at_check', sql`isfinite(${t.observedAt})`)]);
export const keepCustodySourceWindows = pgTable('keep_custody_source_windows', {
  id: uuid('id').primaryKey(), closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
  inventory: jsonb('inventory').notNull(), xid: xid8('xid').notNull(),
}, t => [check('keep_custody_source_windows_closed_at_check', sql`isfinite(${t.closedAt})`),
  check('keep_custody_source_windows_inventory_check', sql`jsonb_typeof(${t.inventory})='array'`)]);
