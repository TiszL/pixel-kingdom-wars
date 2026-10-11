/** L2: production browser ports, controller, IndexedDB journal and hydration
 * must agree with authenticated API receipts, ledger postings and published
 * app balances. Only fetch, lifecycle and browser storage/locks are fixtures.
 * This covers ledger conversion, not wallet purchases or native clients. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { GEMS } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gemsCommand, gemsReceiptPath, parseGemsReceipt, type GemsInput, type GemsIntent, type GemsReceipt } from '../../web/src/lib/gems/contracts';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, ledgerEntries, ledgerTransactions, sessions } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';

// Load the real browser exports without adding DOM ambient fetch types to the
// Node API project. These narrow interfaces describe only this test's calls;
// the browser package owns the implementations' complete typecheck.
type Identity = { api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
type JournalStore = { read(): Promise<{ receipt: unknown }>; close(): Promise<void> };
type Controller = {
  review(input: GemsInput): Promise<void>; confirm(): Promise<void>; open(): Promise<void>;
  snapshot(): { review: GemsIntent | null; error: string | null; enabled: boolean };
};
type HttpOptions = { isCurrent?: () => boolean; observeResponseError?: (error: unknown) => Promise<void> };
const { api, API_URL } = await vi.importActual<{ API_URL: string; api: {
  get<T = unknown>(path: string, options?: HttpOptions): Promise<T>;
  postRaw<T = unknown>(path: string, body?: unknown, options?: HttpOptions): Promise<T>;
} }>('../../web/src/lib/api');
const { GemsController } = await vi.importActual<{ GemsController: new (store: JournalStore, ports: object) => Controller }>('../../web/src/lib/gems/controller');
const { GemsJournalStore } = await vi.importActual<{ GemsJournalStore: new (identity: Identity, factory: unknown) => JournalStore }>('../../web/src/lib/gems/journal');
const { createGemsBrowserPorts, gemsIdentity, hydrateGemsDestination } = await vi.importActual<{
  gemsIdentity(wallet: string): Identity;
  createGemsBrowserPorts(identity: Identity,
    lifecycle: () => { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean },
    hydrate: (intent: GemsIntent, receipt: GemsReceipt, guard: () => void) => Promise<void>): object;
  hydrateGemsDestination(wallet: string, intent: GemsIntent, guard: () => void): Promise<void>;
}>('../../web/src/lib/gems/browser');
const { useApp } = await vi.importActual<{ useApp: { getState(): {
  balances: Balances | null; setAuth(wallet: string | null, entryPaid?: boolean): void;
} } }>('../../web/src/state/store');
// Resolve the existing browser test dependency from the package that owns it.
const { IDBFactory: TestIDBFactory } = createRequire(new URL('../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };
const conn = connectTestDb(), db = conn.db;
let app: FastifyInstance;
const stores: JournalStore[] = [];
type Balances = { keep: string; gems?: string; shards: string };
type Exchange = { method: string; path: string; body: unknown; status: number; response: Record<string, unknown> };

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db); await app.ready();
});
beforeEach(() => {
  vi.stubEnv('GEMS_ENABLED', 'true'); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  useApp.getState().setAuth(null);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(async () => { await app?.close(); await conn.sql.end(); });

async function fixture(keep = 20n) {
  const { wallet } = await createTestPlayer(db);
  if (keep > 0n) await fundTestKeep(db, wallet, keep, 'test.fund', randomUUID());
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  const factory = new TestIDBFactory();
  vi.stubGlobal('window', { location: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
  // One document owns this fixture; exercise the real adapters' lock admission.
  vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown,
    action: (lock: { name: string }) => Promise<T>) => action({ name }) } });
  useApp.getState().setAuth(wallet, true);
  const identity = gemsIdentity(wallet);
  const exchanges: Exchange[] = [];
  let dropNextPost = false;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== new URL(API_URL).origin) throw new Error('Unexpected fixture origin');
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new Error('Unexpected fixture method');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const response = await app.inject({ method, url: `${url.pathname}${url.search}`,
      headers: { ...headers, origin: TEST_CONFIG.WEB_ORIGIN[0]! },
      ...(init?.credentials === 'include' ? { cookies } : {}),
      ...(init?.body === undefined || init.body === null ? {} : { payload: String(init.body) }) });
    exchanges.push({ method, path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
      status: response.statusCode, response: response.json() as Record<string, unknown> });
    // Lose delivery only AFTER the real transaction and response have finished.
    if (dropNextPost && method === 'POST') { dropNextPost = false; throw new TypeError('Lost response'); }
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
      else if (value !== undefined) responseHeaders.set(key, String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
  });
  // Establish a real authenticated read through the same adapter as commands.
  expect(await api.get('/me')).toMatchObject({ wallet });
  function client() {
    const store = new GemsJournalStore(identity, factory); stores.push(store);
    const ports = createGemsBrowserPorts(identity,
      () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }),
      async (intent, _receipt, guard) => {
        // Success cannot precede durable receipt proof or fresh API balances.
        expect(await store.read()).toMatchObject({ receipt: expect.any(Object), hydrated: false, finished: false });
        await hydrateGemsDestination(wallet, intent, guard);
      });
    return { controller: new GemsController(store, ports), store };
  }
  return { wallet, exchanges, client, hydrated: () => useApp.getState().balances,
    loseNextPostResponse: () => { dropNextPost = true; } };
}
const balances = async (wallet: string) => Promise.all((['player_keep', 'player_gems', 'player_shards'] as const)
  .map(async kind => (await getOrCreatePlayerAccount(db, wallet, kind)).balance));
const postings = (wallet: string, intent: GemsIntent) => db.select().from(ledgerTransactions)
  .where(eq(ledgerTransactions.idempotencyKey, `gems:${intent.kind === 'gems-from-keep' ? 'from-keep' : 'to-shards'}:${wallet}:${intent.idempotencyKey}`));
type PostingEntry = { accountId: string; kind: string; currency: string; ownerWallet: string | null; baseId: string | null; delta: bigint };
async function expectPosting(wallet: string, intent: GemsIntent, receiptId: string, expected: PostingEntry[]) {
  const rows = await postings(wallet, intent);
  expect(rows).toHaveLength(1); expect(rows[0]!.id).toBe(receiptId);
  const entries = await db.select({ accountId: accounts.id, kind: accounts.kind, currency: accounts.currency,
    ownerWallet: accounts.ownerWallet, baseId: accounts.baseId, delta: ledgerEntries.delta }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, receiptId));
  expect(entries).toHaveLength(4);
  const byAccount = (a: PostingEntry, b: PostingEntry) => a.accountId.localeCompare(b.accountId);
  expect(entries.sort(byAccount)).toEqual(expected.sort(byAccount));
}

describe('paired web Gems ledger conversion', () => {
  it('converts KEEP into Gems and then SHARDS with exact receipts, ledger legs and hydrated balances', async () => {
    const f = await fixture(), c = f.client();
    await c.controller.review({ kind: 'gems-from-keep', keep: '10' });
    const from = c.controller.snapshot().review!;
    expect(from.consent).toEqual({ rate: GEMS.gemsPerKeep, output: String(10 * GEMS.gemsPerKeep) });
    await c.controller.confirm();
    const accepted = await c.store.read();
    expect(accepted).toMatchObject({ intent: from, attempted: true, hydrated: true, finished: true, refusal: null });
    const receipt = parseGemsReceipt(accepted.receipt, from, f.wallet)!;
    const gems = 10n * BigInt(GEMS.gemsPerKeep);
    const sys = await bootstrapSystemAccounts(db);
    const keepAccount = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
    const gemsAccount = await getOrCreatePlayerAccount(db, f.wallet, 'player_gems');
    const shardAccount = await getOrCreatePlayerAccount(db, f.wallet, 'player_shards');
    await expectPosting(f.wallet, from, receipt.receiptId, [
      { accountId: keepAccount.id, kind: 'player_keep', currency: 'KEEP', ownerWallet: f.wallet, baseId: null, delta: -10n },
      { accountId: sys.emission_pool, kind: 'emission_pool', currency: 'KEEP', ownerWallet: null, baseId: null, delta: 10n },
      { accountId: sys.gems_mint, kind: 'gems_mint', currency: 'GEMS', ownerWallet: null, baseId: null, delta: -gems },
      { accountId: gemsAccount.id, kind: 'player_gems', currency: 'GEMS', ownerWallet: f.wallet, baseId: null, delta: gems },
    ]);
    expect(f.hydrated()).toMatchObject({ keep: '10', gems: String(gems), shards: '0' });

    await c.controller.review({ kind: 'gems-to-shards', gems: '3', baseId: null });
    const to = c.controller.snapshot().review!;
    await c.controller.confirm();
    const finished = await c.store.read(), shards = 3n * BigInt(GEMS.shardsPerGem);
    expect(finished).toMatchObject({ intent: to, hydrated: true, finished: true });
    const proof = parseGemsReceipt(finished.receipt, to, f.wallet)!;
    await expectPosting(f.wallet, to, proof.receiptId, [
      { accountId: gemsAccount.id, kind: 'player_gems', currency: 'GEMS', ownerWallet: f.wallet, baseId: null, delta: -3n },
      { accountId: sys.gems_sink, kind: 'gems_sink', currency: 'GEMS', ownerWallet: null, baseId: null, delta: 3n },
      { accountId: sys.shard_genesis, kind: 'shard_genesis', currency: 'SHARDS', ownerWallet: null, baseId: null, delta: -shards },
      { accountId: shardAccount.id, kind: 'player_shards', currency: 'SHARDS', ownerWallet: f.wallet, baseId: null, delta: shards },
    ]);
    expect(await balances(f.wallet)).toEqual([10n, gems - 3n, shards]);
    expect(f.hydrated()).toMatchObject({ keep: '10', gems: String(gems - 3n), shards: String(shards) });
    expect(f.exchanges.filter(e => e.method === 'POST').map(e => e.body)).toEqual([gemsCommand(from).body, gemsCommand(to).body]);
  });

  it('retains the real insufficient-KEEP refusal without a debit, receipt or hydration', async () => {
    const f = await fixture(1n), c = f.client();
    await c.controller.review({ kind: 'gems-from-keep', keep: '2' });
    const intent = c.controller.snapshot().review!;
    await c.controller.confirm();
    expect(await c.store.read()).toMatchObject({ intent, attempted: true, receipt: null, hydrated: false,
      finished: true, refusal: { status: 422, code: 'INSUFFICIENT_KEEP' } });
    expect(await api.get(gemsReceiptPath(intent))).toMatchObject({ status: 'unknown', receipt: null });
    expect(await postings(f.wallet, intent)).toEqual([]);
    expect(await balances(f.wallet)).toEqual([1n, 0n, 0n]); expect(f.hydrated()).toBeNull();
    expect(f.exchanges.filter(e => e.method === 'POST')).toMatchObject([{ status: 422 }]);
  });

  it.each([false, true])('recovers a committed lost response after client and API restart without resubmission (paused=%s)', async paused => {
    const f = await fixture(), first = f.client();
    await first.controller.review({ kind: 'gems-from-keep', keep: '5' });
    const intent = first.controller.snapshot().review!;
    f.loseNextPostResponse(); await first.controller.confirm();
    expect(await first.store.read()).toMatchObject({ intent, attempted: true, receipt: null, hydrated: false, finished: false });
    expect(first.controller.snapshot().error).toContain('Unable to reach');
    const committed = f.exchanges.find(e => e.method === 'POST')!;
    expect(committed.status).toBe(201);
    const [posting] = await postings(f.wallet, intent); expect(posting!.id).toBe(committed.response.receiptId);
    await first.store.close();
    await app.close(); app = await buildApp(TEST_CONFIG, db); await app.ready();
    if (paused) vi.stubEnv('GEMS_ENABLED', 'false');
    const recovered = f.client(); await recovered.controller.open();
    const journal = await recovered.store.read();
    expect(journal).toMatchObject({ intent, attempted: true, hydrated: true, finished: true, refusal: null });
    expect(parseGemsReceipt(journal.receipt, intent, f.wallet)?.receiptId).toBe(posting!.id);
    expect(await postings(f.wallet, intent)).toHaveLength(1);
    expect(await balances(f.wallet)).toEqual([15n, 5n * BigInt(GEMS.gemsPerKeep), 0n]);
    expect(f.hydrated()).toMatchObject({ keep: '15', shards: '0' });
    expect(f.exchanges.filter(e => e.method === 'POST')).toHaveLength(1);
    if (paused) {
      await recovered.controller.review({ kind: 'gems-from-keep', keep: '1' });
      await recovered.controller.confirm();
      expect(recovered.controller.snapshot().enabled).toBe(false);
      expect(await recovered.store.read()).toEqual(journal);
      expect(f.exchanges.filter(e => e.method === 'POST')).toHaveLength(1);
      const command = gemsCommand({ ...intent, idempotencyKey: randomUUID() });
      await expect(api.postRaw(command.path, command.body)).rejects.toMatchObject({ status: 503, code: 'PHASE_E_DISABLED' });
      expect(await balances(f.wallet)).toEqual([15n, 5n * BigInt(GEMS.gemsPerKeep), 0n]);
    }
  });

  it('same-key exact HTTP replay returns the accepted receipt and cannot double debit', async () => {
    const f = await fixture(), c = f.client();
    await c.controller.review({ kind: 'gems-from-keep', keep: '5' });
    const intent = c.controller.snapshot().review!;
    await Promise.all([c.controller.confirm(), c.controller.confirm()]);
    const journal = await c.store.read(), proof = parseGemsReceipt(journal.receipt, intent, f.wallet)!;
    expect(f.exchanges.filter(e => e.method === 'POST')).toHaveLength(1);
    const command = gemsCommand(intent);
    expect(await api.postRaw(command.path, command.body)).toMatchObject({ receiptId: proof.receiptId, duplicate: true });
    await expect(api.postRaw(command.path, { ...command.body, keep: '6' })).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_BODY_MISMATCH' });
    expect(await postings(f.wallet, intent)).toHaveLength(1);
    expect(await balances(f.wallet)).toEqual([15n, 5n * BigInt(GEMS.gemsPerKeep), 0n]);
    expect(await c.store.read()).toEqual(journal);
  });
});
