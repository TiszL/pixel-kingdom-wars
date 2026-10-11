/** The actual app/session boundary must recover an accepted purchase while paused. */
import { randomUUID } from 'node:crypto';
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from '@shardkeep/shared';
import { FreeBasePurchaseViewSchema } from '@shardkeep/shared/freeBasePurchaseApi';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createFreeBasePurchaseProvider } from '../src/game/freeBasePurchaseRoutes';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions } from '../src/db/schema';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { createTestPlayer, TEST_CONFIG } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';
// App boot verifies the complete active-deed population. Other broad-suite
// fixtures may intentionally exceed that limit; preserve the real preflight by
// owning a fresh database instead of letting test order decide this HTTP case.
const name = `mining_free_http_${randomUUID().replaceAll('-', '')}_test`;
const url = new URL(ADMIN_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Fixture host required');
url.pathname = `/${name}`;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
let conn: ReturnType<typeof createDb>, created = false;
beforeAll(async () => {
  await admin.unsafe(`create database ${name}`); created = true;
  conn = createDb(url.toString(), { max: 4 });
  await runMigrations(conn.db);
});
afterAll(async () => {
  vi.unstubAllEnvs(); await conn?.sql.end();
  if (created) await admin.unsafe(`drop database ${name} with (force)`);
  await admin.end();
});
async function cookies(wallet: string) {
  const [session] = await conn.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}
describe('second free base authenticated recovery', () => {
  it('creates two selectable bases once, recovers a lost response after pause, and keeps receipts private', async () => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    vi.stubEnv('FREE_ONBOARDING', 'true');
    const { wallet } = await createTestPlayer(conn.db), other = await createTestPlayer(conn.db), sourceBaseId = randomUUID();
    await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${sourceBaseId},${wallet},${PHASE_E_FREE_BASE_POLICY.minKeepLevel})`;
    await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${sourceBaseId})`;
    await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values
      (${wallet},${sourceBaseId},'keep',${PHASE_E_FREE_BASE_POLICY.minKeepLevel},10,10),
      (${wallet},${sourceBaseId},'workshop',${PHASE_E_FREE_BASE_POLICY.minWorkshopLevel},20,20),
      (${wallet},${sourceBaseId},'goldforge',${PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel},25,25)`;
    await rewardBaseShards(conn.db, sourceBaseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.free_base_http', randomUUID());
    const auth = await cookies(wallet), foreignAuth = await cookies(other.wallet), app = await buildApp(TEST_CONFIG, conn.db, { freeBasePurchaseProvider: createFreeBasePurchaseProvider(conn.db) });
    const request = { sourceBaseId, idempotencyKey: randomUUID() }, headers = { origin: TEST_CONFIG.WEB_ORIGIN[0]! };
    try {
      const available = await app.inject({ url: `/bases/free-purchases?sourceBaseId=${sourceBaseId}`, cookies: auth });
      expect(available.statusCode, available.body).toBe(200);
      expect(FreeBasePurchaseViewSchema.parse(available.json()).admission).toEqual({ allowed: true, reason: 'ready' });
      const accepted = await app.inject({ method: 'POST', url: '/bases/free-purchases', cookies: auth, headers, payload: request });
      expect(accepted.statusCode, accepted.body).toBe(201);
      const original = accepted.json<{ baseId: string; sourceBaseId: string; debitTransactionId: string }>();
      // Simulate losing the reply: reconnect through receipt lookup, without reposting a debit.
      vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
      const paused = await app.inject({ url: '/bases/free-purchases', cookies: auth });
      expect(FreeBasePurchaseViewSchema.parse(paused.json())).toMatchObject({ enabled: false,
        admission: { allowed: false, reason: 'already-purchased' }, receipt: original });
      const recovered = await app.inject({ method: 'GET', url: `/bases/free-purchases/by-key/${request.idempotencyKey}`, cookies: auth });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.headers['cache-control']).toBe('private, no-store');
      expect(recovered.json()).toEqual({ receipt: original });
      const replay = await app.inject({ method: 'POST', url: '/bases/free-purchases', cookies: auth, headers, payload: request });
      expect(replay.statusCode, replay.body).toBe(201); expect(replay.json()).toEqual(original);
      const privateRead = await app.inject({ method: 'GET', url: `/bases/free-purchases/by-key/${request.idempotencyKey}`, cookies: foreignAuth });
      expect(privateRead.json()).toEqual({ receipt: null });
      for (const baseId of [sourceBaseId, original.baseId]) {
        const state = await app.inject({ method: 'GET', url: `/base?baseId=${baseId}`, cookies: auth });
        expect(state.statusCode, state.body).toBe(200);
      }
      expect((await app.inject({ method: 'GET', url: '/base', cookies: auth })).statusCode).toBe(426);
      expect(await getBaseShardBalance(conn.db, sourceBaseId)).toBe(0n);
      expect(await conn.sql`select id from ledger_transactions where id=${original.debitTransactionId}`).toHaveLength(1);
      expect(await conn.sql`select id from bases where owner_wallet=${wallet}`).toHaveLength(2);
    } finally { await app.close(); }
  });
});
