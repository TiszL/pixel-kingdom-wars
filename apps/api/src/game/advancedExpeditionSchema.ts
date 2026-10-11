/** New private advanced receipts; the0207 row remains the shared vehicle mutex. */
import {sql} from 'drizzle-orm';
import {pgTable,uuid,text,integer,jsonb,bigint,timestamp,foreignKey,index,check,primaryKey} from 'drizzle-orm/pg-core';
import {players,bases,expeditionTermSnapshots} from '../db/schema';
export const advancedInstallations=pgTable('advanced_vehicle_installations',{
 reservationId:uuid('reservation_id').primaryKey(),baseId:uuid('base_id').notNull(),berthId:uuid('berth_id').notNull(),family:text('family').notNull(),tier:integer('tier').notNull(),berthCompletedAt:timestamp('berth_completed_at',{withTimezone:true}).notNull(),
});
export const advancedExpeditions = pgTable('advanced_expeditions', {
  id: uuid('id').primaryKey(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  installationId: uuid('installation_id').notNull().references(() => advancedInstallations.reservationId, { onDelete: 'restrict' }),
  routeId: text('route_id').notNull(),
  policyVersion: integer('policy_version').notNull(),
  completedBefore: bigint('completed_before',{mode:'bigint'}).notNull().default(sql`NULL`),
  homeEvidence: jsonb('home_evidence').notNull(),
  routeSnapshot: jsonb('route_snapshot').notNull(),
  termId: uuid('term_id').notNull(),
  termHash: text('term_hash').notNull(),
  finality: jsonb('finality').notNull(),
  accessEvidence:jsonb('access_evidence'),
  resourceId: text('resource_id').notNull(),
  gross: bigint('gross', { mode: 'bigint' }).notNull(),
  net: bigint('net', { mode: 'bigint' }).notNull(),
  tax: bigint('tax', { mode: 'bigint' }).notNull(),
  departedAt: timestamp('departed_at', { withTimezone: true }).notNull(),
  returnsAt: timestamp('returns_at', { withTimezone: true }).notNull(),
}, t => [
  foreignKey({ columns: [t.termId, t.termHash], foreignColumns: [expeditionTermSnapshots.termId, expeditionTermSnapshots.snapshotHash], name: 'advanced_expedition_term_fk' }),
  index('advanced_expeditions_due_idx').on(t.baseId, t.returnsAt, t.id),
  check('advanced_expeditions_amount_ck', sql`${t.gross} > 0 AND ${t.net} >= 0 AND ${t.tax} >= 0 AND ${t.net}::numeric + ${t.tax}::numeric = ${t.gross}::numeric`),
  check('advanced_expeditions_time_ck', sql`${t.returnsAt} > ${t.departedAt}`),
  check('advanced_expeditions_version_ck', sql`${t.policyVersion} > 0`),
]);
export const advancedExpeditionInflight = pgTable('advanced_expedition_inflight', {
  installationId: uuid('installation_id').primaryKey().references(() => advancedInstallations.reservationId),
  expeditionId: uuid('expedition_id').notNull().unique().references(() => advancedExpeditions.id),
  baseId: uuid('base_id').notNull().unique(),
});
export const advancedExpeditionReturns = pgTable('advanced_expedition_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  expeditionId: uuid('expedition_id').notNull().unique().references(() => advancedExpeditions.id),
  // Historical label; no player FK lock after the base-only return lock.
  custodyWallet: text('custody_wallet').notNull(),
  returnedAt: timestamp('returned_at', { withTimezone: true }).notNull(),
  completedTotal: bigint('completed_total',{mode:'bigint'}).notNull().default(sql`NULL`),
});
/** Original term/resource liability is the immutable island_pool entry; there
 * is deliberately no cross-base mutable pool row or authorized payout here. */
export const advancedExpeditionEntries = pgTable('advanced_expedition_entries', {
  returnId: uuid('return_id').notNull().references(() => advancedExpeditionReturns.id),
  bucket: text('bucket').$type<'issued' | 'base_stock' | 'island_pool'>().notNull(),
  delta: bigint('delta', { mode: 'bigint' }).notNull(),
}, t => [
  primaryKey({ columns: [t.returnId, t.bucket] }),
  check('advanced_expedition_entries_bucket_ck', sql`${t.bucket} IN ('issued','base_stock','island_pool')`),
  check('advanced_expedition_entries_domain_ck', sql`${t.delta} >= -9223372036854775807`),
]);

export const advancedExpeditionSupplies=pgTable('advanced_expedition_supplies',{
 expeditionId:uuid('expedition_id').notNull(),resourceId:text('resource_id').notNull(),reserveId:uuid('reserve_id').notNull(),consumeId:uuid('consume_id').notNull(),
},t=>[primaryKey({columns:[t.expeditionId,t.resourceId]})]);
