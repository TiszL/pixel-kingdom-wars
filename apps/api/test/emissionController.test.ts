/**
 * Treasury-aware emission controller (#45) — the DB integration. Encodes the WHY:
 * the controller must READ the live pool and PERSIST a multiplier that throttles
 * mining as the pool drains, cutting fast but recovering slow, so a draining
 * treasury can't be inflated away. The pure signal→bps policy is covered in
 * @shardkeep/shared mining.test; here we prove the wiring (pool read → persist).
 *
 * Determinism: the controller reads 24h withdrawal outflow + active players, both
 * shared across test files. Running at a FAR-FUTURE `now` puts every ambient row
 * outside the 24h window (outflow=0, active=0), isolating the pool signal — which
 * this test sets directly.
 */
import { MINING, TOKEN } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts } from '../src/db/schema';
import { runEmissionController } from '../src/game/emissionController';
import { ensureGameConfig, getEmissionMultBps, setEmissionMultBps } from '../src/game/gameConfig';
import { bootstrapPlayPool, bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const PLAY_POOL = BigInt(TOKEN.allocation.playPool);
const FUTURE = new Date('2050-01-01T00:00:00Z'); // past every real test row's 24h window

async function setPool(bal: bigint): Promise<void> {
  const sys = await bootstrapSystemAccounts(db);
  await db.update(accounts).set({ balance: bal }).where(eq(accounts.id, sys.emission_pool));
}

beforeAll(async () => {
  await bootstrapPlayPool(db);
  await ensureGameConfig(db);
});
afterAll(async () => {
  // Restore the SHARED emission pool + multiplier so other files see genesis state.
  await setPool(PLAY_POOL);
  await setEmissionMultBps(db, MINING.EPOCH_RATE_BPS);
});

describe('runEmissionController', () => {
  it('holds at full emission when the pool is healthy', async () => {
    await setPool(PLAY_POOL);
    await setEmissionMultBps(db, 10_000);
    const r = await runEmissionController(db, FUTURE);
    expect(r.outflow24h).toBe(0);      // far-future now → ambient rows excluded
    expect(r.activePlayers).toBe(0);
    expect(r.target).toBe(10_000);
    expect(r.next).toBe(10_000);
    expect(await getEmissionMultBps(db)).toBe(10_000); // persisted
  });

  it('throttles DOWN (by up to cutStepBps) when the pool is critically low', async () => {
    await setPool(PLAY_POOL / 20n); // 5% remaining → below the critical floor
    await setEmissionMultBps(db, 10_000);
    const r = await runEmissionController(db, FUTURE);
    expect(r.target).toBe(1_000);                       // pool signal at the floor
    expect(r.previous).toBe(10_000);
    expect(r.next).toBe(10_000 - 4_000);                // one full cut step, not to floor
    expect(await getEmissionMultBps(db)).toBe(6_000);
  });

  it('recovers UP slowly (by only recoverStepBps) once the pool is healthy again', async () => {
    await setPool(PLAY_POOL);
    await setEmissionMultBps(db, 1_000);
    const r = await runEmissionController(db, FUTURE);
    expect(r.target).toBe(10_000);
    expect(r.next).toBe(1_000 + 500); // slow recovery, one step
  });

  it('persists a clamped multiplier (bounds are enforced on write + read)', async () => {
    await setEmissionMultBps(db, 50);      // below minBps
    expect(await getEmissionMultBps(db)).toBe(1_000);
    await setEmissionMultBps(db, 999_999); // above maxBps
    expect(await getEmissionMultBps(db)).toBe(10_000);
  });
});
