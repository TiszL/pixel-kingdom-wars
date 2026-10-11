/**
 * ResearchTray view-model rules (army.helpers.ts). The tray itself is a thin
 * render over these helpers (React screens have no DOM harness here), so the
 * tests pin WHY each rule exists rather than what the JSX looks like:
 *
 * - progress must be derived from the SAME researchTimeSec table the server
 *   used to compute finishesAt (the DTO has no startedAt — a wrong index and
 *   the bar lies about how long is left);
 * - row gating must mirror researchTroop's server gates (forge level,
 *   one-at-a-time, max level) so a tappable button is never a guaranteed 422;
 * - FINISH affordability must only ever DISABLE a doomed tap, never block on
 *   an unknown balance — the server is the enforcer.
 */
import { readFileSync } from 'node:fs';
import { speedupCostKeep, TROOPS, TROOP_LEVELING } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  finishShortfall, forgeLevelFromBase, holdTrainDelayMs, maxTrainableUnits, nextTrainingCancelTarget,
  queueRemainingSec, researchProgress, researchRowState, trainingCancelTarget,
  troopUnlockView, manualTrainingRoom,
} from './army.helpers';
import { TRAINING_PRESETS } from '@shardkeep/shared';
import { troopRolloutGate } from '../troopRollout';

describe('manual training population budget', () => {
  it('reserves mixed draft and queued population against both independent capacities', () => {
    const army = { rosterPts: 40, campCapacityPts: 100, barracksQueuePts: 30,
      queue: [{ troop: 'giant' }, { troop: 'bowman' }] };
    const draft = [{ troop: 'giant', count: 2 }, { troop: 'bowman', count: 1 }];
    const queued = TROOPS.giant.pts + TROOPS.bowman.pts;
    const selected = 2 * TROOPS.giant.pts + TROOPS.bowman.pts;
    expect(manualTrainingRoom(army, draft)).toEqual({ queuePts: queued, draftPts: selected,
      campFreePts: 100 - 40 - queued - selected, queueFreePts: 30 - queued - selected });
    expect(draft).toEqual([{ troop: 'giant', count: 2 }, { troop: 'bowman', count: 1 }]);
  });
});

describe('army currency labels', () => {
  it('distinguishes SHARDS training, free queue completion and explicit paid research review', () => {
    const source = readFileSync(new URL('./army.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<Icon name="shard" size={14} />{t.shardCost}');
    // Owner 2026-09-08: the server's first-army offer is explicitly FREE.
    // Paid queue and research actions both fetch exact server currency/price.
    expect(source).toContain('freeOffer={data.freeFinishAllOffer ?? null}');
    expect(source).toContain("FINISH ALL · {freeOffer ? 'FREE' : 'REVIEW'}");
    expect(source).not.toContain('speedupCostKeep(');
    expect(source).toContain('⚡ FINISH · REVIEW');
    const research = source.slice(source.indexOf('function ResearchActive'), source.indexOf('export function ArmyRoster'));
    expect(research).not.toContain('speedupCostKeep(');
    expect(research).toContain('money.begin({ troop: troop as TroopType, baseId: selectedBaseId })');
    expect(source).not.toContain('{t.keepCost}');
  });
});

describe('troopRolloutGate — dark roster activation is server-authoritative', () => {
  it('fails closed for all three fielded units when an old server omits the capability', () => {
    for (const troop of ['gloamfang', 'direwyvern', 'hexbarrow']) {
      expect(troopRolloutGate(troop, undefined)).toEqual({
        locked: true, message: 'COMING SOON',
      });
    }
  });

  it('uses the server rollout message and opens only on explicit enabled=true', () => {
    expect(troopRolloutGate('gloamfang', {
      enabled: false, code: 'rollout_paused', message: 'ROLLOUT PAUSED',
    })).toEqual({ locked: true, message: 'ROLLOUT PAUSED' });
    expect(troopRolloutGate('gloamfang', {
      enabled: true, code: 'active', message: 'AVAILABLE',
    })).toEqual({ locked: false });
  });

  it('never gates the established roster with the future capability', () => {
    expect(troopRolloutGate('bowman', undefined)).toEqual({ locked: false });
    expect(troopRolloutGate('dragon', { enabled: false })).toEqual({ locked: false });
  });
});

describe('troopUnlockView — training/research mirrors the server WRIT gate (D-058)', () => {
  // REWRITTEN 2026-08-16: the owner replaced the elite Keep-level gates with
  // unlock ITEMS ("dragon only can be dropped from gold forge, same for wyvern
  // and rest of other way unlocked troops"). The card must teach the real
  // unlock path — forge drop vs the 5,000-KEEP mage writ — from the SERVER's
  // eliteUnlocks verdict, and fail closed while that verdict is loading.
  it('locks every elite troop until the server says the writ was consumed', () => {
    for (const troop of ['gloamfang', 'hexbarrow', 'direwyvern', 'dragon'] as const) {
      expect(troopUnlockView(troop, 20, { [troop]: false })).toEqual({
        locked: true, kind: 'elite', label: 'DROPS FROM GOLD FORGE',
        itemAsset: `ui_portrait_${troop}_t1`,
      });
    }
    // The mage writ is the purchasable one — the label carries its KEEP price.
    expect(troopUnlockView('mage', 20, {})).toEqual({
      locked: true, kind: 'elite', label: 'UNLOCK: 5,000 KEEP WRIT',
      itemAsset: 'ui_portrait_mage_t1',
    });
  });

  it('unlocks on the server verdict and fails closed while /army loads', () => {
    expect(troopUnlockView('direwyvern', 1, { direwyvern: true })).toEqual({ locked: false });
    expect(troopUnlockView('direwyvern', 20, undefined).locked).toBe(true);
    // Non-elite roster never writ-gates, even with no data at all.
    expect(troopUnlockView('bowman', undefined, undefined)).toEqual({ locked: false });
  });
});

describe('researchProgress — start derived from the shared duration table', () => {
  // L1→L2 research: the server computed finishesAt = start + researchTimeSec[0]
  // (army.ts researchTroop uses index `current − 1` = `toLevel − 2`).
  const totalSec = TROOP_LEVELING.researchTimeSec[0]!;
  const finish = new Date('2026-01-01T12:00:00Z');
  const finishStr = finish.toISOString();

  it('reads 0% at the derived start and 100% at finishesAt', () => {
    const atStart = researchProgress(2, finishStr, finish.getTime() - totalSec * 1000);
    expect(atStart.remSec).toBe(totalSec);
    expect(atStart.pct).toBe(0);
    const atEnd = researchProgress(2, finishStr, finish.getTime());
    expect(atEnd.remSec).toBe(0);
    expect(atEnd.pct).toBe(100);
  });

  it('reads 50% halfway — the bar tracks the server clock, not a guess', () => {
    const half = researchProgress(2, finishStr, finish.getTime() - (totalSec / 2) * 1000);
    expect(half.pct).toBeCloseTo(50, 5);
  });

  it('clamps past finishesAt (lazy completion: the row can outlive its timer)', () => {
    const late = researchProgress(2, finishStr, finish.getTime() + 60_000);
    expect(late.remSec).toBe(0);
    expect(late.pct).toBe(100);
  });

  it('uses the toLevel−2 row: an L4→L5 bar must consume the L4 duration', () => {
    const t = TROOP_LEVELING.researchTimeSec[3]!; // from-level 4 ⇒ index 3
    const start = researchProgress(5, finishStr, finish.getTime() - t * 1000);
    expect(start.pct).toBe(0);
    expect(start.remSec).toBe(t);
  });

  it('renders an out-of-table toLevel as complete, not a stuck empty bar', () => {
    expect(researchProgress(999, finishStr, finish.getTime() - 1000).pct).toBe(100);
  });
});

describe('researchRowState — mirrors researchTroop server gates', () => {
  it('ready row quotes the exact cost/duration the server will charge (lv×400 rule)', () => {
    const row = researchRowState('dragon', 3, null, 20);
    expect(row).toEqual({
      kind: 'ready',
      costShards: TROOP_LEVELING.researchCostKeep[2],
      durationSec: TROOP_LEVELING.researchTimeSec[2],
      toLevel: 4,
    });
  });

  it('forge gate: blocked names the level the server 422 would name (next > forge)', () => {
    expect(researchRowState('dragon', 5, null, 5)).toEqual({ kind: 'needsForge', forgeLevel: 6 });
  });

  it('forge gate boundary: next === forge level is allowed (rule is next ≤ forge)', () => {
    expect(researchRowState('dragon', 4, null, 5).kind).toBe('ready');
  });

  it('one-at-a-time: another running research locks every other row', () => {
    expect(researchRowState('dragon', 3, 'giant', 20)).toEqual({ kind: 'forgeBusy' });
    expect(researchRowState('giant', 3, 'giant', 20)).toEqual({ kind: 'researching' });
  });

  it('maxed wins over forgeBusy — a maxed troop can never research again', () => {
    expect(researchRowState('dragon', TROOP_LEVELING.maxLevel, 'giant', 20)).toEqual({ kind: 'maxed' });
  });
});

describe('forgeLevelFromBase — mirrors completedBuildingsOf', () => {
  const forge = (id: string, level: number): { id: string; type: string; level: number } => ({ id, type: 'forge', level });

  it('takes the highest COMPLETED forge; a forge inside its build job does not count', () => {
    const buildings = [forge('a', 3), forge('b', 9), { id: 'c', type: 'barracks', level: 20 }];
    // b is still under construction → only a's L3 gates research open.
    expect(forgeLevelFromBase(buildings, [{ kind: 'build', buildingId: 'b' }])).toBe(3);
    expect(forgeLevelFromBase(buildings, [])).toBe(9);
  });

  it('an UPGRADING forge still counts at its current level (only build jobs exclude)', () => {
    expect(forgeLevelFromBase([forge('a', 4)], [{ kind: 'upgrade', buildingId: 'a' }])).toBe(4);
  });

  it('no forge ⇒ 0 (every next level gates as NEEDS FORGE, like the server 422)', () => {
    expect(forgeLevelFromBase([], [])).toBe(0);
    expect(researchRowState('dragon', 1, null, 0)).toEqual({ kind: 'needsForge', forgeLevel: 2 });
  });
});

describe('queueRemainingSec — ⚡ FINISH ALL prices the WHOLE queue (F1)', () => {
  const now = new Date('2026-01-01T12:00:00Z').getTime();
  const at = (msFromNow: number): { finishesAt: string } => ({ finishesAt: new Date(now + msFromNow).toISOString() });

  it('remaining = the TAIL row finish — "getting ready to attack" means the army, not the head unit', () => {
    const queue = [at(60_000), at(300_000), at(3_600_000)]; // /army is finishesAt-ordered
    expect(queueRemainingSec(queue, now)).toBe(3600);
    // The price shown must be tail-shaped: a head-priced label would quote the
    // player less than the server charges for completing everything.
    expect(speedupCostKeep(queueRemainingSec(queue, now))).toBeGreaterThan(speedupCostKeep(60));
  });

  it('never SUMS row times — the queue rows tick concurrently (trainTroop stamps finishesAt at enqueue), so the tail already contains the overlap', () => {
    const queue = [at(120_000), at(180_000)];
    expect(queueRemainingSec(queue, now)).toBe(180); // not 120+180
  });

  it('empty queue → 0 (no queue card, no FINISH ALL)', () => {
    expect(queueRemainingSec([], now)).toBe(0);
  });

  it('overdue tail clamps to 0 — lazy completion can lag the timer', () => {
    expect(queueRemainingSec([at(-5_000)], now)).toBe(0);
  });

  it('ceils to whole seconds, matching the server remSec = ceil((finish−now)/1000) so label and charge agree', () => {
    expect(queueRemainingSec([at(1_500)], now)).toBe(2);
  });
});

describe('trainingCancelTarget — grouped −1 cancels the least-progressed exact row', () => {
  const row = (id: string, troop: string, ms: number, canCancel = true, refundShards: string | null = '40') => ({
    id, troop, finishesAt: new Date(ms).toISOString(), canCancel, refundShards,
  });

  it('selects the latest-finishing refundable identity of the requested troop', () => {
    const queue = [
      row('old', 'bowman', 1_000),
      row('other', 'giant', 9_000),
      row('new', 'bowman', 5_000),
    ];
    expect(trainingCancelTarget(queue, 'bowman')).toEqual({
      id: 'new', troop: 'bowman', finishesAt: new Date(5_000).toISOString(), refundShards: '40',
    });
  });

  it('skips pre-update/unpriced rows and fails closed when no exact refund exists', () => {
    expect(trainingCancelTarget([
      row('v1', 'bowman', 9_000, false, null),
      row('v2', 'bowman', 1_000, true, '40'),
    ], 'bowman')?.id).toBe('v2');
    expect(trainingCancelTarget([row('v1', 'bowman', 9_000, false, null)], 'bowman')).toBeNull();
  });
});

describe('nextTrainingCancelTarget — tap-tap-tap resolves distinct ids without a refetch (D-096)', () => {
  const row = (id: string, troop: string, ms: number, canCancel = true, refundShards: string | null = '40') => ({
    id, troop, finishesAt: new Date(ms).toISOString(), canCancel, refundShards,
  });
  const queue = [row('a', 'bowman', 1_000), row('b', 'bowman', 5_000), row('c', 'bowman', 9_000)];

  it('walks latest-first past ids already spoken for — three taps target c, b, a', () => {
    const pending = new Set<string>();
    for (const expected of ['c', 'b', 'a']) {
      const next = nextTrainingCancelTarget(queue, 'bowman', pending)!;
      expect(next.id).toBe(expected);
      pending.add(next.id);
    }
  });

  it('is null once every refundable row is pending — the extra tap is a no-op, never a duplicate POST', () => {
    expect(nextTrainingCancelTarget(queue, 'bowman', new Set(['a', 'b', 'c']))).toBeNull();
  });

  it('with nothing pending it is exactly trainingCancelTarget (same rule, same row)', () => {
    expect(nextTrainingCancelTarget(queue, 'bowman', new Set())).toEqual(trainingCancelTarget(queue, 'bowman'));
  });
});

describe('holdTrainDelayMs — press-and-hold ramps but never hammers or steals the tap', () => {
  it('first repeat is slow enough that a deliberate tap never trains a second unit', () => {
    // A quick tap releases in well under this; the first repeat must not have
    // fired yet, or "tap = exactly one" (the must-not-regress) breaks.
    expect(holdTrainDelayMs(0)).toBeGreaterThanOrEqual(300);
  });

  it('accelerates: every later tick is at most as long as the one before it', () => {
    for (let n = 1; n <= 12; n++) {
      expect(holdTrainDelayMs(n)).toBeLessThanOrEqual(holdTrainDelayMs(n - 1));
    }
    // and it actually ramps — the first repeat is strictly slower than steady state
    expect(holdTrainDelayMs(0)).toBeGreaterThan(holdTrainDelayMs(20));
  });

  it('caps at a server-safe ceiling — the steady rate stays inside ~4–6/sec', () => {
    const steady = holdTrainDelayMs(50);
    expect(steady).toBeGreaterThanOrEqual(1000 / 6); // never faster than 6/sec
    expect(steady).toBeLessThanOrEqual(1000 / 4); // still feels like a hold (≥4/sec)
    expect(holdTrainDelayMs(9999)).toBe(steady); // clamped, not shrinking to 0
  });

  it('is defined for the first tick and ignores garbage indices (no negative/NaN delay)', () => {
    expect(holdTrainDelayMs(-5)).toBe(holdTrainDelayMs(0)); // clamp to the first repeat
    expect(holdTrainDelayMs(2.7)).toBe(holdTrainDelayMs(2)); // floored index
  });
});

describe('finishShortfall — FINISH may only be disabled by a KNOWN short balance', () => {
  it('short balance disables with the need/have reason', () => {
    expect(finishShortfall('100', 250)).toBe('NEED 250 KEEP · HAVE 100');
  });

  it('exact balance is affordable (the server debits ≤ what it quoted)', () => {
    expect(finishShortfall('250', 250)).toBeNull();
    expect(finishShortfall('251', 250)).toBeNull();
  });

  it('unknown or garbage balance never blocks — the server is the enforcer', () => {
    expect(finishShortfall(undefined, 250)).toBeNull();
    expect(finishShortfall('not-a-number', 250)).toBeNull();
  });
});

describe('maxTrainableUnits — +10 / MAX pass through the +1 gate (tester request 2026-09-16)', () => {
  // WHY: MAX must land exactly where tap-tap-tap would have stopped. If it
  // read a different ceiling than the +1 rule, the card could select an army
  // the server's quote then trims, and "MAX" would quietly mean "too many".
  const army = { rosterPts: 40, campCapacityPts: 100, barracksQueuePts: 30, queue: [{ troop: 'bowman' }] };
  it('is the tightest of army room, queue room and the composition cap, in whole units', () => {
    const queued = TROOPS.bowman.pts;
    const campFree = 100 - 40 - queued;
    const queueFree = 30 - queued;
    expect(maxTrainableUnits(army, [], 'bowman')).toBe(Math.min(
      Math.floor(campFree / TROOPS.bowman.pts), Math.floor(queueFree / TROOPS.bowman.pts), TRAINING_PRESETS.maxCompositionUnits,
    ));
  });
  it('counts the current draft against every ceiling — a MAX after a MAX is 0', () => {
    const n = maxTrainableUnits(army, [], 'bowman');
    expect(n).toBeGreaterThan(0);
    expect(maxTrainableUnits(army, [{ troop: 'bowman', count: n }], 'bowman')).toBe(0);
    expect(maxTrainableUnits(army, [{ troop: 'bowman', count: n }], 'giant')).toBe(0);
  });
  it('a queue too full for even one unit yields 0, never a negative', () => {
    expect(maxTrainableUnits({ ...army, barracksQueuePts: 0 }, [], 'bowman')).toBe(0);
  });
  it('honours the composition cap when capacity is huge', () => {
    const roomy = { rosterPts: 0, campCapacityPts: 1_000_000, barracksQueuePts: 1_000_000, queue: [] };
    expect(maxTrainableUnits(roomy, [{ troop: 'giant', count: 3 }], 'bowman')).toBe(TRAINING_PRESETS.maxCompositionUnits - 3);
  });
  it('an unknown troop cannot be selected at all', () => {
    expect(maxTrainableUnits(army, [], 'not-a-troop')).toBe(0);
  });
});

describe('troop research names the ALCHEMY LAB, never the FORGE (tester report 2026-09-16)', () => {
  // WHY: the research building is shown as ALCHEMY LAB everywhere else
  // (BuildingInfo, the sheet header); "FORGE BUSY" beside a Gold Forge on the
  // same base read as the wrong building. `forge` stays the saved identity.
  it('the research tray gates say ALCHEMY LAB', () => {
    const source = readFileSync(new URL('./army.tsx', import.meta.url), 'utf8');
    expect(source).toContain('ALCHEMY LAB BUSY · 1 AT A TIME');
    expect(source).toContain('NEEDS ALCHEMY LAB L{row.forgeLevel}');
    expect(source).toContain('at the Alchemy Lab.');
    expect(source).not.toContain('FORGE BUSY');
    expect(source).not.toContain('NEEDS FORGE L{');
  });
  it('the research cancel dialog frees the ALCHEMY LAB', () => {
    const source = readFileSync(new URL('../CancelJobConfirm.tsx', import.meta.url), 'utf8');
    expect(source).toContain("'THE ALCHEMY LAB IS FREED'");
    expect(source).not.toContain("'THE FORGE IS FREED'");
  });
});
