import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureFixtureLeagueSources } from '../src/db/keepCustodyLeague';
import { custodyLeagueFixture, deferred, leaf, WEEKS, type CustodyLeagueFixture } from './fixtures/custodyLeague';

let f: CustodyLeagueFixture;
beforeEach(async () => { f = await custodyLeagueFixture(); }, 60_000);
afterEach(async () => { await f?.dispose(); });
const conflict = { code: 'P0001', message: 'CUSTODY_LEAGUE_SOURCE_CONFLICT' };
const frozen = { code: 'P0001', message: 'CUSTODY_LEAGUE_SOURCE_FROZEN' };
const immutable = { code: 'P0001', message: 'CUSTODY_LEAGUE_IMMUTABLE' };

async function rejectCapture() {
  const before = await f.money();
  await expect(f.capture().catch(leaf)).resolves.toMatchObject(conflict);
  expect(await f.money()).toBe(before);
  expect(await f.sql`select * from keep_custody_league_bridge`).toHaveLength(0);
  expect(await f.sql`select * from keep_custody_league_weeks`).toHaveLength(0);
}

describe('original league source authority and enduring fences', () => {
  it('requires the canonical complete-week reserve, not a matching escrow total or row count alone', async () => {
    const key = `league-entitlements:${WEEKS[1]}`;
    for (const mutation of ['count', 'type', 'key', 'award'] as const) {
      if (mutation === 'count') await f.sql`update ledger_transactions set metadata=jsonb_set(metadata,'{entitlements}','1') where idempotency_key=${key}`;
      if (mutation === 'type') await f.sql`update ledger_transactions set type='test.reserve' where idempotency_key=${key}`;
      if (mutation === 'key') await f.sql`update ledger_transactions set idempotency_key='test:reserve' where idempotency_key=${key}`;
      if (mutation === 'award') await f.sql`update base_league_entitlements set keep_amount=241 where week=${WEEKS[1]} and base_id=${f.baseId}`;
      await rejectCapture();
      await f.sql`update ledger_transactions set idempotency_key=${key},type='league.weekly_reserve',metadata=${JSON.stringify({ week: WEEKS[1], entitlements: 2 })}::jsonb
        where idempotency_key in (${key},'test:reserve')`;
      await f.sql`update base_league_entitlements set keep_amount=240 where week=${WEEKS[1]} and base_id=${f.baseId}`;
    }
    expect((await f.capture()).unpaidKeep).toBe('240');
  });

  it('requires actual historical paid evidence and rejects either direction of paid-marker disagreement', async () => {
    const key = `league:${WEEKS[0]}:${f.baseId}`;
    for (const mutation of ['metadata', 'type', 'paid-without-post', 'post-without-paid'] as const) {
      if (mutation === 'metadata') await f.sql`update ledger_transactions set metadata=jsonb_set(metadata,'{wallet}',to_jsonb(${f.buyer}::text)) where idempotency_key=${key}`;
      if (mutation === 'type') await f.sql`update ledger_transactions set type='test.league_release' where idempotency_key=${key}`;
      if (mutation === 'paid-without-post') await f.sql`update base_league_entitlements set paid_at=now() where week=${WEEKS[1]} and base_id=${f.baseId}`;
      if (mutation === 'post-without-paid') await f.sql`update base_league_entitlements set paid_at=null where week=${WEEKS[0]} and base_id=${f.baseId}`;
      await rejectCapture();
      await f.sql`update ledger_transactions set type='league.weekly_prize',metadata=${JSON.stringify({ wallet: f.seller, tier: 'sol', baseId: f.baseId, week: WEEKS[0] })}::jsonb where idempotency_key=${key}`;
      await f.sql`update base_league_entitlements set paid_at=${WEEKS[0] + 'T00:01:00Z'} where week=${WEEKS[0]} and base_id=${f.baseId}`;
      await f.sql`update base_league_entitlements set paid_at=null where week=${WEEKS[1]} and base_id=${f.baseId}`;
    }
    // A historical recipient remains valid after sale; current ownership is
    // relevant to the still-unpaid source only, never to rewriting paid history.
    await f.sql`update bases set owner_wallet=${f.buyer} where id=${f.baseId}`;
    expect((await f.capture()).paidPositiveRows).toBe(1);
    expect(await f.historicalGraph()).toBe(f.originalGraph);
  });

  it('rejects a balanced reserve funded from the wrong system account despite exact totals', async () => {
    // Move the whole pool history coherently so ordinary double-entry/cache
    // checks still pass. Canonical allocation nevertheless requires league_pool.
    await f.sql.begin(async tx => {
      await tx`update ledger_entries set account_id=${f.sys.emission_pool} where account_id=${f.sys.league_pool}`;
      await tx`update accounts set balance=160 where id=${f.sys.emission_pool}`;
      await tx`update accounts set balance=0 where id=${f.sys.league_pool}`;
    });
    expect(await f.balance('league_entitlement_escrow')).toBe(240n);
    await rejectCapture();
  });

  it('prevents same-sum source substitution, zero-row rewrites and OLD/NEW ledger namespace escape', async () => {
    await f.capture();
    const before = await f.money();
    await expect(f.sql`update keep_custody_league_weeks set original_rows=(select jsonb_agg(
      jsonb_set(r,'{keep_amount}',to_jsonb((r->>'keep_amount')::bigint + case when r->>'base_id'=${f.baseId} then -1 else 1 end))
      order by r->>'base_id') from jsonb_array_elements(original_rows) r) where week=${WEEKS[1]}`.catch(leaf)).resolves.toMatchObject(immutable);
    await expect(f.sql`update base_league_entitlements set trophies=1 where base_id=${f.zeroBaseId}`.catch(leaf)).resolves.toMatchObject(frozen);
    await expect(f.sql`update ledger_transactions set idempotency_key='escaped',type='test.escape' where idempotency_key=${`league-entitlements:${WEEKS[1]}`}`.catch(leaf)).resolves.toMatchObject(frozen);
    await expect(f.sql`update ledger_transactions set idempotency_key=${`league:${WEEKS[1]}:${f.baseId}`} where type='test.fixture.league_pool_fund'`.catch(leaf)).resolves.toMatchObject(frozen);
    await expect(f.sql`update ledger_entries set txn_id=(select id from ledger_transactions where type='test.fixture.league_pool_fund')
      where txn_id=(select id from ledger_transactions where idempotency_key=${`league-entitlements:${WEEKS[1]}`})`.catch(leaf)).resolves.toMatchObject(frozen);
    await expect(f.sql`update accounts set owner_wallet=${f.buyer} where id=${f.sys.league_pool}`.catch(leaf)).resolves.toMatchObject(frozen);
    expect(await f.money()).toBe(before);
    expect((await f.capture()).unpaidKeep).toBe('240');
  });

  it('refuses an old allocator both before and after0095 without creating another obligation', async () => {
    await f.capture();
    for (const migrated of [false, true]) {
      if (migrated) await f.migrateAll();
      const before = await f.money();
      await expect(f.sql`insert into ledger_transactions(idempotency_key,type,metadata)
        values('league-entitlements:2026-08-31','league.weekly_reserve','{"week":"2026-08-31","entitlements":1}')`.catch(leaf)).resolves.toMatchObject(frozen);
      await expect(f.sql`insert into base_league_entitlements(week,base_id,tier,trophies,keep_amount)
        values('2026-08-31',${f.baseId},'sol',1300,1)`.catch(leaf)).resolves.toMatchObject(frozen);
      await expect(f.sql`insert into base_league_entitlements(week,base_id,tier,trophies,keep_amount)
        values(${WEEKS[1]},${f.baseId},'sol',1300,0)`.catch(leaf)).resolves.toMatchObject(frozen);
      expect(await f.money()).toBe(before);
    }
  }, 60_000);

  it('refuses a busy old writer atomically, then captures after that writer drains', async () => {
    const ready = deferred(), release = deferred();
    const writer = f.sql.begin(async tx => {
      await tx`update base_league_entitlements set last_attempt_at=last_attempt_at where week=${WEEKS[1]} and base_id=${f.baseId}`;
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    try {
      await expect(f.capture().catch(leaf)).resolves.toMatchObject({ code: '55P03' });
    } finally { release.resolve(); await writer; }
    expect(await f.sql`select * from keep_custody_league_bridge`).toHaveLength(0);
    expect(await f.historicalGraph()).toBe(f.originalGraph);
    expect((await f.capture()).unpaidKeep).toBe('240');
  });

  it('keeps dormant ordinary nonowner money writes usable without exposing private league authority', async () => {
    const role = `league_runtime_${randomUUID().replaceAll('-', '')}`;
    await f.sql.unsafe(`create role ${role}`);
    try {
      await f.sql.unsafe(`grant usage on schema public to ${role}; grant select,insert,update on accounts,ledger_transactions,ledger_entries to ${role}; grant select on deed_economy_cutover_state to ${role}; grant usage,select on all sequences in schema public to ${role}`);
      const [account] = await f.sql<{ id: string }[]>`insert into accounts(owner_wallet,kind,currency) values(${f.bronze},'player_keep','KEEP') returning id`;
      await f.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        const [header] = await tx<{ id: string }[]>`insert into ledger_transactions(idempotency_key,type,metadata) values('fixture:ordinary-runtime','test.ordinary','{}') returning id`;
        for (const [id, delta] of [[f.sys.keep_genesis, -1], [account!.id, 1]] as const) {
          const [row] = await tx<{ balance: string }[]>`update accounts set balance=balance+${delta} where id=${id} returning balance::text`;
          await tx`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${header!.id},${id},${delta},${row!.balance})`;
        }
      });
      expect(await f.balance('player_keep', f.bronze)).toBe(1n);
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`); await tx`select * from keep_custody_league_weeks`;
      }).catch(leaf)).resolves.toMatchObject({ code: '42501' });
      expect((await f.capture()).unpaidKeep).toBe('240');
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`insert into ledger_transactions(idempotency_key,type,metadata) values(${`league:${WEEKS[1]}:${f.baseId}`},'league.weekly_prize','{}')`;
      }).catch(leaf)).resolves.toMatchObject(frozen);
    } finally {
      await f.sql.unsafe(`drop owned by ${role}; drop role ${role}`);
    }
  });

  it('rejects owner TEMP/copied-hook attempts and source/private truncation without erasing the archive', async () => {
    await f.capture();
    for (const [table, hook, error] of [
      ['ledger_transactions', 'shardkeep_league_source_guard', frozen],
      ['keep_custody_league_weeks', 'shardkeep_league_private_guard', { code: 'P0001', message: 'CUSTODY_LEAGUE_FIXTURE_REQUIRED' }],
    ] as const) {
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(`create temporary table league_copy (like public.${table} including all) on commit drop`);
        await tx.unsafe(`create trigger a_keep_custody_league_source before insert on league_copy for each row execute function public.${hook}()`);
        await tx.unsafe(`insert into league_copy select * from public.${table} limit 1`);
      }).catch(leaf)).resolves.toMatchObject(error);
    }
    for (const table of ['ledger_entries', 'ledger_transactions', 'accounts', 'base_league_entitlements']) {
      await expect(f.sql.unsafe(`truncate ${table} cascade`).catch(leaf)).resolves.toMatchObject(frozen);
    }
    await expect(f.sql`truncate keep_custody_league_weeks cascade`.catch(leaf)).resolves.toMatchObject(immutable);
    expect((await f.capture()).unpaidKeep).toBe('240');
    expect(await f.historicalGraph()).toBe(f.originalGraph);
  });

  it('holds reads when a source or deferred hook is missing and refuses incompatible marked schema', async () => {
    await f.capture();
    const ddl = await readFile(new URL('../drizzle/0224_keep_custody_league_bridge.sql', import.meta.url), 'utf8');
    for (const [table, hook] of [
      ['ledger_transactions', 'a_keep_custody_league_source'],
      ['keep_custody_league_bridge', 'keep_custody_league_opening_complete'],
      ['keep_custody_league_retirements', 'keep_custody_league_retirement_complete'],
    ]) {
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(`alter table ${table} disable trigger ${hook}`);
        await tx`select shardkeep_assert_league_archive()`;
      }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_HOOKS_REQUIRED' });
    }
    await expect(f.sql.begin(async tx => {
      await tx`drop trigger keep_custody_league_retirement_complete on keep_custody_league_retirements`;
      await tx.unsafe(`create constraint trigger keep_custody_league_retirement_complete
        after insert or update on keep_custody_league_retirements deferrable initially deferred
        for each row when (false) execute function shardkeep_league_retirement_complete()`);
      await tx`select shardkeep_assert_league_archive()`;
    }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_HOOKS_REQUIRED' });
    for (const alteration of [
      'alter table keep_custody_league_retirements drop constraint keep_custody_league_retirements_posting_key_key',
      'alter table keep_custody_league_weeks alter column original_rows drop not null',
      "comment on table keep_custody_league_weeks is 'untrusted copy'",
    ]) {
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(alteration);
        for (const statement of ddl.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_SCHEMA_CONFLICT' });
    }
    expect((await f.capture()).unpaidKeep).toBe('240');
  });

  it('does not adopt post0095 history or an unsafe environment as original sources', async () => {
    for (const env of [
      { ...f.env, HOLD_BEFORE_MIGRATE: '0' },
      { ...f.env, TEST_DATABASE_URL: 'postgres://example.invalid/shardkeep_custody_apply_00000000000000000000000000000000_test' },
    ]) {
      let connected = false;
      await expect(captureFixtureLeagueSources({ fixtureId: f.bridgeId }, env, () => {
        connected = true; throw Error('must not connect');
      })).rejects.toThrow('CUSTODY_LEAGUE_FIXTURE_REQUIRED');
      expect(connected).toBe(false);
    }
    await f.sql`delete from base_league_entitlements where keep_amount>0`;
    await f.migrateAll();
    await expect(f.capture()).rejects.toThrow('CUSTODY_LEAGUE_OPENING_REQUIRED');
    expect(await f.sql`select * from keep_custody_league_bridge`).toHaveLength(0);
    expect(await f.balance('league_entitlement_escrow')).toBe(240n);
  }, 60_000);

  it('requires the exact opening schema/history and cannot commit an unsealed source header', async () => {
    const [migration] = await f.sql<{ id: number; hash: string }[]>`select id,hash from drizzle.__drizzle_migrations order by id limit 1`;
    await f.sql`update drizzle.__drizzle_migrations set hash='wrong' where id=${migration!.id}`;
    await expect(f.capture()).rejects.toThrow('CUSTODY_LEAGUE_OPENING_REQUIRED');
    await f.sql`update drizzle.__drizzle_migrations set hash=${migration!.hash} where id=${migration!.id}`;
    await f.sql`alter table base_league_entitlements add column unexpected_source text`;
    await expect(f.capture()).rejects.toThrow('CUSTODY_LEAGUE_OPENING_REQUIRED');
    await f.sql`alter table base_league_entitlements drop column unexpected_source`;
    let reached = false;
    await expect(f.sql.begin(async tx => {
      await tx`lock table base_league_entitlements,ledger_transactions,ledger_entries,accounts,players,bases,
        keep_custody_league_bridge,keep_custody_league_weeks,keep_custody_league_retirements,drizzle.__drizzle_migrations
        in access exclusive mode nowait`;
      await tx`insert into keep_custody_league_bridge(fixture_id,database_name,operator_name,source_version,opening_xid,result)
        values(${f.bridgeId},current_database(),current_user,'stable-league-pre0095-v1',txid_current(),
        ${JSON.stringify({ fixtureOnly: true, retirementAuthorized: false, fixtureId: f.bridgeId,
          sourceVersion: 'stable-league-pre0095-v1', weeks: 2, rows: 4, zeroRows: 2,
          paidPositiveRows: 1, unpaidPositiveRows: 1, unpaidKeep: '240' })}::jsonb)`;
      reached = true;
    }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_INCOMPLETE' });
    expect(reached).toBe(true);
    expect(await f.sql`select * from keep_custody_league_bridge`).toHaveLength(0);
    expect((await f.capture()).unpaidKeep).toBe('240');
  });
});
