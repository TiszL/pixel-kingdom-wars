/** 2026-09-18 production incident, reproduced at the HTTP boundary with the
 * PRODUCTION foreground reader (only the chain transport is mocked).
 *
 * Two players who legitimately owned their deeds were answered
 * `503 DEED_AUTHORITY_UNAVAILABLE` in steady state — `POST /raids` at 11:13:07Z
 * and `GET /base` at 11:17:14Z, 2 of ~1,900 requests — while their observation
 * rows read `owned` before and after. The native client was trapped by it and
 * the web showed a failed load. The public devnet RPC occasionally errors or
 * rate-limits ONE request; that must not refuse an owner, and it must never be
 * confused with the chain ANSWERING that somebody else owns the deed. */
import { Keypair } from '@solana/web3.js';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_OWNERSHIP } from '@shardkeep/shared';

const h = vi.hoisted(() => ({ readBatch: vi.fn() }));

vi.mock('@shardkeep/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shardkeep/chain')>()),
  getFinalizedCoreAssetOwnerBatch: h.readBatch,
}));

const { buildApp } = await import('../src/app');
const { SESSION_COOKIE } = await import('../src/auth/session');
const {
  bases, baseSlots, baseTransfers, buildings, deedOwnershipObservations,
} = await import('../src/db/schema');
const { connectTestDb, TEST_CONFIG } = await import('./helpers');
const { isolateDeedTestFixtures } = await import('./deed-fixtures');

type Request = { assets: readonly { assetId: string }[] };
const COLLECTION = 'incident-collection';
const answered = (req: Request, owner: string, slot: number) => ({
  owners: new Map(req.assets.map(({ assetId }) => [assetId, {
    owner, frozen: false, delegate: null, collection: COLLECTION, slot,
  }])),
  contextSlot: slot, transportSucceeded: true,
});
const unanswered = (req: Request) => ({
  owners: new Map(req.assets.map(({ assetId }) => [assetId, null])),
  contextSlot: null, transportSucceeded: false,
});

let ctx: ReturnType<typeof connectTestDb>;
let app: Awaited<ReturnType<typeof buildApp>>;
let restoreDeedFixtures = async () => {};
const priorEnv = {
  multi: process.env['MULTI_BASE_ENABLED'], free: process.env['FREE_ONBOARDING'],
};

beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  process.env['FREE_ONBOARDING'] = 'true';
  ctx = connectTestDb();
  // Boot readiness must depend on this suite's deeds only (shared test DB).
  restoreDeedFixtures = await isolateDeedTestFixtures(ctx.db, { observerQueue: true });
  // No injected finalizedDeedReader: the routes build the production reader
  // (FIFO pacing, coalescing, bounded transport retry) over the mocked chain.
  app = await buildApp(TEST_CONFIG, ctx.db, {
    market: { rpcUrl: 'http://rpc.invalid', deedCollection: COLLECTION },
  });
  await app.ready();
});

afterAll(async () => {
  try {
    await app?.close();
    await restoreDeedFixtures();
  } finally {
    await ctx.sql.end();
    for (const [key, value] of [['MULTI_BASE_ENABLED', priorEnv.multi], ['FREE_ONBOARDING', priorEnv.free]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

beforeEach(() => { h.readBatch.mockReset(); });

/** A signed-in landowner whose deed has NO usable cached proof, i.e. the state
 * a request is in for most of every observer cycle: it needs a foreground read. */
async function landowner() {
  const secret = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secret));
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const message = (challenge.json() as { message: string }).message;
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secret));
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  const cookie = verified.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const deed = Keypair.generate().publicKey.toBase58();
  const [base] = await ctx.db.insert(bases).values({
    ownerWallet: wallet, deedAssetId: deed, landPaidAt: new Date(),
  }).returning();
  await ctx.db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
  const [wall] = await ctx.db.insert(buildings).values({
    playerWallet: wallet, baseId: base!.id, type: 'wall', tx: 9, ty: 9,
  }).returning();
  const cookies = { [SESSION_COOKIE]: cookie };
  return {
    wallet, deed, baseId: base!.id, wallId: wall!.id,
    getBase: () => app.inject({ method: 'GET', url: '/base', query: { baseId: base!.id }, cookies }),
    getArmy: () => app.inject({ method: 'GET', url: '/army', query: { baseId: base!.id }, cookies }),
    moveWall: (tx: number) => app.inject({
      method: 'PATCH', url: `/base/buildings/${wall!.id}/move`, cookies,
      payload: { baseId: base!.id, tx, ty: 9 },
    }),
  };
}
const baseRow = async (baseId: string) => (await ctx.db.select().from(bases).where(eq(bases.id, baseId)))[0]!;
const proof = async (baseId: string) => (await ctx.db.select().from(deedOwnershipObservations)
  .where(eq(deedOwnershipObservations.baseId, baseId)))[0];

describe('deed authority under a flaky public RPC (2026-09-18 incident)', () => {
  it('GET /base survives one failed RPC read: the owner gets the base, not a 503', async () => {
    const p = await landowner();
    h.readBatch.mockImplementationOnce(async (req: Request) => unanswered(req));
    h.readBatch.mockImplementation(async (req: Request) => answered(req, p.wallet, 500));

    const res = await p.getBase();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ baseId: p.baseId });
    // Exactly the failed read and its single retry; the locked re-checks inside
    // the request then run on the FINALIZED proof that retry produced.
    expect(h.readBatch).toHaveBeenCalledTimes(2);
    expect(await proof(p.baseId)).toMatchObject({ status: 'owned', owner: p.wallet, slot: 500n });
  });

  it('serves an owner from a still-valid proof while its early renewal is stuck on a slow, failing RPC', async () => {
    // Security review 2026-09-18 of the first incident fix: the gate AWAITED the
    // early renewal of an 8 s proof; the read failed after 2.5 s; the gate then
    // measured the proof at 10.5 s and answered 503 — a request origin/main
    // served from the cached proof without reading at all. A read may outlive
    // the proof it renews, so the request must never be held for it.
    const p = await landowner();
    // Inside the early-renewal window, with 2.5 s of life left for this test.
    const checkedAt = new Date(
      Date.now() - (BASE_OWNERSHIP.mutationFreshnessMs - BASE_OWNERSHIP.gateRefreshAheadMs + 500),
    );
    await ctx.db.insert(deedOwnershipObservations).values({
      baseId: p.baseId, assetId: p.deed, owner: p.wallet, slot: 400n,
      checkedAt, source: 'sweep', status: 'owned', auditHash: `incident-${p.baseId}`,
    });
    let rpcGivesUp!: () => void;
    const rpcStuck = new Promise<void>((resolve) => { rpcGivesUp = resolve; });
    h.readBatch.mockImplementation(async (req: Request) => { await rpcStuck; return unanswered(req); });
    // The reviewer's timing, as a backstop: the RPC fails on its own just after
    // the proof's 2.5 s of remaining life, so a gate that waits for it answers
    // 503 here instead of hanging the suite.
    const rpcTimesOut = setTimeout(rpcGivesUp, 3_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // GET /base re-checks the proof twice under row locks; GET /army has no
      // locked re-check at all. Both answer while the RPC is still stuck.
      const [baseRes, armyRes] = await Promise.all([p.getBase(), p.getArmy()]);
      expect([baseRes.statusCode, armyRes.statusCode]).toEqual([200, 200]);
      await vi.waitFor(() => expect(h.readBatch).toHaveBeenCalled());
      rpcGivesUp();
      // The abandoned renewal is still attributable, and it changed nothing.
      // (Other subsystems warn in plain text during a first GET /base.)
      const deedWarnings = () => warn.mock.calls.flatMap(([line]) => {
        try { return [JSON.parse(String(line)) as unknown]; } catch { return []; }
      });
      await vi.waitFor(() => expect(deedWarnings()).toContainEqual({
        level: 40, event: 'deed_ownership_refresh_unavailable',
        baseId: p.baseId, source: 'gate-renewal', reason: 'rpc-error', preservedProof: true,
      }));
    } finally {
      clearTimeout(rpcTimesOut);
      rpcGivesUp();
      warn.mockRestore();
    }
    expect(await proof(p.baseId)).toMatchObject({ status: 'owned', owner: p.wallet, slot: 400n, checkedAt });
    expect(await baseRow(p.baseId)).toMatchObject({ ownerWallet: p.wallet, status: 'active' });
  });

  it('a MUTATION still fails closed when the chain cannot be read, and nobody is evicted', async () => {
    const p = await landowner();
    h.readBatch.mockImplementation(async (req: Request) => unanswered(req));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await p.moveWall(10);
    const lines = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'DEED_AUTHORITY_UNAVAILABLE' } });
    // The incident could not be attributed because the reason was swallowed.
    // The refusal now says WHY, per base, without naming the wallet.
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        level: 40, event: 'deed_ownership_refresh_unavailable',
        baseId: p.baseId, source: 'mutation', reason: 'rpc-error', preservedProof: false,
      },
      {
        level: 40, event: 'deed_authority_refused',
        gate: 'refresh', baseId: p.baseId, refresh: 'unavailable', priorStatus: 'none', priorAgeMs: null,
      },
    ]);
    expect(lines.join('\n')).not.toContain(p.wallet);
    // Bounded: one read + the configured retries, never a loop against a sick RPC.
    expect(h.readBatch).toHaveBeenCalledTimes(1 + BASE_OWNERSHIP.foregroundReadTransportRetries);
    expect((await ctx.db.select().from(buildings).where(eq(buildings.id, p.wallId)))[0]?.tx).toBe(9);
    // `unavailable` is never evidence of a sale.
    expect(await baseRow(p.baseId)).toMatchObject({ ownerWallet: p.wallet, status: 'active' });
    expect(await ctx.db.select().from(baseSlots).where(eq(baseSlots.baseId, p.baseId))).toHaveLength(1);
    expect(await ctx.db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, p.deed))).toHaveLength(0);

    // The owner is not locked out once the RPC answers again.
    h.readBatch.mockImplementation(async (req: Request) => answered(req, p.wallet, 501));
    expect((await p.moveWall(10)).statusCode).toBe(200);
  });

  it('a finalized answer naming another owner is read ONCE, refuses, and transfers the base', async () => {
    const p = await landowner();
    const buyer = Keypair.generate().publicKey.toBase58();
    // If an answer were retried, this second response would launder the sale
    // back into `owned` for the seller (e.g. a lagging node behind the pool).
    h.readBatch.mockImplementationOnce(async (req: Request) => answered(req, buyer, 600));
    h.readBatch.mockImplementation(async (req: Request) => answered(req, p.wallet, 601));

    const res = await p.moveWall(10);
    expect(res.statusCode).toBe(503);
    expect(h.readBatch).toHaveBeenCalledTimes(1);
    expect((await ctx.db.select().from(buildings).where(eq(buildings.id, p.wallId)))[0]?.tx).toBe(9);
    expect(await baseRow(p.baseId)).toMatchObject({ ownerWallet: buyer, status: 'inactive' });
    expect(await ctx.db.select().from(baseSlots).where(eq(baseSlots.baseId, p.baseId))).toHaveLength(0);
    expect(await ctx.db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, p.deed)))
      .toEqual([expect.objectContaining({ fromWallet: p.wallet, toWallet: buyer })]);
    expect(await proof(p.baseId)).toMatchObject({ status: 'mismatch', owner: buyer, slot: 600n });
    // The seller's next read is a plain "not yours", not an ambiguous 503.
    expect((await p.getBase()).statusCode).toBe(404);
  });
});
