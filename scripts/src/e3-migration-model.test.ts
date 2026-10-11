/**
 * E3 migration-model tests — the rules the genesis tool must ship with (the
 * "why", per CLAUDE.md test rule; docs/phase-e/E1-MIGRATION-PLAN.md §4/§9/§10):
 *  1. Units: leaves hash base units; 5,000 KEEP → 5,000,000,000,000; a leaf that
 *     would overflow SPL u64 is refused, never truncated (adversarial review
 *     "leaf amount units unspecified" — every claim would otherwise pay 1e-9).
 *  2. I1b: Σ leaves == the frozen custodial total in BOTH denominations, seeded
 *     with the 2026-09-20 production census (player_keep 1,021,562 over 169
 *     accounts / forge_payout_escrow 187,434 over 18 rows / mail_keep_escrow
 *     340,000 / withdrawal_escrow 1,000 / liability 1,549,996).
 *  3. L3 withdrawal escrow never enters a leaf (a legacy payout after F would
 *     pay the same KEEP twice).
 *  4. I1a / I2′ are split: settlement conservation is checked on its own, and
 *     the only new emission the cutover may create is the welcome re-issue.
 *  5. OD4: the welcome re-issue happens ONCE per wallet, only for an expired
 *     welcome, never beside a still-pending one (that KEEP folds as L4).
 *  6. OD7: internal wallets are excluded by default and their total disclosed.
 *  7. OD4b: lapsed-but-unswept Forge rows stay out unless restore is chosen.
 *  8. Mixed mails migrate the KEEP leg only and are counted.
 */
import { PLAYTEST, TOKEN } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  buildGenesisLeafSet, checkI1a, checkI1b, checkI2Prime, expectedFrozenLedgerKeep, keepToBaseUnits,
  type ForgeAllocation, type GenesisCensusInput, type PendingMailKeep, type PlayBalance,
} from './e3-migration-model';

// ---- production census 2026-09-20 (read-only capture; predicates in census-e3.sql)
const PROD = {
  playerKeepTotal: 1_021_562n, playerKeepAccounts: 169, positive: 59, exactly5000: 15, above5000: 24,
  forgeEscrow: 187_434n, forgeRows: 18,
  mailEscrow: 340_000n, // 68 pending welcome mails × 5,000
  withdrawalEscrow: 1_000n, // one failed row
  liability: 1_549_996n,
} as const;

const wallet = (i: number) => `W${String(i).padStart(4, '0')}`;

/** A deterministic population reproducing every aggregate above. */
function productionSeed(): GenesisCensusInput {
  const playBalances: PlayBalance[] = [];
  let i = 0;
  for (let k = 0; k < 15; k++) playBalances.push({ wallet: wallet(i++), keep: 5_000n });           // exactly 5,000
  for (let k = 1; k <= 20; k++) playBalances.push({ wallet: wallet(i++), keep: BigInt(100 * k) }); // 0 < b < 5,000 → 21,000
  for (let k = 0; k < 23; k++) playBalances.push({ wallet: wallet(i++), keep: 30_000n });          // above 5,000
  playBalances.push({ wallet: wallet(i++), keep: 235_562n });                                       // 24th above 5,000
  while (playBalances.length < PROD.playerKeepAccounts) playBalances.push({ wallet: wallet(i++), keep: 0n });
  // 18 claimable Forge rows on the first 18 positive wallets (deed owners at F)
  const forgeUnclaimed: ForgeAllocation[] = [];
  for (let k = 0; k < 17; k++) forgeUnclaimed.push({ wallet: wallet(k), baseId: `B${k}`, keep: 10_000n });
  forgeUnclaimed.push({ wallet: wallet(17), baseId: 'B17', keep: 17_434n });
  // 68 pending welcome mails on zero-balance (dormant) wallets 59..126
  const pendingMailKeep: PendingMailKeep[] = [];
  for (let k = 0; k < 68; k++) {
    pendingMailKeep.push({ wallet: wallet(59 + k), mailId: `M${k}`, keep: 5_000n, mixed: false, welcome: true });
  }
  return {
    playBalances, forgeUnclaimed, legacyForgeUnclaimed: [], pendingMailKeep,
    expiredWelcomeWallets: [], internalWallets: [], withdrawalEscrowKeep: PROD.withdrawalEscrow,
  };
}

describe('units — whole KEEP ledger vs 9-decimal SPL base units', () => {
  it('TEST VECTOR: 5,000 KEEP → 5,000,000,000,000 base units (TOKEN.decimals = 9)', () => {
    expect(TOKEN.decimals).toBe(9);
    expect(keepToBaseUnits(5_000n)).toBe(5_000_000_000_000n);
    expect(keepToBaseUnits(BigInt(PLAYTEST.welcomeKeep))).toBe(5_000_000_000_000n);
    expect(keepToBaseUnits(0n)).toBe(0n);
  });
  it('refuses a leaf above SPL u64 instead of truncating (hotWallet.ts guard)', () => {
    const maxKeep = ((1n << 64n) - 1n) / 10n ** 9n; // 18,446,744,073 KEEP
    expect(() => keepToBaseUnits(maxKeep)).not.toThrow();
    expect(() => keepToBaseUnits(maxKeep + 1n)).toThrow(/u64/);
    expect(() => keepToBaseUnits(-1n)).toThrow(RangeError);
  });
});

describe('genesis leaf set — production census 2026-09-20', () => {
  const seed = productionSeed();
  const set = buildGenesisLeafSet(seed);

  it('the seed reproduces every captured aggregate (so the test is about production, not a toy)', () => {
    const positive = seed.playBalances.filter((p) => p.keep > 0n);
    expect(seed.playBalances.length).toBe(PROD.playerKeepAccounts);
    expect(positive.length).toBe(PROD.positive);
    expect(positive.filter((p) => p.keep === 5_000n).length).toBe(PROD.exactly5000);
    expect(positive.filter((p) => p.keep > 5_000n).length).toBe(PROD.above5000);
    expect(positive.reduce((s, p) => s + p.keep, 0n)).toBe(PROD.playerKeepTotal);
    expect(seed.forgeUnclaimed.length).toBe(PROD.forgeRows);
    expect(seed.forgeUnclaimed.reduce((s, f) => s + f.keep, 0n)).toBe(PROD.forgeEscrow);
    expect(seed.pendingMailKeep.reduce((s, m) => s + m.keep, 0n)).toBe(PROD.mailEscrow);
    expect(PROD.playerKeepTotal + PROD.forgeEscrow + PROD.mailEscrow + PROD.withdrawalEscrow).toBe(PROD.liability);
  });

  it('I1b: Σ leaves == liability − withdrawal escrow, in KEEP and in base units', () => {
    const frozen = PROD.liability - PROD.withdrawalEscrow; // 1,548,996 KEEP
    expect(set.totalKeep).toBe(1_548_996n);
    expect(set.totalKeep).toBe(frozen);
    expect(set.totalBaseUnits).toBe(1_548_996_000_000_000n);
    expect(expectedFrozenLedgerKeep(seed)).toBe(frozen);
    expect(checkI1b(set, frozen, keepToBaseUnits(frozen))).toBe(true);
    // an under-funded vault or a stale ledger total fails I1b loudly
    expect(checkI1b(set, frozen, keepToBaseUnits(frozen) - 1n)).toBe(false);
    expect(checkI1b(set, frozen + 1n, keepToBaseUnits(frozen + 1n))).toBe(false);
  });

  it('L3 never enters a leaf; it is only reported', () => {
    expect(set.withdrawalEscrowKeep).toBe(1_000n);
    expect(set.leaves.every((l) => l.breakdown.playKeep + l.breakdown.forgeUnclaimed + l.breakdown.mailKeep + l.breakdown.welcomeReissue === l.amountKeep)).toBe(true);
    expect(set.totalKeep + set.withdrawalEscrowKeep).toBe(PROD.liability);
  });

  it('one leaf per wallet with a positive total, wallet-ascending, zero wallets omitted', () => {
    expect(set.leaves.length).toBe(59 + 68); // positive balances + dormant welcome-mail wallets
    const wallets = set.leaves.map((l) => l.wallet);
    expect(new Set(wallets).size).toBe(wallets.length);
    expect([...wallets].sort()).toEqual(wallets);
    // wallet 17 is the 3rd small account (300 KEEP) and carries the odd Forge row
    expect(set.leaves.find((l) => l.wallet === wallet(17))!.breakdown).toEqual({
      playKeep: 300n, forgeUnclaimed: 17_434n, mailKeep: 0n, welcomeReissue: 0n,
    });
    expect(set.leaves.find((l) => l.wallet === wallet(59))!.breakdown.mailKeep).toBe(5_000n);
    expect(set.leaves.find((l) => l.wallet === wallet(150))).toBeUndefined();
    expect(set.welcomeReissueKeep).toBe(0n);
    expect(set.excludedInternalKeep).toBe(0n);
    expect(set.mixedMailCount).toBe(0);
  });
});

describe('split invariants I1a / I2′', () => {
  it('I1a: the day-B settlement moves emission_pool by exactly −Σ keep_paid', () => {
    expect(checkI1a({ emissionPoolDelta: -42_000n, keepPaidSum: 42_000n })).toBe(true);
    expect(checkI1a({ emissionPoolDelta: -41_999n, keepPaidSum: 42_000n })).toBe(false);
    expect(checkI1a({ emissionPoolDelta: 0n, keepPaidSum: 0n })).toBe(true);
  });

  it('I2′: emission_pool moves by day-B allocation + Σ welcome re-issue and nothing else', () => {
    const seed = productionSeed();
    seed.expiredWelcomeWallets = [wallet(140), wallet(141), wallet(141)]; // listed twice: still once
    const set = buildGenesisLeafSet(seed);
    expect(set.welcomeReissueKeep).toBe(10_000n);
    expect(set.leaves.find((l) => l.wallet === wallet(141))!.breakdown.welcomeReissue).toBe(5_000n);
    const before = 498_370_771n; // production emission_pool 2026-09-20
    const dayB = 42_000n;
    expect(checkI2Prime(before, before - dayB - 10_000n, dayB, set)).toBe(true);
    // a stray posting (e.g. a lazy expiry or a gameplay reward inside the window) breaks it
    expect(checkI2Prime(before, before - dayB - 10_000n - 1n, dayB, set)).toBe(false);
    expect(checkI2Prime(before, before - dayB, dayB, set)).toBe(false);
  });
});

describe('OD4 welcome re-issue (DEVNET testing aid)', () => {
  it('re-issues once per wallet and refuses to re-issue beside a still-pending welcome', () => {
    const seed = productionSeed();
    seed.expiredWelcomeWallets = [wallet(59)]; // wallet 59 still has a PENDING welcome mail
    expect(() => buildGenesisLeafSet(seed)).toThrow(/collide/);
  });
  it('a wallet with nothing but an expired welcome gets exactly 5,000 KEEP', () => {
    const seed = productionSeed();
    seed.expiredWelcomeWallets = [wallet(160)];
    const set = buildGenesisLeafSet(seed);
    const leaf = set.leaves.find((l) => l.wallet === wallet(160))!;
    expect(leaf.amountKeep).toBe(BigInt(PLAYTEST.welcomeKeep));
    expect(leaf.amountBaseUnits).toBe(5_000_000_000_000n);
    expect(set.totalKeep).toBe(1_548_996n + 5_000n);
    expect(expectedFrozenLedgerKeep(seed)).toBe(set.totalKeep);
  });
});

describe('OD7 internal wallets', () => {
  it('default: excluded from the root and disclosed as a total', () => {
    const seed = productionSeed();
    seed.internalWallets = [wallet(58), wallet(17)]; // 235,562 + (300 play + 17,434 Forge)
    const set = buildGenesisLeafSet(seed);
    expect(set.excludedInternalWallets).toEqual([wallet(17), wallet(58)]);
    expect(set.excludedInternalKeep).toBe(235_562n + 300n + 17_434n);
    expect(set.totalKeep).toBe(1_548_996n - 253_296n);
    expect(set.leaves.some((l) => l.wallet === wallet(58))).toBe(false);
    expect(checkI1b(set, expectedFrozenLedgerKeep(seed), keepToBaseUnits(expectedFrozenLedgerKeep(seed)))).toBe(true);
  });
  it('opt-in include restores them and the totals agree', () => {
    const seed = productionSeed();
    seed.internalWallets = [wallet(58)];
    const set = buildGenesisLeafSet(seed, { includeInternalWallets: true });
    expect(set.excludedInternalKeep).toBe(0n);
    expect(set.totalKeep).toBe(1_548_996n);
  });
});

describe('OD4b lapsed Forge rows and mixed mails', () => {
  it('lapsed-but-unswept rows stay out by default and fold only on restore', () => {
    const seed = productionSeed();
    seed.forgeUnclaimed.push({ wallet: wallet(20), baseId: 'B20', keep: 999n, lapsed: true });
    const dflt = buildGenesisLeafSet(seed);
    expect(dflt.excludedLapsedForgeKeep).toBe(999n);
    expect(dflt.totalKeep).toBe(1_548_996n);
    const restored = buildGenesisLeafSet(seed, { restoreLapsedForge: true });
    expect(restored.excludedLapsedForgeKeep).toBe(0n);
    expect(restored.totalKeep).toBe(1_548_996n + 999n);
    expect(expectedFrozenLedgerKeep(seed, { restoreLapsedForge: true })).toBe(restored.totalKeep);
  });
  it('a mixed mail migrates its KEEP leg only and is counted for the census', () => {
    const seed = productionSeed();
    seed.pendingMailKeep.push({ wallet: wallet(21), mailId: 'MX', keep: 250n, mixed: true, welcome: false });
    const set = buildGenesisLeafSet(seed);
    expect(set.mixedMailCount).toBe(1);
    expect(set.leaves.find((l) => l.wallet === wallet(21))!.breakdown.mailKeep).toBe(250n);
  });
});

describe('unsound inputs are refused, never repaired', () => {
  it('negative player_keep, duplicate accounts and duplicate mails throw', () => {
    const neg = productionSeed(); neg.playBalances[0]!.keep = -1n;
    expect(() => buildGenesisLeafSet(neg)).toThrow(/negative/);
    const dup = productionSeed(); dup.playBalances.push({ wallet: wallet(0), keep: 1n });
    expect(() => buildGenesisLeafSet(dup)).toThrow(/duplicate player_keep/);
    const dupMail = productionSeed();
    dupMail.pendingMailKeep.push({ ...dupMail.pendingMailKeep[0]! });
    expect(() => buildGenesisLeafSet(dupMail)).toThrow(/duplicate pending mail/);
  });
});
