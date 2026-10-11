/** The public API has a runtime connection; only the separate fixture verifier
 * can publish a terminal payment receipt. Lost replies recover with GET alone. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { buildApp, type AppDeps } from '../src/app';
import { createDb } from '../src/db/client';
import { sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createMiningClaimSettlement } from '../src/mining/claimSettlement';
import { withMiningClaimSettlementFixture as fixture, type MiningClaimSettlementFixture } from './fixtures/miningClaimSettlement';
import { TEST_CONFIG } from './helpers';

afterEach(() => vi.unstubAllEnvs());
async function runtime(f: MiningClaimSettlementFixture) {
  const role = `claim_http_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
    grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
    grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
  const url = new URL(f.url); url.username = role; url.password = password;
  const conn = createDb(url.toString(), { max: 4 });
  return { ...conn, role, async close() { await conn.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); } };
}
async function cookies(f: MiningClaimSettlementFixture, wallet: string) {
  const [s] = await f.conn.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, s!.id) };
}
const headers = { origin: TEST_CONFIG.WEB_ORIGIN[0]! };
describe('authenticated mining claim HTTP boundary', () => {
  it('recovers lost prepare and relay replies, then reports only independently verified payment while paused', async () => fixture(async f => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    f.quote.reader.getLatestBlockhashAndContext = async () => ({ context: { slot: 3003 }, value: { blockhash: f.preparedClaim.blockhash, lastValidBlockHeight: 250 } });
    f.quote.reader.getFeeForMessage = async () => ({ context: { slot: 3003 }, value: 5000 });
    f.quote.reader.getSlot = async () => 3003;
    let sends = 0, transportReads = 0, claimId = '';
    const provider: NonNullable<AppDeps['miningClaimsProvider']> = {
      reader: f.bank.reader, trust: f.bank.trust, quoteSource: () => f.quote.reader,
      now: () => new Date(f.preparedClaim.preparedAt),
      transport: () => ({ getGenesisHash: async () => { transportReads++; return f.identity.genesisHash; },
        getSignatureStatuses: async () => ({ context: { slot: 3003 }, value: [null] }), getBlockHeight: async () => 200,
        sendRawTransaction: async bytes => {
          sends++;
          const rows = await f.conn.sql`select encode(signed_transaction,'hex') wire from mining_claim_signed_wires where claim_id=${claimId}`;
          expect(rows).toHaveLength(1); expect(rows[0]!.wire).toBe(Buffer.from(bytes).toString('hex'));
          throw Error('Reply lost after transport received the wire');
        } }),
    };
    const conn = await runtime(f), auth = await cookies(f, f.wallet), foreign = await cookies(f, f.buyer);
    const app = await buildApp(TEST_CONFIG, conn.db, { miningClaimsProvider: provider });
    try {
      const state = await app.inject({ url: '/claims/mining/status', cookies: auth });
      expect(state.statusCode, state.body).toBe(200); expect(state.json()).toMatchObject({ state: 'ready', preparationAllowed: true });
      const key = randomUUID(), body = { idempotencyKey: key };
      const prepared = await app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies: auth, headers, payload: body });
      expect(prepared.statusCode, prepared.body).toBe(201); const original = prepared.json(); claimId = original.claimId;
      expect(claimId).not.toBe(f.preparedClaim.claimId);
      const recovered = await app.inject({ url: `/claims/mining/prepare/by-key/${key}`, cookies: auth });
      expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.headers['cache-control']).toBe('private, no-store');
      expect(recovered.json()).toMatchObject({ wallet: f.wallet, idempotencyKey: key, status: 'prepared', receipt: original });
      const transaction = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(original.transactions[0].message, 'base64')));
      transaction.sign([f.claimantSigner]);
      const submitted = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies: auth, headers,
        payload: { claimId, signedTransaction: Buffer.from(transaction.serialize()).toString('base64') } });
      expect(submitted.statusCode, submitted.body).toBe(202);
      expect(submitted.json()).toMatchObject({ claimId, signature: f.signed.signature, delivery: 'held', reason: 'SEND_UNCERTAIN' });
      expect(sends).toBe(1); expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
      const before = transportReads, bankReads = f.bank.reads(), quoteReads = f.quote.reads();
      const pending = await app.inject({ url: `/claims/mining/${claimId}`, cookies: auth });
      expect(pending.json()).toMatchObject({ state: 'retained', landing: 'pending', signature: f.signed.signature, settledBaseUnits: null });
      expect(transportReads).toBe(before); expect(sends).toBe(1);
      expect(f.bank.reads()).toBe(bankReads); expect(f.quote.reads()).toBe(quoteReads);
      await expect(conn.sql`insert into mining_claim_receipts(claim_id,ordinal,receipt) values(${claimId},0,'{}')`).rejects.toBeDefined();
      // This is the only terminal writer, outside the HTTP app and runtime DB.
      await createMiningClaimSettlement(f.conn.db, { reader: f.receiptReader, trust: f.receiptTrust })({ wallet: f.wallet, claimId, ordinal: 0 });
      vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
      const restarted = await buildApp(TEST_CONFIG, conn.db); // No provider at all.
      try {
        const paid = await restarted.inject({ url: `/claims/mining/${claimId}`, cookies: auth });
        expect(paid.json()).toMatchObject({ state: 'settled', landing: 'finalized', signature: f.signed.signature, settledBaseUnits: String(f.payment) });
        const again = await restarted.inject({ url: `/claims/mining/prepare/by-key/${key}`, cookies: auth });
        expect(again.json()).toMatchObject({ status: 'prepared', receipt: { claimId, transactions: original.transactions } });
        const unseen = await restarted.inject({ url: `/claims/mining/prepare/by-key/${key}`, cookies: foreign });
        expect(unseen.statusCode).toBe(200); expect(unseen.json()).toMatchObject({ wallet: f.buyer, status: 'unknown', receipt: null });
        const privateClaim = await restarted.inject({ url: `/claims/mining/${claimId}`, cookies: foreign });
        expect(privateClaim.statusCode).toBe(200); expect(privateClaim.json()).toMatchObject({ state: 'unknown', signature: null, settledBaseUnits: null });
        expect(transportReads).toBe(before); expect(sends).toBe(1);
        expect(f.bank.reads()).toBe(bankReads); expect(f.quote.reads()).toBe(quoteReads);
        expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(1);
      } finally { await restarted.close(); }
    } finally { await app.close(); await conn.close(); }
  }, { deferSignedPersistence: true }));

  it('keeps the default provider dark, requires real authentication and rejects caller-selected claim authority', async () => fixture(async f => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    const conn = await runtime(f), auth = await cookies(f, f.wallet), foreign = await cookies(f, f.buyer), app = await buildApp(TEST_CONFIG, conn.db);
    try {
      expect((await app.inject({ url: '/claims/mining/status' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/claims/genesis/status', cookies: auth })).statusCode).toBe(404);
      const status = await app.inject({ url: '/claims/mining/status', cookies: auth });
      expect(status.statusCode).toBe(200); expect(status.json()).toMatchObject({ state: 'unavailable', preparationAllowed: false });
      const disabled = await app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies: auth, headers, payload: { idempotencyKey: randomUUID() } });
      expect(disabled.statusCode, disabled.body).toBe(503);
      for (const extra of [{ wallet: f.buyer }, { rootSequence: '2' }, { proof: [] }, { feePayer: f.buyer }]) {
        const invalid = await app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies: auth, headers, payload: { idempotencyKey: randomUUID(), ...extra } });
        expect(invalid.statusCode, invalid.body).toBe(400);
      }
      for (const signedTransaction of ['?', 'A'.repeat(1700), Buffer.from(f.sign()).toString('base64') + '\n']) {
        const invalid = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies: auth, headers, payload: { claimId: f.preparedClaim.claimId, signedTransaction } });
        expect(invalid.statusCode, invalid.body).toBe(400);
      }
      const alien = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies: foreign, headers,
        payload: { claimId: f.preparedClaim.claimId, signedTransaction: Buffer.from(f.sign()).toString('base64') } });
      expect(alien.statusCode, alien.body).toBe(409); expect(alien.json()).toMatchObject({ error: { code: 'CLAIM_UNKNOWN' } });
      const missing = await app.inject({ url: `/claims/mining/prepare/by-key/${randomUUID()}`, cookies: auth });
      expect(missing.statusCode).toBe(200); expect(missing.json()).toMatchObject({ status: 'unknown', receipt: null });
      expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(0);
      // A successful signed commit survives an unavailable receipt reader.
      await f.conn.sql.unsafe(`revoke select on mining_claim_receipts from ${conn.role}`);
      const retained = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies: auth, headers,
        payload: { claimId: f.preparedClaim.claimId, signedTransaction: Buffer.from(f.sign()).toString('base64') } });
      expect(retained.statusCode, retained.body).toBe(202);
      expect(retained.json()).toMatchObject({ delivery: 'held', reason: 'SOURCE_UNAVAILABLE', signature: f.signed.signature });
      await f.conn.sql.unsafe(`grant select on mining_claim_receipts to ${conn.role}`);
      const retainedGet = await app.inject({ url: `/claims/mining/${f.preparedClaim.claimId}`, cookies: auth });
      expect(retainedGet.json()).toMatchObject({ state: 'retained', signature: f.signed.signature, landing: 'pending' });
      expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
    } finally { await app.close(); await conn.close(); }
  }, { deferSignedPersistence: true }));
});
