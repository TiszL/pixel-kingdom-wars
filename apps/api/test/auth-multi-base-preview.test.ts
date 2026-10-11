/** The multi-base preview owns its database: unrelated legacy auth fixtures
 * deliberately lack deed observations and must not weaken boot coverage gates. */
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { bases, baseSlots } from '../src/db/schema';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { TEST_CONFIG, randomWallet } from './helpers';

const conn = isolatedFantasyTestDb();
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  await conn.prepare();
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('DEV_LOGIN', 'true');
  app = await buildApp({ ...TEST_CONFIG, NODE_ENV: 'development' }, conn.db);
  await app.ready();
});
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); await conn.dispose(); });

it('reopens the requested local multi-base fixture without selecting or creating another deed', async () => {
  const wallet = randomWallet();
  expect((await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { wallet } })).statusCode).toBe(200);
  const [first] = await conn.db.select().from(bases).where(eq(bases.ownerWallet, wallet));
  const [second] = await conn.db.insert(bases).values({ ownerWallet: wallet, landPaidAt: new Date() }).returning();
  await conn.db.insert(baseSlots).values({ wallet, slot: 2, baseId: second!.id });
  expect((await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { wallet, baseId: first!.id } })).statusCode).toBe(200);
  expect((await conn.db.select().from(bases).where(eq(bases.ownerWallet, wallet))).map(b => b.id).sort()).toEqual([first!.id, second!.id].sort());
  expect((await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { wallet: randomWallet(), baseId: first!.id } })).statusCode).toBe(404);
});
