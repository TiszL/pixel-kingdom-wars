import { randomUUID } from 'node:crypto';
import { FORGE } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, baseForgePositions, bases, baseSlots, buildings, ledgerTransactions, sessions } from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { contributeToForge } from '../src/game/forge';
import { ForgeContributionReceiptQuerySchema, getForgeContributionReceipt, type ForgeContributionReceiptRequest } from '../src/game/forgeContributionReceipt';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
afterAll(async () => { await conn.sql.end(); });
const shards = BigInt(FORGE.contributionCapByLevel[1]!) / 2n;
// Future fixture cycles cannot join another suite's lazy settlement sweep.
const acceptanceClock = new Date('2035-07-08T23:59:59.000Z');
async function fixture(stable = false) {
  const { wallet } = await createTestPlayer(db); let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: new Date() }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
    await rewardBaseShards(db, baseId, shards * 4n, 'test.forge.receipt', randomUUID());
  } else await rewardShards(db, wallet, shards * 4n, 'test.forge.receipt', randomUUID());
  await db.insert(buildings).values({ playerWallet: wallet, ...(baseId ? { baseId } : {}), type: 'goldforge', level: 1, tx: 20, ty: 20 });
  const request: ForgeContributionReceiptRequest = { idempotencyKey: randomUUID(), shards: shards.toString(), ...(baseId ? { baseId } : {}) };
  const context = baseId ? { baseId, assertActiveAuthority: async () => [{ id: baseId!, landPaidAt: new Date() }] } : undefined;
  return { wallet, baseId, request,
    submit: () => contributeToForge(db, wallet, shards, request.idempotencyKey, acceptanceClock, baseId, context),
    receipt: (input = request) => getForgeContributionReceipt(db, wallet, input),
  };
}

describe('Forge contribution acceptance receipt', () => {
  for (const stable of [false, true]) it(`returns original ${stable ? 'base' : 'wallet'} escrow amount and acceptance day, not cumulative stake`, async () => {
    const f = await fixture(stable); await f.submit(); const receipt = await f.receipt();
    expect(receipt).toEqual({ version: 1, status: 'accepted', wallet: f.wallet, baseId: f.baseId ?? null,
      request: f.request, receiptId: expect.any(String), acceptedAt: expect.any(String),
      funding: { currency: 'SHARDS', amount: shards.toString() },
      result: { day: '2035-07-08', contributedShards: shards.toString() } });
    if (f.baseId) {
      // A mutable net-stake observation must not replace the original debit.
      await db.update(baseForgePositions).set({ raidDebitedShards: shards })
        .where(eq(baseForgePositions.baseId, f.baseId));
      const buyer = await createTestPlayer(db);
      await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
      await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
      expect((await getForgeContributionReceipt(db, buyer.wallet, f.request)).status).toBe('unknown');
      expect(await f.receipt({ ...f.request, baseId: f.baseId.toUpperCase() })).toEqual(receipt);
    }
    expect(await f.receipt()).toEqual(receipt);
    expect(receipt).not.toHaveProperty('myShards'); expect(receipt).not.toHaveProperty('keepPaid');
  });
  it('requires exact actor, key, target and contributed amount without claiming quoted-day consent', async () => {
    const f = await fixture(true); await f.submit(); const other = await createTestPlayer(db);
    for (const input of [{ ...f.request, idempotencyKey: randomUUID() }, { ...f.request, shards: (shards + 1n).toString() },
      { idempotencyKey: f.request.idempotencyKey, shards: f.request.shards }, { ...f.request, baseId: randomUUID() }]) {
      expect((await f.receipt(input)).status).toBe('unknown');
    }
    expect((await getForgeContributionReceipt(db, other.wallet, f.request)).status).toBe('unknown');
    for (const input of [{ ...f.request, day: '2035-07-08' }, { ...f.request, wallet: f.wallet },
      { ...f.request, shards: '1e2' }, { ...f.request, shards: '00' }, { ...f.request, shards: '9'.repeat(33) }]) {
      expect(ForgeContributionReceiptQuerySchema.safeParse(input).success).toBe(false);
    }
  });
  for (const stable of [false, true]) it(`rejects incomplete or substituted ${stable ? 'base' : 'wallet'} funding evidence`, async () => {
    const sys = await bootstrapSystemAccounts(db);
    for (const corruption of ['type', 'actor', 'base', 'day', 'payer', 'escrow', 'amount', 'missing-entries', 'extra-entries']) {
      const f = await fixture(stable); const other = await fixture(stable);
      const source = f.baseId ? await getOrCreateBaseAccount(db, corruption === 'payer' ? other.baseId! : f.baseId, 'base_shards')
        : await getOrCreatePlayerAccount(db, corruption === 'payer' ? other.wallet : f.wallet, 'player_shards');
      const escrow = f.baseId ? (await getOrCreateBaseAccount(db, corruption === 'escrow' ? other.baseId! : f.baseId, 'base_forge_escrow')).id
        : corruption === 'escrow' ? sys.shard_genesis : sys.forge_escrow;
      const key = f.baseId ? `contrib:base:${f.baseId}:${f.request.idempotencyKey}` : `contrib:${f.wallet}:${f.request.idempotencyKey}`;
      const txn = { idempotencyKey: key, type: corruption === 'type' ? 'test.wrong' : 'forge.contribute',
        metadata: { wallet: corruption === 'actor' ? other.wallet : f.wallet,
          day: corruption === 'day' ? 'invalid' : '2035-07-08',
          ...(f.baseId ? { baseId: f.baseId } : {}), ...(corruption === 'base' ? { baseId: randomUUID() } : {}) } };
      if (corruption === 'missing-entries') await db.insert(ledgerTransactions).values(txn);
      else {
        const amount = corruption === 'amount' ? shards + 1n : shards;
        const extra = await getOrCreatePlayerAccount(db, other.wallet, 'player_shards');
        await postTransaction(db, { ...txn, entries: [{ account: source.id, delta: -amount },
          { account: escrow, delta: amount - (corruption === 'extra-entries' ? 1n : 0n) },
          ...(corruption === 'extra-entries' ? [{ account: extra.id, delta: 1n }] : []),
        ] });
      }
      expect((await f.receipt()).status, corruption).toBe('unknown');
    }
  });
  for (const rollback of [false, true]) it(`waits for the contribution to ${rollback ? 'roll back' : 'commit'} before reading evidence`, async () => {
    const f = await fixture();
    let entered!: () => void; let release!: () => void; let readerEntered!: () => void; let readerPid = 0;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const readingStarted = new Promise<void>((resolve) => { readerEntered = resolve; });
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction')
      .mockImplementationOnce((work, config) => transaction(async (tx) => {
        const result = await work(tx); entered(); await finish; if (rollback) throw new Error('test rollback'); return result;
      }, config))
      .mockImplementationOnce((work, config) => transaction(async (tx) => {
        const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        readerPid = Number(result[0]!['pid']); readerEntered(); return work(tx);
      }, config));
    const writing = f.submit().then(() => null, (error: unknown) => error);
    try {
      await inside; const reading = f.receipt(); await readingStarted;
      await expect.poll(async () => {
        const rows = await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${readerPid}`;
        return rows[0]?.['wait_event_type'];
      }, { timeout: 2_000 }).toBe('Lock');
      release(); expect((await writing) === null).toBe(!rollback);
      expect((await reading).status).toBe(rollback ? 'unknown' : 'accepted');
    } finally { release(); await writing; spy.mockRestore(); }
  });
});

it('keeps the auth-only proof available while Forge is off, with private success and failure responses', async () => {
  const previous = process.env['FORGE_ENABLED']; process.env['FORGE_ENABLED'] = 'false';
  const f = await fixture(); await f.submit(); const other = await createTestPlayer(db);
  const cookiesFor = async (wallet: string) => {
    const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  };
  const cookies = await cookiesFor(f.wallet); const otherCookies = await cookiesFor(other.wallet);
  const app = await buildApp(TEST_CONFIG, db);
  const url = `/forge/contribute/receipt?${new URLSearchParams({ idempotencyKey: f.request.idempotencyKey, shards: f.request.shards })}`;
  try {
    expect((await app.inject({ url: '/balances', cookies })).json().features)
      .toMatchObject({ conversionReceipts: { version: 1 }, forgeContributionReceipts: { version: 1 } });
    const before = await db.select().from(accounts);
    for (const [options, status, receiptStatus] of [
      [{ url, cookies }, 200, 'accepted'], [{ url }, 401, undefined], [{ url, cookies: otherCookies }, 200, 'unknown'],
      [{ url: `${url}&day=2035-07-08`, cookies }, 400, undefined],
      [{ url: `${url}&wallet=${f.wallet}`, cookies }, 400, undefined],
      [{ url, cookies: { ...cookies, [LOGIN_COOKIE]: 'pending' } }, 403, undefined],
    ] as const) {
      const response = await app.inject(options);
      expect(response.statusCode).toBe(status); expect(response.headers['cache-control']).toBe('private, no-store');
      if (receiptStatus) expect(response.json().status).toBe(receiptStatus);
    }
    expect(await db.select().from(accounts)).toEqual(before);
  } finally {
    if (previous === undefined) delete process.env['FORGE_ENABLED']; else process.env['FORGE_ENABLED'] = previous;
    await app.close();
  }
});
