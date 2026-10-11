/** Pending-only ingot custody. SQL owns conservation and immutable history. */
import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bases, players } from './schema';
export const miningIngotEpochs = pgTable('mining_ingot_epochs', {
  id: uuid('id').primaryKey(), epochKey: text('epoch_key').notNull().unique(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const miningIngotAdmissions = pgTable('mining_ingot_admissions', { baseId: uuid('base_id').primaryKey().references(() => bases.id, { onDelete: 'restrict' }) });
export const miningIngotReservations = pgTable('mining_ingot_reservations', {
  id: uuid('id').primaryKey(), epochId: uuid('epoch_id').notNull().references(() => miningIngotEpochs.id, { onDelete: 'restrict' }),
  baseId: uuid('base_id').notNull().references(() => miningIngotAdmissions.baseId, { onDelete: 'restrict' }),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet), idempotencyKey: text('idempotency_key').notNull(),
  qty: integer('qty').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, t => [unique('mining_ingot_actor_key_uq').on(t.actorWallet, t.idempotencyKey)]);
export const miningIngotAborts = pgTable('mining_ingot_aborts', {
  epochId: uuid('epoch_id').primaryKey().references(() => miningIngotEpochs.id), decisionKey: text('decision_key').notNull().unique(), reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const miningIngotReleases = pgTable('mining_ingot_releases', {
  reservationId: uuid('reservation_id').primaryKey().references(() => miningIngotReservations.id), abortEpochId: uuid('abort_epoch_id').notNull().references(() => miningIngotAborts.epochId),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
