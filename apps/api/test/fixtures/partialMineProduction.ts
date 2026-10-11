/** Real partial capture setup. Term transport is an explicitly local encoded
 * fixture; custody, source settlement, history, tax and collection remain real. */
import { Keypair, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { MINING, getMiningQuota } from '@shardkeep/shared';
import { createMiningTermFixture } from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { buildApp, type AppDeps } from '../../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { bases, baseSlots, buildings, mineAccrualStates, sessions } from '../../src/db/schema';
import type { Db } from '../../src/db/client';
import { MINE_DAY_MS } from '../../src/game/baseMining';
import { initializeMiningRosterHistory } from '../../src/mining/rosterHistory';
import { createPhysicalMineRecoveryProvider } from '../../src/mining/shardsTaxMineRecoveryProvider';
import { capturePhysicalMineSources } from '../../src/mining/shardsTaxMineFullCapture';
import { resourceClaimsDatabase } from './resourceClaimsDatabase';
import { setMineResolutionRosterClock } from './historicalMineResolution';
import { createTestPlayer, TEST_CONFIG } from '../helpers';

export const partialMineDay = BigInt(MINE_DAY_MS);
export const partialMineQuota = BigInt(getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS));
export const partialMineAnchor = new Date('2035-01-17T00:00:00Z');
export async function createPartialMineFixture(conn: ReturnType<typeof resourceClaimsDatabase>, cutoff = new Date('2035-01-16T00:00:00Z')) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('FREE_ONBOARDING', 'true'); vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  const day = partialMineDay, quota = partialMineQuota, anchor = partialMineAnchor;
  const elapsed = (20n * day + 3n * day / 4n) / quota;
  let now = new Date(+anchor + Number(elapsed)); vi.setSystemTime(now);
  const bank = await createMiningTermFixture({ day: '2035-01-16', round: 2n,
    firstOperatingStart: BigInt(Date.parse('2035-01-01T00:00:00Z') / 1000),
    genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
  await conn.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at)
    values(1,1,1,1,${cutoff.toISOString()})`;
  await setMineResolutionRosterClock(conn, '2035-01-16T00:00:00Z');
  const { wallet } = await createTestPlayer(conn.db);
  const [base] = await conn.db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 1 }).returning();
  await conn.db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
  const [mine] = await conn.db.insert(buildings).values({ playerWallet: wallet, baseId: base!.id, type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  await conn.db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: anchor });
  await initializeMiningRosterHistory(conn.db, wallet);
  const [session] = await conn.db.insert(sessions).values({ wallet, expiresAt: new Date(+now + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  const servers: FastifyInstance[] = [], errors: string[] = [];
  async function time(at: Date) {
    now = new Date(at); vi.setSystemTime(now);
    bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now / 1000)), 32);
    await setMineResolutionRosterClock(conn, now.toISOString());
  }
  await time(now);
  const provider = (unavailable = () => false) => createPhysicalMineRecoveryProvider(conn.db, {
    historicalTerm: { policy: bank.policy, connect: signal => {
      if (unavailable()) throw Error('fixture historical archive unavailable'); return bank.connect(signal);
    } }, clock: () => new Date(now),
  });
  async function open(overrides: AppDeps = {}, db: Db = conn.db) {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    try { const app = await buildApp(TEST_CONFIG, db, { physicalMineRecoveryProvider: provider(), ...overrides }); servers.push(app); app.addHook('onError', async (_request, _reply, error) => {
      let leaf: unknown = error; while (leaf && typeof leaf === 'object' && 'cause' in leaf && leaf.cause) leaf = leaf.cause;
      errors.push(leaf instanceof Error ? leaf.message : String(leaf));
    }); await app.ready(); return app; }
    finally { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); }
  }
  return { conn, bank, base: base!, mine: mine!, wallet, quota, day, anchor, elapsed,
    gross: quota * elapsed / day, remainder: quota * elapsed % day,
    get now() { return new Date(now); }, time, provider, open, errors,
    collect: (app: FastifyInstance) => app.inject({ method: 'POST', url: '/mine/collect', payload: { baseId: base!.id }, cookies }),
    capture: () => capturePhysicalMineSources(conn.db, wallet, base!.id, { clock: () => new Date(now) }),
    state: async () => (await conn.sql`select mine_building_id,accrued_shards::text,production_remainder::text,last_accrual_at,version from mine_accrual_states where mine_building_id=${mine!.id}`)[0]!,
    footprint: async () => ({
      state: await conn.sql`select to_jsonb(s) value from mine_accrual_states s where mine_building_id=${mine!.id}`,
      segments: await conn.sql`select to_jsonb(s) value from shards_mine_segments s where mine_id=${mine!.id} order by id`,
      settlements: await conn.sql`select to_jsonb(s) value from shards_mine_production_settlements s where mine_id=${mine!.id} order by id`,
      sides: await conn.sql`select c.* from shards_mine_segment_production c join shards_mine_segments s on s.id=c.segment_id where s.mine_id=${mine!.id} order by segment_id`,
      headers: await conn.sql`select to_jsonb(h) value from shards_mine_resolutions h join shards_mine_segments s on s.id=h.parent_id where s.mine_id=${mine!.id} order by h.parent_id`,
      terms: await conn.sql`select to_jsonb(t) value from shards_mine_resolution_terms t join shards_mine_segments s on s.id=t.segment_id where s.mine_id=${mine!.id} order by t.segment_id`,
      admissions: await conn.sql`select to_jsonb(a) value from shards_mine_admissions a where base_id=${base!.id} order by id`,
      heads: await conn.sql`select to_jsonb(h) value from shards_mine_heads h where mine_id=${mine!.id}`,
      assessments: await conn.sql`select to_jsonb(a) value from shards_tax_assessments a where wallet=${wallet} order by operation_key`,
      ledger: await conn.sql`select id from ledger_transactions where type='mine.collect' and metadata->>'baseId'=${base!.id} order by id`,
    }),
    closeServers: async () => { await Promise.all(servers.splice(0).map(app => app.close())); },
  };
}
export type PartialMineFixture = Awaited<ReturnType<typeof createPartialMineFixture>>;
