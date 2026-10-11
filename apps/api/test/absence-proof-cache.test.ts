/** The native client reads GET /base, /base/layouts and /army as proof that a
 * lost legacy order left no effect. A browser, proxy or HTTP-client cache must
 * never answer that proof with an earlier copy, so each read is private and
 * never stored. */
import { BuildingType } from '@shardkeep/shared';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, buildings, sessions } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const flags = ['MULTI_BASE_ENABLED', 'FREE_ONBOARDING'] as const;
const prior = Object.fromEntries(flags.map((flag) => [flag, process.env[flag]]));
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => {
  for (const flag of flags) { if (prior[flag] === undefined) delete process.env[flag]; else process.env[flag] = prior[flag]; }
  await conn.sql.end();
});

it('GET /base, /base/layouts and /army answer Cache-Control: private, no-store', async () => {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 4, landPaidAt: new Date() }).returning();
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id, active: true });
  await db.insert(buildings).values({ playerWallet: wallet, baseId: base!.id, type: BuildingType.Keep, level: 4, tx: 10, ty: 10 });
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  // Build without stable mode (no deployment-time deed census for unrelated
  // suites' bases), then serve these reads with the real stable-base gates.
  process.env['FREE_ONBOARDING'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'false';
  const app = await buildApp(TEST_CONFIG, db);
  process.env['MULTI_BASE_ENABLED'] = 'true';
  try {
    for (const url of [`/base?baseId=${base!.id}`, `/base/layouts?baseId=${base!.id}`, `/army?baseId=${base!.id}`]) {
      const response = await app.inject({ method: 'GET', url, cookies });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      expect(response.headers['cache-control'], url).toBe('private, no-store');
    }
  } finally { await app.close(); }
});
