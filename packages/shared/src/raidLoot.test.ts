import { describe, expect, it } from 'vitest';
import { LOOT, STRUCTURES } from './constants';
import {
  approximateLootRange, calculateRaidLoot, lootableShareBps, standingVaultLevel,
  vaultExposureBps, vaultProtectionBps,
} from './raidLoot';

describe('deed-local raid loot formula A', () => {
  it('pays the approved 10k example and only destroyed Mine buffers', () => {
    const loot = calculateRaidLoot({ liquidShards: 10_000n, openForgeShards: 0n,
      stars: 1, vaults: [],
      mines: [{ id: 'm1', unclaimedShards: 700n, destroyed: true },
        { id: 'm2', unclaimedShards: 900n, destroyed: false }] });
    expect(loot.balancePool).toBe(5_000n);
    expect(loot.balance).toBe(1_250n);
    expect(loot.mines).toBe(700n);
    expect(loot.total).toBe(1_950n);
  });

  it('D-065: the highest STANDING Vault shields up to 30 points of the 50% lootable share', () => {
    // WHY (owner 2026-08-21): "during raid 50% of your shards can be taken so
    // vault should be able to reduce that 30% based on level of vault". Level
    // is linear to the maximum; a destroyed Vault protects nothing, which is
    // what makes breaking the Vault worth a plunderer's trouble.
    expect(vaultProtectionBps(0)).toBe(0);
    expect(vaultProtectionBps(1)).toBe(150);
    expect(vaultProtectionBps(10)).toBe(1_500);
    expect(vaultProtectionBps(STRUCTURES.vault.maxLevel)).toBe(LOOT.vaultProtectionMaxBps);
    expect(lootableShareBps(STRUCTURES.vault.maxLevel)).toBe(2_000); // 20% of the balance stays lootable
    expect(vaultExposureBps(0)).toBe(10_000);
    expect(vaultExposureBps(STRUCTURES.vault.maxLevel)).toBe(4_000);
    expect(standingVaultLevel([{ level: 20, destroyed: true }, { level: 7, destroyed: false }])).toBe(7);
    expect(standingVaultLevel([{ level: 20, destroyed: true }])).toBe(0);

    const standing = calculateRaidLoot({ liquidShards: 6_000n, openForgeShards: 4_000n,
      stars: 2, vaults: [{ level: 20, destroyed: false }, { level: 3, destroyed: true }], mines: [] });
    expect(standing.starPrize).toBe(2_500n);
    expect(standing.exposureBps).toBe(4_000);
    expect(standing.balance).toBe(1_000n); // 10,000 × 50% × 50% (2★) × 40%
    expect(standing.fromLiquid + standing.fromOpenForge).toBe(standing.balance);

    const broken = calculateRaidLoot({ liquidShards: 6_000n, openForgeShards: 4_000n,
      stars: 2, vaults: [{ level: 20, destroyed: true }], mines: [] });
    expect(broken.exposureBps).toBe(10_000);
    expect(broken.balance).toBe(2_500n);
  });

  it('pays nothing at zero stars, including destroyed Mines', () => {
    expect(calculateRaidLoot({ liquidShards: 10_000n, openForgeShards: 10_000n,
      stars: 0, vaults: [{ level: 1, destroyed: true }],
      mines: [{ id: 'm', unclaimedShards: 5_000n, destroyed: true }] }).total).toBe(0n);
  });
});

describe('public approximate loot range', () => {
  it('combines sources into one deterministic non-exact public bucket', () => {
    expect(approximateLootRange(0n)).toEqual({ min: '0', max: '0' });
    expect(approximateLootRange(3_325n)).toEqual({ min: '3000', max: '3499' });
    expect(approximateLootRange(12_345n)).toEqual({ min: '10000', max: '14999' });
    expect(approximateLootRange(12_345n)).toEqual(approximateLootRange(12_345n));
  });

  it('keeps very large balances exact internally and applies no attacker cap', () => {
    const amount = 90_071_992_547_409_931n;
    const range = approximateLootRange(amount);
    expect(BigInt(range.min)).toBeLessThanOrEqual(amount);
    expect(BigInt(range.max)).toBeGreaterThanOrEqual(amount);
    expect(BigInt(range.max)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
