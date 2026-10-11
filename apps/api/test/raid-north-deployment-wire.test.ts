/**
 * North-edge deployment must survive the actual HTTP schema and command journal.
 * A service-only fixture misses a route rejecting legal negative tile rows; an
 * out-of-bounds request must not consume a troop or poison the next deployment.
 */
import { randomUUID } from 'node:crypto';
import { battlefieldBounds } from '@shardkeep/shared/battlefield';
import { SIM_VERSION } from '@shardkeep/sim';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { raidCommands, raidLiveStates, raids, sessions } from '../src/db/schema';
import {
  acceptLiveRaidCommand, initializeBatchRaidJournal, initializeLiveRaid, type AcceptedLiveRaidCommand,
} from '../src/game/liveRaids';
import { SIM_VERSION_HEADER } from '../src/version';
import { TEST_CONFIG, connectTestDb, createTestPlayer, insertActiveTestBase } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let origin: string;
type WireCommand = Omit<AcceptedLiveRaidCommand, 'acceptedAt'> & { acceptedAt: string };
type WireReply = { command?: WireCommand; error?: { message: string } };

beforeAll(async () => {
  vi.stubEnv('FREE_ONBOARDING', 'true');
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  app = await buildApp(TEST_CONFIG, db);
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app?.close();
  await conn.sql.end();
  vi.unstubAllEnvs();
});

describe.each(['live', 'batch journal'] as const)('north deployment HTTP: %s', (mode) => {
  it.each(([undefined, 2, 3] as const).flatMap((battlefieldVersion) =>
    (['deploy', 'hero'] as const).map((kind) => ({ battlefieldVersion, kind }))))('accepts the north boundary and preserves reservations on rejection ($kind, field $battlefieldVersion)', async ({ battlefieldVersion, kind }) => {
    const attacker = await createTestPlayer(db);
    const defender = await createTestPlayer(db);
    const attackerBase = await insertActiveTestBase(db, { ownerWallet: attacker.wallet, status: 'active', keepLevel: 5 });
    const defenderBase = await insertActiveTestBase(db, { ownerWallet: defender.wallet, status: 'active', keepLevel: 5 });
    const now = new Date();
    const [raid] = await db.insert(raids).values({
      idempotencyKey: `north-wire-${randomUUID()}`,
      attackerWallet: attacker.wallet,
      attackerBaseId: attackerBase!.id,
      defenderWallet: defender.wallet,
      defenderBaseId: defenderBase!.id,
      seed: 7n,
      snapshot: { keepLevel: 5, buildings: [], surplusShards: 0, claimMin: 8, claimMax: 22,
        ...(battlefieldVersion ? { battlefieldVersion,
          deploymentBlockers: [{ tx: 18, ty: 18, fw: 1, fh: 1 },
            { tx: 9, ty: 9, fw: 3, fh: 1 }, { tx: 9, ty: 11, fw: 3, fh: 1 },
            { tx: 9, ty: 10, fw: 1, fh: 1 }, { tx: 11, ty: 10, fw: 1, fh: 1 }] } : {}),
      },
      armySnapshot: { counts: { highlander: 2 }, levels: { highlander: 1 }, heroes: ['vex', 'theodor'] },
      simVersion: SIM_VERSION,
      ordersDeadlineAt: new Date(now.getTime() + 120_000),
      createdAt: now,
    }).returning();
    if (mode === 'live') {
      await initializeLiveRaid(db, raid!.id, defenderBase!.id, raid!.ordersDeadlineAt, now);
    } else {
      await initializeBatchRaidJournal(db, raid!.id, now);
    }
    const [session] = await db.insert(sessions).values({
      wallet: attacker.wallet, expiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    const token = await issueSessionJwt(TEST_CONFIG, attacker.wallet, session!.id);
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
      'content-type': 'application/json',
      [SIM_VERSION_HEADER]: String(SIM_VERSION),
    };
    const post = async (clientCommandId: string, tx: number, ty: number) => {
      const response = await fetch(`${origin}/raids/${raid!.id}/commands`, {
        method: 'POST', headers, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          clientCommandId,
          command: {
            kind,
            payload: {
              ...(kind === 'deploy' ? { troop: 'highlander' } : { hero: clientCommandId === 'north-first' ? 'vex' : 'theodor' }), tx, ty,
              ...(mode === 'batch journal' ? { tMs: 0 } : {}),
            },
          },
        }),
      });
      return { status: response.status, body: await response.json() as WireReply };
    };

    if (battlefieldVersion === 2) {
      // A current header cannot arm a stale unstarted reservation left over
      // after a rollout. Its next valid attempt must retain the full budget.
      await db.update(raids).set({ simVersion: SIM_VERSION - 1 }).where(eq(raids.id, raid!.id));
      const stale = await post('old-sim-probe', 10, 10);
      expect(stale.status).toBe(409);
      expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, raid!.id))).toHaveLength(0);
      const [untouched] = await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, raid!.id));
      expect(untouched).toMatchObject({ armedAt: null, startedAt: null, lastSequence: -1 });
      await db.update(raids).set({ simVersion: SIM_VERSION }).where(eq(raids.id, raid!.id));
    }
    const north = battlefieldBounds(battlefieldVersion).min;
    // Building/deployment expansion is not permission to expand rally. Both
    // HTTP and direct authoritative entrypoints must leave no command behind.
    const rallyResponse = await fetch(`${origin}/raids/${raid!.id}/commands`, {
      method: 'POST', headers, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ clientCommandId: 'outside-rally', command: {
        kind: 'rally', payload: { tx: -1, ty: 15 },
      } }),
    });
    expect(rallyResponse.status).toBe(400);
    await expect(acceptLiveRaidCommand(db, attacker.wallet, raid!.id, 'outside-service-rally', {
      kind: 'rally', payload: { tx: 30, ty: 15 },
    })).rejects.toMatchObject({ statusCode: 400 });
    if (battlefieldVersion === 3) {
      const before = await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, raid!.id));
      const invalidFirst = await post('single-cell-first', 10, 10);
      expect(invalidFirst.status).toBe(422);
      expect(await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, raid!.id))).toEqual(before);
      expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, raid!.id))).toHaveLength(0);
      const [unspent] = await db.select({ armySnapshot: raids.armySnapshot }).from(raids).where(eq(raids.id, raid!.id));
      expect(unspent!.armySnapshot).toEqual(raid!.armySnapshot);
    }
    const first = await post('north-first', 14, north);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.command).toMatchObject({
      clientCommandId: 'north-first', kind,
      payload: { ...(kind === 'deploy' ? { troop: 'highlander' } : { hero: 'vex' }), tx: 14, ty: north },
    });

    const rejected = await post('north-outside', 14, north - 1);
    // The union wire envelope admits all supported versions; legacy range
    // rejection now belongs to its frozen snapshot validator.
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(battlefieldVersion !== undefined ? 400 : 422);
    expect(rejected.body.error?.message).toEqual(expect.any(String));
    expect(rejected.body.command).toBeUndefined();

    if (battlefieldVersion !== undefined) {
      const blocked = await post('spent-footprint', 18, 18);
      expect(blocked.status).toBe(422);
    }
    if (battlefieldVersion === 3) {
      const hole = await post('single-cell-hole', 10, 10);
      expect(hole.status).toBe(422);
      expect(hole.body.command).toBeUndefined();
    }
    const secondY = battlefieldVersion !== undefined ? 17 : north;
    const second = await post('north-second', 17, secondY);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.command).toMatchObject({
      clientCommandId: 'north-second', kind,
      sequence: first.body.command!.sequence + 1,
      payload: { ...(kind === 'deploy' ? { troop: 'highlander' } : { hero: 'theodor' }), tx: 17, ty: secondY },
    });
    // WHY: the rejection must leave the authoritative journal and troop budget
    // untouched, not merely return a friendly HTTP response after a mutation.
    const stored = await db.select().from(raidCommands)
      .where(eq(raidCommands.raidId, raid!.id)).orderBy(asc(raidCommands.sequence));
    expect(stored.map((command) => command.clientCommandId))
      .toEqual(['north-first', 'north-second']);
    const replay = await fetch(`${origin}/raids/${raid!.id}/live`, {
      headers, signal: AbortSignal.timeout(10_000),
    });
    expect(replay.status).toBe(200);
    const stream = await replay.json() as { commands: WireCommand[] };
    expect(stream.commands).toEqual([first.body.command, second.body.command]);
  });
});
