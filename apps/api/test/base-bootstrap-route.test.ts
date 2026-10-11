/**
 * Stable-mode GET /base must enter the deed-owned economy directly. The
 * production cutover fence makes any accidental wallet-SHARDS starter fatal;
 * these tests assert the stronger invariant without irreversibly activating
 * that shared-database fence for the rest of the API suite.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { BuildingType, ECONOMY } from '@shardkeep/shared';
import bs58 from 'bs58';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  accounts, bases, baseSlots, buildings, ledgerTransactions,
} from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import { TEST_CONFIG, connectTestDb } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorFreeOnboarding = process.env['FREE_ONBOARDING'];
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
let app: FastifyInstance;

async function signIn(): Promise<{ wallet: string; cookie: string }> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const challenge = await app.inject({
    method: 'GET', url: '/auth/challenge', query: { wallet },
  });
  expect(challenge.statusCode).toBe(200);
  const { message } = challenge.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verified = await app.inject({
    method: 'POST', url: '/auth/verify', payload: { wallet, signature },
  });
  expect(verified.statusCode).toBe(200);
  return {
    wallet,
    cookie: verified.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value,
  };
}

async function walletShardAccounts(wallet: string) {
  return db.select().from(accounts).where(and(
    eq(accounts.ownerWallet, wallet), eq(accounts.kind, 'player_shards'),
  ));
}

beforeAll(async () => {
  process.env['FREE_ONBOARDING'] = 'true';
  // Build without running the process-wide production observer-readiness gate:
  // preceding files intentionally leave unrelated deed fixtures in this shared
  // integration database. GET /base reads the flag at request time, so enable
  // stable routing only after the app is ready.
  process.env['MULTI_BASE_ENABLED'] = 'false';
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
  process.env['MULTI_BASE_ENABLED'] = 'true';
});

afterAll(async () => {
  if (app) await app.close();
  await conn.sql.end();
  if (priorFreeOnboarding === undefined) delete process.env['FREE_ONBOARDING'];
  else process.env['FREE_ONBOARDING'] = priorFreeOnboarding;
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
});

describe('stable GET /base bootstrap', () => {
  it('uses an exact selected base for a multi-base wallet without entering the legacy starter path', async () => {
    const owner = await signIn();
    const [first, selected] = await db.insert(bases).values([
      { ownerWallet: owner.wallet },
      { ownerWallet: owner.wallet },
    ]).returning({ id: bases.id });
    await db.insert(baseSlots).values([
      { wallet: owner.wallet, slot: 1, baseId: first!.id },
      { wallet: owner.wallet, slot: 2, baseId: selected!.id },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/base?baseId=${selected!.id}`,
      cookies: { [SESSION_COOKIE]: owner.cookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      baseId: selected!.id,
      buildings: [expect.objectContaining({ type: BuildingType.Keep })],
    });
    expect(await walletShardAccounts(owner.wallet)).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.idempotencyKey, `starter:${owner.wallet}`),
    )).toHaveLength(0);

    const [selectedShards] = await db.select().from(accounts).where(and(
      eq(accounts.baseId, selected!.id), eq(accounts.kind, 'base_shards'),
    ));
    expect(selectedShards?.balance).toBe(BigInt(ECONOMY.starterShards));
    expect(await db.select().from(buildings).where(eq(buildings.baseId, first!.id)))
      .toHaveLength(0);
  });

  it('creates one stable free base and one base starter grant under concurrent and repeated reads', async () => {
    const owner = await signIn();
    const read = () => app.inject({
      method: 'GET', url: '/base', cookies: { [SESSION_COOKIE]: owner.cookie },
    });

    const concurrent = await Promise.all([read(), read(), read(), read()]);
    for (const response of concurrent) expect(response.statusCode, response.body).toBe(200);
    const returnedIds = new Set(concurrent.map((response) => (
      response.json() as { baseId: string }
    ).baseId));
    expect(returnedIds.size).toBe(1);

    const owned = await db.select().from(bases).where(eq(bases.ownerWallet, owner.wallet));
    expect(owned).toHaveLength(1);
    const baseId = owned[0]!.id;
    expect(returnedIds).toEqual(new Set([baseId]));
    expect(await db.select().from(baseSlots).where(and(
      eq(baseSlots.wallet, owner.wallet), eq(baseSlots.baseId, baseId),
    ))).toHaveLength(1);
    expect(await db.select().from(buildings).where(and(
      eq(buildings.baseId, baseId), eq(buildings.type, BuildingType.Keep),
    ))).toHaveLength(1);

    const [baseShards] = await db.select().from(accounts).where(and(
      eq(accounts.baseId, baseId), eq(accounts.kind, 'base_shards'),
    ));
    expect(baseShards?.balance).toBe(BigInt(ECONOMY.starterShards));
    expect(await walletShardAccounts(owner.wallet)).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.idempotencyKey, `starter:base:${baseId}`),
    )).toHaveLength(1);
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.idempotencyKey, `starter:${owner.wallet}`),
    )).toHaveLength(0);

    const repeat = await read();
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect((repeat.json() as { baseId: string }).baseId).toBe(baseId);
    expect(await db.select().from(bases).where(eq(bases.ownerWallet, owner.wallet)))
      .toHaveLength(1);
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.idempotencyKey, `starter:base:${baseId}`),
    )).toHaveLength(1);
  });
});
