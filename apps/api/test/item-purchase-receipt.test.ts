/** A receipt proves the original paid grant, never today's price or inventory. */
import { randomUUID } from 'node:crypto';
import { INVENTORY, ITEMS, type ItemSpec } from '@shardkeep/shared';
import { itemPurchaseBody, itemPurchaseReceiptPath, type ItemPurchaseIntent } from '@shardkeep/shared/itemPurchase';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, baseItems, ledgerTransactions, playerItems, players, sessions } from '../src/db/schema';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { buyItem, getItems } from '../src/game/items';
import { getItemPurchaseReceipt, ItemPurchaseAbsentSchema, itemPurchaseLedgerKey, itemPurchaseQuote, readItemPurchaseReceipt } from '../src/game/itemPurchaseReceipt';
import * as spending from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import type { Db } from '../src/db/client';
import { connectTestDb, createTestPlayer, fundTestKeep, holdPlayerLock, settlesWithin, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db;
const lookup = (r: Pick<ItemPurchaseIntent, 'itemId' | 'baseId' | 'idempotencyKey'>) => ({ itemId: r.itemId, baseId: r.baseId, idempotencyKey: r.idempotencyKey });
const flags = ['MULTI_BASE_ENABLED', 'GEMS_ENABLED', 'FREE_ONBOARDING'] as const;
const originalFlags = Object.fromEntries(flags.map(k => [k, process.env[k]]));
const catalog = ITEMS as unknown as Record<string, ItemSpec>, originalItem = catalog.powder_charge!;
const revision = INVENTORY.catalogRevision;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterEach(() => { catalog.powder_charge = originalItem; (INVENTORY as { catalogRevision: number }).catalogRevision = revision; vi.restoreAllMocks(); });
afterAll(async () => {
  for (const k of flags) { if (originalFlags[k] === undefined) delete process.env[k]; else process.env[k] = originalFlags[k]; }
  await conn.sql.end();
});
async function receiptApp() {
  // Exercise the real per-request stable-base gates without activating every
  // unrelated broad-suite deed's deployment-time observer census.
  const stable = process.env['MULTI_BASE_ENABLED'];
  process.env['MULTI_BASE_ENABLED'] = 'false';
  try { return await buildApp(TEST_CONFIG, db); }
  finally {
    if (stable === undefined) delete process.env['MULTI_BASE_ENABLED'];
    else process.env['MULTI_BASE_ENABLED'] = stable;
  }
}
async function fixture(stable: boolean, currency: 'KEEP' | 'GEMS' = 'KEEP') {
  process.env['MULTI_BASE_ENABLED'] = String(stable); process.env['GEMS_ENABLED'] = 'true';
  const { wallet } = await createTestPlayer(db); await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, wallet));
  await fundTestKeep(db, wallet, 100000n, 'test.items.keep', randomUUID());
  if (currency === 'GEMS') await convertKeepToGems(db, wallet, 10000n, randomUUID());
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, keepLevel: 5, landPaidAt: new Date() }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  }
  const request: ItemPurchaseIntent = { itemId: 'powder_charge', baseId: baseId ?? null,
    idempotencyKey: randomUUID(), expectedCurrency: currency, consent: itemPurchaseQuote(ITEMS.powder_charge)! };
  const buy = (change: Partial<ItemPurchaseIntent> = {}) => {
    const r = { ...request, ...change };
    return withClientCurrencyContext({ currency: undefined, expectedCurrency: r.expectedCurrency },
      () => buyItem(db, wallet, r.itemId, r.idempotencyKey, { baseId: r.baseId ?? undefined, consent: r.consent,
        ...(baseId ? { authorizeBaseMutation: async () => {} } : {}) }));
  };
  const balances = () => Promise.all(['player_keep', 'player_gems'].map(async kind =>
    (await getOrCreatePlayerAccount(db, wallet, kind as 'player_keep' | 'player_gems')).balance));
  const rows = () => baseId ? db.select().from(baseItems).where(eq(baseItems.baseId, baseId))
    : db.select().from(playerItems).where(eq(playerItems.playerWallet, wallet));
  return { wallet, baseId, request, buy, balances, rows };
}
for (const stable of [false, true]) describe(`original item purchase (${stable ? 'base' : 'legacy'} mode)`, () => {
  it.each(['KEEP', 'GEMS'] as const)('concurrent %s requests charge/grant once; sale, consumption and catalogue removal do not erase proof', async currency => {
    const f = await fixture(stable, currency), before = await f.balances(), cost = BigInt(f.request.consent.maxCostKeep);
    const results = await Promise.all([f.buy(), f.buy()]);
    expect(results.filter(r => !r.duplicate)).toHaveLength(1); expect(results.map(r => r.costKeep)).toEqual([Number(cost), Number(cost)]);
    expect(await f.rows()).toMatchObject([{ itemId: f.request.itemId, qty: 1, acquiredVia: currency === 'GEMS' ? 'shop_gems' : 'shop_keep' }]);
    const proof = await getItemPurchaseReceipt(db, f.wallet, lookup(f.request));
    expect(proof).toMatchObject({ status: 'accepted', request: f.request, funding: { currency, amount: cost.toString() }, result: { itemId: f.request.itemId, quantity: 1 } });
    // Inventory is mutable; original payment is not reconstructed from it.
    if (f.baseId) {
      await db.update(baseItems).set({ qty: 0 }).where(eq(baseItems.baseId, f.baseId));
      const other = await createTestPlayer(db); await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await db.update(bases).set({ ownerWallet: other.wallet }).where(eq(bases.id, f.baseId));
    } else await db.update(playerItems).set({ qty: 0 }).where(eq(playerItems.playerWallet, f.wallet));
    delete catalog.powder_charge; process.env['GEMS_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = String(!stable);
    expect(await f.buy()).toEqual({ itemId: f.request.itemId, costKeep: Number(cost), currency, duplicate: true });
    expect(await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).toEqual(proof); expect((await f.rows())[0]!.qty).toBe(0);
    const after = await f.balances(); expect(after[currency === 'KEEP' ? 0 : 1]).toBe(before[currency === 'KEEP' ? 0 : 1]! - cost);
    expect(after[currency === 'KEEP' ? 1 : 0]).toBe(before[currency === 'KEEP' ? 1 : 0]);
  });
  it('refuses a price increase or changed revision without a debit, but allows a lower current price', async () => {
    const f = await fixture(stable), before = await f.balances();
    catalog.powder_charge = { ...originalItem, costKeep: originalItem.costKeep + 1 };
    await expect(f.buy()).rejects.toMatchObject({ code: 'ITEM_BUY_QUOTE_CHANGED' });
    catalog.powder_charge = originalItem; (INVENTORY as { catalogRevision: number }).catalogRevision = revision + 1;
    await expect(f.buy()).rejects.toMatchObject({ code: 'ITEM_BUY_QUOTE_CHANGED' });
    expect(await f.balances()).toEqual(before); expect(await f.rows()).toHaveLength(0);
    (INVENTORY as { catalogRevision: number }).catalogRevision = revision;
    catalog.powder_charge = { ...originalItem, costKeep: originalItem.costKeep - 1 };
    expect((await f.buy()).costKeep).toBe(originalItem.costKeep - 1);
    expect(await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).toMatchObject({ funding: { amount: String(originalItem.costKeep - 1) } });
  });
  it('new intent cannot normalize missing base, switch modes or silently spend another currency', async () => {
    const f = await fixture(stable), before = await f.balances();
    if (stable) await expect(f.buy({ baseId: null })).rejects.toMatchObject({ code: 'ITEM_BUY_SCOPE_CHANGED' });
    await expect(f.buy({ expectedCurrency: 'GEMS' })).rejects.toMatchObject({ code: 'CURRENCY_CONSENT_CHANGED' });
    process.env['MULTI_BASE_ENABLED'] = String(!stable);
    await expect(f.buy()).rejects.toMatchObject({ code: 'ITEM_BUY_SCOPE_CHANGED' });
    expect(await f.balances()).toEqual(before); expect(await f.rows()).toHaveLength(0);
    expect((await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
  });
  it('changed item/key terms cannot reuse an accepted purchase; foreign-wallet/base lookup stays unknown', async () => {
    const f = await fixture(stable); await f.buy(); const before = await f.balances(), inventory = await f.rows();
    for (const change of [{ itemId: 'finishers_seal' }, { expectedCurrency: 'GEMS' as const }, { consent: { ...f.request.consent, maxCostKeep: '99999' } }])
      await expect(f.buy(change)).rejects.toMatchObject({ code: 'ITEM_BUY_RECEIPT_INVALID' });
    const other = await createTestPlayer(db);
    expect((await getItemPurchaseReceipt(db, other.wallet, lookup(f.request))).status).toBe('unknown');
    expect((await getItemPurchaseReceipt(db, f.wallet, { ...lookup(f.request), baseId: randomUUID() })).status).toBe('unknown');
    expect(await f.balances()).toEqual(before); expect(await f.rows()).toEqual(inventory);
  });
  it('an inventory-cap refusal rolls back the debit and original metadata', async () => {
    const f = await fixture(stable, 'GEMS'), before = await f.balances();
    if (f.baseId) await db.insert(baseItems).values({ baseId: f.baseId, itemId: 'finishers_seal', qty: INVENTORY.capacity + 1 });
    else await db.insert(playerItems).values({ playerWallet: f.wallet, itemId: 'finishers_seal', qty: INVENTORY.capacity + 1 });
    const inventory = await f.rows();
    await expect(f.buy()).rejects.toMatchObject({ code: 'ITEM_BUY_UNAVAILABLE' });
    expect(await f.balances()).toEqual(before); expect(await f.rows()).toEqual(inventory);
    expect((await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
  });
});
it('legacy duplicates retain their wire shape but return the original debit, never today\'s catalogue price', async () => {
  const f = await fixture(false); await buyItem(db, f.wallet, f.request.itemId, f.request.idempotencyKey);
  catalog.powder_charge = { ...originalItem, costKeep: originalItem.costKeep + 1 };
  expect(await buyItem(db, f.wallet, f.request.itemId, f.request.idempotencyKey))
    .toEqual({ itemId: f.request.itemId, costKeep: originalItem.costKeep, duplicate: true });
  expect((await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
  await expect(f.buy()).rejects.toMatchObject({ code: 'ITEM_BUY_RECEIPT_INVALID' });
});
it('a failure after the real ledger posting rolls back payment and prevents any item grant', async () => {
  const f = await fixture(false), before = await f.balances(), originalSpend = spending.spendGameCurrency;
  vi.spyOn(spending, 'spendGameCurrency').mockImplementation(async (...args) => { await originalSpend(...args); throw new Error('after actual debit'); });
  await expect(f.buy()).rejects.toThrow('after actual debit');
  expect(await f.balances()).toEqual(before); expect(await f.rows()).toHaveLength(0);
  expect((await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
});
it.each(['sink', 'wallet', 'ceiling', 'result', 'quantity'] as const)('rejects forged historical %s without consulting the catalogue', async variant => {
  const f = await fixture(false), sys = await bootstrapSystemAccounts(db), payer = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
  // A genuine foreign player gets past the activity-event FK so this case
  // reaches the receipt's wallet binding rather than failing during setup.
  const metadataWallet = variant === 'wallet' ? (await createTestPlayer(db)).wallet : f.wallet;
  const amount = BigInt(f.request.consent.maxCostKeep) + (variant === 'ceiling' ? 1n : 0n);
  await postTransaction(db, { type: 'item.buy', idempotencyKey: itemPurchaseLedgerKey(f.wallet, f.request.idempotencyKey),
    entries: [{ account: payer.id, delta: -amount }, { account: variant === 'sink' ? sys.league_pool : sys.emission_pool, delta: amount }],
    metadata: { wallet: metadataWallet, recycled: true, itemId: f.request.itemId,
      itemPurchase: { version: 1, request: f.request, result: { itemId: variant === 'result' ? 'finishers_seal' : f.request.itemId, quantity: variant === 'quantity' ? 2 : 1 } } } });
  expect((await getItemPurchaseReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
  await expect(f.buy()).rejects.toMatchObject({ code: 'ITEM_BUY_RECEIPT_INVALID' });
});
it.each([{ stable: false, currency: 'KEEP' }, { stable: false, currency: 'GEMS' },
  { stable: true, currency: 'KEEP' }, { stable: true, currency: 'GEMS' }] as const)(
  'HTTP $currency purchase/receipt stays scoped and private (stable=$stable)', async ({ stable, currency }) => {
  const f = await fixture(stable, currency); process.env['FREE_ONBOARDING'] = 'true';
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) }, app = await receiptApp();
  const url = itemPurchaseReceiptPath(lookup(f.request)), body = itemPurchaseBody(f.request);
  try {
    expect((await app.inject({ method: 'POST', url: '/items/buy', cookies, payload: body })).statusCode).toBe(400);
    for (const change of [{ quantity: 2 }, { version: '1' }, { maxCostKeep: '0' }])
      expect((await app.inject({ method: 'POST', url: '/items/buy', cookies, headers: { 'x-pkw-expected-currency': currency }, payload: { ...body, consent: { ...body.consent, ...change } } })).statusCode).toBe(400);
    const state = await getItems(db, f.wallet, f.baseId);
    expect(state.features.itemPurchase).toEqual({ version: 1, receipts: 1 });
    expect(state.catalog.find(i => i.id === f.request.itemId)?.paidPurchaseQuote).toEqual(f.request.consent);
    const accepted = await app.inject({ method: 'POST', url: '/items/buy', cookies, headers: { 'x-pkw-expected-currency': currency }, payload: body });
    expect(accepted.statusCode, accepted.body).toBe(201); expect(accepted.json()).toMatchObject({ currency, duplicate: false });
    delete catalog.powder_charge; process.env['MULTI_BASE_ENABLED'] = String(!stable); process.env['GEMS_ENABLED'] = 'false';
    const before = await db.select().from(accounts), txns = await db.select().from(ledgerTransactions);
    expect((await app.inject({ url })).statusCode).toBe(401);
    const receipt = await app.inject({ url, cookies }); expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json().status).toBe('accepted'); expect(receipt.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: `${url}&wallet=${f.wallet}`, cookies })).statusCode).toBe(400);
    const replay = await app.inject({ method: 'POST', url: '/items/buy', cookies, headers: { 'x-pkw-expected-currency': currency }, payload: body });
    expect(replay.statusCode, replay.body).toBe(201); expect(replay.json().duplicate).toBe(true);
    expect(await db.select().from(accounts)).toEqual(before); expect(await db.select().from(ledgerTransactions)).toEqual(txns);
  } finally { await app.close(); }
});

it.each(['warzone_aegis', 'item_troop_dragon', 'forge_ingot'] as const)('earned/crafted %s cannot acquire a paid quote or grant through forged consent', async itemId => {
  const f = await fixture(false), before = await f.balances();
  expect(itemPurchaseQuote(ITEMS[itemId])).toBeNull();
  await expect(f.buy({ itemId })).rejects.toMatchObject({ code: 'ITEM_BUY_UNAVAILABLE' });
  expect(await f.balances()).toEqual(before); expect(await f.rows()).toHaveLength(0);
});
it.each([false, true])('max-owned serializes different keys and keeps exact retry successful (stable=%s)', async stable => {
  const f = await fixture(stable, 'GEMS'), before = await f.balances();
  const request = { ...f.request, itemId: 'item_troop_mage', consent: itemPurchaseQuote(ITEMS.item_troop_mage)! };
  const results = await Promise.allSettled([f.buy(request), f.buy({ ...request, idempotencyKey: randomUUID() })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find(r => r.status === 'rejected');
  expect(failure?.status === 'rejected' ? failure.reason : null).toMatchObject({ code: 'ITEM_BUY_UNAVAILABLE' });
  expect(await f.rows()).toMatchObject([{ itemId: request.itemId, qty: 1, acquiredVia: 'shop_gems' }]);
  expect((await f.balances())[1]).toBe(before[1]! - BigInt(request.consent.maxCostKeep));
  // Whichever key acquired the row, the losing transaction left no paid evidence.
  const txns = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, itemPurchaseLedgerKey(f.wallet, request.idempotencyKey, f.baseId)));
  if (txns.length) expect((await f.buy(request)).duplicate).toBe(true);
  else expect((await getItemPurchaseReceipt(db, f.wallet, lookup(request))).status).toBe('unknown');
});

// GET /items/buy/receipt answers `absent` only as proof that no ledger row holds
// this purchase's key. A client may then forget the saved purchase, so a wrong
// `absent` would hide a real KEEP/Gems charge.
for (const stable of [false, true]) describe(`route answer: absent only when no row holds the purchase key (${stable ? 'base' : 'legacy'} mode)`, () => {
  it('a never-claimed key is absent with a server time; once bought it is accepted, never absent', async () => {
    const f = await fixture(stable), before = Date.now();
    const answer = await readItemPurchaseReceipt(db, f.wallet, lookup(f.request));
    expect(ItemPurchaseAbsentSchema.parse(answer)).toEqual({ version: 1, status: 'absent', idempotencyKey: f.request.idempotencyKey, absentAsOf: expect.any(String) });
    const absentAsOf = Date.parse((answer as { absentAsOf: string }).absentAsOf);
    expect(absentAsOf).toBeGreaterThanOrEqual(before); expect(absentAsOf).toBeLessThanOrEqual(Date.now());
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
      itemPurchaseLedgerKey(f.wallet, f.request.idempotencyKey, f.baseId)))).toEqual([]);
    await f.buy();
    const accepted = await readItemPurchaseReceipt(db, f.wallet, lookup(f.request));
    expect(accepted.status).toBe('accepted'); expect(accepted).toEqual(await getItemPurchaseReceipt(db, f.wallet, lookup(f.request)));
    // Another wallet never claimed this key in its own namespace.
    expect((await readItemPurchaseReceipt(db, (await createTestPlayer(db)).wallet, lookup(f.request))).status).toBe('absent');
  });
  it('an existing legacy, forged or mismatching row under the key stays unknown, never absent', async () => {
    const f = await fixture(stable);
    await buyItem(db, f.wallet, f.request.itemId, f.request.idempotencyKey, { baseId: f.baseId, ...(f.baseId ? { authorizeBaseMutation: async () => {} } : {}) });
    expect((await readItemPurchaseReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
    expect((await readItemPurchaseReceipt(db, f.wallet, { ...lookup(f.request), itemId: 'finishers_seal' })).status).toBe('unknown');
    // A wallet-level key is checked for a base-scoped lookup too.
    const walletLevel = { ...f.request, idempotencyKey: randomUUID() }, sys = await bootstrapSystemAccounts(db);
    const payer = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
    await postTransaction(db, { type: 'item.buy', idempotencyKey: itemPurchaseLedgerKey(f.wallet, walletLevel.idempotencyKey),
      entries: [{ account: payer.id, delta: -1n }, { account: sys.emission_pool, delta: 1n }], metadata: { wallet: f.wallet, itemId: 'finishers_seal', recycled: true } });
    expect((await readItemPurchaseReceipt(db, f.wallet, lookup(walletLevel))).status).toBe('unknown');
  });
  it.each(['commit', 'rollback'] as const)('waits for a purchase still holding the wallet lock instead of answering past it (%s)', async outcome => {
    const f = await fixture(stable);
    const finish = await holdPlayerLock(db, f.wallet, tx => withClientCurrencyContext({ currency: undefined, expectedCurrency: f.request.expectedCurrency },
      () => buyItem(tx as unknown as Db, f.wallet, f.request.itemId, f.request.idempotencyKey, { baseId: f.request.baseId ?? undefined,
        consent: f.request.consent, ...(f.baseId ? { authorizeBaseMutation: async () => {} } : {}) })), outcome);
    const reading = readItemPurchaseReceipt(db, f.wallet, lookup(f.request));
    let answeredEarly: boolean;
    try { answeredEarly = await settlesWithin(reading, 400); } finally { await finish(); }
    expect(answeredEarly).toBe(false);
    expect((await reading).status).toBe(outcome === 'commit' ? 'accepted' : 'absent');
  });
  it('HTTP answers the exact absent shape privately and uncached', async () => {
    const f = await fixture(stable);
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) }, app = await receiptApp();
    try {
      const response = await app.inject({ url: itemPurchaseReceiptPath(lookup(f.request)), cookies });
      expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
      expect(Object.keys(response.json()).sort()).toEqual(['absentAsOf', 'idempotencyKey', 'status', 'version']);
      expect(ItemPurchaseAbsentSchema.parse(response.json())).toMatchObject({ status: 'absent', idempotencyKey: f.request.idempotencyKey });
    } finally { await app.close(); }
  });
});
