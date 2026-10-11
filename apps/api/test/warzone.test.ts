/**
 * Shieldless warzone windows (#46). Encodes the WHY: a warzone must make every base
 * attackable (shields SUPPRESSED, not deleted, so they resume after) via a request-
 * time predicate that works with workers off; 'scheduled' is a predictable weekend
 * window; 'purge' is an admin-set window whose bounds are never derivable by players.
 * Pure predicate tests + the DB round-trip + the scout-gating wiring.
 */
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildings, shields } from '../src/db/schema';
import type { GameConfigRow } from '../src/game/gameConfig';
import { getGameConfig, setShieldlessMode } from '../src/game/gameConfig';
import { scoutBase } from '../src/game/world';
import { ensureStartingBase, getBaseState } from '../src/game/base';
import { isScheduledWarzone, isWarzoneActive, warzoneStatus } from '../src/game/warzone';
import { resolveEffectiveShieldStatus } from '../src/game/baseShields';
import { assertWarzoneShieldPurchasable, grantWarzoneShield, hasActiveWarzoneShield } from '../src/game/warzoneShield';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

const cfg = (over: Partial<GameConfigRow>): GameConfigRow => ({
  emissionMultBps: 10_000, emissionUpdatedAt: null,
  shieldlessMode: 'off', purgeStartAt: null, purgeEndAt: null,
  globalChatEnabled: true, ...over,
});

afterAll(async () => {
  await setShieldlessMode(db, 'off'); // never leave a global warzone on for other files
});

describe('isScheduledWarzone — the predictable weekend window (48h from Sat 00:00 UTC)', () => {
  it('is active across Saturday and Sunday', () => {
    expect(isScheduledWarzone(new Date('2026-07-18T12:00:00Z'))).toBe(true); // Sat
    expect(isScheduledWarzone(new Date('2026-07-19T12:00:00Z'))).toBe(true); // Sun
  });
  it('is inactive mid-week and exactly at the Monday 00:00 close (exclusive end)', () => {
    expect(isScheduledWarzone(new Date('2026-07-22T12:00:00Z'))).toBe(false); // Wed
    expect(isScheduledWarzone(new Date('2026-07-20T00:00:00Z'))).toBe(false); // Mon 00:00 == end
  });
});

describe('isWarzoneActive — mode switch', () => {
  const now = new Date('2026-07-22T12:00:00Z'); // a Wednesday (no scheduled window)
  it("'off' is never active", () => {
    expect(isWarzoneActive(cfg({ shieldlessMode: 'off' }), now)).toBe(false);
  });
  it("'purge' is active only inside its [start, end) window", () => {
    const purge = cfg({
      shieldlessMode: 'purge',
      purgeStartAt: new Date(now.getTime() - 3_600_000),
      purgeEndAt: new Date(now.getTime() + 3_600_000),
    });
    expect(isWarzoneActive(purge, now)).toBe(true);
    expect(isWarzoneActive(purge, new Date(now.getTime() + 2 * 3_600_000))).toBe(false); // after end
    expect(isWarzoneActive(cfg({ shieldlessMode: 'purge' }), now)).toBe(false); // no window set
  });
  it("'scheduled' delegates to the weekend predicate", () => {
    expect(isWarzoneActive(cfg({ shieldlessMode: 'scheduled' }), new Date('2026-07-18T12:00:00Z'))).toBe(true);
    expect(isWarzoneActive(cfg({ shieldlessMode: 'scheduled' }), now)).toBe(false); // Wed
  });
});

describe('player-facing warzone status', () => {
  it('counts down predictable scheduled windows, including the next start', () => {
    const activeNow = new Date('2026-07-18T12:00:00Z');
    expect(warzoneStatus(cfg({ shieldlessMode: 'scheduled' }), activeNow)).toEqual({
      mode: 'scheduled', active: true,
      startsAt: new Date('2026-07-18T00:00:00Z'),
      endsAt: new Date('2026-07-20T00:00:00Z'),
      nextStartsAt: new Date('2026-07-25T00:00:00Z'),
      remainingMs: 36 * 3_600_000,
    });

    const waitingNow = new Date('2026-07-22T12:00:00Z');
    expect(warzoneStatus(cfg({ shieldlessMode: 'scheduled' }), waitingNow)).toEqual({
      mode: 'scheduled', active: false,
      startsAt: new Date('2026-07-25T00:00:00Z'),
      endsAt: new Date('2026-07-27T00:00:00Z'),
      nextStartsAt: new Date('2026-07-25T00:00:00Z'),
      remainingMs: 60 * 3_600_000,
    });
  });

  it('never leaks a future purge start, but an active purge may disclose its end', () => {
    const now = new Date('2026-07-22T12:00:00Z');
    const future = cfg({
      shieldlessMode: 'purge',
      purgeStartAt: new Date('2026-07-23T00:00:00Z'),
      purgeEndAt: new Date('2026-07-24T00:00:00Z'),
    });
    expect(warzoneStatus(future, now)).toEqual({
      mode: 'off', active: false, startsAt: null, endsAt: null,
      nextStartsAt: null, remainingMs: null,
    });

    const active = cfg({
      shieldlessMode: 'purge',
      purgeStartAt: new Date('2026-07-22T00:00:00Z'),
      purgeEndAt: new Date('2026-07-23T00:00:00Z'),
    });
    expect(warzoneStatus(active, now)).toEqual({
      mode: 'purge', active: true, startsAt: null,
      endsAt: new Date('2026-07-23T00:00:00Z'), nextStartsAt: null,
      remainingMs: 12 * 3_600_000,
    });
  });
});

describe('effective shield truth', () => {
  const now = new Date('2026-07-22T12:00:00Z');
  it('shows a resumable loss shield as suppressed, never as active protection', () => {
    const expiry = new Date('2026-07-23T00:00:00Z');
    expect(resolveEffectiveShieldStatus([{ source: 'loss', expiresAt: expiry }], now, true))
      .toEqual({
        active: false, source: 'loss', expiresAt: expiry,
        remainingMs: 12 * 3_600_000, suppressedByWarzone: true,
      });
  });

  it('selects the warzone shield when ordinary and paid protection coexist', () => {
    const lossExpiry = new Date('2026-07-24T00:00:00Z');
    const warzoneExpiry = new Date('2026-07-23T00:00:00Z');
    expect(resolveEffectiveShieldStatus([
      { source: 'loss', expiresAt: lossExpiry },
      { source: 'warzone', expiresAt: warzoneExpiry },
    ], now, true)).toEqual({
      active: true, source: 'warzone', expiresAt: warzoneExpiry,
      remainingMs: 12 * 3_600_000, suppressedByWarzone: false,
    });
  });
});

describe('game_config persistence (#46 lever) + scout gating', () => {
  it('persists the purge mode + window and clears it on off', async () => {
    const now = new Date();
    const start = new Date(now.getTime() + 1_000);
    const end = new Date(now.getTime() + 48 * 3_600_000);
    await setShieldlessMode(db, 'purge', { purgeStartAt: start, purgeEndAt: end }, now);
    const on = await getGameConfig(db);
    expect(on.shieldlessMode).toBe('purge');
    expect(on.purgeStartAt?.getTime()).toBe(start.getTime());

    await setShieldlessMode(db, 'off');
    const off = await getGameConfig(db);
    expect(off.shieldlessMode).toBe('off');
    expect(off.purgeStartAt).toBeNull(); // window cleared, no stale bounds
  });

  it('a shielded base is scoutable at all times — shields gate attacks, never scouting (D-099)', async () => {
    // WHY: the owner's rule (2026-09-02) is "everyone can scout everyone; only
    // attacks are gated". Before D-099 a loss shield 422'd scoutBase outside a
    // purge, which taught a player nothing about the base they could not attack
    // anyway. The shield still refuses the ATTACK path (raids.test.ts pins it).
    const viewer = await createTestPlayer(db);
    const target = await createTestPlayer(db);
    await db.insert(buildings).values({ playerWallet: target.wallet, type: 'keep', level: 1, tx: 14, ty: 14 });
    await db.insert(shields).values({
      playerWallet: target.wallet, source: 'loss', expiresAt: new Date(Date.now() + 3_600_000),
    });

    await setShieldlessMode(db, 'off');
    const shielded = await scoutBase(db, viewer.wallet, target.wallet);
    expect(shielded.wallet).toBe(target.wallet); // shield up → still readable

    const now = new Date();
    await setShieldlessMode(db, 'purge', {
      purgeStartAt: new Date(now.getTime() - 1_000),
      purgeEndAt: new Date(now.getTime() + 3_600_000),
    }, now);
    const preview = await scoutBase(db, viewer.wallet, target.wallet, now);
    expect(preview.wallet).toBe(target.wallet); // shield suppressed → scout allowed

    // cleanup so the row (still active) can't leak into another file
    await db.delete(shields).where(eq(shields.playerWallet, target.wallet));
    await setShieldlessMode(db, 'off');
  });

  it('/base exposes a suppressed ordinary shield without claiming it protects', async () => {
    const player = await createTestPlayer(db);
    await ensureStartingBase(db, player.wallet);
    const now = new Date('2026-07-22T12:00:00Z');
    const expiresAt = new Date('2026-07-23T00:00:00Z');
    await db.insert(shields).values({
      playerWallet: player.wallet, source: 'loss', expiresAt,
    });
    await setShieldlessMode(db, 'purge', {
      purgeStartAt: new Date('2026-07-22T00:00:00Z'),
      purgeEndAt: new Date('2026-07-23T00:00:00Z'),
    }, now);

    expect((await getBaseState(db, player.wallet, now)).shield).toMatchObject({
      active: false,
      activeUntil: expiresAt,
      expiresAt,
      source: 'loss',
      remainingMs: 12 * 3_600_000,
      suppressedByWarzone: true,
    });
    await db.delete(shields).where(eq(shields.playerWallet, player.wallet));
    await setShieldlessMode(db, 'off');
  });
});

describe('warzone shield (#49) — the ONLY protection usable during a warzone', () => {
  const openPurge = (now: Date) => setShieldlessMode(db, 'purge', {
    purgeStartAt: new Date(now.getTime() - 1_000), purgeEndAt: new Date(now.getTime() + 3_600_000),
  }, now);

  it('grant + hasActiveWarzoneShield round-trip (48h)', async () => {
    const p = await createTestPlayer(db);
    const now = new Date();
    expect(await hasActiveWarzoneShield(db, p.wallet, now)).toBe(false);
    const { expiresAt } = await grantWarzoneShield(db, p.wallet, now);
    expect(expiresAt.getTime()).toBe(now.getTime() + 48 * 3_600_000);
    expect(await hasActiveWarzoneShield(db, p.wallet, now)).toBe(true);
    await db.delete(shields).where(eq(shields.playerWallet, p.wallet));
  });

  it('neither a loss shield nor a warzone shield blocks scouting during a warzone (D-099)', async () => {
    // WHY: the warzone shield is the ONLY protection that still stops an ATTACK
    // during a purge (#49); since D-099 it, like every shield, says nothing to a
    // scout. A player must be able to read a layout they may attack once the
    // shield lapses — knowledge is not the thing the shield sells.
    const viewer = await createTestPlayer(db);
    const target = await createTestPlayer(db);
    await db.insert(buildings).values({ playerWallet: target.wallet, type: 'keep', level: 1, tx: 14, ty: 14 });
    const now = new Date();
    await openPurge(now);
    await db.insert(shields).values({ playerWallet: target.wallet, source: 'loss', expiresAt: new Date(now.getTime() + 3_600_000) });
    await expect(scoutBase(db, viewer.wallet, target.wallet, now)).resolves.toBeTruthy();
    await grantWarzoneShield(db, target.wallet, now);
    await expect(scoutBase(db, viewer.wallet, target.wallet, now)).resolves.toBeTruthy();
    await db.delete(shields).where(eq(shields.playerWallet, target.wallet));
    await setShieldlessMode(db, 'off');
  });

  it('purchasable ONLY during a warzone, and never stacks', async () => {
    const p = await createTestPlayer(db);
    const now = new Date();
    await setShieldlessMode(db, 'off');
    await expect(assertWarzoneShieldPurchasable(db, p.wallet, now)).rejects.toThrow(/only sold during/);
    await openPurge(now);
    await expect(assertWarzoneShieldPurchasable(db, p.wallet, now)).resolves.toBeUndefined();
    await grantWarzoneShield(db, p.wallet, now);
    await expect(assertWarzoneShieldPurchasable(db, p.wallet, now)).rejects.toThrow(/already have/);
    await db.delete(shields).where(eq(shields.playerWallet, p.wallet));
    await setShieldlessMode(db, 'off');
  });
});
