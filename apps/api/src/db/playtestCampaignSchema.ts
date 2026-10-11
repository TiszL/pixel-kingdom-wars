/** Owner 2026-09-07: independent competition records; no custody or payouts. */
import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, boolean, jsonb, primaryKey, unique, check, index, foreignKey } from 'drizzle-orm/pg-core';
import { players } from './schema';

// Match PostgreSQL's constraint names from 0114, including separate column checks.
// References are evaluated in table callbacks after the schema module initializes.

/** Owner-confirmed team/test identities. Independent of admission and reversible
 * board presentation; exclusion never deletes their gameplay or evidence. */
export const playtestInternalWallets = pgTable('playtest_internal_wallets', {
  wallet: text('wallet').primaryKey(),
  reason: text('reason').notNull(),
  recordedBy: text('recorded_by').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  evidence: jsonb('evidence').notNull(),
});

export const playtestCampaigns = pgTable('playtest_campaigns', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }),
  endAt: timestamp('end_at', { withTimezone: true }),
  registrationOpen: boolean('registration_open').notNull().default(false),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('playtest_campaigns_kind_key').on(t.kind),
  check('playtest_campaigns_kind_check', sql`${t.kind} IN ('founding', 'rewarded')`),
  check('playtest_campaigns_check', sql`(${t.startAt} IS NULL AND ${t.endAt} IS NULL) OR (${t.startAt} IS NOT NULL AND ${t.endAt} IS NOT NULL AND ${t.endAt} > ${t.startAt})`),
  check('playtest_campaigns_revision_check', sql`${t.revision} > 0`),
]);

export const playtestParticipants = pgTable('playtest_participants', {
  campaignId: text('campaign_id').notNull(),
  wallet: text('wallet').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  disqualifiedAt: timestamp('disqualified_at', { withTimezone: true }),
  disqualificationReason: text('disqualification_reason'),
  bonusAt: timestamp('bonus_at', { withTimezone: true }),
}, t => [primaryKey({ name: 'playtest_participants_pkey', columns: [t.campaignId, t.wallet] }),
  foreignKey({ name: 'playtest_participants_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  foreignKey({ name: 'playtest_participants_wallet_fkey', columns: [t.wallet], foreignColumns: [players.wallet] })]);

export const playtestCampaignDays = pgTable('playtest_campaign_days', {
  campaignId: text('campaign_id').notNull(),
  wallet: text('wallet').notNull(),
  day: text('day').notNull(),
  key: text('key').notNull(),
  count: integer('count').notNull(),
  points: integer('points').notNull(),
  achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull(),
  evidence: jsonb('evidence').notNull(),
}, t => [primaryKey({ name: 'playtest_campaign_days_pkey', columns: [t.campaignId, t.wallet, t.day, t.key] }),
  foreignKey({ name: 'playtest_campaign_days_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  foreignKey({ name: 'playtest_campaign_days_wallet_fkey', columns: [t.wallet], foreignColumns: [players.wallet] }),
  check('playtest_campaign_days_count_check', sql`${t.count} >= 0`),
  check('playtest_campaign_days_points_check', sql`${t.points} >= 0`)]);

/** Only the chain verifier writes this evidence. Never accept it from public/admin JSON. */
export const playtestMintEvidence = pgTable('playtest_mint_evidence', {
  assetId: text('asset_id').primaryKey(),
  originalWallet: text('original_wallet'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  slot: text('slot'),
  transactionIndex: integer('transaction_index'),
  signature: text('signature'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  error: text('error'),
}, t => [check('playtest_mint_evidence_check', sql`${t.verifiedAt} IS NULL OR (${t.originalWallet} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL AND ${t.slot} IS NOT NULL AND ${t.slot} ~ '^[0-9]+$' AND ${t.transactionIndex} IS NOT NULL AND ${t.transactionIndex} >= 0 AND ${t.signature} IS NOT NULL AND ${t.error} IS NULL)`)]);

export const playtestFounders = pgTable('playtest_founders', {
  wallet: text('wallet').primaryKey(),
  position: integer('position').notNull(),
  username: text('username').notNull(),
  assetId: text('asset_id').notNull(),
  evidence: jsonb('evidence').notNull(),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
}, t => [unique('playtest_founders_position_key').on(t.position),
  foreignKey({ name: 'playtest_founders_asset_id_fkey', columns: [t.assetId], foreignColumns: [playtestMintEvidence.assetId] })]);

export const playtestSubmissions = pgTable('playtest_submissions', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull(),
  wallet: text('wallet').notNull(),
  kind: text('kind').notNull(),
  reportId: text('report_id'),
  url: text('url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('playtest_submissions_campaign_id_report_id_key').on(t.campaignId, t.reportId),
  foreignKey({ name: 'playtest_submissions_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  foreignKey({ name: 'playtest_submissions_wallet_fkey', columns: [t.wallet], foreignColumns: [players.wallet] }),
  check('playtest_submissions_check', sql`(${t.kind} = 'video' AND ${t.url} IS NOT NULL AND ${t.reportId} IS NULL) OR (${t.kind} = 'report' AND ${t.reportId} IS NOT NULL AND ${t.url} IS NULL)`)]);

export const playtestAwards = pgTable('playtest_awards', {
  campaignId: text('campaign_id').notNull(),
  prizeId: text('prize_id').notNull(),
  wallet: text('wallet').notNull(),
  username: text('username').notNull(),
  amountUsd: integer('amount_usd').notNull(),
  category: text('category').notNull(),
  evidence: jsonb('evidence').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  paymentReference: text('payment_reference'),
}, t => [primaryKey({ name: 'playtest_awards_pkey', columns: [t.campaignId, t.prizeId] }),
  foreignKey({ name: 'playtest_awards_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  unique('playtest_awards_campaign_id_wallet_category_key').on(t.campaignId, t.wallet, t.category)]);

export const playtestCampaignAudit = pgTable('playtest_campaign_audit', {
  campaignId: text('campaign_id').notNull(),
  requestId: text('request_id').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  requestHash: text('request_hash').notNull(),
  revision: integer('revision').notNull(),
  detail: jsonb('detail').notNull(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ name: 'playtest_campaign_audit_pkey', columns: [t.campaignId, t.requestId] }),
  foreignKey({ name: 'playtest_campaign_audit_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  index('playtest_campaign_audit_revision_idx').on(t.campaignId, t.revision)]);

/** Materialized standings and close-time eligibility evidence freeze at finalization. */
export const playtestCampaignScores = pgTable('playtest_campaign_scores', {
  campaignId: text('campaign_id').notNull(),
  wallet: text('wallet').notNull(),
  username: text('username').notNull(),
  points: integer('points').notNull(),
  activeDays: integer('active_days').notNull(),
  longestStreak: integer('longest_streak').notNull(),
  revenge: integer('revenge').notNull(),
  stages: integer('stages').notNull(),
  achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull(),
  eligible: boolean('eligible').notNull(),
  evidence: jsonb('evidence').notNull(),
}, t => [primaryKey({ name: 'playtest_campaign_scores_pkey', columns: [t.campaignId, t.wallet] }),
  foreignKey({ name: 'playtest_campaign_scores_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  foreignKey({ name: 'playtest_campaign_scores_wallet_fkey', columns: [t.wallet], foreignColumns: [players.wallet] }),
  check('playtest_campaign_scores_check', sql`${t.points} >= 0 AND ${t.activeDays} >= 0 AND ${t.longestStreak} >= 0 AND ${t.revenge} >= 0 AND ${t.stages} >= 0`)]);

/** A successful full collection scan, not a count of whichever assets were found. */
export const playtestMintInventory = pgTable('playtest_mint_inventory', {
  id: text('id').primaryKey(),
  throughSlot: text('through_slot').notNull(),
  assetCount: integer('asset_count').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
}, t => [check('playtest_mint_inventory_through_slot_check', sql`${t.throughSlot} ~ '^[0-9]+$'`),
  check('playtest_mint_inventory_asset_count_check', sql`${t.assetCount} >= 0`)]);

/** Read-only chain verifier receipts; an admin decision cannot manufacture ownership. */
export const playtestCloseDeedEvidence = pgTable('playtest_close_deed_evidence', {
  campaignId: text('campaign_id').notNull(),
  assetId: text('asset_id').notNull(),
  ownerAtClose: text('owner_at_close'),
  throughSlot: text('through_slot'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  error: text('error'),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
}, t => [primaryKey({ name: 'playtest_close_deed_evidence_pkey', columns: [t.campaignId, t.assetId] }),
  foreignKey({ name: 'playtest_close_deed_evidence_campaign_id_fkey', columns: [t.campaignId], foreignColumns: [playtestCampaigns.id] }),
  check('playtest_close_deed_evidence_check', sql`${t.verifiedAt} IS NULL OR (${t.ownerAtClose} IS NOT NULL AND ${t.throughSlot} IS NOT NULL AND ${t.throughSlot} ~ '^[0-9]+$' AND ${t.error} IS NULL)`)]);
