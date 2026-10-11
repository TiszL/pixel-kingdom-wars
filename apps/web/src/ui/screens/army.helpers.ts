/**
 * Pure view-model helpers for the Forge ResearchTray + Barracks TrainQueue
 * (army.tsx) — extracted so the rules the trays render (progress with no
 * startedAt, the Forge-level gate, the one-at-a-time lock, FINISH
 * affordability, whole-queue remaining time) are unit-testable without
 * dragging army.tsx's import graph (→ sheets.tsx → wallet/auth stack) into
 * vitest. Every number comes from @shardkeep/shared; everything here is
 * DISPLAY-only — the server re-validates and re-prices every POST.
 */
import {
  ELITE_TROOP_UNLOCKS, ITEMS, TRAINING_PRESETS, TROOPS, TROOP_LEVELING, isEliteTroop,
  type ItemSpec, type TroopStats,
} from '@shardkeep/shared';

/** Manual selection reserves room in both server capacities. Presets may still
 * request a larger army and use the server's explicit partial quote. */
export function manualTrainingRoom(
  army: { queue: ReadonlyArray<{ troop: string }>; rosterPts: number; campCapacityPts: number; barracksQueuePts: number },
  draft: ReadonlyArray<{ troop: string; count: number }>,
): { queuePts: number; draftPts: number; campFreePts: number; queueFreePts: number } {
  const points = (troop: string): number => (TROOPS as Readonly<Record<string, TroopStats>>)[troop]?.pts ?? 0;
  const queuePts = army.queue.reduce((sum, row) => sum + points(row.troop), 0);
  const draftPts = draft.reduce((sum, row) => sum + points(row.troop) * row.count, 0);
  return {
    queuePts, draftPts,
    campFreePts: Math.max(0, army.campCapacityPts - army.rosterPts - queuePts - draftPts),
    queueFreePts: Math.max(0, army.barracksQueuePts - queuePts - draftPts),
  };
}

/** How many more of `troop` the manual draft may take (tester request
 * 2026-09-16, MAX / +10): the SAME three ceilings the +1 tap already checks
 * one unit at a time — army capacity, training-queue capacity (both from the
 * server's /army figures, via manualTrainingRoom) and the composition size
 * cap — floored to whole units and never negative. An unknown troop yields 0.
 * The server re-validates the batch; this only sizes the local selection. */
export function maxTrainableUnits(
  army: Parameters<typeof manualTrainingRoom>[0],
  draft: ReadonlyArray<{ troop: string; count: number }>,
  troop: string,
): number {
  const pts = (TROOPS as Readonly<Record<string, TroopStats | undefined>>)[troop]?.pts;
  if (pts === undefined || pts <= 0) return 0;
  const room = manualTrainingRoom(army, draft);
  const drafted = draft.reduce((sum, row) => sum + row.count, 0);
  return Math.max(0, Math.min(
    Math.floor(room.campFreePts / pts),
    Math.floor(room.queueFreePts / pts),
    TRAINING_PRESETS.maxCompositionUnits - drafted,
  ));
}

/** Keep gate rendered by both training and research. Unknown base state fails
 * closed for gated units so a loading flash never exposes a doomed action.
 * (Since D-058 no troop carries requiresKeepLevel — the dark troops moved to
 * writ gates — but the mechanism stays for any future Keep-gated troop.) */
export function troopKeepUnlock(
  troop: string,
  keepLevel: number | undefined,
): { locked: boolean; requiresKeepLevel?: number } {
  const stats = (TROOPS as Readonly<Record<string, TroopStats | undefined>>)[troop];
  const required = stats?.requiresKeepLevel;
  return {
    locked: required !== undefined
      && (keepLevel === undefined || keepLevel < required),
    ...(required !== undefined ? { requiresKeepLevel: required } : {}),
  };
}

/** One lock verdict per troop card (D-058, owner 2026-08-16). Elite troops are
 * WRIT-gated: locked until the server's /army eliteUnlocks verdict says the
 * wallet consumed the unlock item (fails closed while /army loads). The label
 * names the unlock path exactly — the forge for drop writs, the KEEP price for
 * the purchasable mage writ — so a locked card teaches instead of taunting. */
export type TroopUnlockView =
  | { locked: false }
  | { locked: true; kind: 'keep'; label: string; requiresKeepLevel: number }
  | { locked: true; kind: 'elite'; label: string; itemAsset: string };

export function troopUnlockView(
  troop: string,
  keepLevel: number | undefined,
  eliteUnlocks: Readonly<Record<string, boolean>> | undefined,
): TroopUnlockView {
  if (isEliteTroop(troop) && eliteUnlocks?.[troop] !== true) {
    const itemId = ELITE_TROOP_UNLOCKS.itemByTroop[troop];
    const spec = (ITEMS as Readonly<Record<string, ItemSpec>>)[itemId]!;
    return {
      locked: true,
      kind: 'elite',
      label: spec.acquisition.type === 'drop'
        ? 'DROPS FROM GOLD FORGE'
        : `UNLOCK: ${spec.costKeep.toLocaleString('en-US')} KEEP WRIT`,
      itemAsset: spec.asset,
    };
  }
  const keep = troopKeepUnlock(troop, keepLevel);
  return keep.locked
    ? { locked: true, kind: 'keep', label: `KEEP L${keep.requiresKeepLevel}`, requiresKeepLevel: keep.requiresKeepLevel! }
    : { locked: false };
}

/**
 * Live progress for the running research. GET /army research rows carry only
 * {troop, toLevel, finishesAt} — troop_research has no start column — but the
 * total duration is exactly recoverable: the server computed finishesAt from
 * TROOP_LEVELING.researchTimeSec[from − 1] (army.ts researchTroop) and
 * from = toLevel − 1, so start = finish − duration. A toLevel outside the
 * table (defensive; the server refuses to create one) renders as complete
 * rather than a stuck empty bar.
 */
export function researchProgress(
  toLevel: number,
  finishesAt: string,
  nowMs: number,
): { remSec: number; pct: number } {
  const totalSec = TROOP_LEVELING.researchTimeSec[toLevel - 2] ?? 0;
  const remSec = Math.max(0, Math.ceil((new Date(finishesAt).getTime() - nowMs) / 1000));
  if (totalSec <= 0) return { remSec, pct: 100 };
  return { remSec, pct: Math.max(0, Math.min(100, 100 * (1 - remSec / totalSec))) };
}

/** What an idle research row shows instead of a dead button. */
export type ResearchRowState =
  | { kind: 'maxed' }
  /** This troop holds the single research slot right now. */
  | { kind: 'researching' }
  /** Another troop holds it (TROOP_LEVELING.concurrentResearch = 1). */
  | { kind: 'forgeBusy' }
  /** Next level exceeds the Forge — carries the level the server's 422
   *  ("requires Forge level N") would name, so the row can say exactly
   *  what to upgrade. */
  | { kind: 'needsForge'; forgeLevel: number }
  | { kind: 'ready'; costShards: number; durationSec: number; toLevel: number };

/**
 * Mirrors researchTroop's gates (apps/api/src/game/army.ts) for display.
 * Precedence deliberately differs from the server's check ORDER in one spot:
 * maxed wins over forgeBusy — a maxed troop can never research again, so
 * showing it as merely "busy right now" would promise a button that will
 * never come back.
 */
export function researchRowState(
  troop: string,
  level: number,
  activeTroop: string | null,
  forgeLevel: number,
): ResearchRowState {
  if (level >= TROOP_LEVELING.maxLevel) return { kind: 'maxed' };
  if (activeTroop === troop) return { kind: 'researching' };
  if (activeTroop !== null) return { kind: 'forgeBusy' };
  const next = level + 1;
  if (next > forgeLevel) return { kind: 'needsForge', forgeLevel: next };
  const costShards = TROOP_LEVELING.researchCostKeep[level - 1];
  const durationSec = TROOP_LEVELING.researchTimeSec[level - 1];
  // No table row defined (mirror of the server's "no research row" 422).
  if (costShards === undefined || durationSec === undefined) return { kind: 'maxed' };
  return { kind: 'ready', costShards, durationSec, toLevel: next };
}

/**
 * Highest COMPLETED forge level — mirrors the server's completedBuildingsOf
 * (army.ts): a forge still inside its 'build' job doesn't open research gates
 * yet. GET /base returns only unfinished jobs, so "referenced by a build job"
 * ⇔ under construction. 0 ⇒ no forge (the server would 422 the POST).
 */
export function forgeLevelFromBase(
  buildings: ReadonlyArray<{ id: string; type: string; level: number }>,
  jobs: ReadonlyArray<{ kind: string; buildingId: string | null }>,
): number {
  const underConstruction = new Set(
    jobs.filter((j) => j.kind === 'build' && j.buildingId !== null).map((j) => j.buildingId),
  );
  return buildings.reduce(
    (m, b) => (b.type === 'forge' && !underConstruction.has(b.id) ? Math.max(m, b.level) : m),
    0,
  );
}

/**
 * FINISH is a KEEP sink (speedupCostKeep → recycled to emission_pool, like the
 * builder-job speed-up). Returns the disable reason when the store balance
 * can't cover the cost, null when it can. An unknown balance (store not
 * hydrated yet) must NOT block a legitimate finish — the server is the
 * enforcer; this is only here so the button never offers a tap that is
 * guaranteed to bounce.
 */
/**
 * Seconds until the WHOLE training queue is done = the TAIL row's finishesAt −
 * now. GET /army orders the queue by finishesAt, so the last row's finish IS
 * the moment the final troop lands in camp — that (owner F1: "getting ready to
 * attack" means the army, not one unit) is the remaining time ⚡ FINISH ALL is
 * priced on, via the SAME shared speedupCostKeep the server charges. Summing
 * per-row time would overcharge: the rows' timers overlap. ceil matches the
 * server's remSec rounding; 0 for an empty or fully-due queue.
 */
export function queueRemainingSec(
  queue: ReadonlyArray<{ finishesAt: string }>,
  nowMs: number,
): number {
  const tail = queue[queue.length - 1];
  if (!tail) return 0;
  return Math.max(0, Math.ceil((new Date(tail.finishesAt).getTime() - nowMs) / 1000));
}

export interface TrainingCancelTarget {
  id: string;
  troop: string;
  finishesAt: string;
  refundShards: string;
}

/** A grouped −1 action always removes the least-progressed unit of that type:
 * the refundable row with the latest authoritative finishesAt. Exact row ids
 * cross the wire, so duplicate troop identities never become ambiguous. */
export function trainingCancelTarget(
  queue: ReadonlyArray<{
    id: string; troop: string; finishesAt: string;
    canCancel: boolean; refundShards: string | null;
  }>,
  troop: string,
): TrainingCancelTarget | null {
  let target: TrainingCancelTarget | null = null;
  for (const row of queue) {
    if (row.troop !== troop || !row.canCancel || row.refundShards === null) continue;
    if (!target || new Date(row.finishesAt).getTime() >= new Date(target.finishesAt).getTime()) {
      target = { id: row.id, troop: row.troop, finishesAt: row.finishesAt, refundShards: row.refundShards };
    }
  }
  return target;
}

/** Tap-tap-tap cancellation (D-096): the same latest-finishing rule, but rows
 * the tray has ALREADY cancelled optimistically — their POST is queued or in
 * flight, /army has not caught up — are skipped, so N rapid taps resolve N
 * DISTINCT ids latest-first without a refetch between taps. Null once every
 * refundable row of that troop is spoken for: the extra tap is a no-op, never
 * a duplicate POST. */
export function nextTrainingCancelTarget(
  queue: ReadonlyArray<{
    id: string; troop: string; finishesAt: string;
    canCancel: boolean; refundShards: string | null;
  }>,
  troop: string,
  pendingIds: ReadonlySet<string>,
): TrainingCancelTarget | null {
  return trainingCancelTarget(queue.filter((row) => !pendingIds.has(row.id)), troop);
}

export function finishShortfall(keepBalance: string | undefined, costKeep: number): string | null {
  if (keepBalance === undefined) return null;
  const have = Number(keepBalance);
  if (!Number.isFinite(have)) return null;
  if (have < costKeep) return `NEED ${costKeep.toLocaleString('en-US')} KEEP · HAVE ${Math.floor(have).toLocaleString('en-US')}`;
  return null;
}

/** Press-and-hold repeat cadence for the Barracks TRAIN cards (army.tsx). `tick`
 *  is the repeat index — 0 is the FIRST repeat after the guaranteed single unit
 *  a plain tap trains. The first repeat is deliberately slow (a quick tap must
 *  release well before it, so tap === exactly one unit), then the interval ramps
 *  DOWN to a steady ceiling so "hold to bulk-train" accelerates without ever
 *  hammering: the floor of ~5.5 taps/sec is the fastest a hold ever POSTs, and
 *  the tray still serializes each POST on top of this so requests never overlap.
 *  Non-increasing by construction (0<DECAY<1, then clamped to FLOOR). */
export function holdTrainDelayMs(tick: number): number {
  const FIRST_MS = 350; // first-repeat pause — longer than any deliberate tap
  const FLOOR_MS = 180; // steady-state ceiling ≈ 5.5/sec (server-safe with per-POST serialization)
  const DECAY = 0.82; // per-tick interval shrink → the "accelerating" feel
  const n = Math.max(0, Math.floor(tick));
  return Math.max(FLOOR_MS, Math.round(FIRST_MS * DECAY ** n));
}
