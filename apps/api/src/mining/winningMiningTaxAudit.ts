/** Consistency of an owner-retained v2 capture, not fresh chain authority.
 * The original reader authenticated settlement transactions and finality. Their
 * bounded retained proofs can be cross-bound here, not cryptographically replayed. */
import { PublicKey } from '@solana/web3.js';
import { keepAta } from '@shardkeep/chain';
import { SPL_TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID } from '../money/reserves';
import bs58 from 'bs58';
import { z } from 'zod';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION as A, PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import { miningConfigPda, miningEpochPda } from '@shardkeep/chain/mining-program';
import { hashMiningTaxCommitment } from '@shardkeep/chain/mining-tax';
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms, seekerAuctionConfigPda,
  seekerAuctionPda, seekerRegistryPda, seekerTermPda, type SeekerAuctionTerms } from '@shardkeep/chain/seeker-auction-protocol';

const P = PHASE_E_POLICY.seekerIsland, U64 = (1n << 64n) - 1n, I64 = (1n << 63n) - 1n;
const need = (value: unknown): void => { if (!value) throw Error('Invalid retained winning mining tax'); };
const uint = z.number().int().nonnegative().safe();
const decimal = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= U64);
const time = decimal.refine(v => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= I64);
const hash = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const key = z.string().min(32).max(44).refine(v => {
  if (v.length > 44) return false;
  try { const p = new PublicKey(v); return p.toBase58() === v && !p.equals(PublicKey.default); } catch { return false; }
});
const signature = z.string().min(64).max(88).refine(v => {
  if (v.length > 88) return false;
  try { const bytes = bs58.decode(v); return bytes.length === 64 && bytes.some(b => b !== 0) && bs58.encode(bytes) === v; } catch { return false; }
});
const termsSchema = z.object({ config: key, term: key, auction: key, registry: key, registryHash: hash,
  spotId: uint.max(P.totalSpots - 1), class: z.union([z.literal(0), z.literal(1)]), realmMask: uint.max(255), round: decimal,
  auctionStart: time, auctionEnd: time, operatingStart: time, operatingEnd: time, mint: key, tokenProgram: key,
  vault: key, prizeOwner: key, prizeAta: key, prizeBps: z.literal(A.prizeBps), grace: decimal, openingBid: decimal,
  registryVersion: z.literal(1), auctionFormat: z.literal(1), termsFormat: z.literal(1) }).strict();
const settlementSchema = z.object({ signature, slot: decimal, instructionIndex: uint, method: z.enum(['permissionless', 'permit']),
  settler: key, policyKey: key.nullable(), requiresFinalizedAccountsAndReviewedDeployment: z.literal(true) }).strict();
const auctionSchema = z.object({ terms: termsSchema, termsHash: hash, winner: key.nullable(), highBid: decimal,
  settledAt: time, settledSlot: decimal, settlement: settlementSchema }).strict();
const sourceSchema = z.object({ source: z.object({ programId: key, genesisHash: key, config: key, round: decimal }).strict(),
  registry: key, registryHash: hash, term: key, previousTerm: key.nullable(), decimals: uint.max(255), auctionStart: time,
  auctionEnd: time, operatingStart: time, operatingEnd: time, completedAt: time, completedSlot: decimal,
  winnerCount: uint.positive().max(P.totalSpots), auctions: z.array(auctionSchema).length(P.totalSpots),
  deployment: z.object({ programDataAddress: key, programDataSha256: hash, upgradeAuthority: key.nullable(), deployedSlot: decimal }).strict() }).strict();
const beneficiary = z.object({ spotId: uint.max(P.totalSpots - 1), auction: key, wallet: key }).strict();
const manifestSchema = z.object({ version: z.literal(2), mode: z.literal('original-term-winning-spot-pool'), day: z.string().length(10),
  startAt: z.string().length(24), endAt: z.string().length(24), source: sourceSchema, beneficiaries: z.array(beneficiary).min(1).max(P.totalSpots),
  distributionVersion: z.literal(1), distribution: z.literal('equal-cumulative-per-winning-spot'),
  remainder: z.literal('original-term-encumbered'), futureTermReassignmentAuthorized: z.literal(false) }).strict();
const fundingSchema = z.object({ config: z.object({ address: key, keepMint: key }).passthrough(), source: z.object({
  programId: key, genesisHash: key, reviewedDeploymentSlot: uint, reviewedProgramDataSha256: hash }).passthrough() }).passthrough();

export function auditWinningMiningTaxManifest(input: { taxManifest: unknown; funding: unknown; day: string; taxCommitment: string }): void {
  // Bound arrays before Zod traverses them; the caller already bounded/canonicalized
  // the entire retained JSON document before invoking this internal audit.
  const raw = input.taxManifest as { source?: { auctions?: unknown }; beneficiaries?: unknown } | null;
  need(raw && Array.isArray(raw.source?.auctions) && raw.source.auctions.length === P.totalSpots
    && Array.isArray(raw.beneficiaries) && raw.beneficiaries.length <= P.totalSpots);
  const m = manifestSchema.parse(input.taxManifest), t = m.source, funds = fundingSchema.parse(input.funding);
  need(/^\d{4}-\d{2}-\d{2}$/.test(input.day));
  const start = new Date(input.day + 'T00:00:00.000Z'), end = new Date(+start + PHASE_E_MINING_PUBLICATION.daySec * 1000);
  need(Number.isFinite(+start) && start.toISOString().slice(0, 10) === input.day);
  need(m.day === input.day && m.startAt === start.toISOString() && m.endAt === end.toISOString());
  const round = BigInt(t.source.round), program = new PublicKey(funds.source.programId), config = seekerAuctionConfigPda(program);
  const registry = seekerRegistryPda(program), term = seekerTermPda(program, config, round), entries = canonicalSeekerRegistry();
  const registryHash = hashSeekerRegistry(entries), deployedSlot = BigInt(t.deployment.deployedSlot);
  const pd = PublicKey.findProgramAddressSync([program.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  need(t.source.programId === funds.source.programId && t.source.genesisHash === funds.source.genesisHash
    && t.deployment.programDataSha256 === funds.source.reviewedProgramDataSha256 && deployedSlot === BigInt(funds.source.reviewedDeploymentSlot)
    && t.deployment.programDataAddress === pd.toBase58());
  need(t.source.config === config.toBase58() && t.term === term.toBase58() && t.registry === registry.toBase58()
    && t.registryHash === registryHash.toString('hex') && funds.config.address === miningConfigPda(program).toBase58());
  need(t.previousTerm === (round === 0n ? null : seekerTermPda(program, config, round - 1n).toBase58()));
  const auctionStart = BigInt(t.auctionStart), auctionEnd = BigInt(t.auctionEnd), operatingStart = BigInt(t.operatingStart), operatingEnd = BigInt(t.operatingEnd);
  const completedAt = BigInt(t.completedAt), completedSlot = BigInt(t.completedSlot);
  need(auctionEnd === operatingStart && auctionEnd - auctionStart === BigInt(P.overlappingAuctionSec)
    && operatingEnd - operatingStart === BigInt(P.operatingTermSec) && operatingStart * 1000n <= BigInt(+start)
    && operatingEnd * 1000n >= BigInt(+end) && completedAt >= auctionEnd && completedAt * 1000n <= BigInt(+start));
  const openingBid = BigInt(A.openingBidSkr) * 10n ** BigInt(t.decimals); need(openingBid <= U64);
  const first = t.auctions[0]!.terms, mint = new PublicKey(first.mint), prizeOwner = new PublicKey(first.prizeOwner);
  const prizeAta = keepAta(prizeOwner, mint, true);
  const beneficiaries: z.infer<typeof beneficiary>[] = [], seenInstructions = new Set<string>(), signatureSlots = new Map<string, string>();
  let maxSlot = 0n, completed = false;
  for (const [index, a] of t.auctions.entries()) {
    const e = entries[index]!, x = a.terms, auction = seekerAuctionPda(program, config, index, round);
    const vault = keepAta(auction, mint, true);
    need(x.spotId === index && x.class === e.class && x.realmMask === e.realmMask && x.config === t.source.config
      && x.term === t.term && x.registry === t.registry && x.registryHash === t.registryHash && x.round === t.source.round
      && x.auctionStart === t.auctionStart && x.auctionEnd === t.auctionEnd && x.operatingStart === t.operatingStart && x.operatingEnd === t.operatingEnd
      && x.auction === auction.toBase58() && x.mint === first.mint && x.prizeOwner === first.prizeOwner && x.prizeAta === prizeAta.toBase58()
      && x.vault === vault.toBase58() && !vault.equals(prizeAta) && x.tokenProgram === TOKEN_PROGRAM_ID.toBase58()
      && BigInt(x.grace) === BigInt(A.settlementGraceSec) && BigInt(x.openingBid) === openingBid);
    const terms: SeekerAuctionTerms = { ...x, config, term, auction, registry, registryHash, round, auctionStart, auctionEnd, operatingStart, operatingEnd,
      mint, tokenProgram: TOKEN_PROGRAM_ID, vault, prizeOwner, prizeAta, grace: BigInt(x.grace), openingBid };
    need(a.termsHash === hashSeekerAuctionTerms(terms).toString('hex'));
    const at = BigInt(a.settledAt), slot = BigInt(a.settledSlot), bid = BigInt(a.highBid), proof = a.settlement;
    need(at >= auctionEnd && at <= completedAt && slot > deployedSlot && slot <= completedSlot && proof.slot === a.settledSlot);
    need(a.winner === null ? bid === 0n : bid >= openingBid);
    need(proof.method === 'permissionless' ? proof.policyKey === null && at >= auctionEnd + BigInt(A.settlementGraceSec) : proof.policyKey !== null);
    const instruction = `${proof.signature}:${proof.instructionIndex}`;
    need(!seenInstructions.has(instruction) && (!signatureSlots.has(proof.signature) || signatureSlots.get(proof.signature) === proof.slot));
    seenInstructions.add(instruction); signatureSlots.set(proof.signature, proof.slot);
    if (slot > maxSlot) maxSlot = slot;
    if (slot === completedSlot && at === completedAt) completed = true;
    if (a.winner !== null) beneficiaries.push({ spotId: index, auction: x.auction, wallet: a.winner });
  }
  need(completed && maxSlot === completedSlot && beneficiaries.length === t.winnerCount
    && JSON.stringify(m.beneficiaries) === JSON.stringify(beneficiaries));
  const day = BigInt(Math.floor(+start / (PHASE_E_MINING_PUBLICATION.daySec * 1000)));
  const commitment = hashMiningTaxCommitment({ programId: program, config: new PublicKey(funds.config.address), keepMint: new PublicKey(funds.config.keepMint),
    auctionConfig: config, term, registry, registryHash, round, auctionStart, auctionEnd, operatingStart, operatingEnd, winnerCount: t.winnerCount },
  { day, epoch: miningEpochPda(program, day) });
  need(hash.parse(input.taxCommitment) === Buffer.from(commitment).toString('hex'));
}
