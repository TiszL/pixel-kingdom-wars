/**
 * Pure supplied-facts port of LiveInfoMapper.kt and LiveBuildingFacts.kt.
 * The live owner reads the existing catalogue/server snapshot and retains every action and gate.
 * No store, transport, clock, catalogue table, or controller is imported here.
 */
import type { ReactNode } from 'react';
import { exactAmount, UNKNOWN } from '../kitLogic';
import type { PriceUi } from '../types';
import type { BuildingInfoUi, InfoExtraUi, InfoPrimaryUi, InfoTagUi } from './BuildingInfoSheet';

export type BuildingSnapshotCategory = 'DEFENCE' | 'TRAP' | 'WALL' | 'PRODUCER' | 'STORAGE' | 'ARMY' | 'HERO' | 'KEEP' | 'CLAN' | 'FEATURE';
export interface BuildingStatFact { key: string; now: string | null; next: string | null }
export interface BuildingJobFact {
  id: string;
  kind: string;
  /** Existing shared fmtDur output; null when the server deadline is unknown. */
  remaining: string | null;
  /** Explicit server free-finish verdict, never inferred from a missing amount. */
  freeFinish: boolean;
  /** The original payment owner's current admission to its review. No finish amount belongs here. */
  canReview: boolean;
  /** Formatted server refund when cancel is offered; null otherwise. */
  cancelRefund: string | null;
}
export interface BuildingRepairFact { cost: string; time: string }
export interface BuildingMineFact { mineBuildingId: string | null; accrued: string | null }
export type BuildingSnapshotArt = (key: string) => ReactNode;
export type InfoExtraKind = 'CANCEL_JOB' | 'TOGGLE_ROW';

/**
 * Mirrors native BuildingFacts, with explicit quote currency and supplied complete builder detail.
 * The original reader supplies shared-owned costs/stats/art IDs and already-computed gates. Web sources:
 * ActionSheet's UPGRADE_COSTS/UPGRADE_TIMES_SEC/upgradeSolLamports/levelStats and BaseStateDto.
 * Every duration string is existing shared fmtDur output; this mapper does not format or infer time.
 */
export interface BuildingSnapshotFacts {
  buildingId: string;
  type: string;
  name: string;
  level: number;
  maxLevel: number;
  artNow: string;
  artNext: string;
  role: string | null;
  category: BuildingSnapshotCategory;
  stats: readonly BuildingStatFact[];
  canShowUpgrade: boolean;
  /** Supplier's guarded enabled-and-current value; the live owner still rechecks before acting. */
  enabled: boolean;
  /** No unknown or foreign currency is relabelled as Shards. */
  upgradeCurrency: string | null;
  upgradeCost: string | null;
  /** Canonical positive integer amount; missing, zero or noncanonical raw cost is UNAVAILABLE. */
  upgradeCostRaw: string | null;
  upgradePriced: boolean;
  upgradeTime: string | null;
  /** Complete owner-supplied builder/time sentence; no local builder requirement is invented. */
  upgradeDetail: string | null;
  paidStep: boolean;
  paidOfferReady: boolean;
  job: BuildingJobFact | null;
  repair: BuildingRepairFact | null;
  /** Canonical nonnegative integer balance; missing or noncanonical is CHECKING, never inferred zero. */
  shardsBalance: string | null;
  freeBuilders: number | null;
  totalBuilders: number | null;
  nextBuilderFreeIn: string | null;
  heroReady: boolean | null;
  wallRow: boolean;
  blockedReason: string;
  /** The supplier includes not-current here, as Android withCosts does. */
  readOnly: boolean;
  constructionBlocked: boolean;
  busy: boolean;
  mine: BuildingMineFact;
}

const NO_FIELD_REPORT = 'Field reports on this structure are still being written.';

export function buildingSnapshot(f: BuildingSnapshotFacts, renderArt: BuildingSnapshotArt): BuildingInfoUi {
  const upgradeOpen = f.canShowUpgrade && f.job == null && f.repair == null;
  const price = upgradeOpen && !f.paidStep ? snapshotUpgradePrice(f) : null;
  const missing = price?.status === 'SHORT' ? snapshotShortfall(f.shardsBalance, f.upgradeCostRaw) : null;
  const extraKind = snapshotInfoExtraKind(f);
  return {
    buildingId: f.buildingId, name: f.name.toUpperCase(), levelTag: `LV ${f.level}`,
    role: f.role != null && f.role.trim() !== '' ? f.role : NO_FIELD_REPORT,
    category: { text: f.category, verb: 'STONE' }, stateTag: stateTag(f),
    headerArt: snapshotArt(f.artNow, renderArt),
    stats: f.stats.map(stat => {
      const look = snapshotStatLook(stat.key);
      return { ...look, art: renderArt(look.icon), now: stat.now, next: stat.next !== stat.now ? stat.next : null };
    }),
    nextLegend: f.level < f.maxLevel && f.stats.some(stat => stat.next != null && stat.next !== stat.now) ? `at LV ${f.level + 1}` : null,
    upgrading: f.job != null, price,
    time: price != null ? f.upgradeTime ?? UNKNOWN : null,
    builders: price != null ? snapshotBuildersLine(f.freeBuilders, f.totalBuilders) : null,
    shortfall: missing != null ? exactAmount(missing) : null,
    primary: infoPrimary(f, upgradeOpen),
    extra: extraKind != null ? infoExtra(f, extraKind, renderArt) : null,
    load: 'READY',
  };
}

/** Only the explicit Shards quote is represented; a foreign/unknown quote is no price. */
export function snapshotUpgradePrice(f: BuildingSnapshotFacts): PriceUi | null {
  if (f.upgradeCurrency !== 'SHARDS') return null;
  // b5df7141 / Android MoneyMapperCommon: validate raw cost before any CHECKING display branch.
  const cost = canonicalWholeAmount(f.upgradeCostRaw);
  if (cost == null || cost <= 0n || !f.upgradePriced) return { currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' };
  // These catalogue facts carry no SERVER_ZERO verdict; zero cannot authorize or advertise a free upgrade.
  if (f.upgradeCost != null && decimal(f.upgradeCost.replace(/,/g, ''))?.units === 0n) return { currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' };
  const balance = canonicalWholeAmount(f.shardsBalance);
  if (f.upgradeCost == null || balance == null) return { currency: 'SHARDS', amount: null, status: 'CHECKING' };
  return { currency: 'SHARDS', amount: f.upgradeCost, status: balance < cost ? 'SHORT' : 'OK' };
}

/** Whole-string validation also rejects trailing newlines, which a bare regex $ anchor would allow. */
function canonicalWholeAmount(value: string | null): bigint | null {
  if (value == null || /^(?:0|[1-9][0-9]*)$/.exec(value)?.[0] !== value) return null;
  return BigInt(value);
}

export function snapshotInfoExtraKind(f: BuildingSnapshotFacts): InfoExtraKind | null {
  if (f.job?.cancelRefund != null && f.enabled) return 'CANCEL_JOB';
  if (f.type === 'wall' && !f.busy) return 'TOGGLE_ROW';
  return null;
}

function infoExtra(f: BuildingSnapshotFacts, kind: InfoExtraKind, renderArt: BuildingSnapshotArt): InfoExtraUi {
  if (kind === 'CANCEL_JOB') {
    const noun = jobNoun(f.job?.kind ?? '');
    const refund = f.job?.cancelRefund ?? UNKNOWN;
    return { art: renderArt('shape:close'), label: `Cancel ${noun} · +${refund} Shards`, description: `Cancel the ${noun} and get ${refund} Shards back` };
  }
  return f.wallRow ? { art: renderArt('shape:minus'), label: 'Select single wall' }
    : { art: renderArt('shape:plus'), label: 'Select whole row' };
}

function infoPrimary(f: BuildingSnapshotFacts, upgradeOpen: boolean): InfoPrimaryUi {
  if (f.job != null) {
    const job = f.job;
    const canFinish = job.freeFinish || job.canReview;
    const enabled = f.enabled && canFinish;
    return { kind: 'FINISH', label: job.freeFinish ? 'FINISH NOW · FREE' : 'REVIEW FINISH',
      sub: job.freeFinish ? `Complete this ${jobNoun(job.kind)}` : 'Review current currency and maximum charge',
      state: enabled ? 'ENABLED' : 'DISABLED', reason: enabled ? null : !canFinish ? 'Finish price unavailable' : f.blockedReason, price: null };
  }
  if (f.repair != null) return { kind: 'UPGRADE', label: 'REARM TRAP', sub: `${f.repair.cost} Shards · ${f.repair.time}`,
    state: f.enabled ? 'ENABLED' : 'DISABLED', reason: f.enabled ? null : f.blockedReason, price: null };
  if (f.level >= f.maxLevel) return { kind: 'MAX', label: 'MAX LEVEL', sub: null, state: 'ENABLED', reason: null, price: null };
  if (upgradeOpen) {
    const price = f.paidStep ? null : snapshotUpgradePrice(f);
    // Android withCosts permits CHECKING here: INFO navigates; the UPGRADE review waits without sending.
    const priced = f.paidStep ? f.paidOfferReady : price != null && price.status !== 'UNAVAILABLE';
    const enabled = f.enabled && priced;
    return { kind: 'UPGRADE', label: `UPGRADE TO LV ${f.level + 1}`,
      sub: f.paidStep ? 'Paid step · review before paying' : f.upgradeDetail,
      state: enabled ? 'ENABLED' : 'DISABLED', reason: enabled ? null : !f.enabled ? f.blockedReason : 'Price unavailable right now', price: null };
  }
  return { kind: 'UPGRADE', label: `UPGRADE TO LV ${f.level + 1}`, sub: null, state: 'DISABLED',
    reason: f.type === 'wall' && f.wallRow ? 'Use UPGRADE ROW on the bar' : 'Not available now', price: null };
}

function stateTag(f: BuildingSnapshotFacts): InfoTagUi {
  if (f.job != null) return { text: `${f.job.kind === 'build' ? 'BUILDING' : 'UPGRADING'} ${f.job.remaining ?? UNKNOWN}`, verb: 'GOLD' };
  if (f.repair != null) return { text: 'SPENT', verb: 'RED' };
  if (f.heroReady === false) return { text: 'RECOVERING', verb: 'GOLD' };
  if (f.category === 'DEFENCE' || f.category === 'TRAP' || f.category === 'WALL') return { text: 'GUARDING', verb: 'MOSS' };
  return { text: 'READY', verb: 'GREEN' };
}

export function snapshotStatLook(key: string): { icon: string; label: string } {
  switch (key) {
    case 'HP': return { icon: 'shield', label: 'Hitpoints' };
    case 'DMG': return { icon: 'attack', label: 'Damage per second' };
    case 'RNG': return { icon: 'scout', label: 'Range' };
    case 'SHIELDS': return { icon: 'shield', label: 'Loot protection' };
    case 'CAP': return { icon: 'army', label: 'Capacity' };
    case 'PWR': return { icon: 'shards', label: 'Mining power' };
    default: return { icon: 'shape:info', label: key };
  }
}

export function snapshotArt(key: string, renderArt: BuildingSnapshotArt): ReactNode {
  return key.trim() !== '' ? renderArt(key) : null;
}

export function snapshotBuildersLine(free: number | null, total: number | null): string {
  return `${free ?? UNKNOWN}/${total ?? UNKNOWN} free`;
}

function jobNoun(kind: string): string {
  switch (kind) {
    case 'build': return 'build';
    case 'upgrade': return 'upgrade';
    case 'clear_obstacle': return 'clearing';
    case 'repair': return 'rearm';
    default: return 'job';
  }
}

/** Exact presentation subtraction of canonical plain decimals, never an eligibility or payment decision. */
export function snapshotShortfall(balance: string | null, cost: string | null): string | null {
  const have = decimal(balance); const need = decimal(cost);
  if (have == null || need == null || have.units < 0n || need.units <= 0n) return null;
  const scale = Math.max(have.scale, need.scale);
  const missing = need.units * 10n ** BigInt(scale - need.scale) - have.units * 10n ** BigInt(scale - have.scale);
  if (missing <= 0n) return null;
  if (scale === 0) return missing.toString();
  const digits = missing.toString().padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return digits.slice(0, -scale) + (fraction === '' ? '' : `.${fraction}`);
}

function decimal(value: string | null): { units: bigint; scale: number } | null {
  if (value == null) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(value.trim());
  if (match == null) return null;
  const whole = match[2] ?? '0'; const fraction = match[3] ?? match[4] ?? '';
  return { units: BigInt(`${match[1] === '-' ? '-' : ''}${whole}${fraction}`), scale: fraction.length };
}
