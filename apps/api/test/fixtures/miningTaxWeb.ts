/** Real browser stack paired with a restricted runtime-role API. The existing
 * owner verifier alone creates receipts from encoded finalized chain fixtures. */
import { createRequire } from 'node:module';
import { Transaction } from '@solana/web3.js';
import type { MiningTaxClaimPreparation, MiningTaxClaimPrepareRequest } from '@shardkeep/shared/miningTaxClaimsApi';
import type { MiningTaxClaimRecoveryEnvelope } from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import type { MiningTaxClaimReviewResponse } from '@shardkeep/shared/miningTaxClaimReviewApi';
import type { MiningTaxClaimContinuationEnvelopeSchema } from '@shardkeep/shared/miningTaxClaimContinuationApi';
import type { MiningTaxClaimFailureEnvelope } from '@shardkeep/shared/miningTaxClaimFailureApi';
import { expect, vi, type Mock } from 'vitest';
import { withMiningTaxApiFixture, type MiningTaxApiFixtureOptions } from './miningTaxApi';
import { TEST_CONFIG } from '../helpers';

type MiningTaxClaimContinuationEnvelope = ReturnType<typeof MiningTaxClaimContinuationEnvelopeSchema.parse>;
type Signed = { ordinal: number; wire: string; signature: string; messageSha256: string; wireSha256: string };
type Operation = { request: MiningTaxClaimPrepareRequest; prepareAttempted: boolean; preparation: MiningTaxClaimPreparation | null;
 transactions: { ordinal: number; signingStarted: boolean; signed: Signed | null; submitAttempted: boolean }[];
 setup: MiningTaxClaimRecoveryEnvelope | null; settlement: MiningTaxClaimRecoveryEnvelope | null;failure?:MiningTaxClaimFailureEnvelope|null; continuation?:{request:{idempotencyKey:string;caps:MiningTaxClaimPrepareRequest['caps']};attempted:boolean;envelope:MiningTaxClaimContinuationEnvelope|null} };
type Journal = { operation: Operation | null; lastArchivedKey?: string };
type Store = { read(): Promise<Journal>; archived(key: string): Promise<Journal | null>; close(): Promise<void> };
type Controller = { begin(round: string, spot: number, caps: MiningTaxClaimPrepareRequest['caps']): Promise<void>;
 open(): Promise<void>; review(ordinal?: number): Promise<void>; sign(): Promise<void>; submit(ordinal?: number): Promise<void>; archive(): Promise<void>;archiveFailed():Promise<void>;prepareContinuation(caps:MiningTaxClaimPrepareRequest['caps']):Promise<void>;resumeContinuation():Promise<void>;activateContinuation():Promise<void>;
 snapshot(): { error: string | null; review: { ordinal: number; current: MiningTaxClaimReviewResponse } | null } };
const { MiningTaxClaimController } = await vi.importActual<{ MiningTaxClaimController: new (store: Store, ports: object, trust: object) => Controller }>('../../../web/src/lib/miningTaxClaims/controller');
const { MiningTaxClaimJournalStore } = await vi.importActual<{ MiningTaxClaimJournalStore: new (identity: object, trust: object, factory: unknown) => Store }>('../../../web/src/lib/miningTaxClaims/journal');
const { createMiningTaxClaimBrowserPorts, miningTaxClaimIdentity } = await vi.importActual<{
 createMiningTaxClaimBrowserPorts(input: object): { key(): string }; miningTaxClaimIdentity(wallet: string): object;
}>('../../../web/src/lib/miningTaxClaims/browser');
const { API_URL } = await vi.importActual<{ API_URL: string }>('../../../web/src/lib/api');
const { useApp } = await vi.importActual<{ useApp: { getState(): { setAuth(wallet: string | null, paid?: boolean): void } } }>('../../../web/src/state/store');
const { IDBFactory } = createRequire(new URL('../../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };

interface Options extends MiningTaxApiFixtureOptions { losePrepare?: boolean; loseSubmit?: boolean; loseContinuation?: boolean }
type ApiFixture = Parameters<Parameters<typeof withMiningTaxApiFixture>[0]>[0];
async function setup(api: ApiFixture, options: Options) {
 const stores: Store[] = [], preparation = api.preparation, trust = api.trust;
 let activeStore: Store | undefined, losePrepare = options.losePrepare === true, loseSubmit = options.loseSubmit === true, actionsEnabled = true, loseContinuation = options.loseContinuation === true;
 const posts: { path: string; status: number; journal: Journal }[] = [];
 vi.stubGlobal('window', { location: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
 vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown, run: (lock: { name: string }) => Promise<T>) => run({ name }) } });
 useApp.getState().setAuth(api.chain.wallet, true);
 vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const target = new URL(String(input)), method = init?.method ?? 'GET';
  expect(target.origin).toBe(new URL(API_URL).origin); expect(init?.credentials).toBe('include'); expect(init?.cache).toBe('no-store'); expect(init?.redirect).toBe('error');
  if (method !== 'GET' && method !== 'POST') throw Error('Unexpected paired method');
  const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
  const journal = method === 'POST' ? await activeStore!.read() : null;
  const response = await api.request({ method, url: target.pathname + target.search,
   headers: { ...headers, origin: TEST_CONFIG.WEB_ORIGIN[0]!, cookie: api.cookie }, ...(init?.body == null ? {} : { body: String(init.body) }) });
  if (method === 'POST') {
   posts.push({ path: target.pathname, status: response.status, journal: journal! });
   if(!target.pathname.includes('/continue/'))expect(response.status, response.body).toBe(target.pathname.endsWith('/prepare') ? 201 : 202);
   if(target.pathname.includes('/continue/')&&response.status===201&&loseContinuation){loseContinuation=false;throw Error('lost continuation reply');}
   if (target.pathname.endsWith('/prepare') && losePrepare) { losePrepare = false; throw Error('lost prepare reply'); }
   if (target.pathname.endsWith('/submit') && loseSubmit) { loseSubmit = false; throw Error('lost submit reply'); }
  }
  return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } });
 });
 const sign: Mock<(tx: Transaction) => Promise<Transaction>> = vi.fn(async (tx: Transaction) => {
  const ordinal = preparation.transactions.findIndex(t => t.messageHex === tx.serializeMessage().toString('hex'));
  expect((await activeStore!.read()).operation?.transactions.find(t => t.ordinal === ordinal)?.signingStarted).toBe(true);
  const result = api.sign({ unsigned: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), key: preparation.idempotencyKey, ordinal });
  return Transaction.from(Buffer.from(result.wire, 'base64'));
 });
 const broadcast: Mock<() => void> = vi.fn();
 const factory = new IDBFactory();
 function client(provider = true) {
  const identity = miningTaxClaimIdentity(api.chain.wallet), store = new MiningTaxClaimJournalStore(identity, trust, factory); activeStore = store; stores.push(store);
  const ports = createMiningTaxClaimBrowserPorts({ identity, trust: provider ? trust : null, clock: () => 0,
   wallet: () => ({ publicKey: provider ? api.chain.chain.signer.publicKey : null, signTransaction: provider ? sign : null, sendTransaction: broadcast, signMessage: null, isEmbedded: false }),
   lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled }) });
  ports.key = () => options.continuationKey && posts.some(p=>p.path.endsWith('/prepare')) ? options.continuationKey : preparation.idempotencyKey;
  return { store, controller: new MiningTaxClaimController(store, ports, trust) };
 }
 return {
  ...api, posts, sign, broadcast, client,
  restartPaused: async () => { actionsEnabled = false; await api.restart(true); },
  complete: () => api.settle({ key: preparation.idempotencyKey, ordinal: preparation.transactions.length - 1 }),
  closeBrowser: async () => { await Promise.all(stores.map(s => s.close())); useApp.getState().setAuth(null); vi.unstubAllGlobals(); },
 };
}
export async function withMiningTaxWebFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: Options) {
 await withMiningTaxApiFixture(async api => {
  const fixture = await setup(api, options); try { await run(fixture); } finally { await fixture.closeBrowser(); }
 }, options);
}
