/** L2 wallet purchase: production browser ports, payment validation, controller,
 * IndexedDB journal and balance publication paired with the authenticated API.
 * Only browser facilities, a throwaway in-memory wallet and chain evidence are
 * fixtures. No RPC connection, external wallet or network transfer is used. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { keepAta } from '@shardkeep/chain';
import { GEMS, TOKEN } from '@shardkeep/shared';
import { Keypair, PublicKey, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASSIC_TOKEN_PROGRAM, type GemsBuyBinding, type GemsBuyDeposit, type GemsBuyQuote, type GemsBuyRequest } from '../../web/src/lib/gemsBuy/contracts';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, deposits, ledgerEntries, ledgerTransactions, players, sessions } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { makeCombinedDepositCommitVerifier, makeCombinedDepositVerifier } from '../src/money/depositWatcher';
import { bindGemsTestReserve, gemsTestAta, gemsTestHot, gemsTestMint } from './gems-reserve-fixture';
import { connectTestDb, TEST_CONFIG } from './helpers';

// Runtime imports preserve the real browser implementations without introducing
// DOM ambient fetch types into the Node API project's typecheck.
type Identity = { origin: string; api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
type Purchase = { request: GemsBuyRequest; quote: GemsBuyQuote | null; prepared: object | null;
  signature: string | null; broadcastStarted: boolean; deposit: GemsBuyDeposit | null; hydrated: boolean };
type Journal = { purchase: Purchase | null; archives: unknown[] };
type Store = { read(): Promise<Journal>; close(): Promise<void> };
type Controller = { begin(keep: number, binding: GemsBuyBinding): Promise<void>; reviewPayment(): Promise<void>;
  pay(): Promise<void>; open(): Promise<void>; recoverPayment(): Promise<void>; abandonDraft(): Promise<void>;
  snapshot(): { error: string | null; reviewed: boolean } };
const { api, API_URL } = await vi.importActual<{ API_URL: string; api: {
  get<T = unknown>(path: string): Promise<T>; postRaw<T = unknown>(path: string, body?: unknown): Promise<T>;
} }>('../../web/src/lib/api');
const { GemsBuyController } = await vi.importActual<{ GemsBuyController: new (store: Store, ports: object) => Controller }>('../../web/src/lib/gemsBuy/controller');
const { GemsBuyJournalStore } = await vi.importActual<{ GemsBuyJournalStore: new (identity: Identity, factory: unknown) => Store }>('../../web/src/lib/gemsBuy/journal');
const { createGemsBuyBrowserPorts, gemsBuyIdentity, gemsBuyBinding } = await vi.importActual<{
  gemsBuyIdentity(wallet: string): Identity; gemsBuyBinding(wallet: string): GemsBuyBinding;
  createGemsBuyBrowserPorts(input: { identity: Identity; connection: Connection;
    wallet(): { publicKey: PublicKey; signTransaction(tx: Transaction): Promise<Transaction> };
    lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): object;
}>('../../web/src/lib/gemsBuy/browser');
const { useApp } = await vi.importActual<{ useApp: { getState(): {
  balances: { keep: string; gems?: string; shards: string } | null;
  setAuth(wallet: string | null, entryPaid?: boolean): void;
} } }>('../../web/src/state/store');
const { IDBFactory: TestIDBFactory } = createRequire(new URL('../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };
const conn = connectTestDb(), db = conn.db, UNIT = 10n ** BigInt(TOKEN.decimals);
let app: FastifyInstance | undefined;
const stores: Store[] = [];
type Exchange = { method: string; path: string; body: unknown; status: number; response: Record<string, unknown> };

beforeAll(async () => { await bootstrapSystemAccounts(db); await bindGemsTestReserve(db); });
beforeEach(() => {
  vi.stubEnv('GEMS_ENABLED', 'true'); vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'true');
  vi.stubEnv('GEMS_RESERVE_ATA', gemsTestAta.toBase58()); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await app?.close(); app = undefined; useApp.getState().setAuth(null);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(async () => { await conn.sql.end(); });

async function fixture(options: { walletKeep?: bigint; rejectWallet?: boolean; finalized?: boolean } = {}) {
  const key = Keypair.generate(), wallet = key.publicKey.toBase58();
  await db.insert(players).values({ wallet });
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  const factory = new TestIDBFactory(), exchanges: Exchange[] = [];
  const landed = new Map<string, { keys: PublicKey[]; reference: PublicKey; source: PublicKey; amount: bigint }>();
  let finalized = options.finalized ?? true, lostPath: string | null = null;
  const signTransaction = vi.fn(async (tx: Transaction) => {
    if (options.rejectWallet) throw new Error('Fixture wallet declined approval');
    tx.sign(key); return tx;
  });
  const sendRawTransaction = vi.fn(async (wire: Uint8Array, sendOptions: unknown) => {
    expect(sendOptions).toEqual({ maxRetries: 0, skipPreflight: false, preflightCommitment: 'confirmed' });
    const tx = Transaction.from(wire), instruction = tx.instructions[0]!;
    expect(tx.instructions).toHaveLength(1); expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.toBase58()).toBe(wallet); expect(instruction.programId.equals(CLASSIC_TOKEN_PROGRAM)).toBe(true);
    expect(instruction.keys).toHaveLength(5); expect(instruction.data[0]).toBe(12); // SPL TransferChecked
    expect(instruction.data[9]).toBe(TOKEN.decimals);
    const source = keepAta(key.publicKey, gemsTestMint);
    expect(instruction.keys.slice(0, 4).map(k => k.pubkey.toBase58())).toEqual([
      source.toBase58(), gemsTestMint.toBase58(), gemsTestAta.toBase58(), wallet,
    ]);
    const reference = instruction.keys[4]!.pubkey, amount = instruction.data.readBigUInt64LE(1);
    const [intent] = await db.select().from(deposits).where(eq(deposits.reference, reference.toBase58()));
    expect(intent).toMatchObject({ playerWallet: wallet, kind: 'gems_buy', status: 'pending' });
    expect(amount).toBe(BigInt((intent!.payload as { keepIn: number }).keepIn) * UNIT);
    const signature = bs58.encode(tx.signatures[0]!.signature!);
    landed.set(signature, { keys: tx.compileMessage().accountKeys, reference, source, amount });
    return signature;
  });
  // The real chain verifiers consume the exact reference, signature, keys and
  // amount from the browser-created wire; no test calls creditDeposit directly.
  const connection = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123 }),
    getBlockHeight: async () => 100, getFeeForMessage: async () => ({ value: 5_000 }), getBalance: async () => 5_000,
    getTokenAccountBalance: async () => ({ value: { amount: String((options.walletKeep ?? 20n) * UNIT), decimals: TOKEN.decimals } }),
    sendRawTransaction,
    getSignaturesForAddress: async (reference: PublicKey) => [...landed].filter(([, tx]) => tx.reference.equals(reference))
      .map(([signature]) => ({ signature, err: null, blockTime: Math.floor(Date.now() / 1_000) + 60 })),
    getTransaction: async (signature: string, config: { commitment: string }) => {
      const tx = landed.get(signature); if (!tx || config.commitment === 'finalized' && !finalized) return null;
      const balances = [
        { accountIndex: tx.keys.findIndex(k => k.equals(tx.source)), pre: 20n * UNIT, post: 20n * UNIT - tx.amount },
        { accountIndex: tx.keys.findIndex(k => k.equals(gemsTestAta)), pre: 100n * UNIT, post: 100n * UNIT + tx.amount },
      ];
      return { transaction: { message: { staticAccountKeys: tx.keys } }, meta: { err: null,
        preTokenBalances: balances.map(b => ({ accountIndex: b.accountIndex, mint: gemsTestMint.toBase58(), uiTokenAmount: { amount: String(b.pre) } })),
        postTokenBalances: balances.map(b => ({ accountIndex: b.accountIndex, mint: gemsTestMint.toBase58(), uiTokenAmount: { amount: String(b.post) } })),
      } };
    },
  } as unknown as Connection;
  async function restartApi() {
    await app?.close();
    const treasury = { liquidity: null, hot: { keepMint: gemsTestMint, pubkey: gemsTestHot } };
    app = await buildApp(TEST_CONFIG, db, {
      keepDeposit: { hotWalletAta: keepAta(gemsTestHot, gemsTestMint).toBase58(), keepMint: gemsTestMint.toBase58(), decimals: TOKEN.decimals },
      depositVerifier: makeCombinedDepositVerifier(connection, treasury),
      depositPaymentCommitVerifier: makeCombinedDepositCommitVerifier(connection, treasury),
    });
    await app.ready();
  }
  await restartApi();
  vi.stubGlobal('window', { location: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
  vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown,
    action: (lock: { name: string }) => Promise<T>) => action({ name }) } });
  useApp.getState().setAuth(wallet, true);
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    if (url.origin !== new URL(API_URL).origin || !['GET', 'POST'].includes(method)) throw new Error('Unexpected fixture HTTP request');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const path = `${url.pathname}${url.search}`;
    const response = await app!.inject({ method: method as 'GET' | 'POST', url: path,
      headers: { ...headers, origin: TEST_CONFIG.WEB_ORIGIN[0]! }, ...(init?.credentials === 'include' ? { cookies } : {}),
      ...(init?.body === undefined || init.body === null ? {} : { payload: String(init.body) }) });
    exchanges.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
      status: response.statusCode, response: response.json() as Record<string, unknown> });
    if (method === 'POST' && path === lostPath) { lostPath = null; throw new TypeError('Lost response after API commit'); }
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) value.forEach(v => responseHeaders.append(name, v));
      else if (value !== undefined) responseHeaders.set(name, String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
  });
  expect(await api.get('/me')).toMatchObject({ wallet });
  const identity = gemsBuyIdentity(wallet), binding = gemsBuyBinding(wallet);
  function client() {
    const store = new GemsBuyJournalStore(identity, factory); stores.push(store);
    return { store, controller: new GemsBuyController(store, createGemsBuyBrowserPorts({ identity, connection,
      wallet: () => ({ publicKey: key.publicKey, signTransaction }),
      lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }) })) };
  }
  return { wallet, binding, client, exchanges, signTransaction, sendRawTransaction, restartApi,
    loseResponse: (path: string) => { lostPath = path; }, finalize: () => { finalized = true; },
    published: () => useApp.getState().balances };
}
const intentRows = (wallet: string) => db.select().from(deposits).where(eq(deposits.playerWallet, wallet));
const creditRows = (id: string) => db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `deposit:${id}:credit`));
const postExchanges = (f: { exchanges: Exchange[] }) => f.exchanges.filter(e => e.method === 'POST');
async function expectCredit(wallet: string, purchase: Purchase) {
  const quote = purchase.quote!, receipt = purchase.deposit!.receipt!;
  expect(await intentRows(wallet)).toHaveLength(1);
  const rows = await creditRows(quote.id); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: receipt.receiptId, type: 'gems.buy' });
  expect(receipt).toMatchObject({ wallet, depositId: quote.id, txSignature: purchase.signature,
    funding: { currency: 'KEEP', amount: String(quote.keepIn), baseUnits: String(BigInt(quote.keepIn) * UNIT) },
    result: { currency: 'GEMS', amount: String(quote.gemsOut), rate: GEMS.gemsPerKeep } });
  const sys = await bootstrapSystemAccounts(db), player = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
  const entries = await db.select({ accountId: accounts.id, kind: accounts.kind, currency: accounts.currency,
    ownerWallet: accounts.ownerWallet, baseId: accounts.baseId, delta: ledgerEntries.delta }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, receipt.receiptId));
  const expected = [
    { accountId: sys.onchain_inflow, kind: 'onchain_inflow', currency: 'KEEP', ownerWallet: null, baseId: null, delta: -BigInt(quote.keepIn) },
    { accountId: sys.emission_pool, kind: 'emission_pool', currency: 'KEEP', ownerWallet: null, baseId: null, delta: BigInt(quote.keepIn) },
    { accountId: sys.gems_mint, kind: 'gems_mint', currency: 'GEMS', ownerWallet: null, baseId: null, delta: -BigInt(quote.gemsOut) },
    { accountId: player.id, kind: 'player_gems', currency: 'GEMS', ownerWallet: wallet, baseId: null, delta: BigInt(quote.gemsOut) },
  ];
  const byAccount = (a: { accountId: string }, b: { accountId: string }) => a.accountId.localeCompare(b.accountId);
  expect(entries).toHaveLength(4); expect(entries.sort(byAccount)).toEqual(expected.sort(byAccount));
  expect(player.balance).toBe(BigInt(quote.gemsOut));
  expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(0n);
}

describe('paired web wallet Gems purchase', () => {
  it('admits one intent, signs and relays once, then publishes the exact API-backed credit despite duplicate actions', async () => {
    const f = await fixture(), c = f.client();
    await c.controller.begin(10, f.binding); await c.controller.reviewPayment();
    expect(c.controller.snapshot()).toMatchObject({ reviewed: true, error: null });
    await Promise.all([c.controller.pay(), c.controller.pay()]);
    const purchase = (await c.store.read()).purchase!;
    expect(purchase).toMatchObject({ prepared: expect.any(Object), broadcastStarted: true, hydrated: true });
    expect(c.controller.snapshot().error).toBeNull(); await expectCredit(f.wallet, purchase);
    expect(f.published()).toMatchObject({ keep: '0', gems: String(10 * GEMS.gemsPerKeep), shards: '0' });
    const admissions = postExchanges(f).filter(e => e.path === '/deposits');
    expect(admissions).toHaveLength(2); expect(admissions.map(e => e.body)).toEqual([purchase.request, purchase.request]);
    expect(admissions.map(e => e.response.id)).toEqual([purchase.quote!.id, purchase.quote!.id]);
    const before = postExchanges(f).length;
    await c.controller.recoverPayment(); await c.controller.reviewPayment(); await c.controller.pay();
    expect(postExchanges(f)).toHaveLength(before);
    expect(await api.postRaw(`/deposits/${purchase.quote!.id}/verify`, {})).toMatchObject({ status: 'credited', receipt: purchase.deposit!.receipt });
    await expect(api.postRaw('/deposits', purchase.request)).rejects.toMatchObject({ status: 409, code: 'INTENT_TERMINAL' });
    expect(f.signTransaction).toHaveBeenCalledTimes(1); expect(f.sendRawTransaction).toHaveBeenCalledTimes(1);
    await expectCredit(f.wallet, purchase);
  });

  it('recovers a lost admission after client/API restart using the saved key before any wallet attempt', async () => {
    const f = await fixture(), first = f.client(); f.loseResponse('/deposits');
    await first.controller.begin(10, f.binding);
    const original = (await first.store.read()).purchase!;
    expect(original).toMatchObject({ quote: null, prepared: null, signature: null, broadcastStarted: false });
    expect(await intentRows(f.wallet)).toHaveLength(1); expect(f.signTransaction).not.toHaveBeenCalled();
    await first.store.close(); await f.restartApi();
    const c = f.client(), before = postExchanges(f).length; await c.controller.open();
    expect(postExchanges(f)).toHaveLength(before); expect(f.signTransaction).not.toHaveBeenCalled();
    expect((await c.store.read()).purchase).toMatchObject({ request: original.request, quote: { id: (await intentRows(f.wallet))[0]!.id } });
    await c.controller.reviewPayment(); await c.controller.pay();
    await expectCredit(f.wallet, (await c.store.read()).purchase!);
    expect(f.signTransaction).toHaveBeenCalledTimes(1); expect(f.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('recovers the committed lost response after client/API restart without another payment (paused=%s)', async paused => {
    const f = await fixture(), first = f.client();
    await first.controller.begin(10, f.binding); await first.controller.reviewPayment();
    const quote = (await first.store.read()).purchase!.quote!; f.loseResponse(`/deposits/${quote.id}/verify`);
    await first.controller.pay();
    const uncertain = (await first.store.read()).purchase!;
    expect(uncertain).toMatchObject({ broadcastStarted: true, hydrated: false, deposit: { receipt: null } });
    expect(first.controller.snapshot().error).toContain('Unable to reach');
    const rows = await creditRows(quote.id); expect(rows).toHaveLength(1); expect(f.published()).toBeNull();
    await first.store.close(); if (paused) { vi.stubEnv('GEMS_ENABLED', 'false'); vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'false'); }
    await f.restartApi(); const c = f.client(), before = postExchanges(f).length;
    await c.controller.open(); expect(f.published()).toBeNull();
    expect((await c.store.read()).purchase!.deposit!.receipt!.receiptId).toBe(rows[0]!.id);
    await c.controller.recoverPayment();
    const recovered = (await c.store.read()).purchase!;
    expect(recovered).toMatchObject({ hydrated: true, signature: uncertain.signature }); await expectCredit(f.wallet, recovered);
    expect(f.published()).toMatchObject({ keep: '0', shards: '0' });
    // A global pause omits Gems from the public balance shape. Recovery still
    // retains the paid receipt and exact credit; it must not invent a HUD field.
    if (paused) expect(f.published()).not.toHaveProperty('gems');
    else expect(f.published()).toMatchObject({ gems: String(10 * GEMS.gemsPerKeep) });
    expect(postExchanges(f)).toHaveLength(before);
    expect(f.signTransaction).toHaveBeenCalledTimes(1); expect(f.sendRawTransaction).toHaveBeenCalledTimes(1);
    if (paused) {
      await expect(api.postRaw('/deposits', { kind: 'gems_buy', keepIn: 10, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ status: 503, code: 'GEMS_WALLET_BUY_DISABLED' });
      expect(await intentRows(f.wallet)).toHaveLength(1);
    }
  });

  it('keeps confirmed payment unresolved until finalized authority arrives, then recovers during pause', async () => {
    const f = await fixture({ finalized: false }), c = f.client();
    await c.controller.begin(10, f.binding); await c.controller.reviewPayment(); await c.controller.pay();
    const pending = (await c.store.read()).purchase!;
    expect(pending).toMatchObject({ broadcastStarted: true, hydrated: false, deposit: { receipt: null } });
    expect(await creditRows(pending.quote!.id)).toHaveLength(0); expect(f.published()).toBeNull();
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_gems')).balance).toBe(0n);
    f.finalize(); vi.stubEnv('GEMS_ENABLED', 'false'); vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'false');
    await c.controller.recoverPayment(); await c.controller.recoverPayment();
    const recovered = (await c.store.read()).purchase!;
    expect(recovered.hydrated).toBe(true); await expectCredit(f.wallet, recovered);
    expect(f.signTransaction).toHaveBeenCalledTimes(1); expect(f.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['short balance', 'wallet rejection'] as const)('refuses %s without a broadcast or credit, including after restart', async refusal => {
    const f = await fixture(refusal === 'short balance' ? { walletKeep: 1n } : { rejectWallet: true }), c = f.client();
    await c.controller.begin(10, f.binding); await c.controller.reviewPayment();
    if (refusal === 'wallet rejection') await c.controller.pay();
    expect(c.controller.snapshot().error).toContain(refusal === 'short balance' ? 'full quoted KEEP' : 'declined approval');
    const original = (await c.store.read()).purchase!;
    expect(original.prepared === null).toBe(refusal === 'short balance');
    await c.store.close(); await f.restartApi(); const restarted = f.client();
    await restarted.controller.open(); await restarted.controller.reviewPayment(); await restarted.controller.pay();
    if (refusal === 'wallet rejection') {
      await restarted.controller.abandonDraft();
      expect(restarted.controller.snapshot().error).toContain('cannot be abandoned');
      expect((await restarted.store.read()).purchase!.prepared).toEqual(original.prepared);
    }
    expect(f.signTransaction).toHaveBeenCalledTimes(refusal === 'wallet rejection' ? 1 : 0);
    expect(f.sendRawTransaction).not.toHaveBeenCalled(); expect(f.published()).toBeNull();
    expect(await intentRows(f.wallet)).toHaveLength(1); expect(await creditRows(original.quote!.id)).toHaveLength(0);
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_gems')).balance).toBe(0n);
  });
});
