/** The real browser signs sequence2 and receives only its new earnings; its
 * durable journal must survive lost replies without replaying the first claim. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Transaction } from '@solana/web3.js';
import type { MiningClaimPreparationView, MiningClaimView } from '@shardkeep/shared/miningClaimsApi';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { withCumulativeMiningClaimFixture as fixture } from './fixtures/cumulativeMiningClaim';
import { TEST_CONFIG } from './helpers';
type Operation = { request: { idempotencyKey: string }; prepareAttempted: boolean; preparation: MiningClaimPreparationView | null;
  signingStarted: boolean; signed: { ordinal: number; wire: string; signature: string } | null; submitAttempted: boolean; claim: MiningClaimView | null };
type Journal = { operation: Operation | null; archives: Operation[] };
type Store = { read(): Promise<Journal>; close(): Promise<void> };
type Controller = { begin(): Promise<void>; open(): Promise<void>; review(): Promise<void>; sign(): Promise<void>; submit(): Promise<void>; finish(): Promise<void>;
  snapshot(): { error: string | null } };
const { MiningClaimController } = await vi.importActual<{ MiningClaimController: new (store: Store, ports: object) => Controller }>('../../web/src/lib/miningClaims/controller');
const { MiningClaimJournalStore } = await vi.importActual<{ MiningClaimJournalStore: new (identity: unknown, factory: unknown) => Store }>('../../web/src/lib/miningClaims/journal');
const { createMiningClaimBrowserPorts, miningClaimIdentity } = await vi.importActual<{
  createMiningClaimBrowserPorts(input: object): object; miningClaimIdentity(wallet: string): unknown;
}>('../../web/src/lib/miningClaims/browser');
const { API_URL } = await vi.importActual<{ API_URL: string }>('../../web/src/lib/api');
const { useApp } = await vi.importActual<{ useApp: { getState(): { setAuth(wallet: string | null, paid?: boolean): void } } }>('../../web/src/state/store');
const { IDBFactory } = createRequire(new URL('../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };

describe('paired browser cumulative mining claim', () => {
  it('explicitly claims only day2 delta with no new account rent and recovers paused without another approval or send', async () => fixture(async f => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    const first = await f.firstClaim(), next = await f.nextAdmission();
    expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(1);
    const role = `cumulative_pair_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
      grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
      grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
    const url = new URL(f.url); url.username = role; url.password = password; const runtime = createDb(url.toString(), { max: 4 });
    const statusSlot = await next.quote.reader.getSlot('finalized');
    const blockHeight = await next.quote.reader.getBlockHeight({ commitment: 'finalized', minContextSlot: next.bank.before.slot });
    let sends = 0, sent = '';
    let app = await buildApp(TEST_CONFIG, runtime.db, { miningClaimsProvider: { reader: next.bank.reader, trust: next.bank.trust,
      quoteSource: () => next.quote.reader, now: () => new Date(next.preparedAt), transport: () => ({ getGenesisHash: async () => f.identity.genesisHash,
        getSignatureStatuses: async () => ({ context: { slot: statusSlot }, value: [null] }),
        getBlockHeight: async () => blockHeight,
        sendRawTransaction: async bytes => { sends++; sent = Buffer.from(bytes).toString('base64'); throw Error('lost RPC acknowledgment'); } }) } });
    const stores: Store[] = [];
    try {
      const [session] = await f.conn.db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) }, factory = new IDBFactory();
      vi.stubGlobal('window', { location: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
      vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown, run: (lock: { name: string }) => Promise<T>) => run({ name }) } });
      useApp.getState().setAuth(f.wallet, true);
      let activeStore: Store, losePrepare = true, loseSubmit = true;
      const posts: { path: string; journal: Journal; status: number }[] = [];
      vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const target = new URL(String(input)), method = init?.method ?? 'GET';
        if (target.origin !== new URL(API_URL).origin || method !== 'GET' && method !== 'POST') throw Error('Unexpected paired request');
        const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
        const journal = method === 'POST' ? await activeStore.read() : null;
        const response = await app.inject({ method, url: `${target.pathname}${target.search}`, headers: { ...headers, origin: TEST_CONFIG.WEB_ORIGIN[0]! },
          ...(init?.credentials === 'include' ? { cookies } : {}), ...(init?.body == null ? {} : { payload: String(init.body) }) });
        if (method === 'POST') {
          posts.push({ path: target.pathname, journal: journal!, status: response.statusCode });
          if (target.pathname.endsWith('/prepare') && losePrepare) { losePrepare = false; throw Error('lost prepare reply'); }
          if (target.pathname.endsWith('/submit') && loseSubmit) { loseSubmit = false; throw Error('lost submit reply'); }
        }
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      });
      const signTransaction = vi.fn(async (tx: Transaction) => { expect((await activeStore.read()).operation?.signingStarted).toBe(true); tx.partialSign(next.claimantSigner); return tx; });
      const trust = { ...f.identity, keepMint: next.bank.trust.keepMint.toBase58(), reserveOwner: next.bank.trust.reserveOwner.toBase58() };
      const client = (pins: typeof trust | null = trust) => {
        const store = new MiningClaimJournalStore(miningClaimIdentity(f.wallet), factory); activeStore = store; stores.push(store);
        const ports = createMiningClaimBrowserPorts({ identity: miningClaimIdentity(f.wallet), trust: pins,
          connection: { getGenesisHash: async () => trust.genesisHash, getBlockHeight: async () => blockHeight },
          wallet: () => ({ connected: true, publicKey: next.claimantSigner.publicKey, signTransaction }),
          lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }) });
        return { store, controller: new MiningClaimController(store, ports) };
      };
      const started = client(); await started.controller.begin(); expect(started.controller.snapshot().error).not.toBeNull();
      expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ status: 201, journal: { operation: { prepareAttempted: true } } });
      const resumed = client(); await resumed.controller.open(); expect(resumed.controller.snapshot().error).toBeNull();
      const operation = (await resumed.store.read()).operation!, original = operation.preparation!;
      expect(original.rootSequence).toBe('2'); expect(original.fees.rentLamports).toBe('0'); expect(original.transactions).toHaveLength(1);
      expect(original.transactions[0]?.kind).toBe('claim');
      await resumed.controller.review(); await resumed.controller.sign(); expect(resumed.controller.snapshot().error).toBeNull();
      expect(signTransaction).toHaveBeenCalledOnce(); await resumed.controller.submit();
      expect(posts).toHaveLength(2); expect(sends).toBe(1); expect(sent).toBe((await resumed.store.read()).operation?.signed?.wire);
      const recovery = client(); await recovery.controller.open(); await recovery.controller.submit();
      expect(posts).toHaveLength(2); expect(sends).toBe(1);
      const verified = await next.completeClientClaim(operation.request.idempotencyKey);
      expect(verified.payment).toBe(BigInt(next.publication.prepared.publication.playerNet));
      expect(verified.payment).toBeLessThan(BigInt(verified.preparedClaim.header.totalCumulative));
      expect(verified.preparedClaim.claimId).toBe(original.claimId);
      expect(Buffer.from(verified.wire).toString('base64')).toBe(sent);
      vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); await app.close(); app = await buildApp(TEST_CONFIG, runtime.db);
      const paused = client(null); await paused.controller.open(); expect(paused.controller.snapshot().error).toBeNull();
      expect((await paused.store.read()).operation?.claim).toMatchObject({ state: 'settled', settledBaseUnits: String(verified.payment) });
      await paused.controller.finish(); expect(paused.controller.snapshot().error).toBeNull();
      const done = await paused.store.read(); expect(done.operation).toBeNull(); expect(done.archives).toHaveLength(1);
      expect(done.archives[0]?.signed?.signature).toBe(verified.signed.signature);
      expect(done.archives[0]?.claim?.settledBaseUnits).toBe(String(verified.payment));
      expect(await first.recover()).toEqual(first.settlement); expect(await first.recoverPreparation()).toEqual(first.preparedClaim);
      expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(2);
      expect(posts).toHaveLength(2); expect(sends).toBe(1); expect(signTransaction).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(stores.map(store => store.close())); useApp.getState().setAuth(null); vi.unstubAllGlobals();
      await app.close(); await runtime.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`);
    }
  }), 120_000);
});
