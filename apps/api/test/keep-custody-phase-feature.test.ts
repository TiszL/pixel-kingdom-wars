/** GF-C1: authenticated capability reads must reflect the custody latch without
 * advertising an unusable ledger source or hiding the independent wallet rail.
 *
 * The real open/fenced/withdrawals_closed/frozen cases use the existing owner
 * phase-advance function in rolled-back transactions on one exclusive local
 * fixture database. No trigger is disabled and no shared custody row is reset.
 * Retired needs a separate retirement attestation: its route projection, and an
 * unavailable phase read, use only the existing custody-transparency seam.
 * GUARD cases intentionally pass before GF-C1; they are not claimed as RED.
 */
import { randomUUID } from 'node:crypto';
import { ECONOMY, GEMS } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exactGameCurrencyAvailable, gemsGameCurrencyAvailable } from '../../web/src/lib/gameCurrency';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { sessions } from '../src/db/schema';
import { bootstrapEconomyAllocations } from '../src/ledger';
import { createUnfittedStarterExpeditionWorkflow } from '../src/game/starterExpeditionWorkflow';
import * as custody from '../src/money/custodyTransparency';
import { ADMIN_DATABASE_URL } from './db-url';
import { bindGemsTestReserve } from './gems-reserve-fixture';
import { createTestPlayer, TEST_CONFIG } from './helpers';

const database = `phase_e_custody_feature_${randomUUID().replaceAll('-', '')}_test`;
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || !/^phase_e_custody_feature_[0-9a-f]{32}_test$/.test(database)) {
  throw new Error('unsafe custody phase feature fixture database');
}
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
let conn: ReturnType<typeof createDb> | undefined;
let created = false;

beforeAll(async () => {
  await admin.unsafe(`create database ${database}`);
  created = true;
  conn = createDb(url.toString(), { max: 2 });
  await runMigrations(conn.db);
  await bootstrapEconomyAllocations(conn.db);
});
beforeEach(() => {
  vi.stubEnv('GEMS_ENABLED', 'true');
  vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'true');
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  try {
    await conn?.sql.end();
  } finally {
    try {
      // Drop only the database this file actually created, with no FORCE or
      // cleanup of a shared database, container, ownership receipt or process.
      if (created) await admin.unsafe(`drop database ${database}`);
    } finally { await admin.end(); }
  }
});

type Fixture = { db: Db; app: FastifyInstance; cookies: Record<string, string> };
async function withFixture(check: (fixture: Fixture) => Promise<void>, verifiedReserve = true): Promise<void> {
  if (!conn) throw new Error('custody phase feature fixture was not initialized');
  // Capability routes retain the transaction; the unrelated starter workflow
  // requires its real top-level owner connection, even when never called.
  const starterExpeditionWorkflow = createUnfittedStarterExpeditionWorkflow(conn.db);
  const rollback = new Error('rollback custody phase feature fixture');
  try {
    await conn.db.transaction(async tx => {
      const db = tx as unknown as Db;
      const { wallet } = await createTestPlayer(db);
      if (verifiedReserve) await bindGemsTestReserve(db);
      const [session] = await db.insert(sessions).values({ wallet,
        expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      if (!session) throw new Error('custody phase feature session was not created');
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session.id) };
      const app = await buildApp({ ...TEST_CONFIG, DATABASE_URL: url.toString() }, db, { starterExpeditionWorkflow });
      try {
        await app.ready();
        await check({ db, app, cookies });
      } finally { await app.close(); }
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}

const nonOpenPhases = ['fenced', 'withdrawals_closed', 'frozen'] as const;
async function advanceTo(db: Db, target: typeof nonOpenPhases[number]): Promise<void> {
  let previous = 'open';
  for (const phase of nonOpenPhases) {
    await db.execute(sql`select shardkeep_advance_keep_custody_phase(${previous}, ${phase})`);
    if (phase === target) return;
    previous = phase;
  }
}
async function get(f: Fixture, path: '/balances' | '/gems') {
  const response = await f.app.inject({ method: 'GET', url: path, cookies: f.cookies });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}

// Existing reader tests prove missing/duplicate/malformed rows and permission
// failures return unknown. Here the REAL reader handles a narrowly failed DB
// seam before that result is projected through the real authenticated routes.
async function unavailableCustodyRead(): Promise<void> {
  const failedReadDb = { execute: vi.fn().mockRejectedValue(new Error('fixture custody metadata unavailable')) } as unknown as Db;
  const unknown = await custody.readCustodyTransparency(failedReadDb);
  expect(unknown.phase).toBe('unknown');
  vi.spyOn(custody, 'readCustodyTransparency').mockResolvedValue(unknown);
}
function retiredCustodyRead(): void {
  vi.spyOn(custody, 'readCustodyTransparency').mockResolvedValue({
    phase: 'retired', changedAt: '2026-10-02T00:00:00.000Z',
    evidence: { status: 'unknown' }, reserveAttested: false,
  });
}

describe('Gold Forge custody phase and Gems source capabilities', () => {
  it('GUARD: authenticates both capability routes before revealing their state', async () => {
    await withFixture(async ({ app }) => {
      for (const path of ['/balances', '/gems']) {
        const response = await app.inject({ method: 'GET', url: path });
        expect(response.statusCode, response.body).toBe(401);
      }
    });
  });

  it('/balances advertises versioned custody phase open by default', async () => {
    await withFixture(async f => {
      expect((await get(f, '/balances')).json()).toMatchObject({
        features: { keepCustody: { version: 1, phase: 'open' } },
      });
    });
  });

  it('GUARD: /gems keeps both sources while custody is open and the wallet reserve is verified', async () => {
    await withFixture(async f => {
      const response = await get(f, '/gems');
      expect(response.json().sources).toEqual(['ledger-keep', 'wallet-keep']);
      expect(response.headers['cache-control']).toBe('private, no-store');
    });
  });

  it('/balances still advertises the custody phase while Gems is paused', async () => {
    vi.stubEnv('GEMS_ENABLED', 'false');
    await withFixture(async f => {
      await advanceTo(f.db, 'fenced');
      const response = (await get(f, '/balances')).json();
      expect(response).toMatchObject({ features: {
        keepCustody: { version: 1, phase: 'fenced' }, conversionReceipts: { version: 1 },
      } });
      expect(response.features).not.toHaveProperty('gems');
    });
  });

  it.each(nonOpenPhases)('/balances advertises %s after the real ordered phase advance', async phase => {
    await withFixture(async f => {
      await advanceTo(f.db, phase);
      expect((await get(f, '/balances')).json()).toMatchObject({
        features: { keepCustody: { version: 1, phase } },
      });
    });
  });

  it.each(nonOpenPhases)('/gems suppresses ledger-keep in %s and retains configured wallet-keep', async phase => {
    await withFixture(async f => {
      await advanceTo(f.db, phase);
      const response = await get(f, '/gems');
      expect(response.json().sources).toEqual(['wallet-keep']);
      expect(response.headers['cache-control']).toBe('private, no-store');
    });
  });

  it('/balances projects retired from the custody reader without inventing a retirement attestation', async () => {
    retiredCustodyRead();
    await withFixture(async f => {
      expect((await get(f, '/balances')).json()).toMatchObject({
        features: { keepCustody: { version: 1, phase: 'retired' } },
      });
    });
  });

  it('/gems suppresses ledger-keep when the custody reader reports retired', async () => {
    retiredCustodyRead();
    await withFixture(async f => {
      expect((await get(f, '/gems')).json().sources).toEqual(['wallet-keep']);
    });
  });

  it('/balances reports unknown rather than open when custody metadata cannot be read', async () => {
    await unavailableCustodyRead();
    await withFixture(async f => {
      expect((await get(f, '/balances')).json()).toMatchObject({
        features: { keepCustody: { version: 1, phase: 'unknown' } },
      });
    });
  });

  it('/gems fails closed for the ledger source on an unknown custody read while retaining wallet-keep', async () => {
    await unavailableCustodyRead();
    await withFixture(async f => {
      expect((await get(f, '/gems')).json().sources).toEqual(['wallet-keep']);
    });
  });

  it.each(['flag off', 'unverified reserve'] as const)('/gems advertises no source when fenced and wallet buying has %s', async reason => {
    if (reason === 'flag off') vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'false');
    await withFixture(async f => {
      await advanceTo(f.db, 'fenced');
      expect((await get(f, '/gems')).json().sources).toEqual([]);
    }, reason !== 'unverified reserve');
  });

  it.each(['true', 'false'])('GUARD: existing client field readers ignore the additive custody feature with Gems=%s', async enabled => {
    vi.stubEnv('GEMS_ENABLED', enabled);
    await withFixture(async f => {
      const body = (await get(f, '/balances')).json();
      expect(body).toMatchObject({ shards: '0', keep: '0', keepRate: ECONOMY.shardsPerKeep });
      // These existing web readers know nothing about keepCustody. This guard
      // proves their compatibility; native decoder coverage belongs to GF-B1.
      expect(exactGameCurrencyAvailable(body)).toBe(true);
      expect(gemsGameCurrencyAvailable(body)).toBe(enabled === 'true');
      if (enabled === 'true') expect(body).toMatchObject({ gems: '0',
        gemsRate: { gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem } });
      else expect(body.features).toMatchObject({ conversionReceipts: { version: 1 } });
    });
  });
});
