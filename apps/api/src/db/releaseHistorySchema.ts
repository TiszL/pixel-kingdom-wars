/** M47 §5 public release history (0500). Written only by the release-notes CLI
 * (releases/cli.ts) that infra/deploy.sh runs after a publicly verified release;
 * read by GET /public/releases. DB triggers refuse UPDATE, DELETE and TRUNCATE on
 * both tables, and a CHECK re-validates every entry, so neither code nor psql can
 * rewrite what players were told or store a row the public route cannot serve. */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** One published changelog line. Mirrors releases/contracts.ts ReleaseEntrySchema. */
export interface ReleaseEntryRow {
  id: string;
  category: 'new' | 'improved' | 'fixed' | 'balance' | 'android' | 'world';
  platforms: 'all' | 'web' | 'android';
  title: string;
  body: string;
}

export const releaseHistory = pgTable('release_history', {
  gitSha: text('git_sha').primaryKey(),
  version: text('version').notNull(),
  simVersion: integer('sim_version').notNull(),
  builtAt: timestamp('built_at', { withTimezone: true }),
  deployedAt: timestamp('deployed_at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').$type<'deploy' | 'backfill'>().notNull(),
  entries: jsonb('entries').$type<ReleaseEntryRow[]>().notNull(),
  fragmentIds: text('fragment_ids').array().notNull().default(sql`'{}'::text[]`),
  recordedBy: text('recorded_by').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('release_history_deployed_at_idx').on(t.deployedAt.desc(), t.gitSha),
  check('release_history_git_sha_ck', sql`${t.gitSha} ~ '^[0-9a-f]{40}$'`),
  check('release_history_version_ck', sql`${t.version} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'`),
  check('release_history_sim_version_ck', sql`${t.simVersion} > 0 AND ${t.simVersion} <= 100000`),
  check('release_history_kind_ck', sql`${t.kind} IN ('deploy','backfill')`),
  check('release_history_entries_ck', sql`public.shardkeep_release_entries_valid(${t.entries})`),
  check('release_history_fragment_ids_ck', sql`cardinality(${t.fragmentIds}) <= 40`),
  check('release_history_recorded_by_ck', sql`length(${t.recordedBy}) BETWEEN 1 AND 200`),
]);

/** A fragment id belongs to exactly one release: the first recorded one carrying it. */
export const releaseFragmentClaims = pgTable('release_fragment_claims', {
  fragmentId: text('fragment_id').primaryKey(),
  gitSha: text('git_sha').notNull().references(() => releaseHistory.gitSha),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('release_fragment_claims_git_sha_idx').on(t.gitSha),
]);
