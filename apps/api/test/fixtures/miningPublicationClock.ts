import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { createDb, Db, DbTx } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';

/** Opt-in fixture for fresh, disposable publication test databases only.
 * Install data-backed clocks and prospective coverage BEFORE 0261 takes its
 * first retirement fingerprint (including capture-trigger enabled states).
 * The real migrator still executes every original SQL statement and journal
 * write. Later clock changes update fixture data, never functions or seals.
 * This does not model production schema bytes or authorize a production clock.
 */
export async function runMiningPublicationFixtureMigrations(conn: ReturnType<typeof createDb>, coverageAt: string) {
  if (!Number.isFinite(Date.parse(coverageAt))) throw new Error('finite publication fixture clock required');
  if (!conn.sql.options.host.every(host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host))) {
    throw new Error('loopback publication fixture required');
  }
  const [database] = await conn.sql`select current_database() name,
    (select pg_get_userbyid(datdba) from pg_database where datname=current_database())=current_user owned,
    current_user=session_user same_user,
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','drizzle')) empty`;
  if (!database || !/^mining_free_score_[0-9a-f]{32}_test$/.test(String(database.name))
    || !database.owned || !database.same_user || !database.empty) {
    throw new Error('fresh empty publication fixture required');
  }
  const dialect = new PgDialect();
  // Unique first chunk of 0261; inject before executing any of that migration.
  const beforeFirstSeal = 'CREATE TABLE public.charter_retirements(';
  let installations = 0;
  const migrated = new Proxy(conn.db, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver);
    if (name === 'transaction') return <T>(run: (tx: DbTx) => Promise<T>, config?: Parameters<Db['transaction']>[1]) =>
      target.transaction(async tx => run(new Proxy(tx, { get(transaction, method, txReceiver) {
        const operation = Reflect.get(transaction, method, txReceiver);
        if (method === 'execute') return async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
          if (dialect.sqlToQuery(statement).sql.includes(beforeFirstSeal)) {
            if (installations !== 0) throw new Error('publication clock seal boundary repeated');
            await transaction.execute(sql`create table public.test_mining_publication_clock(
              singleton boolean primary key check(singleton), at timestamptz check(at is null or isfinite(at)))`);
            await transaction.execute(sql`insert into public.test_mining_publication_clock
              values(true,${new Date(coverageAt).toISOString()}::timestamptz)`);
            await transaction.execute(sql`revoke all on public.test_mining_publication_clock from public`);
            for (const clock of ['shardkeep_mining_free_clock', 'shardkeep_mining_development_clock', 'shardkeep_mining_roster_clock']) {
              await transaction.execute(sql.raw(`create or replace function public.${clock}() returns timestamptz
                language sql volatile set search_path=pg_catalog,public,pg_temp as $$
                select coalesce(at,clock_timestamp()) from public.test_mining_publication_clock where singleton $$`));
            }
            // Exact SQL effects of the three coverage initializers, in their
            // original order, using this migration transaction. The real INSERT
            // guards enable capture prospectively and supply their clock/floor.
            // No seal row or source guard is changed or bypassed here.
            await transaction.execute(sql`lock table players,bases,base_slots,seeker_links,ledger_entries,accounts,ledger_transactions,
              mining_free_cohort_events,playtest_activity_coverage,player_action_events,buildings,builder_jobs in share mode nowait`);
            await transaction.execute(sql`insert into mining_free_coverage(id,started_at)
              values(true,public.shardkeep_mining_free_clock()) on conflict do nothing`);
            await transaction.execute(sql`insert into mining_free_gems_coverage(id) values(true) on conflict do nothing`);
            await transaction.execute(sql`insert into mining_gems_flow_coverage(id) values(true) on conflict do nothing`);
            installations++;
          }
          return transaction.execute(statement);
        };
        return typeof operation === 'function' ? operation.bind(transaction) : operation;
      } })), config);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await runMigrations(migrated);
  if (installations !== 1) throw new Error('publication clock seal boundary missing');
  await conn.sql`select public.shardkeep_divine_fragment_source()`;
  return async (at: string | null) => {
    if (at !== null && !Number.isFinite(Date.parse(at))) throw new Error('finite publication fixture clock required');
    const rows = await conn.sql`update public.test_mining_publication_clock
      set at=${at === null ? null : new Date(at).toISOString()}::timestamptz where singleton returning singleton`;
    if (rows.length !== 1) throw new Error('publication fixture clock row missing');
  };
}
