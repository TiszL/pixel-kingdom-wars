import { REFERRALS } from '@shardkeep/shared';
import { ReferralStatusV1Schema, ReferralUseV1ResponseSchema } from '@shardkeep/shared/referrals';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import type { Db, DbTx } from '../src/db/client';
import { players, referrals, sessions } from '../src/db/schema';
import { getOrCreateReferralCode, referralStatusV1, useReferralCode, useReferralCodeV1 } from '../src/game/social';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const forcedDraws = vi.hoisted(() => ({ values: [] as number[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: (size: number) => size === 5 && forcedDraws.values.length
    ? Buffer.alloc(size, forcedDraws.values.shift()) : actual.randomBytes(size) };
});
afterAll(async () => { await conn.sql.end(); });
async function fixture() {
  const owner = await createTestPlayer(db); const friend = await createTestPlayer(db);
  const code = await getOrCreateReferralCode(db, owner.wallet);
  return { owner, friend, code };
}
function failMirror(error: Error): Db {
  return new Proxy(db, { get(target, key) {
    if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => target.transaction((tx) => run(new Proxy(tx, {
      get(t, k) {
        if (k === 'update') return () => { throw error; };
        const value = Reflect.get(t, k); return typeof value === 'function' ? value.bind(t) : value;
      },
    })));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe.sequential('immutable referral recovery', () => {
  it('concurrent identical submissions allocate one relationship and retain its original proof', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 6 }, () => useReferralCodeV1(db, f.friend.wallet, f.code)));
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_applied')).toHaveLength(5);
    expect(new Set(results.map((r) => r.relationship.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.relationship.createdAt)).size).toBe(1);
    expect((await db.select().from(referrals).where(eq(referrals.refereeWallet, f.friend.wallet)))).toHaveLength(1);
    expect((await db.select().from(players).where(eq(players.wallet, f.friend.wallet)))[0]?.referredBy).toBe(f.owner.wallet);
  });
  it('concurrent different codes report the actual immutable winner without claiming both succeeded', async () => {
    const f = await fixture(); const other = await createTestPlayer(db); const second = await getOrCreateReferralCode(db, other.wallet);
    const results = await Promise.all([f.code, second].map((code) => useReferralCodeV1(db, f.friend.wallet, code)));
    expect(results.map((r) => r.outcome).sort()).toEqual(['already_bound', 'applied']);
    expect(results[0]!.relationship).toEqual(results[1]!.relationship);
    const winner = results.find((r) => r.outcome === 'applied')!;
    expect(winner.relationship.referrerWallet).toBe(winner.submittedCode === f.code ? f.owner.wallet : other.wallet);
  });
  it('overlapping reciprocal submissions do not deadlock their foreign-key checks', async () => {
    const f = await fixture(); const friendCode = await getOrCreateReferralCode(db, f.friend.wallet);
    let count = 0; let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new Proxy(db, { get(target, key) {
      if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => target.transaction((tx) => run(new Proxy(tx, {
        get(t, k) {
          if (k === 'insert') return (table: unknown) => {
            expect(table).toBe(referrals);
            return { values: (value: typeof referrals.$inferInsert) => ({ returning: async () => {
              if (++count === 2) release(); await both;
              return t.insert(referrals).values(value).returning();
            } }) };
          };
          const value = Reflect.get(t, k); return typeof value === 'function' ? value.bind(t) : value;
        },
      })));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const results = await Promise.allSettled([
      useReferralCodeV1(delayed, f.owner.wallet, friendCode), useReferralCodeV1(delayed, f.friend.wallet, f.code),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await referralStatusV1(db, f.owner.wallet)).relationship?.referrerWallet).toBe(f.friend.wallet);
    expect((await referralStatusV1(db, f.friend.wallet)).relationship?.referrerWallet).toBe(f.owner.wallet);
  });
  it('mirror failure rolls the relationship back and propagates uncertainty through legacy and v1', async () => {
    const failure = new Error('synthetic interrupted mirror write');
    for (const submit of [useReferralCode, useReferralCodeV1]) {
      const f = await fixture();
      await expect(submit(failMirror(failure), f.friend.wallet, f.code)).rejects.toBe(failure);
      expect((await referralStatusV1(db, f.friend.wallet)).relationship).toBeNull();
      expect((await db.select().from(players).where(eq(players.wallet, f.friend.wallet)))[0]?.referredBy).toBeNull();
      expect((await useReferralCodeV1(db, f.friend.wallet, f.code)).outcome).toBe('applied');
    }
  });
  it('positive proof survives the onboarding window and never changes qualification or allocates a code on status GET', async () => {
    const f = await fixture(); const applied = await useReferralCodeV1(db, f.friend.wallet, f.code);
    const future = new Date(Date.now() + (REFERRALS.useWindowDays + 1) * 86_400_000);
    expect((await useReferralCodeV1(db, f.friend.wallet, `  ${f.code.toLowerCase()}  `, future))).toEqual({ ...applied, outcome: 'already_applied' });
    const status = await referralStatusV1(db, f.friend.wallet);
    expect(status.relationship).toEqual(applied.relationship);
    const [player] = await db.select().from(players).where(eq(players.wallet, f.friend.wallet));
    expect(player?.referralCode).toBeNull();
    const [row] = await db.select().from(referrals).where(eq(referrals.refereeWallet, f.friend.wallet));
    expect(row?.qualifiedAt).toBeNull(); expect(row?.totalMatchedKeep).toBe(0n);
    const fresh = await createTestPlayer(db);
    await expect(useReferralCodeV1(db, fresh.wallet, f.code, future)).rejects.toThrow('referral window has passed');
  });
  it('legacy duplicate and self refusals remain while v1 can report an existing different binding', async () => {
    const f = await fixture(); const old = await useReferralCode(db, f.friend.wallet, f.code);
    await expect(useReferralCode(db, f.friend.wallet, f.code)).rejects.toThrow('already referred');
    const self = await getOrCreateReferralCode(db, f.friend.wallet);
    await expect(useReferralCode(db, f.friend.wallet, self)).rejects.toThrow('cannot refer yourself');
    expect((await useReferralCodeV1(db, f.friend.wallet, self)).outcome).toBe('already_bound');
    expect((await useReferralCodeV1(db, f.friend.wallet, f.code)).relationship.id).toBe(old.id);
    await expect(useReferralCodeV1(db, f.owner.wallet, f.code)).rejects.toThrow('cannot refer yourself');
  });
  it('concurrent first code reads cannot overwrite a code another caller was already shown', async () => {
    const owner = await createTestPlayer(db);
    const values = await Promise.all(Array.from({ length: 12 }, () => getOrCreateReferralCode(db, owner.wallet)));
    expect(new Set(values).size).toBe(1);
    expect((await getOrCreateReferralCode(db, owner.wallet))).toBe(values[0]);
    const failure = new Error('synthetic allocation transport failure'); const next = await createTestPlayer(db);
    await expect(getOrCreateReferralCode(failMirror(failure), next.wallet)).rejects.toBe(failure);
  });
  it('redraws only an actual referral-code uniqueness collision in a fresh transaction', async () => {
    const owner = await createTestPlayer(db); const next = await createTestPlayer(db);
    await db.update(players).set({ referralCode: 'KEEP-AAAAA' }).where(eq(players.wallet, owner.wallet));
    forcedDraws.values = [0, 1];
    try {
      expect(await getOrCreateReferralCode(db, next.wallet)).toBe('KEEP-BBBBB');
      expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]?.referralCode).toBe('KEEP-AAAAA');
      expect(forcedDraws.values).toEqual([]);
    } finally { forcedDraws.values = []; }
  });
  it('checks eligibility after transaction admission instead of freezing a pre-lock wall clock', async () => {
    const f = await fixture(); const before = new Date();
    await db.update(players).set({ createdAt: new Date(before.getTime() - REFERRALS.useWindowDays * 86_400_000 + 1000) }).where(eq(players.wallet, f.friend.wallet));
    let signal!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const permit = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new Proxy(db, { get(target, key) {
      if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => target.transaction(async (tx) => { signal(); await permit; return run(tx); });
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(before);
    try {
      const pending = useReferralCodeV1(delayed, f.friend.wallet, f.code);
      const refusal = expect(pending).rejects.toMatchObject({ code: 'REFERRAL_WINDOW_CLOSED' });
      await entered; vi.setSystemTime(new Date(before.getTime() + 2000)); release(); await refusal;
      expect((await referralStatusV1(db, f.friend.wallet)).relationship).toBeNull();
    } finally { release(); vi.useRealTimers(); }
  });
  it('status is caller-scoped, auth-only, no-store, and does not mistake an unbound wallet for a failed command', async () => {
    const f = await fixture(); const app = await buildApp(TEST_CONFIG, db);
    const cookies = async (wallet: string) => {
      const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    };
    try {
      const friendCookies = await cookies(f.friend.wallet); const ownerCookies = await cookies(f.owner.wallet);
      expect((await app.inject({ method: 'GET', url: '/referrals/v1/status' })).statusCode).toBe(401);
      const initial = await app.inject({ method: 'GET', url: '/referrals/v1/status', cookies: friendCookies });
      expect(initial.statusCode).toBe(200); expect(initial.headers['cache-control']).toBe('private, no-store');
      expect(ReferralStatusV1Schema.parse(initial.json())).toEqual({ version: 1, wallet: f.friend.wallet, relationship: null });
      const applied = await app.inject({ method: 'POST', url: '/referrals/v1/use', cookies: friendCookies, payload: { code: ` ${f.code.toLowerCase()} ` } });
      expect(applied.statusCode).toBe(200); expect(applied.headers['cache-control']).toBe('private, no-store');
      const result = ReferralUseV1ResponseSchema.parse(applied.json());
      expect(result.submittedCode).toBe(f.code); expect(result.outcome).toBe('applied');
      const other = await app.inject({ method: 'GET', url: `/referrals/v1/status?wallet=${f.friend.wallet}`, cookies: ownerCookies });
      expect(ReferralStatusV1Schema.parse(other.json())).toEqual({ version: 1, wallet: f.owner.wallet, relationship: null });
      const recovered = await app.inject({ method: 'GET', url: '/referrals/v1/status', cookies: friendCookies });
      expect(recovered.json().relationship).toEqual(result.relationship);
      const legacy = await createTestPlayer(db);
      const response = await app.inject({ method: 'POST', url: '/referrals/use', cookies: await cookies(legacy.wallet), payload: { code: f.code } });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ referrer: f.owner.wallet });
      const invalid = await createTestPlayer(db);
      const invalidResponse = await app.inject({ method: 'POST', url: '/referrals/v1/use', cookies: await cookies(invalid.wallet), payload: { code: 'KEEP-INVALID' } });
      expect(invalidResponse.statusCode).toBe(404); expect(invalidResponse.json().error.code).toBe('REFERRAL_CODE_UNKNOWN');
      expect((await referralStatusV1(db, invalid.wallet)).relationship).toBeNull();
    } finally { await app.close(); }
  });
});
