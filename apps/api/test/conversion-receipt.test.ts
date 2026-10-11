import { randomUUID } from 'node:crypto';
import { ECONOMY } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, ledgerTransactions, sessions } from '../src/db/schema';
import { ConversionReceiptQuerySchema, getConversionReceipt, type ConversionReceiptRequest } from '../src/game/conversionReceipt';
import { convertKeepToShards } from '../src/game/forge';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
afterAll(async () => { await conn.sql.end(); });
const keep = 5n;
async function fixture(stable = false) {
  const { wallet } = await createTestPlayer(db);
  await fundTestKeep(db, wallet, keep * 4n, 'test.conversion.receipt', randomUUID());
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: new Date() }).returning();
    baseId = base!.id;
    await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  }
  const request: ConversionReceiptRequest = { idempotencyKey: randomUUID(), keep: keep.toString(), ...(baseId ? { baseId } : {}) };
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  return { wallet, request, baseId,
    submit: () => convertKeepToShards(db, wallet, keep, request.idempotencyKey, baseId, context),
    receipt: (input = request) => getConversionReceipt(db, wallet, input),
  };
}

describe('exact conversion receipt', () => {
  for (const stable of [false, true]) it(`proves both transfers into the original ${stable ? 'base' : 'wallet'} SHARDS account`, async () => {
    const f = await fixture(stable); const result = await f.submit(); const before = await f.receipt();
    expect(before).toEqual({ version: 1, status: 'accepted', wallet: f.wallet, baseId: f.baseId ?? null,
      request: f.request, receiptId: expect.any(String), acceptedAt: expect.any(String),
      funding: { currency: 'KEEP', amount: keep.toString() }, result });
    await fundTestKeep(db, f.wallet, keep, 'test.conversion.later', randomUUID());
    if (f.baseId) {
      const buyer = await createTestPlayer(db);
      await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
      await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
      expect((await getConversionReceipt(db, buyer.wallet, f.request)).status).toBe('unknown');
      expect(await f.receipt({ ...f.request, baseId: f.baseId.toUpperCase() })).toEqual(before);
    }
    expect(await f.receipt()).toEqual(before);
  });
  it('binds exact actor, key, original target and KEEP amount', async () => {
    const f = await fixture(true); await f.submit();
    for (const input of [{ ...f.request, idempotencyKey: randomUUID() }, { ...f.request, keep: (keep + 1n).toString() },
      { idempotencyKey: f.request.idempotencyKey, keep: f.request.keep }, { ...f.request, baseId: randomUUID() }]) {
      expect((await f.receipt(input)).status).toBe('unknown');
    }
    const other = await createTestPlayer(db);
    expect((await getConversionReceipt(db, other.wallet, f.request)).status).toBe('unknown');
  });
  it('requires both exact balanced currency legs and consistent immutable metadata, never current rates', async () => {
    const sys = await bootstrapSystemAccounts(db);
    for (const corruption of ['none', 'missing-half', 'missing-entries', 'type', 'metadata', 'rate', 'payer', 'recycling', 'genesis', 'target', 'extra-entries']) {
      const f = await fixture(); const other = await createTestPlayer(db);
      await fundTestKeep(db, other.wallet, keep, 'test.conversion.other', randomUUID());
      const payer = await getOrCreatePlayerAccount(db, corruption === 'payer' ? other.wallet : f.wallet, 'player_keep');
      const target = await getOrCreatePlayerAccount(db, corruption === 'target' ? other.wallet : f.wallet, 'player_shards');
      // Historical rate deliberately differs from today's constant. Its own
      // two ledger legs and original metadata, not current config, are proof.
      const rate = ECONOMY.shardsPerKeep + 1; const shards = keep * BigInt(rate);
      const metadata = { wallet: f.wallet, keep: keep.toString(), shards: shards.toString(), rate };
      const prefix = `convert:${f.wallet}:${f.request.idempotencyKey}`;
      await postTransaction(db, { idempotencyKey: `${prefix}:keep`, type: 'forge.convert', metadata,
        entries: [{ account: payer.id, delta: -keep }, { account: corruption === 'recycling' ? sys.keep_genesis : sys.emission_pool, delta: keep }] });
      if (corruption !== 'missing-half') {
        const txn = { idempotencyKey: `${prefix}:shards`, type: corruption === 'type' ? 'test.wrong' : 'forge.convert',
          metadata: { ...metadata, ...(corruption === 'metadata' ? { wallet: other.wallet } : {}), ...(corruption === 'rate' ? { rate: rate + 1 } : {}) } };
        if (corruption === 'missing-entries') await db.insert(ledgerTransactions).values(txn);
        else {
          if (corruption === 'genesis') await postTransaction(db, {
            type: 'test.conversion.burn.seed', idempotencyKey: randomUUID(),
            entries: [{ account: sys.shard_genesis, delta: -shards }, { account: sys.shard_burn, delta: shards }],
          });
          const extra = await getOrCreatePlayerAccount(db, other.wallet, 'player_shards');
          await postTransaction(db, { ...txn, entries: [
            { account: corruption === 'genesis' ? sys.shard_burn : sys.shard_genesis, delta: -shards },
            { account: target.id, delta: shards - (corruption === 'extra-entries' ? 1n : 0n) },
            ...(corruption === 'extra-entries' ? [{ account: extra.id, delta: 1n }] : []),
          ] });
        }
      }
      const receipt = await f.receipt();
      expect(receipt.status, corruption).toBe(corruption === 'none' ? 'accepted' : 'unknown');
      if (receipt.status === 'accepted') expect(receipt.result).toEqual({ converted: keep.toString(), shards: shards.toString(), rate });
    }
  });
  for (const rollback of [false, true]) it(`waits behind the writer lock and observes its ${rollback ? 'rollback' : 'commit'}`, async () => {
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
      // This assertion fails if the read no longer takes the writer's lock;
      // merely starting a promise before commit would not prove serialization.
      await expect.poll(async () => {
        const rows = await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${readerPid}`;
        return rows[0]?.['wait_event_type'];
      }, { timeout: 2_000 }).toBe('Lock');
      release(); expect((await writing) === null).toBe(!rollback);
      expect((await reading).status).toBe(rollback ? 'unknown' : 'accepted');
    } finally { release(); await writing; spy.mockRestore(); }
  });
  it('rejects malformed amounts or extra consent fields instead of guessing', () => {
    const valid = { idempotencyKey: randomUUID(), keep: '10' };
    for (const input of [{ ...valid, keep: '1e1' }, { ...valid, keep: '010' }, { ...valid, keep: '0' },
      { ...valid, keep: '9'.repeat(33) }, { ...valid, wallet: 'other' }, { ...valid, rate: 1 },
      { ...valid, baseId: 'invalid' }]) expect(ConversionReceiptQuerySchema.safeParse(input).success).toBe(false);
  });
});

it('negotiates support and keeps private receipt access independent of current land and Forge availability', async () => {
  const originalForge = process.env['FORGE_ENABLED']; const originalMode = process.env['MULTI_BASE_ENABLED'];
  process.env['FORGE_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
  const f = await fixture(); await f.submit();
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const app = await buildApp(TEST_CONFIG, db);
  const url = `/forge/convert/receipt?${new URLSearchParams({ idempotencyKey: f.request.idempotencyKey, keep: f.request.keep })}`;
  const before = await db.select().from(accounts);
  try {
    expect((await app.inject({ url: '/balances', cookies })).json().features).toMatchObject({ conversionReceipts: { version: 1 } });
    for (const [options, status, receiptStatus] of [
      [{ url, cookies }, 200, 'accepted'], [{ url }, 401, undefined],
      [{ url: `${url}&wallet=${f.wallet}`, cookies }, 400, undefined],
      [{ url: url.replace(`keep=${keep}`, 'keep=1e1'), cookies }, 400, undefined],
      [{ url, cookies: { ...cookies, [LOGIN_COOKIE]: 'pending' } }, 403, undefined],
      [{ url: url.replace(f.request.idempotencyKey, randomUUID()), cookies }, 200, 'unknown'],
    ] as const) {
      const response = await app.inject(options);
      expect(response.statusCode).toBe(status); expect(response.headers['cache-control']).toBe('private, no-store');
      if (receiptStatus) expect(response.json().status).toBe(receiptStatus);
    }
    expect(await db.select().from(accounts)).toEqual(before);
    await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, session!.id), eq(sessions.wallet, f.wallet)));
    const revoked = await app.inject({ url, cookies }); expect(revoked.statusCode).toBe(401); expect(revoked.headers['cache-control']).toBe('private, no-store');
  } finally {
    if (originalForge === undefined) delete process.env['FORGE_ENABLED']; else process.env['FORGE_ENABLED'] = originalForge;
    if (originalMode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMode;
    await app.close();
  }
});
