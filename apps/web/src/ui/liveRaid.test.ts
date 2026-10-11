import frozenRaid from './__fixtures__/stage100-frozen-raid.json';
import { SIM_VERSION } from '@shardkeep/sim';
import { describe, expect, it } from 'vitest';
import {
  assertLiveRaidSimVersion, clockFromStaleRaidError, hydrateLiveOrders, isNewerRaidClock, liveRaidPath, liveRaidPlayheadMs,
  liveRaidSpeedRequest, liveRaidStartRequest,
  liveRaidFinishRequest,
  liveRaidNormalFinishDelayMs,
  playbackPlayheadMs,
  playbackWallDelayMs,
  type LiveCommand,
} from './liveRaid';

describe('defender live command hydration', () => {
  it('rebuilds the settlement order shape from canonical sequence and server time', () => {
    const commands: LiveCommand[] = [
      {
        sequence: 3, clientCommandId: 'buff', acceptedAt: '2026-08-12T00:00:03Z',
        serverOffsetMs: 3_000, kind: 'buff', payload: { buff: 'warhorn' },
      },
      {
        sequence: 1, clientCommandId: 'hero', acceptedAt: '2026-08-12T00:00:01Z',
        serverOffsetMs: 1_250, kind: 'hero', payload: { hero: 'vex', tx: 4, ty: 5 },
      },
      {
        sequence: 0, clientCommandId: 'unit', acceptedAt: '2026-08-12T00:00:00Z',
        serverOffsetMs: 0, kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 2 },
      },
      {
        sequence: 2, clientCommandId: 'rally', acceptedAt: '2026-08-12T00:00:02Z',
        serverOffsetMs: 2_500, kind: 'rally', payload: { tx: 8, ty: 9 },
      },
    ];
    expect(hydrateLiveOrders(commands, { vex: 7 })).toEqual({
      deploys: [{ troop: 'highlander', tx: 1, ty: 2, tMs: 0 }],
      heroDeploys: [{ hero: 'vex', tx: 4, ty: 5, tMs: 1_250, level: 7 }],
      rally: { tx: 8, ty: 9, tMs: 2_500 },
      buffs: { warhorn: true },
    });
  });

  it('preserves the frozen Stage100 hero equipment that produced the archived result', () => {
    // Omitting Theodor's frozen gear changed the real battle from 89% to 83%.
    // Canonical command ids are anonymised; simulation inputs remain exact.
    const hydrated = hydrateLiveOrders(frozenRaid.commands as LiveCommand[],
      frozenRaid.army.heroLevels, frozenRaid.army.heroLoadouts);
    expect(hydrated).toEqual(frozenRaid.orders);
  });

  it('encodes the participant reconnect cursor', () => {
    expect(liveRaidPath('raid/id', 41)).toBe('/raids/raid%2Fid/live?afterSequence=41');
    expect(liveRaidStartRequest('raid/id', 'start-1', 4)).toEqual({
      path: '/raids/raid%2Fid/start',
      body: { clientCommandId: 'start-1', expectedClockRevision: 4 },
    });
    expect(liveRaidSpeedRequest('raid/id', 'speed-1', 5, 2)).toEqual({
      path: '/raids/raid%2Fid/speed',
      body: { clientCommandId: 'speed-1', expectedClockRevision: 5, rate: 2 },
    });
    expect(liveRaidFinishRequest('raid/id', 'retreat-1')).toEqual({
      path: '/raids/raid%2Fid/finish',
      body: { retreat: true, clientCommandId: 'retreat-1' },
    });
  });

  it('runs live playback only on the current v18 simulator', () => {
    // SIM18 admits the five Phase E passive structures. A SIM17 client has no
    // reviewed placement/content contract for them. The literal pin moves with
    // each deliberate sim bump so the client gate can never drift silently.
    expect(SIM_VERSION).toBe(18);
    expect(() => assertLiveRaidSimVersion(SIM_VERSION)).not.toThrow();
    expect(() => assertLiveRaidSimVersion(SIM_VERSION - 1))
      .toThrow('LIVE RAID REQUIRES SIM VERSION 18');
  });

  it('hydrates only the contiguous server-accepted command prefix', () => {
    const accepted: LiveCommand[] = [
      {
        sequence: 0, clientCommandId: 'accepted-0', acceptedAt: '2026-08-12T00:00:00Z',
        serverOffsetMs: 0, kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 2 },
      },
      {
        sequence: 2, clientCommandId: 'accepted-after-gap', acceptedAt: '2026-08-12T00:00:02Z',
        serverOffsetMs: 2_000, kind: 'buff', payload: { buff: 'warhorn' },
      },
    ];
    expect(hydrateLiveOrders(accepted)).toEqual({
      deploys: [{ troop: 'highlander', tx: 1, ty: 2, tMs: 0 }],
      heroDeploys: [],
    });
  });

  it('keeps start and speed controls in sequence without turning them into SIM orders', () => {
    const controls: LiveCommand[] = [
      {
        sequence: 0, clientCommandId: 'start', acceptedAt: '2026-09-04T00:00:00Z',
        serverOffsetMs: 0, kind: 'start', payload: { expectedClockRevision: 0 },
      },
      {
        sequence: 1, clientCommandId: 'speed', acceptedAt: '2026-09-04T00:00:01Z',
        serverOffsetMs: 1_000, kind: 'speed', payload: { expectedClockRevision: 1, rate: 2 },
      },
      {
        sequence: 2, clientCommandId: 'unit', acceptedAt: '2026-09-04T00:00:02Z',
        serverOffsetMs: 3_000, kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 2 },
      },
    ];
    expect(hydrateLiveOrders(controls)).toEqual({
      deploys: [{ troop: 'highlander', tx: 1, ty: 2, tMs: 3_000 }],
      heroDeploys: [],
    });
  });

  it('advances a canonical playhead at its accepted rate and clamps to duration', () => {
    const clock = {
      protocolVersion: 2 as const,
      revision: 4,
      rate: 2 as const,
      anchorWallAt: '2026-09-04T00:00:00.000Z',
      anchorSimMs: 12_000,
      serverNow: '2026-09-04T00:00:06.000Z',
      simNowMs: 24_000,
      battleEndsAt: '2026-09-04T00:00:39.000Z',
      durationMs: 90_000,
    };
    expect(liveRaidPlayheadMs(clock, 1_000, 4_000)).toBe(30_000);
    // A duplicate receipt must not undo a newer tab's accepted rate or rewind
    // a more recent sample from the same clock segment.
    expect(isNewerRaidClock(clock, { ...clock, revision: 3, rate: 1,
      serverNow: '2026-09-04T00:00:07.000Z' })).toBe(false);
    expect(isNewerRaidClock(clock, { ...clock,
      serverNow: '2026-09-04T00:00:05.000Z' })).toBe(false);
    expect(isNewerRaidClock(clock, clock)).toBe(false);
    expect(isNewerRaidClock(clock, { ...clock,
      serverNow: '2026-09-04T00:00:07.000Z' })).toBe(true);
    expect(isNewerRaidClock(clock, { ...clock, revision: 5, rate: 1 })).toBe(true);
    expect(isNewerRaidClock(null, { ...clock, revision: 0 })).toBe(true);
    expect(liveRaidPlayheadMs(clock, 4_000, 1_000)).toBe(24_000);
    expect(liveRaidPlayheadMs(clock, 1_000, 100_000)).toBe(90_000);
    expect(liveRaidPlayheadMs({ ...clock, anchorWallAt: null, simNowMs: 0 }, 1_000, 4_000)).toBe(0);
    expect(liveRaidNormalFinishDelayMs({ ...clock, rate: 1, simNowMs: 20_000 }, 1_000, 11_000))
      .toBe(60_000);
    expect(liveRaidNormalFinishDelayMs({ ...clock, rate: 2, simNowMs: 20_000 }, 1_000, 11_000))
      .toBe(25_000);
    expect(liveRaidNormalFinishDelayMs({ ...clock, anchorWallAt: null }, 1_000, 11_000))
      .toBeNull();
    expect(clockFromStaleRaidError({ code: 'RAID_CLOCK_STALE', details: { clock } }))
      .toEqual(clock);
    expect(clockFromStaleRaidError({ code: 'OTHER', details: { clock } })).toBeNull();
    expect(clockFromStaleRaidError({
      code: 'RAID_CLOCK_STALE', details: { clock: { ...clock, rate: 8 } },
    })).toBeNull();
  });

  it('rebases completed replay presentation without losing simulator time', () => {
    // WHY: changing a replay from 1x to 2x must preserve the already-viewed
    // prefix while halving every remaining HUD/event wall delay.
    expect(playbackPlayheadMs(2_000, 1_000, 4_000, 1, 90_000)).toBe(5_000);
    expect(playbackPlayheadMs(5_000, 4_000, 7_000, 2, 90_000)).toBe(11_000);
    expect(playbackWallDelayMs(8_001, 2)).toBe(4_001);
    expect(playbackWallDelayMs(-1, 2)).toBe(0);
  });
});

describe('every accepted tap is a unit', () => {
  it('hydrates two accepted commands with identical payloads as two deploys', () => {
    // WHY: the server deduplicates by client command id, never by payload — a
    // re-tap on the same tile is a second unit and nothing downstream collapses
    // it. That is why RaidUI must show a tap the moment it is queued: an
    // impatient re-tap during a slow round-trip lands here as a real deploy.
    const twin = (sequence: number, clientCommandId: string): LiveCommand => ({
      sequence, clientCommandId, kind: 'deploy',
      payload: { troop: 'giant', tx: 2, ty: 9 }, serverOffsetMs: 300 * sequence,
      acceptedAt: '2026-09-04T00:00:00.000Z',
    });
    expect(hydrateLiveOrders([twin(0, 'tap-a'), twin(1, 'tap-b')]).deploys).toEqual([
      { troop: 'giant', tx: 2, ty: 9, tMs: 0 },
      { troop: 'giant', tx: 2, ty: 9, tMs: 300 },
    ]);
    // Only an exact retry (same sequence, same id) is one unit.
    expect(hydrateLiveOrders([twin(0, 'tap-a'), twin(0, 'tap-a')]).deploys).toHaveLength(1);
  });
});
