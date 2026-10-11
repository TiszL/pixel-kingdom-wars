/** K-night-A7 (owner's Seeker on QA): saved land reservations had no receipt, so the land gate's "needs checking" cards
 * could never close. A client may forget a saved request only on a definitive server answer, so these tests pin that
 * `accepted` names only the row THIS key reserved, `absent` is answered only when no row can be the key's, and every
 * ambiguous case stays `unknown`. */
import { randomUUID } from 'node:crypto';
import { FANTASY_WORLD_ID, fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { deposits, fantasyLandClaims, sessions } from '../src/db/schema';
import { installFantasyCatalog } from '../src/game/fantasyLocation';
import { createDepositIntent } from '../src/money/deposits';
import { readLandReservationReceipt } from '../src/money/landReservationReceipt';
import { createTestPlayer, holdPlayerLock, settlesWithin, TEST_CONFIG } from './helpers';
import { isolatedFantasyTestDb } from './fantasy-test-db';

const conn = isolatedFantasyTestDb(); const db = conn.db;
const flags = ['FANTASY_WORLD_ENABLED', 'MULTI_BASE_ENABLED'] as const;
const original = Object.fromEntries(flags.map(k => [k, process.env[k]]));
beforeAll(async () => {
  await conn.prepare(); await db.transaction(installFantasyCatalog);
  process.env['FANTASY_WORLD_ENABLED'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'true';
}, 120000);
afterAll(async () => {
  for (const k of flags) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }
  await conn.dispose();
});

async function freeTile() {
  const used = new Set((await db.select().from(fantasyLandClaims)).map(claim => claim.tileId));
  return [...fantasyTiles()].find(tile => tile.allocation === 'ordinary' && !used.has(tile.tileId))!.tileId;
}
function reserve(wallet: string, idempotencyKey: string | undefined, tileId?: number) {
  return createDepositIntent(db, wallet, 'entry', { ...(idempotencyKey ? { idempotencyKey } : {}),
    landAddress: { kind: 'fantasy', worldId: FANTASY_WORLD_ID, ...(tileId === undefined ? {} : { tileId }) } });
}
const absent = (idempotencyKey: string) => ({ version: 1, status: 'absent', idempotencyKey, absentAsOf: expect.any(String) });
const unknown = (idempotencyKey: string) => ({ version: 1, status: 'unknown', idempotencyKey });

describe('land reservation receipts by idempotency key', () => {
  it('accepts only the row this key reserved; a replayed or wrong-shaped lookup never borrows it', async () => {
    const { wallet } = await createTestPlayer(db); const tileId = await freeTile(); const key = randomUUID();
    const intent = await reserve(wallet, key, tileId);
    if (!('baseId' in intent)) throw new Error('Expected a reservation');
    const accepted = { version: 1, status: 'accepted', idempotencyKey: key, kind: 'entry', depositId: intent.id, baseId: intent.baseId,
      reservedAt: expect.any(String), landAddress: { kind: 'fantasy', worldId: FANTASY_WORLD_ID, tileId } };
    expect(await readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: key })).toEqual(accepted);
    expect(await readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: key, tileId })).toEqual(accepted);
    // The key's row is another tile or another purchase kind: not this request, and not provably absent either.
    expect(await readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: key, tileId: tileId + 1 })).toEqual(unknown(key));
    expect(await readLandReservationReceipt(db, wallet, { kind: 'deed', idempotencyKey: key })).toEqual(unknown(key));
    // Another wallet never sees this wallet's key.
    const other = await createTestPlayer(db);
    expect(await readLandReservationReceipt(db, other.wallet, { kind: 'entry', idempotencyKey: key })).toEqual(absent(key));

    // A second key is answered with the SAME pending reservation: it reserved nothing, so it is absent, and the row
    // keeps recording the key that created it.
    const replayKey = randomUUID(); const replay = await reserve(wallet, replayKey);
    expect(replay.id).toBe(intent.id);
    expect(await readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: replayKey })).toEqual(absent(replayKey));
    const [row] = await db.select().from(deposits).where(eq(deposits.id, intent.id));
    expect((row!.payload as { idempotencyKey?: string }).idempotencyKey).toBe(key);
  });

  it('answers absent only when no row of that kind could be the key, and unknown beside a keyless reservation', async () => {
    const { wallet } = await createTestPlayer(db); const never = randomUUID();
    expect(await readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: never })).toEqual(absent(never));
    // A request without a key (or written before keys were recorded) leaves a row no key can be told apart from.
    await reserve(wallet, undefined, await freeTile());
    expect(await readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: never })).toEqual(unknown(never));
    // That row is an entry; a deed request cannot have created it.
    expect(await readLandReservationReceipt(db, wallet, { kind: 'deed', idempotencyKey: never })).toEqual(absent(never));
  });

  it('waits for a reservation in flight instead of answering absent past its uncommitted row', async () => {
    const { wallet } = await createTestPlayer(db); const key = randomUUID(); const id = randomUUID();
    const finish = await holdPlayerLock(db, wallet, tx => tx.insert(deposits).values({ id, playerWallet: wallet, kind: 'entry',
      reference: `held-${id}`, status: 'pending', payload: { landPurchaseVersion: 1, baseId: randomUUID(), idempotencyKey: key,
        landAddress: { kind: 'fantasy', worldId: FANTASY_WORLD_ID, tileId: 0 } } }), 'commit');
    const reading = readLandReservationReceipt(db, wallet, { kind: 'entry', idempotencyKey: key });
    let answeredEarly: boolean;
    try { answeredEarly = await settlesWithin(reading, 400); } finally { await finish(); }
    expect(answeredEarly).toBe(false);
    expect(await reading).toMatchObject({ status: 'accepted', depositId: id });
  });

  it('serves GET /deposits/land/receipt for the signed-in wallet with the exact absent contract and strict query', async () => {
    const { wallet } = await createTestPlayer(db);
    const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    const stable = process.env['MULTI_BASE_ENABLED']; process.env['MULTI_BASE_ENABLED'] = 'false';
    const app = await buildApp(TEST_CONFIG, db).finally(() => { process.env['MULTI_BASE_ENABLED'] = stable; });
    try {
      const key = randomUUID(); const tileId = await freeTile();
      const before = await app.inject({ url: `/deposits/land/receipt?kind=entry&idempotencyKey=${key}`, cookies });
      expect(before.statusCode, before.body).toBe(200); expect(before.headers['cache-control']).toBe('private, no-store');
      expect(Object.keys(before.json()).sort()).toEqual(['absentAsOf', 'idempotencyKey', 'status', 'version']);
      // The real POST records its body's key: the same request read back is accepted.
      const posted = await app.inject({ method: 'POST', url: '/deposits', cookies,
        payload: { kind: 'entry', idempotencyKey: key, landAddress: { kind: 'fantasy', worldId: FANTASY_WORLD_ID, tileId } } });
      expect(posted.statusCode, posted.body).toBe(200);
      const after = await app.inject({ url: `/deposits/land/receipt?kind=entry&idempotencyKey=${key}&tileId=${tileId}`, cookies });
      expect(after.json()).toMatchObject({ status: 'accepted', depositId: posted.json().id, landAddress: { tileId } });
      for (const query of [`kind=entry&idempotencyKey=${key}&tileId=01`, `kind=gems_buy&idempotencyKey=${key}`, 'kind=entry&idempotencyKey=short',
        `kind=entry&idempotencyKey=${key}&wallet=${wallet}`]) {
        expect((await app.inject({ url: `/deposits/land/receipt?${query}`, cookies })).statusCode, query).toBe(400);
      }
      expect((await app.inject({ url: `/deposits/land/receipt?kind=entry&idempotencyKey=${key}` })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
