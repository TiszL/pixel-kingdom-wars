/** Controlled pre0095 fixture opening only; no HTTP/worker/import surface. */
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbTx } from './client';

export interface FixtureLeagueBridgeRequest { fixtureId: string }
export interface FixtureLeagueBridgeResult {
  fixtureOnly: true; retirementAuthorized: false; fixtureId: string;
  sourceVersion: 'stable-league-pre0095-v1'; weeks: number; rows: number;
  zeroRows: number; paidPositiveRows: number; unpaidPositiveRows: number; unpaidKeep: string;
}
const fail = (code: string): never => { throw new Error(code); };
const read = async <T extends Record<string, unknown>>(tx: DbTx, query: ReturnType<typeof sql>) =>
  await tx.execute<T>(query) as unknown as T[];

export async function captureFixtureLeagueSources(request: FixtureLeagueBridgeRequest, env: NodeJS.ProcessEnv,
  connect: (url: string) => { db: Db; close: () => Promise<void> } = url => {
    const conn = createDb(url, { max: 1 }); return { db: conn.db, close: () => conn.sql.end() };
  }): Promise<FixtureLeagueBridgeResult> {
  if (env['HOLD_BEFORE_MIGRATE'] !== '1' || !env['TEST_DATABASE_URL']) fail('CUSTODY_LEAGUE_FIXTURE_REQUIRED');
  const url = new URL(env['TEST_DATABASE_URL']!), database = url.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^shardkeep_custody_apply_[0-9a-f]{32}_test$/.test(database) || url.search || url.hash)
    fail('CUSTODY_LEAGUE_FIXTURE_REQUIRED');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.fixtureId)) fail('CUSTODY_LEAGUE_INPUT_INVALID');
  const conn = connect(url.toString());
  try { return await conn.db.transaction(async tx => {
    await tx.execute(sql`set local search_path=pg_catalog,public,pg_temp`);
    await tx.execute(sql`set local time zone 'UTC'`);
    await tx.execute(sql`select public.shardkeep_league_rc()`);
    await tx.execute(sql`lock table public.base_league_entitlements,public.ledger_transactions,public.ledger_entries,
      public.accounts,public.players,public.bases,public.keep_custody_league_bridge,public.keep_custody_league_weeks,
      public.keep_custody_league_retirements,drizzle.__drizzle_migrations in access exclusive mode nowait`);
    const [identity] = await read<{ database: string; operator: string; owner: boolean }>(tx, sql`select current_database() as database,current_user as operator,
      current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.keep_custody_league_bridge'::regclass)
      and current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.base_league_entitlements'::regclass) as owner`);
    if (!identity?.owner || identity.database !== database) fail('CUSTODY_LEAGUE_FIXTURE_REQUIRED');
    const [prior] = await read<{ fixture_id: string; database_name: string; operator_name: string; sealed: boolean; result: FixtureLeagueBridgeResult }>(tx,
      sql`select fixture_id,database_name,operator_name,sealed,result from public.keep_custody_league_bridge where id`);
    if (prior) {
      if (!prior.sealed || prior.fixture_id !== request.fixtureId || prior.database_name !== database || prior.operator_name !== identity!.operator)
        fail('CUSTODY_LEAGUE_SOURCE_CONFLICT');
      await tx.execute(sql`select public.shardkeep_assert_league_archive()`);
      return prior.result;
    }
    // This comparison authenticates the schema prefix, not historical awards.
    // The opening DB is explicitly controlled by the disposable fixture.
    const expected = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) }).slice(0, 95);
    const applied = await read<{ hash: string; created_at: string }>(tx,
      sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`);
    if (applied.length !== expected.length || applied.some((row, index) => row.hash !== expected[index]!.hash
      || Number(row.created_at) !== expected[index]!.folderMillis)) fail('CUSTODY_LEAGUE_OPENING_REQUIRED');
    const [shape] = await read<{ columns: string[] }>(tx, sql`select array_agg(attname::text order by attnum) as columns from pg_attribute
      where attrelid='public.base_league_entitlements'::regclass and attnum>0 and not attisdropped`);
    if (JSON.stringify(shape?.columns) !== JSON.stringify(['week','base_id','tier','trophies','keep_amount','paid_at','last_attempt_at','created_at']))
      fail('CUSTODY_LEAGUE_OPENING_REQUIRED');
    const [invariant] = await read<{ valid: boolean }>(tx, sql`select
      not exists(select 1 from public.accounts a where a.balance<>coalesce((select sum(e.delta) from public.ledger_entries e where e.account_id=a.id),0))
      and not exists(select 1 from (select e.balance_after,sum(e.delta) over(partition by e.account_id order by e.id) as expected from public.ledger_entries e) audit where balance_after<>expected)
      and not exists(select 1 from public.ledger_entries e join public.accounts a on a.id=e.account_id group by e.txn_id,a.currency having sum(e.delta)<>0) as valid`);
    if (!invariant?.valid) fail('CUSTODY_LEAGUE_SOURCE_CONFLICT');
    await tx.execute(sql`insert into public.keep_custody_league_bridge(fixture_id,database_name,operator_name,source_version,opening_xid,result)
      select ${request.fixtureId}::uuid,current_database(),current_user,'stable-league-pre0095-v1',txid_current(),
      jsonb_build_object('fixtureOnly',true,'retirementAuthorized',false,'fixtureId',${request.fixtureId}::text,'sourceVersion','stable-league-pre0095-v1',
        'weeks',count(distinct week),'rows',count(*),'zeroRows',count(*) filter(where keep_amount=0),
        'paidPositiveRows',count(*) filter(where keep_amount>0 and paid_at is not null),
        'unpaidPositiveRows',count(*) filter(where keep_amount>0 and paid_at is null),
        'unpaidKeep',coalesce(sum(keep_amount) filter(where keep_amount>0 and paid_at is null),0)::text)
      from public.base_league_entitlements`);
    await tx.execute(sql`insert into public.keep_custody_league_weeks(week,original_rows,reserve_receipt,paid_receipts)
      select e.week,jsonb_agg(to_jsonb(e) order by e.base_id),
        (select public.shardkeep_league_receipt(t.id) from public.ledger_transactions t where t.idempotency_key='league-entitlements:'||e.week::text),
        (select coalesce(jsonb_agg(public.shardkeep_league_receipt(t.id) order by t.idempotency_key),'[]'::jsonb)
         from public.ledger_transactions t join public.base_league_entitlements p on t.idempotency_key='league:'||p.week::text||':'||p.base_id::text where p.week=e.week)
      from public.base_league_entitlements e group by e.week order by e.week`);
    // Unknown escrow movement is not a second allocator version.
    const [unknown] = await read<{ bad: boolean }>(tx, sql`select exists(select 1 from public.ledger_entries e join public.accounts a on a.id=e.account_id
      where a.kind::text='league_entitlement_escrow' and not exists(select 1 from public.keep_custody_league_weeks w
        cross join lateral jsonb_array_elements(jsonb_build_array(w.reserve_receipt)||w.paid_receipts) p where p->>'id'=e.txn_id::text)) as bad`);
    if (unknown?.bad) fail('CUSTODY_LEAGUE_SOURCE_CONFLICT');
    await tx.execute(sql`delete from public.base_league_entitlements where keep_amount>0`);
    await tx.execute(sql`update public.keep_custody_league_bridge set sealed=true where id`);
    const [saved] = await read<{ result: FixtureLeagueBridgeResult }>(tx, sql`select result from public.keep_custody_league_bridge where id`);
    return saved!.result;
  }); } finally { await conn.close(); }
}
