/** Actual startup composition: restricted HTTP DB, private terminal owner and
 * loopback JSON-RPC carrying the accepted original finalized bank/transaction. */
import { createServer } from 'node:http';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { afterEach, expect, it, vi } from 'vitest';
import { createMiningClaimRuntime } from '../src/mining/claimRuntime';
import { createPhaseEServices } from '../src/phaseEServices';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { withMiningClaimSettlementFixture } from './fixtures/miningClaimSettlement';
import { miningClaimRestrictedRuntime, claimRuntimeKey } from './fixtures/miningClaimRuntime';
import { TEST_CONFIG } from './helpers';

afterEach(() => vi.unstubAllEnvs());
it('recovers the original finalized receipt through process startup while paused and serves it through the restricted API', async () => {
  await withMiningClaimSettlementFixture(async f => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    const seen: string[] = [];
    const rpc = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { id: string; method: string; params: unknown[] };
      seen.push(body.method); let result: unknown;
      if (body.method === 'getGenesisHash') result = f.identity.genesisHash;
      else if (body.method === 'getSlot') result = 3005;
      else if (body.method === 'getTransaction') {
        expect(body.params[0]).toBe(f.signed.signature); result = f.tx;
      } else if (body.method === 'getMultipleAccounts') {
        const rows = new Map(f.receiptRows.filter(row => row !== null).map(row => [row.address.toBase58(), row]));
        result = { context: { slot: 3005 }, value: (body.params[0] as string[]).map(address => {
          const row = rows.get(address);
          return row ? { owner: row.owner.toBase58(), executable: row.executable,
            data: [Buffer.from(row.data).toString('base64'), 'base64'], lamports: Number(row.lamports ?? 1), rentEpoch: 0 } : null;
        }) };
      } else { response.statusCode = 400; response.end('Unexpected source request'); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
    const address = rpc.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const request = await miningClaimRestrictedRuntime(f), trust = f.trust;
    const config = { ...TEST_CONFIG, DATABASE_URL: request.url, PHASE_E_SERVICE_DATABASE_URL: f.url.toString(),
      SOLANA_RPC_URL: `http://127.0.0.1:${address.port}`, MINING_CLAIM_PROGRAM_ID: trust.programId.toBase58(),
      MINING_CLAIM_DEPLOYMENT_SLOT: trust.reviewedDeploymentSlot, MINING_CLAIM_PROGRAM_DATA_SHA256: trust.reviewedProgramDataSha256,
      GEMS_RESERVE_OWNER: trust.reserveOwner.toBase58(), HOT_WALLET_PUBKEY: claimRuntimeKey(32) };
    const chain = createMiningClaimRuntime(config, { cluster: 'devnet', keepMint: trust.keepMint.toBase58(),
      coreProgram: claimRuntimeKey(30), configPda: claimRuntimeKey(31) })!;
    const services = await createPhaseEServices(config, request.db, {}, { receiptSource: chain.receiptSource, trust: chain.provider.trust });
    const app = await buildApp(config, request.db, { ...services!.deps, miningClaimsProvider: chain.provider });
    try {
      expect(seen).toEqual([]); // Construction does not observe or send a claim.
      services!.start();
      await vi.waitFor(async () => { expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(1); }, { timeout: 5_000, interval: 25 });
      const [session] = await f.conn.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString()}) returning id`;
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, f.wallet, session!.id) };
      const result = await app.inject({ url: `/claims/mining/${f.preparedClaim.claimId}`, cookies });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().state).toBe('settled');
      await expect(request.sql`insert into mining_claim_receipts default values`).rejects.toMatchObject({ code: '42501' });
      expect(seen).toContain('getTransaction'); expect(seen).not.toContain('sendTransaction');
      expect(await f.conn.sql`select * from mining_claim_failures`).toHaveLength(0);
      expect(await f.conn.sql`select * from mining_claim_signed_wires`).toHaveLength(1);
    } finally {
      await app.close(); await services!.close(); chain.close(); await request.close();
      rpc.closeAllConnections(); await new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve()));
    }
  }, { genesisHash: SOLANA_GENESIS_HASH.devnet });
}, 30_000);
