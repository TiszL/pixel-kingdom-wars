/**
 * Custody-retirement model tests — the rules the retirement tool must ship with
 * (the "why", per CLAUDE.md test rule; docs/phase-e/GEMS-CURRENCY.md §3 G-8 and
 * §7, D-152). These REWRITE the 15 genesis leaf-set tests to the new owner rule
 * (the test count only rises: 16 here):
 *  1. Units: whole KEEP becomes whole Gems at GEMS.gemsPerKeep (1:1 LOCKED);
 *     nothing is ever scaled by 10⁹ (the old leaf vector would pay 1e-9 or 1e9×).
 *  2. G-8: Σ Gems minted == the frozen custodial total minus L3, seeded with the
 *     2026-09-20 production census (player_keep 1,021,562 over 169 accounts /
 *     forge_payout_escrow 187,434 over 18 rows / mail_keep_escrow 340,000 /
 *     withdrawal_escrow 1,000 / liability 1,549,996); the pool rises by exactly
 *     the converted (+ swept) KEEP; liability after is zero.
 *  3. L3 withdrawal escrow never converts and must be 0 at F (the retirement
 *     refuses otherwise — a legacy payout after F would pay the same KEEP twice).
 *  4. I1a stays split from G-8; G-8 fails loudly on any stray posting.
 *  5. D-152: the welcome aid is NOT re-issued inside the retirement; expired
 *     welcome wallets are listed once for the separate Gems welcome grant, and a
 *     wallet whose welcome is still pending converts that KEEP as L4 instead.
 *  6. Internal wallets are excluded from the conversion (swept, zero Gems) and
 *     disclosed; opt-in include exists for rehearsals.
 *  7. OD4b: lapsed-but-unswept Forge rows stay out unless restore is chosen.
 *  8. Mixed mails convert the KEEP leg only and are counted.
 *  9. L5 legacy league entitlement KEEP converts to Gems (owner: no KEEP prizes).
 */
import { GEMS, PLAYTEST } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  assertReadyForRetirement, buildRetirementPlan, checkG8, checkI1a, custodialLiability, expectedConvertedKeep,
  keepToGems, type CustodialLedger, type ForgeAllocation, type PendingMailKeep, type PlayBalance,
  type RetirementCensusInput,
} from './custody-retirement-model';

// ---- production census 2026-09-20 (read-only capture; predicates in census-e3.sql)
const PROD = {
  playerKeepTotal: 1_021_562n, playerKeepAccounts: 169, positive: 59, exactly5000: 15, above5000: 24,
  forgeEscrow: 187_434n, forgeRows: 18,
  mailEscrow: 340_000n, // 68 pending welcome mails × 5,000
  withdrawalEscrow: 1_000n, // one failed row — drained before F
  liability: 1_549_996n,
  emissionPool: 498_370_771n,
} as const;

const wallet = (i: number) => `W${String(i).padStart(4, '0')}`;

/** A deterministic population reproducing every aggregate above. */
function productionSeed(): RetirementCensusInput {
  const playBalances: PlayBalance[] = [];
  let i = 0;
  for (let k = 0; k < 15; k++) playBalances.push({ wallet: wallet(i++), keep: 5_000n });           // exactly 5,000
  for (let k = 1; k <= 20; k++) playBalances.push({ wallet: wallet(i++), keep: BigInt(100 * k) }); // 0 < b < 5,000 → 21,000
  for (let k = 0; k < 23; k++) playBalances.push({ wallet: wallet(i++), keep: 30_000n });          // above 5,000
  playBalances.push({ wallet: wallet(i++), keep: 235_562n });                                       // 24th above 5,000
  while (playBalances.length < PROD.playerKeepAccounts) playBalances.push({ wallet: wallet(i++), keep: 0n });
  const forgeUnclaimed: ForgeAllocation[] = [];
  for (let k = 0; k < 17; k++) forgeUnclaimed.push({ wallet: wallet(k), baseId: `B${k}`, keep: 10_000n });
  forgeUnclaimed.push({ wallet: wallet(17), baseId: 'B17', keep: 17_434n });
  const pendingMailKeep: PendingMailKeep[] = [];
  for (let k = 0; k < 68; k++) {
    pendingMailKeep.push({ wallet: wallet(59 + k), mailId: `M${k}`, keep: 5_000n, mixed: false, welcome: true });
  }
  return {
    playBalances, forgeUnclaimed, legacyForgeUnclaimed: [], pendingMailKeep, leagueEntitlements: [],
    expiredWelcomeWallets: [], internalWallets: [], withdrawalEscrowKeep: PROD.withdrawalEscrow,
  };
}

/** The census after the pre-F drain (L3 refunded to L1 or paid out; here the
 *  one failed row was refunded to wallet 58 before F). */
function drainedSeed(): RetirementCensusInput {
  const seed = productionSeed();
  seed.playBalances.find((p) => p.wallet === wallet(58))!.keep += PROD.withdrawalEscrow;
  seed.withdrawalEscrowKeep = 0n;
  return seed;
}

function ledgerBefore(seed: RetirementCensusInput): CustodialLedger {
  return {
    playerKeep: seed.playBalances.reduce((s, p) => s + p.keep, 0n),
    withdrawalEscrow: seed.withdrawalEscrowKeep,
    forgePayoutEscrow: seed.forgeUnclaimed.reduce((s, f) => s + f.keep, 0n),
    leagueEntitlementEscrow: seed.leagueEntitlements.reduce((s, e) => s + e.keep, 0n),
    mailKeepEscrow: seed.pendingMailKeep.reduce((s, m) => s + m.keep, 0n),
    emissionPool: PROD.emissionPool,
    gemsMintedRetirement: 0n,
  };
}

/** What the ledger shows after a correct retirement transaction. */
function ledgerAfter(before: CustodialLedger, plan: ReturnType<typeof buildRetirementPlan>): CustodialLedger {
  return {
    playerKeep: 0n, withdrawalEscrow: 0n, forgePayoutEscrow: 0n, leagueEntitlementEscrow: 0n, mailKeepEscrow: 0n,
    emissionPool: before.emissionPool + plan.totalKeepConverted + plan.sweptInternalKeep + plan.excludedLapsedForgeKeep * 0n,
    gemsMintedRetirement: before.gemsMintedRetirement + plan.totalGemsMinted,
  };
}

describe('units — whole KEEP becomes whole Gems, never base units', () => {
  it('5,000 KEEP → 5,000 Gems at the LOCKED 1:1 rate; the ×10⁹ leaf vector is gone', () => {
    expect(GEMS.gemsPerKeep).toBe(1);
    expect(keepToGems(5_000n)).toBe(5_000n);
    expect(keepToGems(5_000n)).not.toBe(5_000_000_000_000n);
    expect(keepToGems(BigInt(PLAYTEST.welcomeKeep))).toBe(BigInt(PLAYTEST.welcomeGems));
    expect(keepToGems(0n)).toBe(0n);
  });
  it('refuses a negative amount instead of minting a negative Gems balance', () => {
    expect(() => keepToGems(-1n)).toThrow(RangeError);
  });
});

describe('retirement plan — production census 2026-09-20', () => {
  const seed = drainedSeed();
  const plan = buildRetirementPlan(seed);

  it('the seed reproduces every captured aggregate (so the test is about production, not a toy)', () => {
    const raw = productionSeed();
    const positive = raw.playBalances.filter((p) => p.keep > 0n);
    expect(raw.playBalances.length).toBe(PROD.playerKeepAccounts);
    expect(positive.length).toBe(PROD.positive);
    expect(positive.filter((p) => p.keep === 5_000n).length).toBe(PROD.exactly5000);
    expect(positive.filter((p) => p.keep > 5_000n).length).toBe(PROD.above5000);
    expect(positive.reduce((s, p) => s + p.keep, 0n)).toBe(PROD.playerKeepTotal);
    expect(raw.forgeUnclaimed.length).toBe(PROD.forgeRows);
    expect(raw.forgeUnclaimed.reduce((s, f) => s + f.keep, 0n)).toBe(PROD.forgeEscrow);
    expect(raw.pendingMailKeep.reduce((s, m) => s + m.keep, 0n)).toBe(PROD.mailEscrow);
    expect(PROD.playerKeepTotal + PROD.forgeEscrow + PROD.mailEscrow + PROD.withdrawalEscrow).toBe(PROD.liability);
  });

  it('G-8: Σ Gems minted == the whole custodial liability once L3 is drained, and liability after is zero', () => {
    expect(plan.totalKeepConverted).toBe(PROD.liability); // the refunded L3 row converts as L1
    expect(plan.totalGemsMinted).toBe(1_549_996n);
    expect(expectedConvertedKeep(seed)).toBe(plan.totalKeepConverted);
    const before = ledgerBefore(seed);
    expect(custodialLiability(before)).toBe(PROD.liability);
    const after = ledgerAfter(before, plan);
    expect(checkG8(plan, before, after)).toBe(true);
    expect(custodialLiability(after)).toBe(0n);
    expect(after.emissionPool - before.emissionPool).toBe(1_549_996n);
  });

  it('L3 never converts: the retirement refuses while withdrawal escrow or in-flight withdrawals exist', () => {
    const undrained = buildRetirementPlan(productionSeed());
    expect(undrained.withdrawalEscrowKeep).toBe(1_000n);
    expect(undrained.totalKeepConverted).toBe(PROD.liability - PROD.withdrawalEscrow);
    expect(() => assertReadyForRetirement(undrained, { unbonding: 0, processing: 0, pendingKeepDeposits: 0 })).toThrow(/withdrawal_escrow/);
    expect(() => assertReadyForRetirement(plan, { unbonding: 1, processing: 0, pendingKeepDeposits: 0 })).toThrow(/terminal/);
    expect(() => assertReadyForRetirement(plan, { unbonding: 0, processing: 0, pendingKeepDeposits: 2 })).toThrow(/late credits/);
    expect(() => assertReadyForRetirement(plan, { unbonding: 0, processing: 0, pendingKeepDeposits: 0 })).not.toThrow();
  });

  it('one posting per wallet with a positive total, wallet-ascending, zero wallets omitted', () => {
    expect(plan.postings.length).toBe(59 + 68); // positive balances + dormant welcome-mail wallets
    const wallets = plan.postings.map((p) => p.wallet);
    expect(new Set(wallets).size).toBe(wallets.length);
    expect([...wallets].sort()).toEqual(wallets);
    expect(plan.postings.every((p) => p.breakdown.playKeep + p.breakdown.forgeUnclaimed + p.breakdown.mailKeep + p.breakdown.leagueKeep === p.keepConverted)).toBe(true);
    expect(plan.postings.every((p) => p.gemsMinted === keepToGems(p.keepConverted))).toBe(true);
    // wallet 17 is the 3rd small account (300 KEEP) and carries the odd Forge row
    expect(plan.postings.find((p) => p.wallet === wallet(17))!.breakdown).toEqual({
      playKeep: 300n, forgeUnclaimed: 17_434n, mailKeep: 0n, leagueKeep: 0n,
    });
    expect(plan.postings.find((p) => p.wallet === wallet(59))!.breakdown.mailKeep).toBe(5_000n);
    expect(plan.postings.find((p) => p.wallet === wallet(150))).toBeUndefined();
    expect(plan.sweptInternalKeep).toBe(0n);
    expect(plan.mixedMailCount).toBe(0);
    expect(plan.welcomeGemsPending).toEqual([]);
  });
});

describe('split invariants I1a / G-8', () => {
  it('I1a: the day-B settlement moves emission_pool by exactly −Σ keep_paid', () => {
    expect(checkI1a({ emissionPoolDelta: -42_000n, keepPaidSum: 42_000n })).toBe(true);
    expect(checkI1a({ emissionPoolDelta: -41_999n, keepPaidSum: 42_000n })).toBe(false);
    expect(checkI1a({ emissionPoolDelta: 0n, keepPaidSum: 0n })).toBe(true);
  });

  it('G-8 fails loudly on a stray posting, a missing Gems credit or a non-zero residue', () => {
    const seed = drainedSeed();
    const plan = buildRetirementPlan(seed);
    const before = ledgerBefore(seed);
    const good = ledgerAfter(before, plan);
    expect(checkG8(plan, before, good)).toBe(true);
    // a lazy expiry or gameplay reward inside the window moves the pool by one more KEEP
    expect(checkG8(plan, before, { ...good, emissionPool: good.emissionPool + 1n })).toBe(false);
    // Gems credited short of the KEEP debited
    expect(checkG8(plan, before, { ...good, gemsMintedRetirement: good.gemsMintedRetirement - 1n })).toBe(false);
    // a custodial residue outside the fenced late-credit path
    expect(checkG8(plan, before, { ...good, playerKeep: 1n })).toBe(false);
    // withdrawal escrow not drained
    expect(checkG8(plan, { ...before, withdrawalEscrow: 1n }, good)).toBe(false);
  });
});

describe('D-152 welcome aid — a separate Gems grant, never a retirement posting', () => {
  it('expired-welcome wallets are listed once for the Gems welcome and are not converted here', () => {
    const seed = drainedSeed();
    seed.expiredWelcomeWallets = [wallet(140), wallet(141), wallet(141)]; // listed twice: still once
    const plan = buildRetirementPlan(seed);
    expect(plan.welcomeGemsPending).toEqual([wallet(140), wallet(141)]);
    expect(plan.welcomeGemsPendingTotal).toBe(2n * BigInt(PLAYTEST.welcomeGems));
    expect(plan.postings.find((p) => p.wallet === wallet(140))).toBeUndefined();
    expect(plan.totalGemsMinted).toBe(1_549_996n); // unchanged by the pending grants
  });
  it('a wallet whose welcome mail is still pending converts that KEEP as L4 and is not listed twice', () => {
    const seed = drainedSeed();
    seed.expiredWelcomeWallets = [wallet(59)]; // wallet 59 still has a PENDING welcome mail
    const plan = buildRetirementPlan(seed);
    expect(plan.welcomeGemsPending).toEqual([]);
    expect(plan.postings.find((p) => p.wallet === wallet(59))!.breakdown.mailKeep).toBe(5_000n);
  });
});

describe('internal wallets', () => {
  it('default: excluded from the conversion — swept with zero Gems — and disclosed as a total', () => {
    const seed = drainedSeed();
    seed.internalWallets = [wallet(58), wallet(17)]; // (235,562 + 1,000 refunded) + (300 play + 17,434 Forge)
    const plan = buildRetirementPlan(seed);
    expect(plan.sweptInternalWallets).toEqual([wallet(17), wallet(58)]);
    expect(plan.sweptInternalKeep).toBe(236_562n + 300n + 17_434n);
    expect(plan.totalKeepConverted).toBe(1_549_996n - 254_296n);
    expect(plan.postings.some((p) => p.wallet === wallet(58))).toBe(false);
    const before = ledgerBefore(seed);
    expect(checkG8(plan, before, ledgerAfter(before, plan))).toBe(true);
    expect(expectedConvertedKeep(seed)).toBe(plan.totalKeepConverted);
  });
  it('opt-in include converts them and the totals agree', () => {
    const seed = drainedSeed();
    seed.internalWallets = [wallet(58)];
    const plan = buildRetirementPlan(seed, { includeInternalWallets: true });
    expect(plan.sweptInternalKeep).toBe(0n);
    expect(plan.totalKeepConverted).toBe(1_549_996n);
  });
});

describe('OD4b lapsed Forge rows, mixed mails and league entitlements', () => {
  it('lapsed-but-unswept rows stay out by default and convert only on restore', () => {
    const seed = drainedSeed();
    seed.forgeUnclaimed.push({ wallet: wallet(20), baseId: 'B20', keep: 999n, lapsed: true });
    const dflt = buildRetirementPlan(seed);
    expect(dflt.excludedLapsedForgeKeep).toBe(999n);
    expect(dflt.totalKeepConverted).toBe(1_549_996n);
    const restored = buildRetirementPlan(seed, { restoreLapsedForge: true });
    expect(restored.excludedLapsedForgeKeep).toBe(0n);
    expect(restored.totalKeepConverted).toBe(1_549_996n + 999n);
    expect(expectedConvertedKeep(seed, { restoreLapsedForge: true })).toBe(restored.totalKeepConverted);
  });
  it('a mixed mail converts its KEEP leg only and is counted for the census', () => {
    const seed = drainedSeed();
    seed.pendingMailKeep.push({ wallet: wallet(21), mailId: 'MX', keep: 250n, mixed: true, welcome: false });
    const plan = buildRetirementPlan(seed);
    expect(plan.mixedMailCount).toBe(1);
    expect(plan.postings.find((p) => p.wallet === wallet(21))!.breakdown.mailKeep).toBe(250n);
  });
  it('legacy league entitlement KEEP converts to Gems (owner: league KEEP prizes are removed)', () => {
    const seed = drainedSeed();
    seed.leagueEntitlements = [{ wallet: wallet(22), entitlementId: 'E1', keep: 1_234n }];
    const plan = buildRetirementPlan(seed);
    expect(plan.postings.find((p) => p.wallet === wallet(22))!.breakdown.leagueKeep).toBe(1_234n);
    expect(plan.totalGemsMinted).toBe(1_549_996n + 1_234n);
    const before = ledgerBefore(seed);
    expect(before.leagueEntitlementEscrow).toBe(1_234n);
    expect(checkG8(plan, before, ledgerAfter(before, plan))).toBe(true);
  });
});

describe('unsound inputs are refused, never repaired', () => {
  it('negative balances, duplicate accounts, duplicate mails and duplicate entitlements throw', () => {
    const neg = drainedSeed(); neg.playBalances[0]!.keep = -1n;
    expect(() => buildRetirementPlan(neg)).toThrow(/negative/);
    const dup = drainedSeed(); dup.playBalances.push({ wallet: wallet(0), keep: 1n });
    expect(() => buildRetirementPlan(dup)).toThrow(/duplicate player_keep/);
    const dupMail = drainedSeed();
    dupMail.pendingMailKeep.push({ ...dupMail.pendingMailKeep[0]! });
    expect(() => buildRetirementPlan(dupMail)).toThrow(/duplicate pending mail/);
    const dupEnt = drainedSeed();
    dupEnt.leagueEntitlements = [{ wallet: wallet(1), entitlementId: 'E', keep: 1n }, { wallet: wallet(2), entitlementId: 'E', keep: 1n }];
    expect(() => buildRetirementPlan(dupEnt)).toThrow(/duplicate league entitlement/);
  });
});
