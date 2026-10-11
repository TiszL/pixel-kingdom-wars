/** Real browser journal, signing and transport against the authenticated runtime
 * API. A separate owner verifier proves the generated wallet's finalized transfer. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Transaction } from '@solana/web3.js';
import type { MiningClaimPreparationView, MiningClaimView } from '@shardkeep/shared/miningClaimsApi';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createMiningClaimFailure } from '../src/mining/claimFailure';
import { createMiningClaimSettlement } from '../src/mining/claimSettlement';
import { withMiningClaimSettlementFixture as fixture } from './fixtures/miningClaimSettlement';
import { TEST_CONFIG } from './helpers';
type Identity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
type Operation = { request: { idempotencyKey: string }; prepareAttempted: boolean; preparation: MiningClaimPreparationView | null;
  signingStarted: boolean; signed: { ordinal: number; wire: string; signature: string } | null; submitAttempted: boolean; claim: MiningClaimView | null };
type Journal = { operation: Operation | null; archives: Operation[] };
type Store = { read(): Promise<Journal>; close(): Promise<void> };
type Controller = { begin(): Promise<void>; open(): Promise<void>; review(): Promise<void>; sign(): Promise<void>; submit(): Promise<void>; finish(): Promise<void>; archiveFailed(): Promise<void>;
  snapshot(): { error: string | null } };
const { MiningClaimController } = await vi.importActual<{ MiningClaimController: new (store: Store, ports: object) => Controller }>('../../web/src/lib/miningClaims/controller');
const { MiningClaimJournalStore } = await vi.importActual<{ MiningClaimJournalStore: new (identity: Identity, factory: unknown) => Store }>('../../web/src/lib/miningClaims/journal');
const { createMiningClaimBrowserPorts, miningClaimIdentity } = await vi.importActual<{
  createMiningClaimBrowserPorts(input: object): object; miningClaimIdentity(wallet: string): Identity;
}>('../../web/src/lib/miningClaims/browser');
const { API_URL } = await vi.importActual<{ API_URL: string }>('../../web/src/lib/api');
const { useApp } = await vi.importActual<{ useApp: { getState(): { setAuth(wallet: string | null, paid?: boolean): void } } }>('../../web/src/state/store');
const { IDBFactory } = createRequire(new URL('../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };

describe('paired web mining claims', () => {
  it.each(['settled', 'failed'] as const)('recovers both lost replies and archives only owner-verified %s outcome after pause', async outcome => fixture(async f => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    f.quote.reader.getLatestBlockhashAndContext = async () => ({ context: { slot: 3003 }, value: { blockhash: f.preparedClaim.blockhash, lastValidBlockHeight: 250 } });
    f.quote.reader.getFeeForMessage = async () => ({ context: { slot: 3003 }, value: 5000 }); f.quote.reader.getSlot = async () => 3003;
    const role = `claim_pair_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
      grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
      grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
    const url = new URL(f.url); url.username = role; url.password = password; const runtime = createDb(url.toString(), { max: 4 });
    let sends = 0;
    let app = await buildApp(TEST_CONFIG, runtime.db, { miningClaimsProvider: { reader: f.bank.reader, trust: f.bank.trust, quoteSource: () => f.quote.reader,
      now: () => new Date(f.preparedClaim.preparedAt), transport: () => ({ getGenesisHash: async () => f.identity.genesisHash,
        getSignatureStatuses: async () => ({ context: { slot: 3003 }, value: [null] }), getBlockHeight: async () => 200,
        sendRawTransaction: async bytes => { sends++; expect(Buffer.from(bytes).toString('hex')).toBe(f.signed.signedTransactionHex); throw Error('lost RPC acknowledgment'); } }) } });
    const stores: Store[] = [];
    try {
      const [session] = await f.conn.db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) }, factory = new IDBFactory();
      vi.stubGlobal('window', { location: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
      vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown, run: (lock: { name: string }) => Promise<T>) => run({ name }) } });
      useApp.getState().setAuth(f.wallet, true);
      let losePrepare = true, loseSubmit = true, activeStore: Store;
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
          if (target.pathname.endsWith('/prepare') && losePrepare) { losePrepare = false; throw Error('lost prepare response'); }
          if (target.pathname.endsWith('/submit') && loseSubmit) { loseSubmit = false; throw Error('lost submit response'); }
        }
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      });
      const signTransaction = vi.fn(async (tx: Transaction) => { expect((await activeStore.read()).operation?.signingStarted).toBe(true); tx.partialSign(f.claimantSigner); return tx; });
      const wallet = { connected: true, publicKey: f.claimantSigner.publicKey, signTransaction };
      const trust = { genesisHash: f.identity.genesisHash, programId: f.identity.programId, configAddress: f.identity.configAddress,
        keepMint: f.preparedClaim.header.keepMint, reserveOwner: f.preparedClaim.header.reserveOwner };
      const client = (pins: typeof trust | null = trust) => {
        const store = new MiningClaimJournalStore(miningClaimIdentity(f.wallet), factory); activeStore = store; stores.push(store);
        const ports = createMiningClaimBrowserPorts({ identity: miningClaimIdentity(f.wallet), trust: pins,
          connection: { getGenesisHash: async () => trust.genesisHash, getBlockHeight: async () => 200 }, wallet: () => wallet,
          lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }) });
        return { store, controller: new MiningClaimController(store, ports) };
      };
      const first = client(); await first.controller.begin(); expect(first.controller.snapshot().error).not.toBeNull();
      expect(posts).toHaveLength(1); expect(posts[0]?.journal.operation?.prepareAttempted).toBe(true); expect(posts[0]?.status).toBe(201);
      expect((await first.store.read()).operation?.preparation).toBeNull();
      const second = client(); await second.controller.open(); expect(second.controller.snapshot().error).toBeNull();
      const original = (await second.store.read()).operation!.preparation!; expect(original).not.toBeNull();
      await second.controller.review(); await second.controller.sign(); expect(second.controller.snapshot().error).toBeNull();
      expect(signTransaction).toHaveBeenCalledOnce();
      await second.controller.submit(); expect(second.controller.snapshot().error).not.toBeNull(); expect(posts).toHaveLength(2);
      expect(posts[1]?.journal.operation?.submitAttempted).toBe(true); expect(posts[1]?.journal.operation?.signed?.wire).toBe(Buffer.from(f.sign()).toString('base64'));
      expect(sends).toBe(1); expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
      const third = client(); await third.controller.open(); expect((await third.store.read()).operation?.claim?.state).toBe('retained');
      await third.controller.submit(); expect(posts).toHaveLength(2); expect(sends).toBe(1);
      const key = { wallet: f.wallet, claimId: original.claimId, ordinal: 0 };
      if (outcome === 'settled') await createMiningClaimSettlement(f.conn.db, { reader: f.receiptReader, trust: f.receiptTrust })(key);
      else {
        const meta = f.tx.meta!, tx = { ...f.tx, meta: { ...meta, err: { InstructionError: [f.tx.transaction.message.compiledInstructions.length - 1, { Custom: 6000 }] },
          postBalances: meta.preBalances.map((amount, index) => index === 0 ? amount - meta.fee : amount), postTokenBalances: structuredClone(meta.preTokenBalances!) } };
        await createMiningClaimFailure(f.conn.db, { reader: { ...f.receiptReader, getTransaction: async () => tx }, trust: f.receiptTrust })(key);
      }
      vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); await app.close(); app = await buildApp(TEST_CONFIG, runtime.db);
      const recovery = client(null); await recovery.controller.open(); expect(recovery.controller.snapshot().error).toBeNull();
      expect((await recovery.store.read()).operation?.claim).toMatchObject({ state: outcome, settledBaseUnits: outcome === 'settled' ? String(f.payment) : null });
      if (outcome === 'settled') await recovery.controller.finish(); else await recovery.controller.archiveFailed(); expect(recovery.controller.snapshot().error).toBeNull();
      const done = await recovery.store.read(); expect(done.operation).toBeNull(); expect(done.archives[0]?.signed?.signature).toBe(f.signed.signature);
      expect(done.archives[0]?.claim?.settledBaseUnits).toBe(outcome === 'settled' ? String(f.payment) : null); expect(posts).toHaveLength(2); expect(sends).toBe(1);
      expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(outcome === 'settled' ? 1 : 0);
      expect(await f.conn.sql`select claim_id from mining_claim_failures`).toHaveLength(outcome === 'failed' ? 1 : 0);
    } finally {
      await Promise.all(stores.map(store => store.close())); useApp.getState().setAuth(null); vi.unstubAllGlobals();
      await app.close(); await runtime.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`);
    }
  }, { deferSignedPersistence: true }));
});
