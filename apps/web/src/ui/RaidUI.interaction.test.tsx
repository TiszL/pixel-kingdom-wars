import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { RAID_CAMERA, RAID_RULES } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';

// This unit owns the HUD boundary only. Keep wallet/sheet hooks out of the Node
// import graph; their browser providers are unrelated to event propagation.
vi.mock('../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: vi.fn() }));

import {
  RAID_HUD_BOUNDARY_STYLE,
  RAID_HUD_INPUT_PROPS,
  RAID_DEPLOY_UI,
  RAID_TRAY_SCROLL_STYLE,
  RaidUI,
  raidSpeedUnavailableReason,
  RaidHudInputBoundary,
  raidCreateRequest,
  createRaidWithProtocolFallback,
  battleCameraInsets,
  batchAutoSubmitAtMs,
  batchDeployEndsAtMs,
  liveDeployEndsAtMs,
  raidDeployTrayTroops,
  raidDeployLayout,
  raidCameraControlLayout,
  liveRaidCommandRequest,
  resumableCommittedRaid,
  resumableRaidById,
  savedReplayPath,
  snappedDeployIsVisible,
  targetForResumedRaid,
  unavailableFrozenHeroes,
} from './RaidUI';

describe('comfortable battle deployment deck', () => {
  it.each([
    ['desktop', 1440, 900, false, RAID_DEPLOY_UI.desktopCardW, RAID_DEPLOY_UI.desktopArt],
    ['390×844 portrait phone', 390, 844, false, RAID_DEPLOY_UI.portraitCardW, RAID_DEPLOY_UI.portraitArt],
    ['915×311 Seeker landscape', 915, 311, true, RAID_DEPLOY_UI.landscapeCardW, RAID_DEPLOY_UI.landscapeArt],
  ] as const)('solves %s without shrinking any action below 44px', (
    _name, w, h, oneRow, cardWidth, artSize,
  ) => {
    const layout = raidDeployLayout(w, h);
    expect(layout).toMatchObject({ oneRow, cardWidth, artSize });
    expect(layout.cardHeight).toBeGreaterThanOrEqual(RAID_DEPLOY_UI.tap);
    expect(layout.actionHeight).toBeGreaterThanOrEqual(RAID_DEPLOY_UI.tap);
    expect(layout.trayMaxHeight).toBeLessThan(h / 2);
  });

  it('keeps the 915×311 camera controls in one row between HUD and measured tray', () => {
    const viewport = { w: 915, h: 311 };
    const trayHeight = 112;
    const slot = raidCameraControlLayout(
      viewport,
      raidDeployLayout(viewport.w, viewport.h),
      trayHeight,
      { top: 0, right: 28, bottom: 0, left: 12 },
    );

    expect(slot).toMatchObject({ horizontal: true, height: RAID_DEPLOY_UI.tap });
    expect(slot.width).toBe(RAID_DEPLOY_UI.tap * 3 + RAID_DEPLOY_UI.cameraGap * 2);
    expect(slot.right).toBe(RAID_DEPLOY_UI.cameraEdge + 28);
    expect(slot.top).toBeGreaterThanOrEqual(RAID_CAMERA.hudTopPx);
    expect(slot.top + slot.height).toBeLessThanOrEqual(
      viewport.h - trayHeight - RAID_CAMERA.pillGapPx,
    );
  });

  it('keeps portrait camera controls on the vertical rail above the measured tray', () => {
    const viewport = { w: 390, h: 844 };
    const trayHeight = 172;
    const slot = raidCameraControlLayout(
      viewport,
      raidDeployLayout(viewport.w, viewport.h),
      trayHeight,
      { top: 28, right: 0, bottom: 24, left: 0 },
    );

    expect(slot).toMatchObject({
      horizontal: false,
      width: RAID_DEPLOY_UI.tap,
      height: RAID_DEPLOY_UI.tap * 3 + RAID_DEPLOY_UI.cameraGap * 2,
      bottom: trayHeight + RAID_CAMERA.pillGapPx,
    });
    expect(slot.top).toBeGreaterThanOrEqual(RAID_CAMERA.hudTopPx + 28);
    expect(slot.top + slot.height).toBeLessThanOrEqual(viewport.h - trayHeight);
  });
});

describe('battle camera safe area', () => {
  it('rejects a legal snap whose final actor envelope would sit under HUD chrome', () => {
    expect(snappedDeployIsVisible({ tx: 4, ty: 3 }, ['4,4', '5,4'])).toBe(false);
    expect(snappedDeployIsVisible({ tx: 4, ty: 4 }, ['4,4', '5,4'])).toBe(true);
    expect(snappedDeployIsVisible({ tx: 4, ty: 3 })).toBe(true);
    const actualPreview = vi.fn(() => false);
    expect(snappedDeployIsVisible(
      { tx: 4, ty: 4 }, ['4,4'], actualPreview, 'direwyvern',
    )).toBe(false);
    expect(actualPreview).toHaveBeenCalledWith({ tx: 4, ty: 4 }, 'direwyvern', undefined);
  });
  it('excludes the native control clearance from the full painted battle without counting safe-area padding twice', () => {
    expect(battleCameraInsets(96, 184, { top: 28, right: 0, bottom: 34, left: 0 }, 64))
      .toEqual({ top: 124, bottom: 248, left: 0, right: 0 });
  });
  it('keeps a Solana Mobile portrait cutout and measured tray outside the fit rect', () => {
    expect(battleCameraInsets(96, 184, { top: 28, right: 0, bottom: 24, left: 0 }))
      .toEqual({ top: 124, bottom: 184, left: 0, right: 0 });
  });

  it('reserves the landscape side cutout independently of the tray', () => {
    expect(battleCameraInsets(96, 112, { top: 0, right: 28, bottom: 0, left: 12 }))
      .toEqual({ top: 96, bottom: 112, left: 12, right: 28 });
  });
});

describe('batch deploy deadline', () => {
  const createdAt = Date.parse('2026-08-13T12:00:00.000Z');
  const ordersDeadlineAt = new Date(createdAt + (
    RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec
  ) * 1_000).toISOString();

  it('uses all 30 deploy seconds only when the API advertises its replay tail', () => {
    expect(batchDeployEndsAtMs(ordersDeadlineAt, RAID_RULES.batchOrdersGraceSec) - createdAt)
      .toBe(RAID_RULES.deployWindowSec * 1_000);
    expect(batchAutoSubmitAtMs(ordersDeadlineAt, RAID_RULES.batchOrdersGraceSec) - createdAt)
      .toBe(RAID_RULES.deployWindowSec * 1_000);
  });

  it('keeps old-web safety margins against an old API or pre-rollout pending row', () => {
    // WHY: an absent capability means the server may still reject at the stored
    // deploy+fight boundary. New web must not spend the extra five seconds until
    // it knows the API accepts the bounded finalization tail.
    expect(batchDeployEndsAtMs(ordersDeadlineAt) - createdAt).toBe(27_000);
    expect(batchAutoSubmitAtMs(ordersDeadlineAt) - createdAt).toBe(25_000);
  });

  it('keeps live first-deploy authority at exactly 30 seconds', () => {
    expect(liveDeployEndsAtMs(ordersDeadlineAt) - createdAt)
      .toBe(RAID_RULES.deployWindowSec * 1_000);
  });
});

const resumable = {
  id: 'pending-raid', defenderWallet: 'defender-wallet', defenderBaseId: 'defender-base',
  attackerBaseId: 'attacker-base', pveCampId: null, campaignStage: null,
  snapshot: {}, armySnapshot: { counts: {}, levels: {} },
  ordersDeadlineAt: '2026-08-12T12:05:00.000Z', seed: 7, simVersion: SIM_VERSION, heroReserved: true,
};

describe('lost pending-raid recovery', () => {
  it('resumes only the attacker exact live march named by the hero conflict', () => {
    const error = new ApiError(409, 'hero committed', 'HERO_ALREADY_COMMITTED');
    expect(resumableCommittedRaid(error, [resumable], Date.parse('2026-08-12T12:00:00.000Z')))
      .toEqual(resumable);
    expect(resumableRaidById([resumable], 'pending-raid', Date.parse('2026-08-12T12:00:00.000Z')))
      .toEqual(resumable);
  });

  it('does not revive an expired march or branch on an unrelated conflict', () => {
    const rows = [resumable];
    expect(resumableCommittedRaid(
      new ApiError(409, 'hero committed', 'HERO_ALREADY_COMMITTED'), rows,
      Date.parse('2026-08-12T12:05:00.000Z'),
    )).toBeNull();
    expect(resumableCommittedRaid(new ApiError(409, 'other', 'OTHER'), rows, 0)).toBeNull();
  });

  it('restores the frozen PvP, PvE, and campaign navigation identity', () => {
    expect(targetForResumedRaid(resumable)).toEqual({
      kind: 'pvp', raidId: 'pending-raid', wallet: 'defender-wallet', defenderBaseId: 'defender-base',
    });
    expect(targetForResumedRaid({ ...resumable, pveCampId: 'camp-id' }))
      .toEqual({ kind: 'pve', campId: 'camp-id', raidId: 'pending-raid' });
    expect(targetForResumedRaid({ ...resumable, campaignStage: 4 }))
      .toEqual({ kind: 'campaign', stage: 4, raidId: 'pending-raid' });
  });
});

describe('stable-base raid request identity', () => {
  it('carries the selected attacker and exact defender base through PvP', () => {
    expect(raidCreateRequest({
      kind: 'pvp', wallet: 'defender-wallet', defenderBaseId: 'defender-base',
    }, 'attacker-base', 'idem-1234')).toEqual({
      path: '/raids',
      body: {
        defenderWallet: 'defender-wallet', defenderBaseId: 'defender-base', attackerBaseId: 'attacker-base',
        idempotencyKey: 'idem-1234', raidProtocolVersion: 2,
      },
      raw: true,
    });
  });

  it.each([
    [{ kind: 'pve', campId: 'camp' } as const, '/raids/pve', { campId: 'camp' }],
    [{ kind: 'campaign', stage: 37 } as const, '/campaign/37/raid', {}],
  ])('carries the selected attacker base through %s', (target, path, extra) => {
    expect(raidCreateRequest(target, 'attacker-base', 'idem-1234')).toEqual({
      path,
      body: {
        ...extra, idempotencyKey: 'idem-1234', attackerBaseId: 'attacker-base',
        raidProtocolVersion: 2,
      },
      raw: true,
    });
  });

  it('retries the exact create identity as v1 only for explicit v2 disablement', async () => {
    const request = raidCreateRequest(null, 'attacker-base', 'stable-id');
    const send = vi.fn()
      .mockRejectedValueOnce(new ApiError(503, 'disabled', 'LIVE_RAID_V2_DISABLED'))
      .mockResolvedValueOnce({ raid: { id: 'raid-1' } });
    await expect(createRaidWithProtocolFallback(request, send)).resolves
      .toEqual({ raid: { id: 'raid-1' } });
    expect(send).toHaveBeenNthCalledWith(1, '/raids', {
      attackerBaseId: 'attacker-base', idempotencyKey: 'stable-id', raidProtocolVersion: 2,
    });
    expect(send).toHaveBeenNthCalledWith(2, '/raids', {
      attackerBaseId: 'attacker-base', idempotencyKey: 'stable-id',
    });

    const failure = new ApiError(503, 'offline', 'NETWORK_UNAVAILABLE');
    await expect(createRaidWithProtocolFallback(request, vi.fn().mockRejectedValue(failure)))
      .rejects.toBe(failure);
  });
});

describe('private replay authorization routing', () => {
  it('keeps an immutable participant endpoint ahead of deed and legacy fallbacks', () => {
    // WHY: after a sale the prior participant no longer owns replayBaseId. WATCH
    // AGAIN must reuse the participant scope selected by Battle History.
    expect(savedReplayPath({
      replayPath: '/battles/participated/raid%2Fid/replay',
      replayBaseId: 'sold-base',
    }, 'raid/id')).toBe('/battles/participated/raid%2Fid/replay');
    expect(savedReplayPath({ replayBaseId: 'base/id' }, 'raid/id'))
      .toBe('/bases/base%2Fid/battles/raid%2Fid/replay');
  });
});

describe('stable PvP command stream request identity', () => {
  it('binds an accepted deploy to one reusable client command id', () => {
    expect(liveRaidCommandRequest('raid/id', 'command-123', {
      kind: 'deploy', payload: { troop: 'highlander', tx: 3, ty: 4 },
    })).toEqual({
      path: '/raids/raid%2Fid/commands',
      body: {
        clientCommandId: 'command-123',
        command: { kind: 'deploy', payload: { troop: 'highlander', tx: 3, ty: 4 } },
      },
    });
  });

  it('maps hero, rally, and buff without a client-authored timestamp', () => {
    for (const command of [
      { kind: 'hero' as const, payload: { hero: 'vex' as const, tx: 5, ty: 6 } },
      { kind: 'rally' as const, payload: { tx: 7, ty: 8 } },
      { kind: 'buff' as const, payload: { buff: 'warhorn' as const } },
    ]) {
      const request = liveRaidCommandRequest('raid', 'stable-id', command);
      expect(request.body).toEqual({ clientCommandId: 'stable-id', command });
      expect(request.body.command.payload).not.toHaveProperty('tMs');
    }
  });
});

describe('raid deploy rollout capability', () => {
  it('keeps recovering heroes visible as disabled members of the frozen roster', () => {
    const base = {
      baseId: 'attacker-base', heroes: [
        { hero: 'vex' as const, recoveryUntil: null, available: true },
        { hero: 'theodor' as const, recoveryUntil: '2026-08-13T12:00:00.000Z', available: false },
      ],
    } as ReturnType<typeof import('../state/store').useApp.getState>['base'];
    expect(unavailableFrozenHeroes({
      attackerBaseId: 'attacker-base',
      armySnapshot: { counts: {}, levels: {}, heroes: ['vex'] },
    }, base)).toEqual([expect.objectContaining({ hero: 'theodor', available: false })]);
    expect(unavailableFrozenHeroes({
      attackerBaseId: 'another-base',
      armySnapshot: { counts: {}, levels: {}, heroes: [] },
    }, base)).toEqual([]);
  });

  it('fails closed on old-server omission and never exposes spawn-only Barrowling', () => {
    const troops = raidDeployTrayTroops({ counts: {} });
    expect(troops).not.toContain('gloamfang');
    expect(troops).not.toContain('direwyvern');
    expect(troops).not.toContain('hexbarrow');
    expect(troops).not.toContain('barrowling');
    expect(troops).toContain('bowman');
  });

  it('exposes exactly the three fielded roots on explicit server activation', () => {
    const troops = raidDeployTrayTroops({
      counts: {},
      features: {
        darkAttackerRoster: { enabled: true, code: 'active', message: 'AVAILABLE' },
      },
    });
    expect(troops).toEqual(expect.arrayContaining([
      'gloamfang', 'direwyvern', 'hexbarrow',
    ]));
    expect(troops).not.toContain('barrowling');
  });
});

describe('Raid HUD canvas-input boundary', () => {
  it.each([
    'onMouseDown',
    'onTouchStart',
  ] as const)('%s stops the native event before Phaser window listeners see it', (name) => {
    const stopPropagation = vi.fn();

    RAID_HUD_INPUT_PROPS[name]({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('leaves releases unhandled so a field-origin gesture can reach Phaser pointerupoutside', () => {
    expect(RAID_HUD_INPUT_PROPS).not.toHaveProperty('onMouseUp');
    expect(RAID_HUD_INPUT_PROPS).not.toHaveProperty('onTouchEnd');
    expect(RAID_HUD_INPUT_PROPS).not.toHaveProperty('onTouchCancel');
  });

  it.each(['onDragStart', 'onContextMenu'] as const)(
    '%s prevents native browser chrome without disabling tray scrolling',
    (name) => {
      const preventDefault = vi.fn();

      RAID_HUD_INPUT_PROPS[name]({ preventDefault });

      expect(preventDefault).toHaveBeenCalledOnce();
    },
  );

  it('prevents text selection across the HUD', () => {
    expect(RAID_HUD_BOUNDARY_STYLE).toMatchObject({
      pointerEvents: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
    });
  });

  it('puts the tested handlers and selection guard on its rendered boundary', () => {
    const element = RaidHudInputBoundary({ children: 'HUD' }) as ReactElement<{
      children: ReactNode;
      style: CSSProperties;
      onMouseDown: typeof RAID_HUD_INPUT_PROPS.onMouseDown;
      onTouchStart: typeof RAID_HUD_INPUT_PROPS.onTouchStart;
      onDragStart: typeof RAID_HUD_INPUT_PROPS.onDragStart;
      onContextMenu: typeof RAID_HUD_INPUT_PROPS.onContextMenu;
    }>;

    expect(element.props).toMatchObject(RAID_HUD_INPUT_PROPS);
    expect(element.props.style).toBe(RAID_HUD_BOUNDARY_STYLE);
  });

  it('structurally wraps every production RaidUI branch in the tested boundary', () => {
    // RaidUI itself intentionally has no hooks: it returns the boundary around
    // the hook-heavy content child, so this assertion exercises the real export
    // without needing a browser/provider harness.
    const element = RaidUI() as ReactElement<{ children: ReactNode }>;

    expect(element.type).toBe(RaidHudInputBoundary);
    expect(element.props.children).toBeTruthy();
  });

  it('preserves native horizontal touch scrolling while containing scroll chaining', () => {
    expect(RAID_TRAY_SCROLL_STYLE).toMatchObject({
      overflowX: 'auto',
      overflowY: 'hidden',
      overscrollBehaviorX: 'contain',
      touchAction: 'pan-x',
      WebkitOverflowScrolling: 'touch',
    });
  });
});


describe('truthful live speed availability', () => {
  it('explains legacy, pending and disconnected states without presenting a local live-battle multiplier', () => {
    expect(raidSpeedUnavailableReason(1, 'playing', false, false)).toBe('LEGACY RAID · 1× ONLY');
    expect(raidSpeedUnavailableReason(2, 'deploying', false, false)).toBe('SPEED AVAILABLE AFTER ATTACK');
    expect(raidSpeedUnavailableReason(2, 'playing', true, false)).toBe('SPEED UNAVAILABLE WHILE RECONNECTING');
    expect(raidSpeedUnavailableReason(2, 'playing', false, true)).toBe('SAVING SPEED…');
    expect(raidSpeedUnavailableReason(2, 'playing', false, false)).toBeUndefined();
  });
});
