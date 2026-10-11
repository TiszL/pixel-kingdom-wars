/** Actual normal collection must retain original fractional production while
 * current operating admission is unavailable. Historical proof remains real. */
import { Keypair, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { MINING, PHASE_E_HARVESTER, getMiningQuota } from '@shardkeep/shared';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, buildings, mineAccrualStates, sessions } from '../src/db/schema';
import { MINE_DAY_MS } from '../src/game/baseMining';
import { initializeMiningRosterHistory } from '../src/mining/rosterHistory';
import { createPhysicalMineRecoveryProvider } from '../src/mining/shardsTaxMineRecoveryProvider';
import { readHistoricalMineTaxSource } from '../src/mining/shardsTaxMineRecoveryHistory';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { setMineResolutionRosterClock } from './fixtures/historicalMineResolution';
import { createTestPlayer, TEST_CONFIG } from './helpers';

let active: ReturnType<typeof resourceClaimsDatabase> | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => {
  const server = app; app = undefined; await server?.close();
  const db = active; active = undefined; await db?.close();
  vi.unstubAllEnvs(); vi.useRealTimers();
});

it('collects uncapped original output and the next fractional unit without a current provider or new admission', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('FREE_ONBOARDING', 'true');
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  const db = active = resourceClaimsDatabase(); await db.setup();
  const quota = BigInt(getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS));
  const day = BigInt(MINE_DAY_MS), anchor = new Date('2035-01-17T00:00:00.000Z');
  // Twenty whole units plus a nonzero fraction: enough to fund a real tax leg,
  // far below the physical one-day cap. Expected amounts use an independent
  // numerator, never the production projection under test.
  const elapsed = (20n * day + 3n * day / 4n) / quota;
  let now = new Date(+anchor + Number(elapsed)); vi.setSystemTime(now);
  const bank = await createMiningTermFixture({ day: '2035-01-16', round: 2n,
    firstOperatingStart: BigInt(Date.parse('2035-01-01T00:00:00Z') / 1000),
    genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
  bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now / 1000)), 32);
  await db.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at)
    values(1,1,1,1,'2035-01-16T00:00:00Z')`;
  await setMineResolutionRosterClock(db, '2035-01-16T00:00:00Z');
  const { wallet } = await createTestPlayer(db.db);
  const [base] = await db.db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 1 }).returning();
  await db.db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
  const [mine] = await db.db.insert(buildings).values({ playerWallet: wallet, baseId: base!.id,
    type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  await db.db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: anchor });
  await initializeMiningRosterHistory(db.db, wallet);
  await setMineResolutionRosterClock(db, now.toISOString());
  const [session] = await db.db.insert(sessions).values({ wallet,
    expiresAt: new Date(+now + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  const recovery = createPhysicalMineRecoveryProvider(db.db, {
    historicalTerm: { connect: bank.connect, policy: bank.policy }, clock: () => new Date(now),
  });
  // Avoid unrelated startup enrollment; this test establishes its real baseline
  // before production and exercises the normal route's actual recovery hook.
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  try { app = await buildApp(TEST_CONFIG, db.db, { physicalMineRecoveryProvider: recovery }); await app.ready(); }
  finally { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); }
  const collect = () => app!.inject({ method: 'POST', url: '/mine/collect', payload: { baseId: base!.id }, cookies });
  const gross = quota * elapsed / day, remainder = quota * elapsed % day;
  expect(gross).toBe(20n); expect(remainder).toBeGreaterThan(0n); expect(gross).toBeLessThan(quota);
  const tax = gross * BigInt(PHASE_E_HARVESTER.v1.islandPoolBps) / BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
  const first = await collect();
  expect(first.statusCode, first.body).toBe(200); // Actual pre-fix RED: SHARDS_SOURCE_HELD.
  expect(first.json()).toEqual({ amount: (gross - tax).toString() });
  const [state] = await db.sql`select accrued_shards::text,production_remainder::text,last_accrual_at
    from mine_accrual_states where mine_building_id=${mine!.id}`;
  expect(state).toMatchObject({ accrued_shards: '0', production_remainder: remainder.toString() });
  expect(new Date(state!.last_accrual_at)).toEqual(now);
  const children = await db.sql`select id,starts_at,ends_at,quota::text,gross::text from shards_mine_segments
    where mine_id=${mine!.id} and recovery_parent_id is not null order by starts_at,id`;
  expect(children).toHaveLength(1); expect(children[0]!.gross).toBe(gross.toString());
  expect(new Date(children[0]!.starts_at)).toEqual(new Date(+anchor + Number((day + quota - 1n) / quota)));
  const original = await readHistoricalMineTaxSource(db.db, children[0]!.id);
  expect(original.original.wallet).toBe(wallet); expect(original.term.snapshot.source.round).toBe('2');
  const assessments = await db.sql`select gross::text,net::text,tax::text,term_id,wallet from shards_tax_assessments where wallet=${wallet}`;
  expect(assessments).toHaveLength(1);
  expect(assessments[0]).toMatchObject({ gross: gross.toString(), net: (gross - tax).toString(), tax: tax.toString(),
    term_id: original.term.snapshot.termId, wallet });
  expect(await db.sql`select id from shards_mine_admissions where base_id=${base!.id}`).toHaveLength(0);
  expect(await db.sql`select mine_id from shards_mine_heads where mine_id=${mine!.id}`).toHaveLength(0);
  // Repeated empty taps must neither reset r nor create a second issue.
  expect((await collect()).json()).toEqual({ amount: '0' });
  expect(await db.sql`select production_remainder::text from mine_accrual_states where mine_building_id=${mine!.id}`)
    .toEqual([{ production_remainder: remainder.toString() }]);
  const completionMs = BigInt(+now) + (day - remainder + quota - 1n) / quota;
  // The actual term verifier observes an integer-second chain Clock. Collect
  // strictly after completion at the next real second, not under a fake future
  // Clock. This is still too little new elapsed production to earn alone.
  const nextMs = (completionMs / 1000n + 1n) * 1000n;
  const nextElapsed = nextMs - BigInt(+now);
  expect(nextElapsed * quota).toBeLessThan(day); // It earns only because the old fraction survived.
  now = new Date(Number(nextMs)); vi.setSystemTime(now);
  bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now / 1000)), 32);
  await setMineResolutionRosterClock(db, now.toISOString());
  const second = await collect(); expect(second.statusCode, second.body).toBe(200);
  expect(second.json()).toEqual({ amount: '1' });
  const total = await db.sql`select sum(gross)::text gross,sum(net)::text net,sum(tax)::text tax
    from shards_tax_assessments where wallet=${wallet}`;
  expect(total).toEqual([{ gross: (gross + 1n).toString(), net: (gross + 1n - tax).toString(), tax: tax.toString() }]);
  expect(await readHistoricalMineTaxSource(db.db, children[0]!.id)).toEqual(original);
  expect((await collect()).json()).toEqual({ amount: '0' });
  expect(await db.sql`select id from ledger_transactions where type='mine.collect' and metadata->>'baseId'=${base!.id}`)
    .toHaveLength(2);
}, 120_000);
