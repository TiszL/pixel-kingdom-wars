/** Pure supplied-facts port of LiveUpgradeMapper.kt; no reader, clock, transport or controller ownership. */
import { exactAmount, UNKNOWN } from '../kitLogic';
import type { UpgradeSheetUi } from './UpgradeSheet';
import type { UpgradeState } from './buildingTypes';
import {
  snapshotArt, snapshotBuildersLine, snapshotShortfall, snapshotStatLook, snapshotUpgradePrice,
  type BuildingMineFact, type BuildingSnapshotArt, type BuildingSnapshotFacts,
} from './buildingSnapshot';

export interface UpgradeSnapshotOutcome {
  /** Supplied by the original controller; a timeout is VERIFYING, never REFUSED. */
  state: 'VERIFYING' | 'REFUSED';
  reason: string | null;
}
export interface UpgradeSnapshotOptions {
  /** True only for this sheet's own press while the original controller remains busy. */
  sent?: boolean;
  /** The original controller must retain VERIFYING until an authoritative outcome resolves it. */
  outcome?: UpgradeSnapshotOutcome | null;
}

/**
 * Declines every native non-upgrade/money branch and every unknown/non-Shards quote.
 * The host then retains the original review. Returning a snapshot does not authorize submission:
 * the unchanged action owner still checks its live synchronous predicate and idempotency key.
 */
export function upgradeSnapshot(
  f: BuildingSnapshotFacts,
  renderArt: BuildingSnapshotArt,
  options: UpgradeSnapshotOptions = {},
): UpgradeSheetUi | null {
  if (!f.canShowUpgrade || f.job != null || f.repair != null || f.paidStep || f.upgradeCost == null || f.upgradeCurrency !== 'SHARDS') return null;
  const price = snapshotUpgradePrice(f);
  if (price == null) return null;
  const missing = price.status === 'SHORT' ? snapshotShortfall(f.shardsBalance, f.upgradeCostRaw) : null;
  const outcome = options.outcome;
  let state: UpgradeState;
  if (outcome?.state === 'VERIFYING') state = 'VERIFYING';
  else if (f.readOnly || f.constructionBlocked || (!f.enabled && !f.busy)) state = 'READ_ONLY';
  else if (f.busy) state = options.sent ? 'BUSY' : 'READ_ONLY';
  else if (price.status === 'UNAVAILABLE') state = 'READY';
  else if (missing != null) state = 'SHORT';
  else if (f.freeBuilders === 0) state = 'NO_BUILDER';
  else state = outcome?.state === 'REFUSED' ? 'ERROR' : 'READY';
  const reason = state === 'VERIFYING' ? outcome?.reason ?? 'Checking the upgrade'
    : state === 'READ_ONLY' ? f.busy && !f.readOnly && !f.constructionBlocked ? 'Working…' : f.blockedReason
      : state === 'ERROR' ? outcome?.reason ?? null : null;

  return {
    buildingId: f.buildingId, name: f.name.toUpperCase(), levelFrom: `LV ${f.level}`, levelTo: `LV ${f.level + 1}`,
    artNow: snapshotArt(f.artNow, renderArt), artNext: snapshotArt(f.artNext, renderArt),
    newLook: f.artNext.trim() !== '' && f.artNext !== f.artNow,
    rows: f.stats.flatMap(stat => stat.next != null && stat.next !== stat.now
      ? [{ ...snapshotStatLook(stat.key), old: stat.now, new: stat.next, unlock: false }] : []),
    price, time: f.upgradeTime ?? UNKNOWN, builders: snapshotBuildersLine(f.freeBuilders, f.totalBuilders), state,
    shortfall: missing != null ? exactAmount(missing) : null,
    bestDoorLabel: state === 'SHORT' ? upgradeDoorLabel(f.mine) : null,
    builderFreeIn: state === 'NO_BUILDER' ? f.nextBuilderFreeIn : null,
    reason, primaryDetail: f.upgradeDetail,
  };
}

function upgradeDoorLabel(mine: BuildingMineFact): string {
  if (mine.mineBuildingId == null) return 'Build a Mine';
  return mine.accrued != null ? `Mines hold ${mine.accrued}` : 'Collect at your Mines';
}
