import { randomUUID } from 'node:crypto';
import { FORGE } from '@shardkeep/shared';
import { ForgeClaimReceiptSchema, ForgeClaimStatusSchema, type ForgeClaimRequest } from '@shardkeep/shared/forgeClaims';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import type { Db, DbTx } from '../src/db/client';
import { baseForgePositions, bases, baseSlots, buildings, forgeClaimCommands, forgeContributions, ledgerEntries, ledgerTransactions, players, sessions } from '../src/db/schema';
import { executeForgeClaimCommand, getForgeClaimCommand } from '../src/game/forgeClaimCommands';
import { claimForgeDays, contributeToForge, settleForgeDay, type ForgeStableBaseContext } from '../src/game/forge';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { rewardShards } from '../src/game/spend';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const oldFlag = process.env['FORGE_ENABLED'];
afterEach(() => { if (oldFlag === undefined) delete process.env['FORGE_ENABLED']; else process.env['FORGE_ENABLED'] = oldFlag; });
afterAll(async () => { await conn.sql.end(); });
const now = new Date('2034-06-01T00:00:00.000Z');
let dayNumber = 0;
async function fixture(stable = false, count = 1) {
  const { wallet } = await createTestPlayer(db); let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: new Date() }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  }
  const context: ForgeStableBaseContext | undefined = baseId ? { baseId, assertActiveAuthority: async (tx, actor) => {
    const [base] = await tx.select().from(bases).where(and(eq(bases.id, baseId!), eq(bases.ownerWallet, actor), eq(bases.status, 'active'))).for('update');
    if (!base) throw new Error('original deed unavailable');
    return [{ id: base.id, landPaidAt: base.landPaidAt }];
  } } : undefined;
  await db.insert(buildings).values({ playerWallet: wallet, ...(baseId ? { baseId } : {}), type: 'goldforge', level: 1, tx: 20, ty: 20 });
  const amount = BigInt(FORGE.contributionCapByLevel[1]!);
  if (baseId) await rewardBaseShards(db, baseId, amount * BigInt(count), 'test.forge.claim.fund', randomUUID());
  else await rewardShards(db, wallet, amount * BigInt(count), 'test.forge.claim.fund', randomUUID());
  const days: string[] = []; let expected = 0n;
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.UTC(2033, 0, 1 + dayNumber++)); const day = at.toISOString().slice(0, 10); days.push(day);
    await contributeToForge(db, wallet, amount, randomUUID(), at, baseId, context);
    await settleForgeDay(db, day, now);
    const rows = baseId ? await db.select({ keep: baseForgePositions.keepPaid }).from(baseForgePositions).where(and(eq(baseForgePositions.baseId, baseId), eq(baseForgePositions.day, day)))
      : await db.select({ keep: forgeContributions.keepPaid }).from(forgeContributions).where(and(eq(forgeContributions.playerWallet, wallet), eq(forgeContributions.day, day)));
    expected += rows[0]!.keep!;
  }
  const request: ForgeClaimRequest = { idempotencyKey: randomUUID(), baseId: baseId ?? null, day: null };
  return { wallet, baseId, context, request, days, expected, submit: (r = request) => executeForgeClaimCommand(db, wallet, r, now, context) };
}
function failReceipt(error: Error | null): Db {
  return new Proxy(db, { get(target, key) {
    if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => target.transaction(tx => run(new Proxy(tx, {
      get(t, k) {
        if (k === 'insert') return (table: typeof forgeClaimCommands) => {
          if (table !== forgeClaimCommands) return t.insert(table);
          if (error) throw error;
          // Persist the real receipt, then corrupt only the returned proof. The
          // serializer must reject it before the enclosing payout transaction commits.
          return { values: (value: typeof forgeClaimCommands.$inferInsert) => ({ returning: async () =>
            (await t.insert(table).values(value).returning()).map(row => ({ ...row, result: { claimed: [], totalKeep: '-1', remaining: 0 } })),
          }) };
        };
        const value = Reflect.get(t, k); return typeof value === 'function' ? value.bind(t) : value;
      },
    })));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
describe.sequential('immutable Forge claim command recovery', () => {
  for (const stable of [false, true]) it(`concurrent identical ${stable ? 'deed' : 'wallet'} requests pay once and retain exact ledger proof`, async () => {
    const f = await fixture(stable, 2); const before = (await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance;
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => f.submit()));
    outcomes.forEach(r => expect(r).toEqual(outcomes[0])); const receipt = ForgeClaimReceiptSchema.parse(outcomes[0]);
    expect(receipt.result.totalKeep).toBe(f.expected.toString()); expect(receipt.result.claimed.map(r => r.day)).toEqual(f.days);
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance).toBe(before + f.expected);
    for (const row of receipt.result.claimed) {
      const [transaction] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, row.ledgerTransactionId));
      expect(transaction!.type).toBe('forge.claim');
      const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, row.ledgerTransactionId));
      expect(entries.map(e => e.delta).sort()).toEqual([-BigInt(row.keep), BigInt(row.keep)]);
    }
  });
  it('a completed empty single-day command cannot change its original selector', async () => {
    const f = await fixture(); const request = { ...f.request, day: '2030-01-01' }; const receipt = await f.submit(request);
    expect(receipt.result).toEqual({ claimed: [], totalKeep: '0', remaining: 1 });
    expect(await f.submit(request)).toEqual(receipt);
    await expect(f.submit({ ...request, day: null })).rejects.toMatchObject({ code: 'FORGE_CLAIM_MISMATCH' });
    expect((await f.submit({ ...f.request, idempotencyKey: randomUUID() })).result.totalKeep).toBe(f.expected.toString());
  });
  it('an all-days empty receipt remains empty when a later allocation becomes claimable', async () => {
    const f = await fixture(); await f.submit();
    const emptyRequest = { ...f.request, idempotencyKey: randomUUID() }; const empty = await f.submit(emptyRequest);
    expect(empty.result).toEqual({ claimed: [], totalKeep: '0', remaining: 0 });
    const amount = BigInt(FORGE.contributionCapByLevel[1]!); const at = new Date(Date.UTC(2033, 0, 1 + dayNumber++));
    await rewardShards(db, f.wallet, amount, 'test.forge.claim.fund', randomUUID());
    await contributeToForge(db, f.wallet, amount, randomUUID(), at);
    await settleForgeDay(db, at.toISOString().slice(0, 10), now);
    expect(await f.submit(emptyRequest)).toEqual(empty);
    const fresh = await f.submit({ ...f.request, idempotencyKey: randomUUID() });
    expect(fresh.result.claimed.map(row => row.day)).toEqual([at.toISOString().slice(0, 10)]);
    expect(BigInt(fresh.result.totalKeep)).toBeGreaterThan(0n);
  });
  it('records only the selected day; another explicit fresh command claims the remaining allocation', async () => {
    const f = await fixture(true, 2); const receipt = await f.submit({ ...f.request, day: f.days[1]! });
    expect(receipt.result.claimed.map(r => r.day)).toEqual([f.days[1]]); expect(receipt.result.remaining).toBe(1);
    const next = await f.submit({ ...f.request, idempotencyKey: randomUUID() });
    expect(next.result.claimed.map(r => r.day)).toEqual([f.days[0]]);
  });
  it('keeps the canonical claim batch bound and requires a fresh tap for remaining days', async () => {
    const f = await fixture(false, FORGE.claimBatchMax + 1); const first = await f.submit();
    expect(first.result.claimed).toHaveLength(FORGE.claimBatchMax); expect(first.result.remaining).toBe(1);
    expect(await f.submit()).toEqual(first);
    expect((await f.submit({ ...f.request, idempotencyKey: randomUUID() })).result.claimed).toHaveLength(1);
  });
  it('a receipt persistence outage rolls back payout and allocation claim markers together', async () => {
    const f = await fixture(true); const before = (await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance; const error = new Error('receipt storage outage');
    await expect(executeForgeClaimCommand(failReceipt(error), f.wallet, f.request, now, f.context)).rejects.toBe(error);
    expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance).toBe(before);
    const [row] = await db.select().from(baseForgePositions).where(eq(baseForgePositions.baseId, f.baseId!));
    expect(row!.claimedAt).toBeNull(); expect(row!.claimTxnId).toBeNull(); expect((await f.submit()).result.totalKeep).toBe(f.expected.toString());
  });
  it('invalid returned payout proof rolls back both the already inserted receipt and real payout', async () => {
    const f = await fixture(true); const before = (await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance;
    await expect(executeForgeClaimCommand(failReceipt(null), f.wallet, f.request, now, f.context)).rejects.toThrow();
    expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance).toBe(before);
    const [row] = await db.select().from(baseForgePositions).where(eq(baseForgePositions.baseId, f.baseId!));
    expect(row!.claimedAt).toBeNull(); expect(row!.claimTxnId).toBeNull();
    expect((await f.submit()).result.totalKeep).toBe(f.expected.toString());
  });
  it('claim payout and proof finish before an overlapping ownership transfer can take the same player and deed', async () => {
    const f = await fixture(true); const buyer = await createTestPlayer(db);
    let entered!: () => void; let release!: () => void; let transferEntered!: () => void; let transferPid = 0;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const transferStarted = new Promise<void>(resolve => { transferEntered = resolve; });
    const context: ForgeStableBaseContext = { baseId: f.baseId!, assertActiveAuthority: async (tx, actor) => {
      const result = await f.context!.assertActiveAuthority(tx, actor); entered(); await finish; return result;
    } };
    const claiming = executeForgeClaimCommand(db, f.wallet, f.request, now, context);
    let transferring: Promise<void> | undefined;
    try {
      await inside;
      // A historical read while the payout is in flight stays unknown; it does
      // not invent a failure or initiate another claim.
      expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
      transferring = db.transaction(async tx => {
        transferPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!['pid']); transferEntered();
        await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
        await tx.select().from(bases).where(eq(bases.id, f.baseId!)).for('update');
        await tx.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId!));
        await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId!));
      });
      await transferStarted;
      await expect.poll(async () => (await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${transferPid}`)[0]?.['wait_event_type'], { timeout: 2_000 }).toBe('Lock');
      release(); const receipt = await claiming; await transferring;
      expect(receipt.result.totalKeep).toBe(f.expected.toString());
      expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
      expect((await getForgeClaimCommand(db, buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    } finally { release(); await claiming; await transferring; }
  });
  for (const stable of [false, true]) it(`legacy and versioned ${stable ? 'deed' : 'wallet'} claims race without duplicate payout or attribution to the losing command`, async () => {
    const f = await fixture(stable); const before = (await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance;
    const [legacy, versioned] = await Promise.all([claimForgeDays(db, f.wallet, undefined, now, f.baseId, f.context), f.submit()]);
    expect(BigInt(legacy.totalKeep) + BigInt(versioned.result.totalKeep)).toBe(f.expected);
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance).toBe(before + f.expected);
    for (const row of legacy.claimed) expect(Object.keys(row).sort()).toEqual(['day', 'keep']);
    expect(await f.submit()).toEqual(versioned);
  });
  it('historical proof is actor-only and survives deed transfer, deactivation and the Forge kill switch', async () => {
    const f = await fixture(true); const receipt = await f.submit(); const buyer = await createTestPlayer(db);
    await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId!));
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId!));
    process.env['FORGE_ENABLED'] = 'false';
    expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
    expect(await executeForgeClaimCommand(db, f.wallet, f.request)).toEqual(receipt);
    expect((await getForgeClaimCommand(db, buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('changed original consent and authority failures retain unknown outcomes without claiming another deed', async () => {
    const f = await fixture(true); await expect(executeForgeClaimCommand(db, f.wallet, f.request, now)).rejects.toMatchObject({ code: 'FORGE_CLAIM_CONTEXT_MISMATCH' });
    expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    await f.submit(); await expect(f.submit({ ...f.request, baseId: randomUUID() })).rejects.toMatchObject({ code: 'FORGE_CLAIM_MISMATCH' });
  });
  it('immutable storage rejects updates, deletes and truncation without erasing proof', async () => {
    const f = await fixture(); const receipt = await f.submit();
    for (const operation of [() => db.update(forgeClaimCommands).set({ day: null }), () => db.delete(forgeClaimCommands), () => db.execute(sql`TRUNCATE forge_claim_commands`)]) {
      await expect(operation()).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    expect((await getForgeClaimCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
  });
  it('HTTP v1 accepts explicit wallet scope without a current deed and replays only the same consent', async () => {
    const { wallet } = await createTestPlayer(db); await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, wallet));
    const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    const app = await buildApp({ ...TEST_CONFIG, MULTI_BASE_ENABLED: 'true' }, db);
    const request: ForgeClaimRequest = { idempotencyKey: randomUUID(), baseId: null, day: null };
    try {
      const first = await app.inject({ method: 'POST', url: '/forge/claims/v1', cookies, payload: request });
      expect(first.statusCode).toBe(201); const receipt = ForgeClaimReceiptSchema.parse(first.json());
      expect(receipt.actor).toBe(wallet); expect(receipt.baseId).toBeNull();
      expect(receipt.result).toEqual({ claimed: [], totalKeep: '0', remaining: 0 });
      const replay = await app.inject({ method: 'POST', url: '/forge/claims/v1', cookies, payload: request });
      expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(receipt);
      const changed = await app.inject({ method: 'POST', url: '/forge/claims/v1', cookies, payload: { ...request, day: '2020-01-01' } });
      expect(changed.statusCode).toBe(409); expect(changed.json().error.code).toBe('FORGE_CLAIM_MISMATCH');
      const invented = await app.inject({ method: 'POST', url: '/forge/claims/v1', cookies, payload: { ...request, amount: '1' } });
      expect(invented.statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('authenticated historical GET is private, mutation-free and available with Forge disabled', async () => {
    const f = await fixture(); const receipt = await f.submit();
    await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, f.wallet));
    process.env['FORGE_ENABLED'] = 'false'; const app = await buildApp(TEST_CONFIG, db);
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const jwt = await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id); const url = `/forge/claims/v1/${f.request.idempotencyKey}`;
    try {
      const unauthenticated = await app.inject({ method: 'GET', url });
      expect(unauthenticated.statusCode).toBe(401); expect(unauthenticated.headers['cache-control']).toBe('private, no-store');
      const malformed = await app.inject({ method: 'GET', url: '/forge/claims/v1/not-a-key', cookies: { [SESSION_COOKIE]: jwt } });
      expect(malformed.statusCode).toBe(400); expect(malformed.headers['cache-control']).toBe('private, no-store');
      const response = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: jwt } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
      const observed = ForgeClaimStatusSchema.parse(response.json()); expect(observed.enabled).toBe(false); expect(observed.receipt).toEqual(receipt);
      expect((await app.inject({ method: 'POST', url: '/forge/claims/v1', cookies: { [SESSION_COOKIE]: jwt }, payload: f.request })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
