/** SQL adapter fixtures use connection-local copies of migrated column types.
 * No shared suite rows, triggers or sequence defaults are modified. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { BASE_OWNERSHIP, FORGE, REMOVED_SKIN_REFUNDS, STRUCTURES } from '@shardkeep/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runCustodyRetirement } from '../src/db/keepCustodyRetire';
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
import { runMigrations } from '../src/db/migrate';

const conn = createDb(TEST_DATABASE_URL, { max: 1 });
const tables = ['accounts', 'ledger_entries', 'ledger_transactions', 'players', 'bases', 'base_forge_positions',
  'forge_contributions', 'deed_ownership_observations', 'mail_messages', 'mail_attachments', 'base_league_entitlements',
  'withdrawals', 'deposits', 'raid_loot_reservations', 'base_raid_locks', 'player_items', 'item_listings', 'buildings', 'clans', 'base_items'];
const at = new Date('2035-01-01T00:00:00.000Z');
const args = ['retire', '--dry-run', '--as-of', at.toISOString()];
const env = { TEST_DATABASE_URL, HOLD_BEFORE_MIGRATE: '1' };
const connect = () => ({ db: conn.db, close: async () => {} });
beforeAll(async () => {
  for (const name of tables) await conn.sql.unsafe(`create temporary table ${name} as select * from public.${name} with no data`);
});
beforeEach(async () => { for (const name of tables) await conn.sql.unsafe(`truncate pg_temp.${name}`); });
afterAll(() => conn.sql.end());
async function state() {
  const result = [];
  for (const name of tables) result.push(await conn.sql.unsafe(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from pg_temp.${name} t`));
  return JSON.stringify(result);
}
async function seed() {
  const wallet = Keypair.generate().publicKey.toBase58(), internal = Keypair.generate().publicKey.toBase58();
  const dev = Keypair.generate().publicKey.toBase58(), asset = Keypair.generate().publicKey.toBase58();
  const base = randomUUID(), mail = randomUUID(), forge = randomUUID(), transaction = randomUUID();
  for (const w of [wallet, internal, dev]) await conn.sql`insert into players (wallet) values (${w})`;
  await conn.sql`insert into bases (id, owner_wallet, deed_asset_id) values (${base},${wallet},${asset})`;
  await conn.sql`insert into ledger_transactions (id,type,metadata) values (${transaction},'test.seed','{}')`;
  const amounts = [['player_keep', wallet, 100n], ['player_keep', internal, 40n], ['player_keep', dev, 50n],
    ['forge_payout_escrow', null, 20n], ['mail_keep_escrow', null, 30n], ['emission_pool', null, 1_000n], ['keep_genesis', null, -1_240n]] as const;
  for (const [kind, owner, amount] of amounts) {
    const id = randomUUID();
    await conn.sql`insert into accounts (id,kind,currency,owner_wallet,balance) values (${id},${kind},'KEEP',${owner},${amount.toString()})`;
    // The dev grant is identified by the actual positive KEEP entry, not metadata.
    const txn = kind === 'player_keep' && owner === dev ? randomUUID() : transaction;
    if (txn !== transaction) await conn.sql`insert into ledger_transactions (id,type,metadata) values (${txn},'dev.fund','{}')`;
    await conn.sql`insert into ledger_entries (txn_id,account_id,delta) values (${txn},${id},${amount.toString()})`;
  }
  await conn.sql`insert into base_forge_positions (id,day,base_id,keep_paid,keep_escrow_txn_id,settled_at)
    values (${forge},'2034-12-31',${base},20,${transaction},${new Date(at.getTime() - 1_000).toISOString()})`;
  await conn.sql`insert into deed_ownership_observations (id,base_id,asset_id,owner,status,checked_at,slot)
    values (1,${base},${asset},${internal},'mismatch',${at.toISOString()},100),(2,${base},${asset},${wallet},'owned',${at.toISOString()},100)`;
  await conn.sql`insert into mail_messages (id,recipient_wallet,reward_state,dedupe_key,expires_at)
    values (${mail},${wallet},'pending','welcome:fixture',${new Date(at.getTime() + 1_000).toISOString()})`;
  await conn.sql`insert into mail_attachments (message_id,kind,amount) values (${mail},'KEEP',30),(${mail},'SHARDS',7)`;
  return { wallet, internal, dev, base, forge, asset, mail };
}

describe('fixture-only custody retirement census and dry-run', () => {
  it.each([
    [args, { ...env, HOLD_BEFORE_MIGRATE: '0' }],
    [['retire', '--apply', '--as-of', at.toISOString()], env],
    [args, { ...env, TEST_DATABASE_URL: 'postgres://localhost/shardkeep' }],
    [args, { ...env, TEST_DATABASE_URL: 'postgres://example.com/fixture_test' }],
    [args, { ...env, TEST_DATABASE_URL: 'postgres://localhost/fixture_test?host=example.com' }],
    [['retire', '--dry-run', '--as-of', 'invalid'], env],
    [['census', '--as-of', '2035-01-01T00:00:00Z'], env],
  ])('rejects unsafe input before connecting (%j)', async (command, environment) => {
    const factory = vi.fn(connect);
    await expect(runCustodyRetirement(command, environment, factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('projects G-8 from measured classes, discloses internal wallets and leaves every fixture row unchanged', async () => {
    const f = await seed(), before = await state();
    const result = await runCustodyRetirement(args, { ...env, ALPHA_WALLETS: f.internal }, connect);
    expect(result.blockers).toEqual([]); expect(result.projectedG8).toBe(true);
    expect(result).toMatchObject({ fixtureOnly: true, retirementAuthorized: false, projectedResidualKeep: 0n });
    expect(result.plan).toMatchObject({ totalKeepConverted: 150n, totalGemsMinted: 150n, sweptInternalKeep: 90n,
      sweptInternalWallets: [f.internal, f.dev].sort(), mixedMailCount: 1, welcomeGemsPending: [] });
    expect(result.before.playerKeep).toBe(190n); expect(result.after.emissionPool - result.before.emissionPool).toBe(240n);
    expect(result.releaseGates).toHaveLength(8);
    expect(await runCustodyRetirement(args, { ...env, ALPHA_WALLETS: f.internal }, connect)).toEqual(result);
    expect(await state()).toBe(before);
  });

  it('selects one latest observation by timestamp/id and holds mismatched or future ownership out', async () => {
    const f = await seed();
    const first = await runCustodyRetirement(args, env, connect);
    expect(first.census.forgeUnclaimed).toHaveLength(1);
    await conn.sql`insert into deed_ownership_observations (id,base_id,asset_id,owner,status,checked_at,slot)
      values (3,${f.base},${f.asset},${f.internal},'mismatch',${at.toISOString()},100)`;
    const mismatch = await runCustodyRetirement(args, env, connect);
    expect(mismatch.blockers).toContain('FORGE_OWNERSHIP_UNRESOLVED');
    expect(mismatch.projectedResidualKeep).toBe(20n); expect(mismatch.projectedG8).toBe(false);
    await conn.sql`update deed_ownership_observations set owner=${f.wallet},status='owned',checked_at=${new Date(at.getTime() + 1).toISOString()} where id=3`;
    expect((await runCustodyRetirement(args, env, connect)).blockers).toContain('FORGE_OWNERSHIP_UNRESOLVED');
  });

  it.each(['pending', 'finalized', 'failed', 'expired', 'credited'] as const)('does not infer K-147 resolution from %s status or missing payment evidence', async status => {
    const f = await seed();
    await conn.sql`insert into deposits (id,player_wallet,kind,status,reference,payment_signature)
      values (${randomUUID()},${f.wallet},'mine_build',${status},${Keypair.generate().publicKey.toBase58()},${status === 'failed' ? 'fixture-paid' : null})`;
    expect((await runCustodyRetirement(args, env, connect)).blockers).toContain('MINE_BUILD_RECONCILIATION_REQUIRED');
  });

  it.each(['stale', 'null-slot'] as const)('holds %s ownership proof instead of attributing Forge KEEP', async reason => {
    await seed();
    if (reason === 'stale') await conn.sql`update deed_ownership_observations set checked_at=${new Date(at.getTime() - BASE_OWNERSHIP.mutationFreshnessMs - 1).toISOString()}`;
    else await conn.sql`update deed_ownership_observations set slot=null where id=2`;
    const result = await runCustodyRetirement(args, env, connect);
    expect(result.blockers).toContain('FORGE_OWNERSHIP_UNRESOLVED');
    expect(result.after.forgePayoutEscrow).toBe(20n); expect(result.projectedG8).toBe(false);
  });

  it('does not manufacture zero liability for lapsed or unexplained escrow balances', async () => {
    const f = await seed();
    await conn.sql`update base_forge_positions set settled_at=${new Date(at.getTime() - FORGE.claimWindowDays * 86_400_000).toISOString()} where id=${f.forge}`;
    const lapsed = await runCustodyRetirement(args, env, connect);
    expect(lapsed.blockers).toContain('LAPSED_FORGE_UNSWEPT'); expect(lapsed.projectedResidualKeep).toBe(20n);
    expect(lapsed.projectedG8).toBe(false);
    await conn.sql`delete from base_forge_positions where id=${f.forge}`;
    const missing = await runCustodyRetirement(args, env, connect);
    expect(missing.blockers).toContain('FORGE_ESCROW_MISMATCH'); expect(missing.projectedResidualKeep).toBe(20n);
    expect(missing.projectedG8).toBe(false);
  });

  it('reports all drain blockers together without writes', async () => {
    const f = await seed();
    await conn.sql`insert into withdrawals (id,status,amount,currency) values (${randomUUID()},'failed',1,'KEEP')`;
    await conn.sql`insert into deposits (id,kind,status) values (${randomUUID()},'keep_deposit','pending')`;
    await conn.sql`insert into base_forge_positions (id,base_id) values (${randomUUID()},${f.base})`;
    await conn.sql`insert into raid_loot_reservations (state,forge_reserved_shards) values ('reserved',1)`;
    const before = await state(), result = await runCustodyRetirement(args, env, connect);
    expect(result.blockers).toEqual(expect.arrayContaining(['WITHDRAWALS_NOT_DRAINED', 'WITHDRAWAL_ESCROW_MISMATCH',
      'KEEP_DEPOSITS_NOT_DRAINED', 'FORGE_POSITIONS_OPEN', 'FORGE_RAID_RESERVATIONS_OPEN']));
    expect(await state()).toBe(before);
  });

  it('rejects cached balances that disagree with immutable entry totals', async () => {
    const f = await seed();
    await conn.sql`update accounts set balance=101 where owner_wallet=${f.wallet} and kind='player_keep'`;
    const result = await runCustodyRetirement(args, env, connect);
    expect(result.blockers).toContain('LEDGER_BALANCE_MISMATCH');
    expect(result.retirementAuthorized).toBe(false);
  });

  it('holds lazy-expired pending welcome mail without converting it or inventing a welcome grant', async () => {
    const f = await seed();
    await conn.sql`update mail_messages set expires_at=${at.toISOString()} where id=${f.mail}`;
    const result = await runCustodyRetirement(args, env, connect);
    expect(result.blockers).toContain('MAIL_EXPIRY_UNRESOLVED');
    expect(result.plan.welcomeGemsPending).toEqual([]); expect(result.census.pendingMailKeep).toEqual([]);
    expect(result.after.mailKeepEscrow).toBe(30n); expect(result.projectedG8).toBe(false);
  });

  it.each([null, new Date(at.getTime() + 1).toISOString()])('holds malformed escrowed Forge settlement %s', async settled => {
    const f = await seed();
    await conn.sql`update base_forge_positions set settled_at=${settled} where id=${f.forge}`;
    const result = await runCustodyRetirement(args, env, connect);
    expect(result.blockers).toContain('FORGE_SETTLEMENT_INVALID');
    expect(result.census.forgeUnclaimed).toEqual([]); expect(result.after.forgePayoutEscrow).toBe(20n);
  });

  it('counts legacy entitlements separately from expired welcome grants and reports legacy reconciliation', async () => {
    const f = await seed(), expiredWallet = Keypair.generate().publicKey.toBase58();
    await conn.sql`insert into base_league_entitlements (base_id,week,keep_amount) values (${f.base},'2034-12-25',9)`;
    await conn.sql`insert into mail_messages (id,recipient_wallet,reward_state,dedupe_key)
      values (${randomUUID()},${expiredWallet},'expired','welcome:expired'),(${randomUUID()},${expiredWallet},'expired','welcome-keep:expired')`;
    const result = await runCustodyRetirement(args, env, connect);
    expect(result.plan.welcomeGemsPending).toEqual([expiredWallet]);
    expect(result.plan.postings.find(p => p.wallet === f.wallet)!.breakdown).toMatchObject({ leagueKeep: 9n, mailKeep: 30n });
    expect(result.plan.postings.some(p => p.wallet === expiredWallet)).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining(['LEGACY_LEAGUE_RECONCILIATION_REQUIRED', 'LEAGUE_ESCROW_MISMATCH']));
    expect(result.after.leagueEntitlementEscrow).toBe(-9n); expect(result.projectedG8).toBe(false);
  });
});


describe('P6 local diagnostics do not claim operator readiness', () => {
  it('measures clean named predicates and disclosure in repeatable read-only census mode', async () => {
    const f = await seed(), before = await state();
    const censusArgs = ['census', '--as-of', at.toISOString()];
    const result = await runCustodyRetirement(censusArgs, { ...env, ALPHA_WALLETS: f.internal }, connect);
    expect(result.mode).toBe('census'); expect(result.localProjectionPassed).toBe(true);
    expect(result.p6.scope).toBe('local-fixture-snapshot');
    expect(result.p6.asOfSemantics).toContain('not a historical reconstruction');
    expect(result.p6.predicates).toEqual([
      { id: 'P6_L5_ZERO', status: 'pass' }, { id: 'P6_S2_ZERO', status: 'pass' },
      { id: 'P6_S3_ZERO', status: 'pass' }, { id: 'P6_L6_ZERO', status: 'pass' },
      { id: 'P6_SKIN_REFUNDS_ZERO', status: 'pass' },
    ]);
    expect(result.p6.internalWalletDisclosure).toMatchObject({ wallets: [f.internal, f.dev].sort(),
      l1Wallets: 2, l1Keep: '90', sourceCompleteness: 'unverified' });
    const metric = (id: string) => result.p6.metrics.find(m => m.id === id)!;
    expect(metric('L4_MIXED_PENDING_KEEP_MAILS')).toMatchObject({ value: '1', table: 'mail_messages, mail_attachments' });
    expect(metric('WELCOME_PENDING_MESSAGES')).toMatchObject({ value: '1', unit: 'messages' });
    expect(metric('WELCOME_EXPIRED_MESSAGES').value).toBe('0');
    expect(metric('WELCOME_CLAIMED_MESSAGES').value).toBe('0');
    for (const m of result.p6.metrics) { expect(m.table.length).toBeGreaterThan(0); expect(m.predicate.length).toBeGreaterThan(0); }
    expect(result.releaseEvidence.map(e => [e.gate, e.status])).toEqual(
      ['P1','P2','P3','P4','P5','P6','P7','P8'].map(gate => [gate, 'unverified']));
    expect(result.p6.unverified).toEqual(expect.arrayContaining(['verbatim published census-e3 baseline', 'production L1–L7 / S1–S7 / R1–R3 census']));
    expect(result.retirementAuthorized).toBe(false);
    expect(await runCustodyRetirement(censusArgs, { ...env, ALPHA_WALLETS: f.internal }, connect)).toEqual(result);
    const dryRun = await runCustodyRetirement(args, { ...env, ALPHA_WALLETS: f.internal }, connect);
    expect(dryRun).toEqual({ ...result, mode: 'retire' }); expect(await state()).toBe(before);
  });

  it('keeps pending, claimed and expired welcome messages distinct from expiry eligibility and deduplicated grant wallets', async () => {
    const f = await seed(); const expired1 = randomUUID(), expired2 = randomUUID(), claimed = randomUUID(), missingExpiry = randomUUID();
    await conn.sql`insert into mail_messages (id,recipient_wallet,reward_state,dedupe_key,expires_at) values
      (${expired1},${f.wallet},'expired','welcome:expired-1',${at.toISOString()}),
      (${expired2},${f.wallet},'expired','welcome-keep:expired-2',${at.toISOString()}),
      (${claimed},${f.wallet},'claimed','welcome:claimed',${new Date(at.getTime() + 1000).toISOString()}),
      (${missingExpiry},${f.wallet},'pending','welcome:missing-expiry',null),
      (${randomUUID()},${f.wallet},'claimed','unrelated:claimed',null)`;
    await conn.sql`insert into mail_attachments(message_id,kind,amount) values (${claimed},'KEEP',99),(${f.mail},'KEEP',1)`;
    const before = await state(), first = await runCustodyRetirement(args, env, connect);
    const values = Object.fromEntries(first.p6.metrics.map(m => [m.id, m.value]));
    expect(values).toMatchObject({ WELCOME_PENDING_MESSAGES: '2', WELCOME_PENDING_KEEP_MESSAGES: '1', WELCOME_PENDING_KEEP: '31',
      WELCOME_EXPIRED_MESSAGES: '2', WELCOME_EXPIRED_WALLETS: '1', WELCOME_CLAIMED_MESSAGES: '1',
      WELCOME_PENDING_DUE_MESSAGES: '0', WELCOME_PENDING_UNKNOWN_EXPIRY_MESSAGES: '1' });
    const later = await runCustodyRetirement(['census', '--as-of', new Date(at.getTime() + 1000).toISOString()], env, connect);
    const laterValues = Object.fromEntries(later.p6.metrics.map(m => [m.id, m.value]));
    expect(laterValues.WELCOME_PENDING_MESSAGES).toBe('2'); expect(laterValues.WELCOME_PENDING_DUE_MESSAGES).toBe('1');
    // Separate stored-state counts do not override the model's existing
    // pending-welcome exclusion or manufacture another grant for this wallet.
    expect(first.plan.welcomeGemsPending).toEqual([]);
    expect(later.retirementAuthorized).toBe(false); expect(await state()).toBe(before);
  });

  it('names every failing P6 zero predicate without changing legacy blockers or authorizing a zero-residue projection', async () => {
    const f = await seed(); const removed = Object.keys(REMOVED_SKIN_REFUNDS)[0]!;
    await conn.sql`insert into base_league_entitlements(base_id,week,keep_amount) values (${f.base},'2034-12-25',9)`;
    await conn.sql`insert into forge_contributions(id,player_wallet,settled_at) values (${randomUUID()},${f.wallet},null)`;
    await conn.sql`insert into accounts(id,kind,currency,balance) values (${randomUUID()},'forge_escrow','SHARDS',5)`;
    await conn.sql`insert into deposits(id,kind,status) values (${randomUUID()},'keep_vend','finalized')`;
    await conn.sql`insert into player_items(id,player_wallet,item_id) values (${randomUUID()},${f.wallet},${removed})`;
    const before = await state(), result = await runCustodyRetirement(args, env, connect);
    expect(result.p6.predicates.map(p => p.status)).toEqual(['fail','fail','fail','fail','fail']);
    expect(result.blockers).toEqual(expect.arrayContaining(['LEGACY_LEAGUE_RECONCILIATION_REQUIRED',
      'LEGACY_FORGE_RECONCILIATION_REQUIRED','FORGE_SHARDS_NOT_DRAINED','KEEP_DEPOSITS_NOT_DRAINED','SKIN_REFUNDS_PENDING']));
    expect(result.localProjectionPassed).toBe(false); expect(result.retirementAuthorized).toBe(false);
    expect(await state()).toBe(before);
  });

  it('does not mistake settled legacy rows for open S2 positions or local zero predicates for full drain readiness', async () => {
    const f = await seed();
    await conn.sql`insert into forge_contributions(id,player_wallet,settled_at) values (${randomUUID()},${f.wallet},${at.toISOString()})`;
    const result = await runCustodyRetirement(args, env, connect);
    expect(result.p6.predicates.find(p => p.id === 'P6_S2_ZERO')?.status).toBe('pass');
    expect(result.blockers).toContain('LEGACY_FORGE_RECONCILIATION_REQUIRED');
    expect(result.localProjectionPassed).toBe(false); expect(result.retirementAuthorized).toBe(false);
  });

  it('existing CLI emits typed census JSON and refuses apply without exposing connection details', async () => {
    const cli = fileURLToPath(new URL('../src/db/keepCustodyRetire.ts', import.meta.url));
    // A child cannot see this suite's connection-local temporary tables. Give
    // it an isolated migrated DB, never other suites' persistent fixture rows.
    const database = `custody_cli_${randomUUID().replaceAll('-', '')}_test`;
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('unsafe CLI fixture host');
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    let fixture: ReturnType<typeof createDb> | undefined;
    try {
      await createMigratedDatabase(admin, database);
      fixture = createDb(url.toString(), { max: 1 });
      await runMigrations(fixture.db);
      const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...env, TEST_DATABASE_URL: url.toString() };
      const run = promisify(execFile);
      const child = await run(process.execPath, ['--import', 'tsx', cli, 'census', '--as-of', at.toISOString()], { env: childEnv });
      const result = JSON.parse(child.stdout);
      expect(result).toMatchObject({ mode: 'census', fixtureOnly: true, retirementAuthorized: false, localProjectionPassed: true });
      expect(result.releaseEvidence).toHaveLength(8); expect(result.p6.predicates.every((p: { status: string }) => p.status === 'pass')).toBe(true);
      await expect(run(process.execPath, ['--import', 'tsx', cli, 'retire', '--apply', '--as-of', at.toISOString()], { env: childEnv }))
        .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Custody fixture rehearsal refused;') });
    } finally {
      await fixture?.sql.end();
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  }, 30_000);
});


describe('all local custody census classes', () => {
  it('measures nonzero L1–L7 and S1–S7 classes without treating preserved SHARDS, items or pools as converted KEEP', async () => {
    const f = await seed();
    for (const [kind, amount, currency] of [
      ['league_entitlement_escrow', 9, 'KEEP'], ['withdrawal_escrow', 23, 'KEEP'],
      ['league_pool', 13, 'KEEP'], ['treasury', 17, 'KEEP'], ['burn', 19, 'KEEP'],
      ['onchain_inflow', -31, 'KEEP'], ['onchain_outflow', 29, 'KEEP'],
      ['forge_escrow', 5, 'SHARDS'], ['base_forge_escrow', 21, 'SHARDS'],
      ['clan_chest', 25, 'SHARDS'], ['base_shards', 41, 'SHARDS'],
    ] as const) await conn.sql`insert into accounts(id,kind,currency,balance) values (${randomUUID()},${kind},${currency},${amount})`;
    await conn.sql`insert into base_league_entitlements(base_id,week,keep_amount) values (${f.base},'2034-12-25',9)`;
    await conn.sql`insert into base_forge_positions(id,base_id,day,contributed_shards,raid_debited_shards) values
      (${randomUUID()},${f.base},'2034-12-30',15,3),(${randomUUID()},${f.base},'2034-12-31',11,2)`;
    await conn.sql`insert into forge_contributions(id,player_wallet,settled_at,keep_paid,keep_escrow_txn_id) values
      (${randomUUID()},${f.wallet},null,0,null),(${randomUUID()},${f.wallet},${at.toISOString()},7,${randomUUID()})`;
    await conn.sql`insert into withdrawals(id,currency,status,amount,unbonds_at) values
      (${randomUUID()},'KEEP','unbonding',10,${new Date(at.getTime()-1).toISOString()}),
      (${randomUUID()},'KEEP','processing',6,null),(${randomUUID()},'KEEP','failed',7,null),
      (${randomUUID()},'KEEP','sent',99,null),(${randomUUID()},'KEEP','refunded',88,null)`;
    await conn.sql`insert into deposits(id,kind,status) values
      (${randomUUID()},'keep_deposit','pending'),(${randomUUID()},'keep_vend','finalized'),
      (${randomUUID()},'keep_deposit','credited'),(${randomUUID()},'gems_buy','pending')`;
    await conn.sql`insert into raid_loot_reservations(state,forge_reserved_shards) values ('reserved',8),('reserved',0),('released',99)`;
    await conn.sql`insert into base_raid_locks(base_id) values (${f.base})`;
    await conn.sql`insert into clans(id,chest_shards) values (${randomUUID()},12),(${randomUUID()},13)`;
    await conn.sql`insert into base_items(id,base_id,item_id,qty) values (${randomUUID()},${f.base},'fixture-base',4)`;
    await conn.sql`insert into player_items(id,player_wallet,item_id,qty) values (${randomUUID()},${f.wallet},'fixture-player',3)`;
    const before = await state(), result = await runCustodyRetirement(args, env, connect);
    const values = Object.fromEntries(result.p6.metrics.map(m => [m.id,m.value]));
    expect(new Set(result.p6.metrics.map(m => m.id)).size).toBe(result.p6.metrics.length);
    expect(values).toMatchObject({ L1_POSITIVE_ACCOUNTS:'3', L1_POSITIVE_KEEP:'190', L1_ALL_ACCOUNTS:'3',
      L2A_CLAIMABLE_ROWS:'1', L2A_CLAIMABLE_KEEP:'20', L2B_UNCLAIMED_ROWS:'1', L2B_UNCLAIMED_KEEP:'7', L2_ESCROW_KEEP:'20',
      L3_UNBONDING_ROWS:'1', L3_UNBONDING_KEEP:'10', L3_UNBONDING_OVERDUE_ROWS:'1', L3_PROCESSING_KEEP:'6', L3_FAILED_KEEP:'7', L3_ESCROW_KEEP:'23',
      L4_PENDING_KEEP_MAILS:'1', L4_PENDING_KEEP:'30', L4_ESCROW_KEEP:'30', L5_UNPAID_LEAGUE_KEEP:'9', L6_OPEN_KEEP_INTENTS:'2',
      L7_EMISSION_POOL_KEEP:'1000', L7_LEAGUE_POOL_KEEP:'13', L7_TREASURY_KEEP:'17', L7_BURN_KEEP:'19',
      L7_ONCHAIN_INFLOW_KEEP:'-31', L7_ONCHAIN_OUTFLOW_KEEP:'29', L7_KEEP_GENESIS_KEEP:'-1240',
      S1_OPEN_DEED_FORGE_ROWS:'2', S1_OPEN_DEED_FORGE_SHARDS:'21', S1_OPEN_DEED_FORGE_DAYS:'2', S2_OPEN_LEGACY_FORGE_ROWS:'1',
      S3_LEGACY_FORGE_ESCROW_SHARDS:'5', S4_POSITIVE_DEED_ESCROW_ACCOUNTS:'1', S4_DEED_ESCROW_SHARDS:'21',
      S5_RESERVED_FORGE_ROWS:'1', S5_RESERVED_FORGE_SHARDS:'8', S5_BASE_RAID_LOCKS:'1',
      S6_CLANS:'2', S6_CLAN_CHEST_SHARDS:'25', S6_LEDGER_CHEST_SHARDS:'25',
      S7_BASE_SHARDS:'41', S7_BASE_ITEM_ROWS:'1', S7_BASE_ITEM_QUANTITY:'4', S7_PLAYER_ITEM_ROWS:'1', S7_PLAYER_ITEM_QUANTITY:'3' });
    expect(result.p6.localClassCoverage).toEqual({ liabilities:['L1','L2','L3','L4','L5','L6','L7'], shards:['S1','S2','S3','S4','S5','S6','S7'], rights:['R1','R2','R3'] });
    expect(result.plan.totalKeepConverted).toBe(206n); // 140 player +20 Forge +7 legacy +30 mail +9 league; dev50 excluded.
    expect(result.retirementAuthorized).toBe(false);
    expect(result.releaseEvidence.every(e => e.status === 'unverified')).toBe(true);
    expect(await runCustodyRetirement(args, env, connect)).toEqual(result); expect(await state()).toBe(before);
  });

  it('counts paid rights by actual building identity/level and only eligible pending intents and listings', async () => {
    const f = await seed(), gold = randomUUID(), other = randomUUID();
    await conn.sql`insert into buildings(id,player_wallet,type,level) values
      (${gold},${f.wallet},'goldforge',1),(${randomUUID()},${f.wallet},'goldforge',${STRUCTURES.goldforge.maxLevel}),
      (${other},${f.wallet},'mine',${STRUCTURES.mine.maxLevel})`;
    for (const [kind,status,target] of [['mine','pending',gold],['mine','finalized',gold],['mine','pending',other],
      ['mine','pending',randomUUID()],['gems_buy','pending',gold]] as const)
      await conn.sql`insert into deposits(id,kind,status,payload) values (${randomUUID()},${kind},${status},${JSON.stringify({buildingId:target})}::jsonb)`;
    await conn.sql`insert into item_listings(id,status,item_id) values
      (${randomUUID()},'active','fixture'),(${randomUUID()},'reserved','fixture'),(${randomUUID()},'sold','fixture'),(${randomUUID()},'cancelled','fixture')`;
    const before = await state(), result = await runCustodyRetirement(['census','--as-of',at.toISOString()],env,connect);
    const values = Object.fromEntries(result.p6.metrics.map(m => [m.id,m.value]));
    expect(values).toMatchObject({ R1_GOLDFORGE_BUILDINGS:'2', R2_PENDING_GOLDFORGE_SOL_INTENTS:'1', R3_OPEN_ITEM_LISTINGS:'2' });
    expect(result.p6.goldForgeLevels).toEqual([{ level:1, buildings:'1' },{ level:STRUCTURES.goldforge.maxLevel, buildings:'1' }]);
    expect(result.plan.totalKeepConverted).toBe(190n); // Existing player/Forge/mail fixture only; rights never compensate.
    expect(result.p6.unverified).toContain('production L1–L7 / S1–S7 / R1–R3 census');
    expect(await state()).toBe(before);
  });

  it('uses the supplied boundary for lapse and overdue diagnostics without counting terminal or invalid-time obligations as claimable', async () => {
    const f = await seed(), cutoff = new Date(at.getTime()-FORGE.claimWindowDays*86_400_000).toISOString();
    await conn.sql`update base_forge_positions set settled_at=${cutoff} where id=${f.forge}`;
    await conn.sql`insert into base_forge_positions(id,base_id,day,keep_paid,keep_escrow_txn_id,settled_at,claimed_at,expired_at) values
      (${randomUUID()},${f.base},'future',11,${randomUUID()},${new Date(at.getTime()+1).toISOString()},null,null),
      (${randomUUID()},${f.base},'claimed',99,${randomUUID()},${at.toISOString()},${at.toISOString()},null),
      (${randomUUID()},${f.base},'expired',88,${randomUUID()},${at.toISOString()},null,${at.toISOString()})`;
    await conn.sql`insert into withdrawals(id,currency,status,amount,unbonds_at) values
      (${randomUUID()},'KEEP','unbonding',3,${at.toISOString()}),(${randomUUID()},'KEEP','sent',7,${cutoff})`;
    const before = await state(), result = await runCustodyRetirement(args,env,connect);
    const values = Object.fromEntries(result.p6.metrics.map(m => [m.id,m.value]));
    expect(values).toMatchObject({ L2A_CLAIMABLE_ROWS:'0', L2A_CLAIMABLE_KEEP:'0', L2A_LAPSED_ROWS:'1', L2A_LAPSED_KEEP:'20',
      L2A_INVALID_SETTLEMENT_ROWS:'1', L2_ESCROW_KEEP:'20', L3_UNBONDING_ROWS:'1', L3_UNBONDING_KEEP:'3', L3_UNBONDING_OVERDUE_ROWS:'0' });
    expect(result.projectedG8).toBe(false); expect(await state()).toBe(before);
  });
});
