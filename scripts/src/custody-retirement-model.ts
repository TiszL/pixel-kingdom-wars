/**
 * Custody-retirement model — pure and integer (forge-model.ts pattern; no DB,
 * no chain). Encodes docs/phase-e/GEMS-CURRENCY.md §7 and invariant G-8 (D-152)
 * so the retirement tool (HELD; `apps/api/src/db/keepCustodyRetire.ts`, not yet
 * written) and its rehearsal can be checked against one reference before any
 * production row moves. It REPLACES the genesis leaf-set model
 * (`e3-migration-model.ts`, kept as history): under D-152 every custodial KEEP
 * liability becomes Gems 1:1 at F — there is no genesis program, no leaf set,
 * no base-unit scaling and no claim.
 *
 * RULES ENCODED (each pinned by custody-retirement-model.test.ts):
 *  - One retirement posting per wallet = L1 play balance + L2 claimable Forge
 *    KEEP attributed to the deed owner at F + L4 pending KEEP mail legs + L5
 *    legacy league entitlement KEEP, all converted to Gems at GEMS.gemsPerKeep
 *    (LOCKED 1:1), each posting `player_keep → emission_pool` (D-152 §0-3:
 *    "same way as spent KEEP") and `gems_mint → player_gems` (reason
 *    `retirement`). Whole KEEP ↔ whole Gems; never ×10⁹.
 *  - L3 withdrawal escrow never converts: it must be 0 at F (drained or
 *    operator-resolved before the window), otherwise the retirement refuses.
 *  - Internal wallets (ALPHA_WALLETS ∪ ADMIN_WALLETS, dev grants) are excluded
 *    from the conversion and disclosed: their custodial KEEP is swept to the
 *    pool with zero Gems (PROPOSED default; opt-in include exists for tests).
 *  - The welcome aid is NOT re-issued inside the retirement (D-152 supersedes
 *    OD4): wallets whose welcome mail expired unclaimed are only listed for the
 *    separate once-per-wallet Gems welcome grant (`welcome-gems:<wallet>`),
 *    which is gated on the devnet cluster like today's welcome KEEP.
 *  - Lapsed-but-unswept Forge rows stay out unless restore is chosen (OD4b
 *    default no; they expire to the pool as the lazy sweep would).
 *  - Mixed mails convert the KEEP leg only; other legs stay pending; counted.
 *  - Invariants: I1a settlement conservation is unchanged; G-8 replaces
 *    I1b/I2′: Σ Gems minted with reason `retirement` == Σ converted KEEP,
 *    `emission_pool` delta over the retirement == converted + swept internal
 *    KEEP, withdrawal escrow == 0, custodial liability after == 0.
 *
 * Every number here is PROPOSED unless imported from
 * packages/shared/src/constants.ts (GEMS.gemsPerKeep, PLAYTEST.welcomeGems).
 */
import { GEMS, PLAYTEST } from '@shardkeep/shared';

/** L1: `accounts.kind = 'player_keep'` balance per wallet (whole KEEP). */
export interface PlayBalance { wallet: string; keep: bigint }
/** L2a: `base_forge_positions` claimable row attributed to the deed owner at F
 *  (after the forced ownership sweep). `lapsed` = past the 30-day window but
 *  unswept; converted only when `restoreLapsedForge` (OD4b, default false). */
export interface ForgeAllocation { wallet: string; baseId: string; keep: bigint; lapsed?: boolean }
/** L4: pending reward mail with a KEEP attachment. `mixed` = also carries
 *  SHARDS/ITEM legs (only the KEEP leg converts; the rest stays pending with
 *  expiry paused). `welcome` = dedupe_key `welcome:%` / `welcome-keep:%`. */
export interface PendingMailKeep { wallet: string; mailId: string; keep: bigint; mixed: boolean; welcome: boolean }
/** L5: `base_league_entitlements where paid_at is null and keep_amount > 0`
 *  (`leagues.ts:557` already writes 0; production expects none). */
export interface LeagueEntitlement { wallet: string; entitlementId: string; keep: bigint }

export interface RetirementCensusInput {
  playBalances: PlayBalance[];
  forgeUnclaimed: ForgeAllocation[];
  /** L2b `forge_contributions` (wallet-keyed legacy); expected empty. */
  legacyForgeUnclaimed: PlayBalance[];
  pendingMailKeep: PendingMailKeep[];
  leagueEntitlements: LeagueEntitlement[];
  /** Wallets whose welcome mail expired unclaimed. NOT converted here; listed
   *  for the separate Gems welcome grant (D-152 §0-6). */
  expiredWelcomeWallets: string[];
  /** ALPHA_WALLETS ∪ ADMIN_WALLETS and legacy dev grants (disclosed). */
  internalWallets: string[];
  /** L3 gross KEEP in withdrawal_escrow — must be 0 at F. */
  withdrawalEscrowKeep: bigint;
}

export interface RetirementOptions {
  /** Default: internal wallets are swept without Gems and disclosed. */
  includeInternalWallets?: boolean;
  /** OD4b default: lapsed-but-unswept Forge rows are NOT restored. */
  restoreLapsedForge?: boolean;
}

export interface RetirementPosting {
  wallet: string;
  /** Whole KEEP debited from the wallet's custodial classes (→ emission_pool). */
  keepConverted: bigint;
  /** Whole Gems credited (`gems_mint → player_gems`, reason `retirement`). */
  gemsMinted: bigint;
  breakdown: { playKeep: bigint; forgeUnclaimed: bigint; mailKeep: bigint; leagueKeep: bigint };
}

export interface RetirementPlan {
  /** Wallet-ascending, like money/snapshot.ts (deterministic journal order). */
  postings: RetirementPosting[];
  /** Σ keepConverted == Σ gemsMinted × gemsPerKeep⁻¹ (1:1 LOCKED). */
  totalKeepConverted: bigint;
  totalGemsMinted: bigint;
  /** Internal wallets: swept to the pool with zero Gems; disclosed. */
  sweptInternalKeep: bigint;
  sweptInternalWallets: string[];
  /** L2a lapsed rows left to expire (OD4b default). */
  excludedLapsedForgeKeep: bigint;
  /** L3, reported; the plan refuses unless it is 0 (see assertReadyForRetirement). */
  withdrawalEscrowKeep: bigint;
  /** Mixed mails whose non-KEEP legs stay pending (count for the census). */
  mixedMailCount: number;
  /** Wallets that receive the separate Gems welcome grant once Gems ship
   *  (deduplicated; never a retirement posting). */
  welcomeGemsPending: string[];
  /** PLAYTEST.welcomeGems × welcomeGemsPending.length — a later `grant`
   *  reason, never part of totalGemsMinted. */
  welcomeGemsPendingTotal: bigint;
}

const GEMS_PER_KEEP = BigInt(GEMS.gemsPerKeep);

/** Whole KEEP → whole Gems at the LOCKED rate. There is deliberately no
 *  base-unit scaling anywhere in the retirement (the old leaf model's ×10⁹
 *  vector is history). */
export function keepToGems(keep: bigint): bigint {
  if (keep < 0n) throw new RangeError(`keepToGems: negative amount ${keep}`);
  return keep * GEMS_PER_KEEP;
}

/** Build the retirement plan from a census-shaped input (post-settlement,
 *  post-ownership-sweep state). Pure; throws on inputs that would make the
 *  retirement unsound instead of silently repairing them. */
export function buildRetirementPlan(input: RetirementCensusInput, opts: RetirementOptions = {}): RetirementPlan {
  const internal = new Set(input.internalWallets);
  const includeInternal = opts.includeInternalWallets === true;
  const restoreLapsed = opts.restoreLapsedForge === true;

  const byWallet = new Map<string, RetirementPosting['breakdown']>();
  const bucket = (wallet: string) => {
    let b = byWallet.get(wallet);
    if (!b) { b = { playKeep: 0n, forgeUnclaimed: 0n, mailKeep: 0n, leagueKeep: 0n }; byWallet.set(wallet, b); }
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
  const seenEntitlement = new Set<string>();
  for (const e of input.leagueEntitlements) {
    if (seenEntitlement.has(e.entitlementId)) throw new Error(`duplicate league entitlement ${e.entitlementId}`);
    seenEntitlement.add(e.entitlementId);
    if (e.keep < 0n) throw new Error(`negative league entitlement ${e.entitlementId}`);
    if (e.keep > 0n) bucket(e.wallet).leagueKeep += e.keep;
  }

  // D-152: no re-issue inside the retirement. A wallet whose welcome is still
  // PENDING converts that KEEP as L4 and is therefore not listed for the grant
  // (either its KEEP became Gems or it gets the Gems welcome once — never both).
  const pendingWelcome = new Set(input.pendingMailKeep.filter((m) => m.welcome).map((m) => m.wallet));
  const welcomeGemsPending = [...new Set(input.expiredWelcomeWallets)]
    .filter((wallet) => !pendingWelcome.has(wallet) && (includeInternal || !internal.has(wallet)))
    .sort();

  const postings: RetirementPosting[] = [];
  let sweptInternalKeep = 0n;
  const sweptInternalWallets: string[] = [];
  for (const [wallet, breakdown] of byWallet) {
    const keepConverted = breakdown.playKeep + breakdown.forgeUnclaimed + breakdown.mailKeep + breakdown.leagueKeep;
    if (keepConverted <= 0n) continue;
    if (internal.has(wallet) && !includeInternal) {
      sweptInternalKeep += keepConverted;
      sweptInternalWallets.push(wallet);
      continue;
    }
    postings.push({ wallet, keepConverted, gemsMinted: keepToGems(keepConverted), breakdown });
  }
  postings.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  sweptInternalWallets.sort();

  const totalKeepConverted = postings.reduce((s, p) => s + p.keepConverted, 0n);
  return {
    postings,
    totalKeepConverted,
    totalGemsMinted: postings.reduce((s, p) => s + p.gemsMinted, 0n),
    sweptInternalKeep,
    sweptInternalWallets,
    excludedLapsedForgeKeep,
    withdrawalEscrowKeep: input.withdrawalEscrowKeep,
    mixedMailCount,
    welcomeGemsPending,
    welcomeGemsPendingTotal: BigInt(PLAYTEST.welcomeGems) * BigInt(welcomeGemsPending.length),
  };
}

/** The retirement transaction may only run when every drain precondition of
 *  GEMS-CURRENCY §7 (W) holds; the tool refuses otherwise. */
export function assertReadyForRetirement(plan: RetirementPlan, drained: { unbonding: number; processing: number; pendingKeepDeposits: number }): void {
  if (plan.withdrawalEscrowKeep !== 0n) throw new Error(`withdrawal_escrow must be 0 at F, found ${plan.withdrawalEscrowKeep}`);
  if (drained.unbonding !== 0 || drained.processing !== 0) throw new Error('withdrawals must be terminal at F');
  if (drained.pendingKeepDeposits !== 0) throw new Error('pending KEEP deposits must be terminal at F (late credits use the fenced path)');
}

/** I1a — day-B settlement conservation (unchanged from the E1 plan): the
 *  emission_pool debit over the settlement step equals Σ keep_paid of the rows
 *  it settled (forge.ts posts emission_pool −payout / forge_payout_escrow
 *  +payout per row). */
export function checkI1a(settlement: { emissionPoolDelta: bigint; keepPaidSum: bigint }): boolean {
  return settlement.emissionPoolDelta === -settlement.keepPaidSum;
}

/** Custodial liability set (money/snapshot.ts:230-233 allow-list, whole KEEP). */
export interface CustodialLedger {
  playerKeep: bigint;
  withdrawalEscrow: bigint;
  forgePayoutEscrow: bigint;
  leagueEntitlementEscrow: bigint;
  mailKeepEscrow: bigint;
  emissionPool: bigint;
  /** −balance(gems_mint) restricted to reason `retirement`. */
  gemsMintedRetirement: bigint;
}

export function custodialLiability(l: CustodialLedger): bigint {
  return l.playerKeep + l.withdrawalEscrow + l.forgePayoutEscrow + l.leagueEntitlementEscrow + l.mailKeepEscrow;
}

/** G-8 — retirement conservation, measured over the retirement transaction:
 *  Σ Gems minted with reason `retirement` == Σ converted KEEP; emission_pool
 *  rises by converted + swept internal KEEP and nothing else; withdrawal
 *  escrow is 0; custodial liability after == 0 (fenced late credits excepted
 *  by the caller). */
export function checkG8(plan: RetirementPlan, before: CustodialLedger, after: CustodialLedger): boolean {
  const gemsMinted = after.gemsMintedRetirement - before.gemsMintedRetirement;
  return gemsMinted === plan.totalGemsMinted
    && plan.totalGemsMinted === keepToGems(plan.totalKeepConverted)
    && after.emissionPool - before.emissionPool === plan.totalKeepConverted + plan.sweptInternalKeep
    && before.withdrawalEscrow === 0n && after.withdrawalEscrow === 0n
    && custodialLiability(after) === 0n;
}

/** What the custodial ledger must total before F for the plan to convert
 *  everything: liability minus L3 (which must already be 0) minus lapsed rows
 *  that expire, split into converted and swept parts. Kept separate from
 *  buildRetirementPlan so a test can compute both sides independently. */
export function expectedConvertedKeep(input: RetirementCensusInput, opts: RetirementOptions = {}): bigint {
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
  for (const e of input.leagueEntitlements) if (e.keep > 0n && !internal.has(e.wallet)) total += e.keep;
  return total;
}
