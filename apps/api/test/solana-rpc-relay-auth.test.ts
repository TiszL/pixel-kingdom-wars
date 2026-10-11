/** The relay must permit the first land payment, but a login-pending or revoked
 * cookie must never acquire the ability to broadcast as the wallet. */
import { randomUUID } from 'node:crypto';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueLoginJwt, issueSessionJwt } from '../src/auth/session';
import { players, sessions } from '../src/db/schema';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
afterAll(async () => { await conn.sql.end(); });
it('requires the real DB-active full session, preserves first-land access, and rechecks MFA/revocation', async () => {
  const payer = Keypair.generate(); const wallet = payer.publicKey.toBase58(); const id = randomUUID();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(payer);
  const payload = { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [tx.serialize().toString('base64'), { encoding: 'base64' }] };
  await conn.db.insert(players).values({ wallet });
  await conn.db.insert(sessions).values({ id, wallet, expiresAt: new Date(Date.now() + 60_000), scope: 'login_pending' });
  const upstream = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'submitted' })));
  const app = await buildApp({ ...TEST_CONFIG, RPC_RELAY_ENABLED: 'true' }, conn.db, { solanaRpcRelay: {
    fetch: upstream,
    admission: { charge: async () => {}, acquire: async () => ({ renew: async () => {}, release: async () => {} }), close: async () => {} },
  } });
  const full = await issueSessionJwt(TEST_CONFIG, wallet, id); const pending = await issueLoginJwt(TEST_CONFIG, wallet, id);
  const send = (token = full) => app.inject({ method: 'POST', url: '/rpc/solana/devnet', payload,
    headers: { origin: TEST_CONFIG.WEB_ORIGIN[0]!, cookie: `shardkeep_session=${token}` } });
  try {
    expect((await send(pending)).statusCode).toBe(401);
    expect((await send()).statusCode).toBe(401);
    await conn.db.update(sessions).set({ scope: 'full' }).where(eq(sessions.id, id));
    await conn.db.update(players).set({ loginTotpRequired: true }).where(eq(players.wallet, wallet));
    expect((await send()).statusCode).toBe(401); expect(upstream).not.toHaveBeenCalled();
    await conn.db.update(sessions).set({ loginMfaAt: new Date() }).where(eq(sessions.id, id));
    // There is intentionally no base/deed fixture: new players need RPC to buy it.
    expect((await send()).statusCode).toBe(200); expect(upstream).toHaveBeenCalledOnce();
    await conn.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
    expect((await send()).statusCode).toBe(401); expect(upstream).toHaveBeenCalledOnce();
    await conn.db.update(sessions).set({ revokedAt: null, expiresAt: new Date(0) }).where(eq(sessions.id, id));
    expect((await send()).statusCode).toBe(401); expect(upstream).toHaveBeenCalledOnce();
  } finally {
    await app.close(); await conn.db.delete(sessions).where(eq(sessions.id, id)); await conn.db.delete(players).where(eq(players.wallet, wallet));
  }
});
