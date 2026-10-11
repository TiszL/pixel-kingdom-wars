/** Real browser journal/transport + authenticated API + exact conserved SHARDS debit. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from '@shardkeep/shared';
import type { FreeBasePurchaseReceipt, FreeBasePurchaseRequest, FreeBasePurchaseTerms } from '@shardkeep/shared/freeBasePurchaseApi';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions } from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { createFreeBasePurchaseProvider } from '../src/game/freeBasePurchaseRoutes';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';
type Identity = { origin: string; api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
type Command = { request: FreeBasePurchaseRequest; terms: FreeBasePurchaseTerms };
type Operation = { command: Command; attemptRevision: number | null; proof: { status: string; receipt: FreeBasePurchaseReceipt } | null };
type Journal = { revision: number; operation: Operation | null; archives: { operation: Operation }[] };
type Store = { read(): Promise<Journal>; close(): Promise<void> };
type Controller = { beginPurchase(baseId: string): Promise<void>; confirm(): Promise<void>; open(): Promise<void>;
  finish(hydrate: (guard: () => void) => Promise<void>): Promise<void>;
  snapshot(): { error: string | null; review: { command: Command } | null } };
const { API_URL, api } = await vi.importActual<{ API_URL: string; api: { get(path: string): Promise<unknown> } }>('../../web/src/lib/api');
const { FreeBasePurchaseController } = await vi.importActual<{ FreeBasePurchaseController: new (store: Store, ports: object) => Controller }>('../../web/src/lib/freeBasePurchase/controller');
const { FreeBasePurchaseJournalStore } = await vi.importActual<{ FreeBasePurchaseJournalStore: new (identity: Identity, factory: unknown) => Store }>('../../web/src/lib/freeBasePurchase/journal');
const { freeBasePurchaseIdentity, createFreeBasePurchaseBrowserPorts } = await vi.importActual<{
  freeBasePurchaseIdentity(wallet: string): Identity;
  createFreeBasePurchaseBrowserPorts(input: { identity: Identity; lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): object;
}>('../../web/src/lib/freeBasePurchase/browser');
const { refreshFreeBasePurchaseSnapshot } = await vi.importActual<{
  refreshFreeBasePurchaseSnapshot(identity: Identity, ports: object, guard: () => void): Promise<unknown>;
}>('../../web/src/lib/freeBasePurchase/snapshot');
const { useApp } = await vi.importActual<{ useApp: { getState(): {
  setAuth(wallet: string | null, entryPaid?: boolean): void; setSelectedBaseId(id: string | null, persist?: boolean): void;
  selectedBaseId: string | null; balances: { shards: string } | null;
} } }>('../../web/src/state/store');
const { IDBFactory } = createRequire(new URL('../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };
const conn = connectTestDb(); let app: FastifyInstance;
const stores: Store[] = [];
beforeAll(async () => {
  vi.stubEnv('FREE_ONBOARDING', 'true'); // Router admission is selected at registration.
  // Since 8495c1a6f (2026-09-29) the purchase service is private composition: the
  // route answers 503 FREE_BASE_SOURCE_UNAVAILABLE unless a provider is injected,
  // as createPhaseEServices does in production and the sibling http test does.
  app = await buildApp(TEST_CONFIG, conn.db, { freeBasePurchaseProvider: createFreeBasePurchaseProvider(conn.db) }); await app.ready();
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map(s => s.close())); useApp.getState().setAuth(null);
  useApp.getState().setSelectedBaseId(null, false); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(async () => { await app?.close(); await conn.sql.end(); });
async function fixture() {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); vi.stubEnv('FREE_ONBOARDING', 'true');
  const { wallet } = await createTestPlayer(conn.db), baseId = randomUUID();
  await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},${PHASE_E_FREE_BASE_POLICY.minKeepLevel})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values
    (${wallet},${baseId},'keep',${PHASE_E_FREE_BASE_POLICY.minKeepLevel},10,10),
    (${wallet},${baseId},'workshop',${PHASE_E_FREE_BASE_POLICY.minWorkshopLevel},20,20),
    (${wallet},${baseId},'goldforge',${PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel},25,25)`;
  await rewardBaseShards(conn.db, baseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.web_pair', randomUUID());
  const [session] = await conn.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) }, factory = new IDBFactory();
  vi.stubGlobal('window', { location: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
  vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown, action: (lock: { name: string }) => Promise<T>) => action({ name }) } });
  useApp.getState().setAuth(wallet, true); useApp.getState().setSelectedBaseId(baseId, false);
  const identity = freeBasePurchaseIdentity(wallet);
  let lost = false, activeStore: Store | undefined;
  const posts: { body: unknown; journal: Journal; status: number }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    if (url.origin !== new URL(API_URL).origin || method !== 'GET' && method !== 'POST') throw new Error('Unexpected paired request');
    const journal = method === 'POST' ? await activeStore!.read() : null;
    const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const response = await app.inject({ method, url: `${url.pathname}${url.search}`,
      headers: { ...headers, origin: TEST_CONFIG.WEB_ORIGIN[0]! }, ...(init?.credentials === 'include' ? { cookies } : {}),
      ...(init?.body === undefined || init.body === null ? {} : { payload: String(init.body) }) });
    if (method === 'POST') {
      posts.push({ body: JSON.parse(String(init?.body)), journal: journal!, status: response.statusCode });
      if (lost) { lost = false; throw new TypeError('Lost accepted reply'); }
    }
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  });
  expect(await api.get('/me')).toMatchObject({ wallet });
  function client() {
    const store = new FreeBasePurchaseJournalStore(identity, factory); stores.push(store); activeStore = store;
    const ports = createFreeBasePurchaseBrowserPorts({ identity, lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }) });
    return { store, controller: new FreeBasePurchaseController(store, ports), hydrate: async (guard: () => void) => {
      expect((await store.read()).operation?.proof?.status).toBe('accepted');
      await refreshFreeBasePurchaseSnapshot(identity, ports, guard);
    } };
  }
  return { wallet, baseId, posts, client, loseReply: () => { lost = true; } };
}
async function exactDebit(receipt: FreeBasePurchaseReceipt) {
  const rows = await conn.sql`select a.kind,a.base_id,e.delta::text from ledger_entries e join accounts a on a.id=e.account_id
    where e.txn_id=${receipt.debitTransactionId} order by a.kind::text`;
  expect(rows).toEqual([
    { kind: 'base_shards', base_id: receipt.sourceBaseId, delta: `-${receipt.shardsCharged}` },
    { kind: 'shard_burn', base_id: null, delta: receipt.shardsCharged },
  ]);
  expect(await conn.sql`select wallet from mining_free_base_purchases where wallet=${receipt.wallet}`).toHaveLength(1);
}
describe('paired web second free base purchase', () => {
  it('persists consent before the actual debit and hydrates current source balances before archiving', async () => {
    const f = await fixture(), c = f.client(); await c.controller.beginPurchase(f.baseId);
    expect(c.controller.snapshot().error).toBeNull(); expect(f.posts).toHaveLength(0);
    const command = c.controller.snapshot().review!.command; await c.controller.confirm();
    expect(c.controller.snapshot().error).toBeNull(); const receipt = (await c.store.read()).operation!.proof!.receipt;
    expect(f.posts).toHaveLength(1); expect(f.posts[0]!.body).toEqual(command.request);
    expect(f.posts[0]!.journal.operation?.command).toEqual(command);
    expect(f.posts[0]!.journal.operation?.attemptRevision).toBe(f.posts[0]!.journal.revision);
    await exactDebit(receipt); await c.controller.finish(c.hydrate);
    expect(c.controller.snapshot().error).toBeNull(); expect((await c.store.read()).operation).toBeNull();
    expect((await c.store.read()).archives[0]!.operation.proof!.receipt).toEqual(receipt);
    expect(useApp.getState().selectedBaseId).toBe(f.baseId); expect(useApp.getState().balances?.shards).toBe('0');
  });
  it('recreates the browser journal after a lost reply and recovers while paused with no second POST', async () => {
    const f = await fixture(), c = f.client(); await c.controller.beginPurchase(f.baseId); f.loseReply(); await c.controller.confirm();
    expect(c.controller.snapshot().error).not.toBeNull(); expect((await c.store.read()).operation?.proof).toBeNull();
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); const recovered = f.client();
    await recovered.controller.open(); expect(recovered.controller.snapshot().error).toBeNull();
    const receipt = (await recovered.store.read()).operation!.proof!.receipt; await exactDebit(receipt);
    await recovered.controller.confirm(); await recovered.controller.finish(recovered.hydrate);
    expect(recovered.controller.snapshot().error).toBeNull(); expect(f.posts).toHaveLength(1);
    expect((await recovered.store.read()).archives[0]!.operation.proof!.receipt).toEqual(receipt);
    expect(await conn.sql`select id from bases where owner_wallet=${f.wallet}`).toHaveLength(2);
  });
});
