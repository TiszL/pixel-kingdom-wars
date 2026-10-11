import { LOOT, STRUCTURES } from './constants';

export interface RaidVaultState {
  /** Building level at the frozen raid snapshot (1..STRUCTURES.vault.maxLevel). */
  level: number;
  destroyed: boolean;
}

export interface RaidLootInput {
  liquidShards: bigint;
  openForgeShards: bigint;
  stars: 0 | 1 | 2 | 3;
  /** Every physical Vault on the defending deed with its end-of-battle state. */
  vaults: readonly RaidVaultState[];
  mines: readonly { id: string; unclaimedShards: bigint; destroyed: boolean }[];
}

/** D-065: how many basis points of the deed's shards a standing Vault of this
 * level keeps out of the lootable pool. Linear in level; the constant is the
 * maximum at STRUCTURES.vault.maxLevel. Level 0 / no Vault protects nothing. */
export function vaultProtectionBps(level: number): number {
  if (!Number.isInteger(level) || level <= 0) return 0;
  const capped = Math.min(level, STRUCTURES.vault.maxLevel);
  return Math.floor(LOOT.vaultProtectionMaxBps * capped / STRUCTURES.vault.maxLevel);
}

/** The share of the deed's liquid + open-Forge shards that can be taken when a
 * Vault of this level is standing at the end of the raid (bps of the balance).
 * Player copy: "L20 Vault → 20% lootable". */
export function lootableShareBps(standingVaultLevel: number): number {
  return LOOT.balanceLootableBps - vaultProtectionBps(standingVaultLevel);
}

/** Highest level among Vaults that survived the battle; 0 when none stand. A
 * destroyed Vault protects nothing — breaking it is how raiders reach the rest. */
export function standingVaultLevel(vaults: readonly RaidVaultState[]): number {
  return vaults.reduce((best, vault) => (vault.destroyed ? best : Math.max(best, vault.level)), 0);
}

/** Share of the reserved lootable pool that is exposed, given the standing
 * Vault level (bps). The pool itself is always LOOT.balanceLootableBps of the
 * balance, frozen at raid creation before anyone knows which Vaults will fall. */
export function vaultExposureBps(standingLevel: number): number {
  return Math.floor(lootableShareBps(standingLevel) * 10_000 / LOOT.balanceLootableBps);
}

export interface RaidLootBreakdown {
  total: bigint;
  balance: bigint;
  mines: bigint;
  fromLiquid: bigint;
  fromOpenForge: bigint;
  balancePool: bigint;
  starPrize: bigint;
  exposureBps: number;
  mineSources: readonly { id: string; amount: bigint }[];
}

export interface ApproximateLootRange {
  /** Decimal strings keep previews correct above JavaScript's safe integer. */
  min: string;
  max: string;
}

const bps = (amount: bigint, factor: number): bigint => amount * BigInt(factor) / 10_000n;

/** Formula A. All inputs belong to one deed/base; wallet-global balances never
 * enter this calculator. Floors happen once at each named economic boundary. */
export function calculateRaidLoot(input: RaidLootInput): RaidLootBreakdown {
  if (input.liquidShards < 0n || input.openForgeShards < 0n
    || input.vaults.some((v) => !Number.isInteger(v.level) || v.level < 1)
    || input.mines.some((m) => m.unclaimedShards < 0n)) {
    throw new RangeError('invalid raid loot input');
  }
  const available = input.liquidShards + input.openForgeShards;
  const balancePool = bps(available, LOOT.balanceLootableBps);
  const starPrize = bps(balancePool, LOOT.starPayoutBps[input.stars]);
  const exposureBps = vaultExposureBps(standingVaultLevel(input.vaults));
  const balance = bps(starPrize, exposureBps);
  const fromLiquid = available === 0n ? 0n : balance * input.liquidShards / available;
  const fromOpenForge = balance - fromLiquid;
  const mineSources = input.stars === 0 ? [] : input.mines
    .filter((m) => m.destroyed && m.unclaimedShards > 0n)
    .map((m) => ({ id: m.id, amount: m.unclaimedShards }));
  const mines = mineSources.reduce((sum, m) => sum + m.amount, 0n);
  return { total: balance + mines, balance, mines, fromLiquid, fromOpenForge,
    balancePool, starPrize, exposureBps, mineSources };
}

/** Stable public preview for combined Mine + balance loot. It intentionally
 * reveals neither component and never returns the exact private total alone. */
export function approximateLootRange(amount: bigint): ApproximateLootRange {
  if (amount < 0n) throw new RangeError('loot preview amount cannot be negative');
  if (amount === 0n) return { min: '0', max: '0' };
  let magnitude = 1n;
  while (amount >= magnitude * 10n) magnitude *= 10n;
  const configured = magnitude / BigInt(LOOT.previewBucketsPerDecade);
  const width = configured > BigInt(LOOT.previewMinimumBucketShards)
    ? configured : BigInt(LOOT.previewMinimumBucketShards);
  const min = amount / width * width;
  return { min: min.toString(), max: (min + width - 1n).toString() };
}
