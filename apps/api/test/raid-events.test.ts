import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import type { ActiveBaseRaid } from '@shardkeep/shared/raidEvents';
import { buildApp } from '../src/app';
import { issueSessionJwt } from '../src/auth/session';
import { baseRaidLocks, bases, raids, sessions } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { RaidEventHub } from '../src/game/raidEvents';
import { HttpError } from '../src/lib/errors';
import {
  markRaidBaseChanged, raidEventTransaction, RedisRaidEventBus,
  registerRaidEventPublisher, type RaidInvalidationBus,
} from '../src/lib/raidEventBus';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

class LocalBus implements RaidInvalidationBus {
  listeners = new Set<(baseId: string) => void>();
  publish = vi.fn((id: string) => { for (const listener of this.listeners) listener(id); });
  subscribe(listener: (baseId: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
const conn = connectTestDb();
const env = { multi: process.env.MULTI_BASE_ENABLED, free: process.env.FREE_ONBOARDING };
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  if (env.multi === undefined) delete process.env.MULTI_BASE_ENABLED;
  else process.env.MULTI_BASE_ENABLED = env.multi;
  if (env.free === undefined) delete process.env.FREE_ONBOARDING;
  else process.env.FREE_ONBOARDING = env.free;
  await conn.sql.end();
});

describe('raid event transaction boundaries', () => {
  it('publishes once after the outer commit, discarding rollback and failed savepoints', async () => {
    const bus = new LocalBus();
    const unregister = registerRaidEventPublisher(conn.db, bus);
    const baseId = randomUUID();
    try {
      await raidEventTransaction(conn.db, async (tx) => {
        markRaidBaseChanged(tx, baseId);
        await raidEventTransaction(tx, async (nested) => { markRaidBaseChanged(nested, baseId); });
        await expect(raidEventTransaction(tx, async (nested) => {
          markRaidBaseChanged(nested, randomUUID());
          throw new Error('savepoint fails');
        })).rejects.toThrow('savepoint fails');
        expect(bus.publish).not.toHaveBeenCalled();
      });
      expect(bus.publish.mock.calls).toEqual([[baseId]]);
      await expect(raidEventTransaction(conn.db, async (tx) => {
        markRaidBaseChanged(tx, randomUUID());
        throw new Error('outer fails');
      })).rejects.toThrow('outer fails');
      expect(bus.publish).toHaveBeenCalledTimes(1);
    } finally { unregister(); }
  });
});

describe('selected-base stream reconciliation', () => {
  it('drops a stale in-flight null and coalesces tabs into one fresh read', async () => {
    const bus = new LocalBus();
    const baseId = randomUUID();
    const active: ActiveBaseRaid = { raidId: randomUUID(), state: 'reserved' };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn<() => Promise<ActiveBaseRaid | null>>()
      .mockImplementationOnce(async () => { await barrier; return null; })
      .mockResolvedValue(active);
    const hub = new RaidEventHub(bus, read);
    const frames: string[] = [];
    const client = () => ({ wallet: 'owner', validate: async () => {},
      write: (frame: string) => { frames.push(frame); return true; }, close: vi.fn() });
    try {
      hub.add(baseId, client());
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      hub.add(baseId, client());
      bus.publish(baseId);
      bus.publish(baseId);
      release();
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(read).toHaveBeenCalledTimes(2);
      expect(frames.every((frame) => frame.includes(active.raidId))).toBe(true);
      expect(frames.some((frame) => frame.includes('"activeRaid":null'))).toBe(false);
    } finally { hub.close(); }
  });

  it('retains a reconnect while the previous connection read is still pending', async () => {
    const bus = new LocalBus();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn<() => Promise<ActiveBaseRaid | null>>()
      .mockImplementationOnce(async () => { await barrier; return null; }).mockResolvedValue(null);
    const hub = new RaidEventHub(bus, read);
    const write = vi.fn(() => true);
    const client = { wallet: 'owner', validate: async () => {}, write, close: vi.fn() };
    try {
      const disconnect = hub.add('base', { ...client, write: vi.fn(() => true) });
      disconnect();
      hub.add('base', client);
      release();
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      bus.publish('base');
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    } finally { hub.close(); }
  });

  it('reconciles a suppressed notification after 15 seconds and rechecks revocation', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    let active: ActiveBaseRaid | null = null;
    let revoked = false;
    const frames: string[] = [];
    const close = vi.fn();
    const hub = new RaidEventHub(bus, async () => active);
    try {
      hub.add('base', { wallet: 'owner', validate: async () => {
        if (revoked) throw new HttpError(401, 'invalid or expired session');
      }, write: (frame) => { frames.push(frame); return true; }, close });
      await vi.advanceTimersByTimeAsync(0);
      active = { raidId: 'raid', state: 'live' };
      await vi.advanceTimersByTimeAsync(15_000);
      expect(frames.at(-1)).toContain('"state":"live"');
      revoked = true;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(frames.at(-1)).toContain('"status":401');
      expect(close).toHaveBeenCalledTimes(1);
    } finally { hub.close(); }
    expect(bus.listeners.size).toBe(0);
  });

  it('bounds connections, removes slow clients, and preserves other subscribers', async () => {
    const bus = new LocalBus();
    const hub = new RaidEventHub(bus, async () => null);
    const closed = vi.fn();
    try {
      for (let i = 0; i < 4; i++) hub.add('base', {
        wallet: 'owner', validate: async () => {}, write: () => false, close: closed,
      });
      expect(() => hub.assertCapacity('owner')).toThrow('too many raid update connections');
      const healthy = vi.fn(() => true);
      hub.add('base', { wallet: 'second session', validate: async () => {}, write: healthy, close: vi.fn() });
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(4));
      expect(healthy).toHaveBeenCalled();
      expect(() => hub.assertCapacity('owner')).not.toThrow();
    } finally { hub.close(); }
  });
});

function events(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream ended without the expected event');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

it('streams worker commits across two API instances and closes revoked or transferred access', async () => {
  process.env.MULTI_BASE_ENABLED = 'false';
  process.env.FREE_ONBOARDING = 'true';
  const player = await createTestPlayer(conn.db);
  await ensureStartingBase(conn.db, player.wallet);
  const baseId = (await ensureWalletBaseIdentity(conn.db, player.wallet))!;
  const other = await createTestPlayer(conn.db);
  await ensureStartingBase(conn.db, other.wallet);
  const otherBaseId = (await ensureWalletBaseIdentity(conn.db, other.wallet))!;
  const sessionId = randomUUID();
  await conn.db.insert(sessions).values({ id: sessionId, wallet: player.wallet, expiresAt: new Date(Date.now() + 60_000) });
  const token = await issueSessionJwt(TEST_CONFIG, player.wallet, sessionId);
  const headers = { cookie: `shardkeep_session=${token}`, 'x-sim-version': String(SIM_VERSION) };
  const second = connectTestDb();
  const config = { ...TEST_CONFIG, RAID_EVENTS_ENABLED: 'true' as const };
  const apps = [await buildApp(config, conn.db), await buildApp(config, second.db)];
  const worker = new RedisRaidEventBus(TEST_CONFIG.REDIS_URL, () => {});
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 20_000);
  try {
    await vi.waitFor(() => expect(worker.isSubscribed).toBe(true));
    process.env.MULTI_BASE_ENABLED = 'true';
    expect((await apps[0]!.inject({ url: `/bases/${baseId}/raid-events`, headers: { 'x-sim-version': String(SIM_VERSION) } })).statusCode).toBe(401);
    expect((await apps[0]!.inject({ url: `/bases/${otherBaseId}/raid-events`, headers })).statusCode).toBe(404);
    const urls = await Promise.all(apps.map((app) => app.listen({ host: '127.0.0.1', port: 0 })));
    const responses = await Promise.all(urls.map((url) => fetch(`${url}/bases/${baseId}/raid-events`, { headers, signal: stop.signal })));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    const streams = responses.map(events);
    expect(await Promise.all(streams.map((read) => read()))).toEqual([
      { baseId, activeRaid: null }, { baseId, activeRaid: null },
    ]);
    const raidId = randomUUID();
    await conn.db.insert(raids).values({ id: raidId, attackerWallet: other.wallet,
      defenderWallet: player.wallet, defenderBaseId: baseId, seed: 1n, snapshot: {}, armySnapshot: {},
      simVersion: SIM_VERSION, ordersDeadlineAt: new Date(Date.now() + 60_000) });
    await conn.db.insert(baseRaidLocks).values({ baseId, raidId, expiresAt: new Date(Date.now() + 60_000) });
    worker.publish(baseId);
    const snapshots = await Promise.all(streams.map((read) => read()));
    expect(snapshots).toEqual(Array(2).fill({ baseId, activeRaid: { raidId, state: 'reserved' } }));
    await conn.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
    worker.publish(baseId);
    expect((await Promise.all(streams.map((read) => read()))).map((row) => row.status)).toEqual([401, 401]);
    await conn.db.update(sessions).set({ revokedAt: null }).where(eq(sessions.id, sessionId));
    const transferred = events(await fetch(`${urls[0]}/bases/${baseId}/raid-events`, { headers, signal: stop.signal }));
    await transferred();
    await conn.db.update(bases).set({ ownerWallet: other.wallet }).where(eq(bases.id, baseId));
    worker.publish(baseId);
    expect((await transferred()).status).toBe(404);
  } finally {
    clearTimeout(timeout);
    stop.abort();
    worker.close();
    await Promise.all(apps.map((app) => app.close()));
    await conn.db.update(bases).set({ ownerWallet: player.wallet }).where(eq(bases.id, baseId));
    await conn.db.delete(baseRaidLocks).where(eq(baseRaidLocks.baseId, baseId));
    await second.sql.end();
    process.env.MULTI_BASE_ENABLED = 'false';
  }
});
