/** Real Postgres (disposable database). K-night-03: the owned grant reads behind GET /devnet-skr-faucet/grants and
 * /grants/:grantId. The phone proves "no lost claim remains" from these pages, so the SQL must return exactly the
 * wallet's requested grants in (requested_at, id) descending order, page by an owned cursor and never write. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import { bases, players, devnetSkrFaucetGrants as grants, devnetSkrFaucetAttempts as attempts } from '../src/db/schema';
import { makeSkrFaucetStore } from '../src/devnet-only/skrFaucetStore';
import { makeSkrFaucetService } from '../src/devnet-only/skrFaucet';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { mint, policy, referenceMessage, testRpc } from './skr-faucet-fixtures';
import { nativeDiscoveryScan, nativeGrant } from './skr-faucet-native-decoder';

const conn = isolatedFantasyTestDb(), now = new Date('2026-10-06T12:00:00Z'), size = SKR_FAUCET.devnet.grantReadPageSize;
beforeAll(async () => { await conn.prepare(); }, 120_000);
afterAll(async () => { await conn.dispose(); });
async function player() {
  const wallet = Keypair.generate().publicKey.toBase58();
  await conn.db.insert(players).values({ wallet });
  const [base] = await conn.db.insert(bases).values({ ownerWallet: wallet, landPaidAt: now }).returning();
  if (!base) throw new Error('missing fixture base'); return { wallet, baseId: base.id };
}
// The 0299 guard trigger admits only requested grants / prepared attempts; terminal rows take its legal transitions.
async function grant(owner: { wallet: string; baseId: string }, daysAgo: number, failed = false) {
  const requestedAt = new Date(now.getTime() - daysAgo * 86_400_000);
  const [row] = await conn.db.insert(grants).values({ wallet: owner.wallet, baseId: owner.baseId, deedAssetId: `deed-${randomUUID()}`,
    day: requestedAt.toISOString().slice(0, 10), requestedAt, mint, decimals: 6, amountRaw: '1000000000' }).returning();
  if (!row) throw new Error('missing fixture grant');
  if (!failed) return row;
  await conn.db.update(grants).set({ status: 'failed', error: 'day_changed' }).where(eq(grants.id, row.id));
  return { ...row, status: 'failed' as const, error: 'day_changed' };
}
async function attempt(row: typeof grants.$inferSelect, attemptNo: number, abandoned = false) {
  const reference = Keypair.generate().publicKey.toBase58();
  const [inserted] = await conn.db.insert(attempts).values({ grantId: row.id, attemptNo, reference, message: referenceMessage(row, reference).message,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200n, createdAt: now }).returning();
  if (!inserted) throw new Error('missing fixture attempt');
  if (abandoned) await conn.db.update(attempts).set({ phase: 'abandoned', settledAt: now }).where(eq(attempts.id, inserted.id));
  return inserted;
}

describe.sequential('SKR faucet owned grant reads on Postgres', () => {
  it('pages the wallet\'s requested grants newest first by an owned cursor, with latest attempts, and writes nothing', async () => {
    const me = await player(), them = await player();
    const requested = [];
    for (let n = 0; n < size + 2; n++) requested.push(await grant(me, n + 1));
    const settled = await grant(me, size + 5, true);
    await grant(them, 1); await grant(them, 2);
    await attempt(requested[0]!, 1, true); const latest = await attempt(requested[0]!, 2);
    const mine = () => conn.db.select().from(grants).where(eq(grants.wallet, me.wallet)).orderBy(grants.id);
    const before = await mine();
    const service = makeSkrFaucetService(policy, makeSkrFaucetStore(conn.db), testRpc().rpc, { now: () => now,
      eligibility: async () => ({ reason: 'ok', deed: null }), refreshDeed: async () => 'unused' });

    const page1 = await service.listGrants(me.wallet);
    expect(page1.items).toHaveLength(size); expect(page1.nextCursor).toBe(page1.items[size - 1]!.id);
    const page2 = await service.listGrants(me.wallet, page1.nextCursor!);
    expect(page2.items).toHaveLength(2); expect(page2.nextCursor).toBeNull();
    // JSON round trip = what the route sends; the phone's checks accept the complete sequence.
    const scan = nativeDiscoveryScan(JSON.parse(JSON.stringify([page1, page2])), size, { mint, decimals: 6 }, SKR_FAUCET.devnet.grantSkr);
    expect(scan.flatMap((page) => page.items.map((item) => item.id))).toEqual(requested.map((row) => row.id));
    expect(page1.items[0]!.attempt).toMatchObject({ id: latest.id, phase: 'prepared' });

    await expect(service.listGrants(me.wallet, randomUUID())).rejects.toMatchObject({ statusCode: 404, code: 'SKR_FAUCET_NOT_OWNED' });
    const theirs = await conn.db.select().from(grants).where(eq(grants.wallet, them.wallet));
    await expect(service.listGrants(me.wallet, theirs[0]!.id)).rejects.toMatchObject({ statusCode: 404, code: 'SKR_FAUCET_NOT_OWNED' });
    expect(await mine()).toEqual(before); // the reads above wrote nothing
    // A cursor grant that settled meanwhile still marks its position: only older requested grants follow it.
    await conn.db.update(grants).set({ status: 'failed', error: 'day_changed' }).where(eq(grants.id, requested[size - 1]!.id));
    const settledMeanwhile = await mine();
    expect((await service.listGrants(me.wallet, requested[size - 1]!.id)).items.map((item) => item.id))
      .toEqual([requested[size]!.id, requested[size + 1]!.id]);
    expect((await service.listGrants(me.wallet, settled.id)).items).toEqual([]);

    const read = nativeGrant(JSON.parse(JSON.stringify((await service.readGrant(me.wallet, requested[0]!.id)).grant)));
    expect(read.attempt?.id).toBe(latest.id);
    expect(nativeGrant(JSON.parse(JSON.stringify((await service.readGrant(me.wallet, settled.id)).grant))).status.raw).toBe('failed');
    await expect(service.readGrant(me.wallet, theirs[0]!.id)).rejects.toMatchObject({ statusCode: 404, code: 'SKR_FAUCET_NOT_OWNED' });
    // Reads never expire a prior-day grant or touch any row: that stays the worker's job under its grant lock.
    expect(await mine()).toEqual(settledMeanwhile);
  });
});
