/**
 * E3 migration model — the genesis leaf set, pure and integer (forge-model.ts
 * pattern; no DB, no chain). Encodes docs/phase-e/E1-MIGRATION-PLAN.md §1 and
 * §4 so the cutover tool (HELD, E3a) and the rehearsal can be checked against
 * one reference before any production row moves.
 *
 * RULES ENCODED (each pinned by e3-migration-model.test.ts):
 *  - One leaf per wallet = L1 play balance + L2 unclaimed Forge KEEP attributed
 *    to the deed owner at F + L4 pending KEEP mail + the OD4 welcome re-issue
 *    (owner 2026-09-20: re-issued ONCE, only for wallets whose welcome mail
 *    expired unclaimed; a DEVNET testing aid, never a mainnet economy feature).
 *  - L3 withdrawal escrow never enters a leaf (drained or excluded, §1 L3).
 *  - OD7 internal wallets: default EXCLUDE and disclose the excluded total.
 *  - Units: the ledger is WHOLE KEEP; the distributor pays SPL base units, so
 *    every leaf carries amount_keep AND amount_base_units = amount_keep × 10^9
 *    (TOKEN.decimals), converted in exactly one place with the u64 guard from
 *    packages/chain/src/hotWallet.ts. Test vector: 5,000 KEEP → 5,000,000,000,000.
 *  - Split invariants: I1a settlement conservation (emission_pool delta over
 *    the day-B settlement == Σ keep_paid), I1b leaf equality measured AFTER
 *    settlement + migrate postings, I2′ emission_pool delta over the whole
 *    cutover == day-B allocation + Σ welcome re-issue.
 *
 * Every number here is PROPOSED unless it is imported from
 * packages/shared/src/constants.ts (TOKEN.decimals, PLAYTEST.welcomeKeep).
 */
import { PLAYTEST, TOKEN } from '@shardkeep/shared';

const U64_MAX = (1n << 64n) - 1n;

/** L1: `accounts.kind = 'player_keep'` balance per wallet (whole KEEP). */
export interface PlayBalance { wallet: string; keep: bigint }
/** L2a: `base_forge_positions` claimable row attributed to the deed owner at F
 *  (after the forced ownership sweep). `lapsed` = past the 30-day window but
 *  unswept; folded only when `restoreLapsed` (OD4b, default false). */
export interface ForgeAllocation { wallet: string; baseId: string; keep: bigint; lapsed?: boolean }
/** L4: pending reward mail with a KEEP attachment. `mixed` = also carries
 *  SHARDS/ITEM legs (only the KEEP leg migrates; the rest stays pending with
 *  expiry paused). `welcome` = dedupe_key `welcome:%` / `welcome-keep:%`. */
export interface PendingMailKeep { wallet: string; mailId: string; keep: bigint; mixed: boolean; welcome: boolean }

export interface GenesisCensusInput {
  playBalances: PlayBalance[];
  forgeUnclaimed: ForgeAllocation[];
  /** L2b `forge_contributions` (wallet-keyed legacy); expected empty. */
  legacyForgeUnclaimed: PlayBalance[];
  pendingMailKeep: PendingMailKeep[];
  /** Wallets whose welcome mail expired unclaimed (mail_messages reward_state
   *  = 'expired', dedupe_key welcome%). OD4: re-issued once inside the leaf. */
  expiredWelcomeWallets: string[];
  /** OD7: ALPHA_WALLETS ∪ ADMIN_WALLETS and legacy dev grants. */
  internalWallets: string[];
  /** L3 gross KEEP in withdrawal_escrow — reported, never a leaf. */
  withdrawalEscrowKeep: bigint;
}

export interface GenesisOptions {
  /** OD7 default: exclude internal wallets from the root and disclose the sum. */
  includeInternalWallets?: boolean;
  /** OD4b default: lapsed-but-unswept Forge rows are NOT restored. */
  restoreLapsedForge?: boolean;
  /** PLAYTEST.welcomeKeep unless a test overrides it. */
  welcomeKeep?: bigint;
}

export interface GenesisLeaf {
  wallet: string;
  amountKeep: bigint;
  amountBaseUnits: bigint;
  breakdown: { playKeep: bigint; forgeUnclaimed: bigint; mailKeep: bigint; welcomeReissue: bigint };
}

export interface GenesisLeafSet {
  /** Wallet-ascending, like money/snapshot.ts (deterministic root input). */
  leaves: GenesisLeaf[];
  totalKeep: bigint;
  totalBaseUnits: bigint;
  /** Σ welcome re-issue — the ONLY new emission the cutover creates (I2′). */
  welcomeReissueKeep: bigint;
  /** OD7 disclosure line: KEEP held by excluded internal wallets. */
  excludedInternalKeep: bigint;
  excludedInternalWallets: string[];
  /** L2a lapsed rows left out (OD4b default). */
  excludedLapsedForgeKeep: bigint;
  /** L3, reported for the census line; never in a leaf. */
  withdrawalEscrowKeep: bigint;
  /** Mixed mails whose non-KEEP legs stay pending (count for the census). */
  mixedMailCount: number;
}

/** Whole KEEP → SPL base units, converted ONCE, u64-guarded (hotWallet.ts:514). */
export function keepToBaseUnits(keep: bigint): bigint {
  if (keep < 0n) throw new RangeError(`keepToBaseUnits: negative amount ${keep}`);
  const units = keep * 10n ** BigInt(TOKEN.decimals);
  if (units > U64_MAX) throw new RangeError('genesis leaf exceeds SPL Token u64');
  return units;
}

/** Build the genesis leaf set from a census-shaped input (post-settlement,
 *  post-ownership-sweep state). Pure; throws on inputs that would make the
 *  root unsound instead of silently repairing them. */
export function buildGenesisLeafSet(input: GenesisCensusInput, opts: GenesisOptions = {}): GenesisLeafSet {
  const welcomeKeep = opts.welcomeKeep ?? BigInt(PLAYTEST.welcomeKeep);
  const internal = new Set(input.internalWallets);
  const includeInternal = opts.includeInternalWallets === true;
  const restoreLapsed = opts.restoreLapsedForge === true;

  const byWallet = new Map<string, GenesisLeaf['breakdown']>();
  const bucket = (wallet: string) => {
    let b = byWallet.get(wallet);
    if (!b) { b = { playKeep: 0n, forgeUnclaimed: 0n, mailKeep: 0n, welcomeReissue: 0n }; byWallet.set(wallet, b); }
    return b;
  };

  const seenPlay = new Set<string>();
  for (const p of input.playBalances) {
    if (seenPlay.has(p.wallet)) throw new Error(`duplicate player_keep account for ${p.wallet}`);
    seenPlay.add(p.wallet);
    if (p.keep < 0n) throw new Error(`negative player_keep for ${p.wallet}: ${p.keep}`);
    if (p.keep > 0n) bucket(p.wallet).playKeep += p.keep;
  }
  let excludedLapsedForgeKeep = 0n;
  for (const f of input.forgeUnclaimed) {
    if (f.keep <= 0n) continue; // 'nothing' rows (forge.ts claimabilityOf) never escrowed KEEP
    if (f.lapsed && !restoreLapsed) { excludedLapsedForgeKeep += f.keep; continue; }
    bucket(f.wallet).forgeUnclaimed += f.keep;
  }
  for (const f of input.legacyForgeUnclaimed) if (f.keep > 0n) bucket(f.wallet).forgeUnclaimed += f.keep;
  let mixedMailCount = 0;
  const seenMail = new Set<string>();
  for (const m of input.pendingMailKeep) {
    if (seenMail.has(m.mailId)) throw new Error(`duplicate pending mail ${m.mailId}`);
    seenMail.add(m.mailId);
    if (m.mixed) mixedMailCount++;
    if (m.keep > 0n) bucket(m.wallet).mailKeep += m.keep;
  }
  // OD4: exactly once per wallet, and never for a wallet whose welcome is still
  // pending (that KEEP migrates as L4) — a wallet is either re-issued or folded.
  const pendingWelcome = new Set(input.pendingMailKeep.filter((m) => m.welcome).map((m) => m.wallet));
  let welcomeReissueKeep = 0n;
  for (const wallet of new Set(input.expiredWelcomeWallets)) {
    if (pendingWelcome.has(wallet)) throw new Error(`welcome re-issue and pending welcome collide for ${wallet}`);
    bucket(wallet).welcomeReissue += welcomeKeep;
    welcomeReissueKeep += welcomeKeep;
  }

  const leaves: GenesisLeaf[] = [];
  let excludedInternalKeep = 0n;
  const excludedInternalWallets: string[] = [];
  for (const [wallet, breakdown] of byWallet) {
    const amountKeep = breakdown.playKeep + breakdown.forgeUnclaimed + breakdown.mailKeep + breakdown.welcomeReissue;
    if (amountKeep <= 0n) continue;
    if (internal.has(wallet) && !includeInternal) {
      excludedInternalKeep += amountKeep;
      excludedInternalWallets.push(wallet);
      continue;
    }
    leaves.push({ wallet, amountKeep, amountBaseUnits: keepToBaseUnits(amountKeep), breakdown });
  }
  leaves.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  excludedInternalWallets.sort();

  return {
    leaves,
    totalKeep: leaves.reduce((s, l) => s + l.amountKeep, 0n),
    totalBaseUnits: leaves.reduce((s, l) => s + l.amountBaseUnits, 0n),
    welcomeReissueKeep,
    excludedInternalKeep,
    excludedInternalWallets,
    excludedLapsedForgeKeep,
    withdrawalEscrowKeep: input.withdrawalEscrowKeep,
    mixedMailCount,
  };
}

/** I1a — day-B settlement conservation: the emission_pool debit over the
 *  settlement step equals Σ keep_paid of the rows it settled (forge.ts posts
 *  emission_pool −payout / forge_payout_escrow +payout per row). */
export function checkI1a(settlement: { emissionPoolDelta: bigint; keepPaidSum: bigint }): boolean {
  return settlement.emissionPoolDelta === -settlement.keepPaidSum;
}

/** I1b — leaf equality AFTER settlement and migrate postings: Σ leaves ==
 *  frozen custodial total that the root must fund == vault funding, in both
 *  denominations. `frozenLedgerKeep` is Σ player_keep after the L2/L4 migrate
 *  postings and the welcome re-issue, minus excluded (internal, lapsed) KEEP. */
export function checkI1b(set: GenesisLeafSet, frozenLedgerKeep: bigint, vaultFundedBaseUnits: bigint): boolean {
  return set.totalKeep === frozenLedgerKeep
    && set.totalBaseUnits === keepToBaseUnits(frozenLedgerKeep)
    && set.totalBaseUnits === vaultFundedBaseUnits;
}

/** I2′ — emission_pool over the whole cutover moves by exactly the day-B
 *  allocation (settlement) plus the approved welcome re-issue; nothing else. */
export function checkI2Prime(
  emissionPoolBefore: bigint, emissionPoolAfter: bigint, dayBKeepPaid: bigint, set: GenesisLeafSet,
): boolean {
  return emissionPoolBefore - emissionPoolAfter === dayBKeepPaid + set.welcomeReissueKeep;
}

/** The frozen custodial total the ledger must show after the migrate postings
 *  when every class in the input is folded: what I1b compares the leaves to.
 *  Kept separate from buildGenesisLeafSet so a test can compute both sides
 *  independently. */
export function expectedFrozenLedgerKeep(input: GenesisCensusInput, opts: GenesisOptions = {}): bigint {
  const welcomeKeep = opts.welcomeKeep ?? BigInt(PLAYTEST.welcomeKeep);
  const internal = new Set(opts.includeInternalWallets ? [] : input.internalWallets);
  const restoreLapsed = opts.restoreLapsedForge === true;
  let total = 0n;
  for (const p of input.playBalances) if (p.keep > 0n && !internal.has(p.wallet)) total += p.keep;
  for (const f of input.forgeUnclaimed) {
    if (f.keep <= 0n || internal.has(f.wallet) || (f.lapsed && !restoreLapsed)) continue;
    total += f.keep;
  }
  for (const f of input.legacyForgeUnclaimed) if (f.keep > 0n && !internal.has(f.wallet)) total += f.keep;
  for (const m of input.pendingMailKeep) if (m.keep > 0n && !internal.has(m.wallet)) total += m.keep;
  for (const w of new Set(input.expiredWelcomeWallets)) if (!internal.has(w)) total += welcomeKeep;
  return total;
}
