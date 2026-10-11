/** Actual process wiring over loopback finalized RPC and a restricted request LOGIN.
 * Encoded banks and signed packets are fixture evidence, never a live deployment. */
import { randomUUID } from 'node:crypto';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { afterEach, expect, it, vi } from 'vitest';
import { createMiningTaxRuntime } from '../src/mining/taxRuntime';
import { createPhaseEServices } from '../src/phaseEServices';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { withMiningTaxSettlementFixture } from './fixtures/miningTaxSettlement';
import { miningTaxRuntimeRpc } from './fixtures/miningTaxRuntime';
import { TEST_CONFIG } from './helpers';

afterEach(() => vi.unstubAllEnvs());
it('records original tax finality through actual private startup while paused and recovers it after source removal', async () => {
  await withMiningTaxSettlementFixture(async f => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false');
    await runMigrations(f.conn.db);
    const bodies = new Map([...f.chain.transactions].filter((row): row is [string, VersionedTransactionResponse] => row[1] !== null));
    const rpc = await miningTaxRuntimeRpc({ ...f.chain.state, rpc: f.chain.rpc, seeker: { ...f.chain.state.seeker, bodies } });
    const role = `tax_start_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
      grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures,mining_tax_claim_continuations to ${role};
      grant insert on mining_tax_claim_preparations,mining_tax_claim_signed_wires to ${role}`);
    const requestUrl = new URL(f.url); requestUrl.username = role; requestUrl.password = password;
    const request = createDb(requestUrl.toString(), { max: 2 }), trust = f.chain.trust;
    const config = { ...TEST_CONFIG, DATABASE_URL: requestUrl.toString(), PHASE_E_SERVICE_DATABASE_URL: f.url.toString(),
      SOLANA_RPC_URL: rpc.url, GEMS_RESERVE_OWNER: trust.mining.reserveOwner.toBase58(), HOT_WALLET_PUBKEY: f.wallet,
      MINING_TAX_PROGRAM_ID: trust.mining.programId.toBase58(), MINING_TAX_DEPLOYMENT_SLOT: trust.mining.reviewedDeploymentSlot,
      MINING_TAX_PROGRAM_DATA_SHA256: trust.mining.reviewedProgramDataSha256, MINING_TAX_UPGRADE_AUTHORITY: trust.seeker.deployment.upgradeAuthority ?? 'none',
      MINING_TAX_AUCTION_MINT: trust.seeker.mint.toBase58(), MINING_TAX_PRIZE_OWNER: trust.seeker.prizeOwner.toBase58(), MINING_TAX_STATE_PROVENANCE: 'fresh-reviewed-deployment' as const };
    const source = createMiningTaxRuntime(config, { cluster: config.SOLANA_CLUSTER, keepMint: trust.mining.keepMint.toBase58(),
      coreProgram: f.wallet, configPda: f.wallet })!;
    let services = await createPhaseEServices(config, request.db, {}, undefined, undefined, {
      receiptSource: source.receiptSource, failureSource: source.failureSource, trust: source.trust });
    let app = await buildApp(config, request.db, { ...services!.deps,
      miningTaxPreparationSources: source.preparationSources, miningTaxRelaySources: source.relaySources });
    try {
      expect(rpc.requests).toHaveLength(0); services!.start();
      await vi.waitFor(async () => { expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(1); }, { timeout: 10_000, interval: 25 });
      await f.conn.sql`insert into players(wallet) values(${f.wallet})`;
      const [session] = await f.conn.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString()}) returning id`;
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, f.wallet, session!.id) }, path = `/claims/mining-tax/by-key/${f.key.idempotencyKey}`;
      const result = await app.inject({ url: path, cookies });
      expect(result.statusCode, result.body).toBe(200); expect(result.json().status).toBe('settled');
      expect(result.json().settlement.receipt).toMatchObject({ phase: 'settled', paidKeepBaseUnits: f.record.artifact.intended.claimBaseUnits });
      await expect(request.sql`insert into mining_tax_claim_receipts default values`).rejects.toMatchObject({ code: '42501' });
      expect(rpc.requests.some(row => row.method === 'getTransaction')).toBe(true); expect(rpc.sent).toHaveLength(0);
      await app.close(); await services!.close(); source.close();
      services = await createPhaseEServices(config, request.db);
      app = await buildApp(config, request.db, services!.deps);
      const count = rpc.requests.length, recovered = await app.inject({ url: path, cookies });
      expect(recovered.json().settlement).toEqual(result.json().settlement);
      expect(recovered.headers['cache-control']).toBe('private, no-store'); expect(rpc.requests).toHaveLength(count);
      expect(await f.conn.sql`select * from mining_tax_claim_failures`).toHaveLength(0);
      expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(1);
    } finally {
      await app.close(); await services!.close(); source.close(); await request.sql.end();
      await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`); await rpc.close();
    }
  }, { genesisHash: new PublicKey(SOLANA_GENESIS_HASH.devnet) });
}, 60_000);
