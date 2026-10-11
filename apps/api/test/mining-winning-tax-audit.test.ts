import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { MINING_PROGRAM_ADDRESS, miningConfigPda, miningEpochPda } from '@shardkeep/chain/mining-program';
import { hashMiningTaxCommitment } from '@shardkeep/chain/mining-tax';
import { readFinalizedSeekerTerm } from '@shardkeep/chain/seeker-terms';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { auditWinningMiningTaxManifest as audit } from '../src/mining/winningMiningTaxAudit';

const day = '2020-01-01', dayNumber = BigInt(Date.parse(day + 'T00:00:00Z') / 86_400_000);
const key = () => Keypair.generate().publicKey;
const copy = <T>(value: T): T => structuredClone(value);
async function capture(sameWallet = false) {
  const first = key();
  const f = await createMiningTermFixture({ day, programId: new PublicKey(MINING_PROGRAM_ADDRESS), genesisHash: key(),
    winners: [{ spotId: 0, wallet: first }, { spotId: PHASE_E_POLICY.seekerIsland.kingSpots, wallet: sameWallet ? first : key() }] });
  const { finality: _finality, authority: _authority, ...original } = await readFinalizedSeekerTerm(f.connect, f.policy);
  const term = JSON.parse(JSON.stringify(original, (_key, value) => typeof value === 'bigint' ? String(value) : value));
  const funding = { config: { address: miningConfigPda(f.policy.programId).toBase58(), keepMint: key().toBase58() },
    source: { programId: f.policy.programId.toBase58(), genesisHash: f.policy.genesisHash.toBase58(),
      reviewedDeploymentSlot: Number(original.deployment.deployedSlot), reviewedProgramDataSha256: original.deployment.programDataSha256 } };
  const taxManifest = { version: 2, mode: 'original-term-winning-spot-pool', day, startAt: day + 'T00:00:00.000Z', endAt: '2020-01-02T00:00:00.000Z', source: term,
    beneficiaries: original.auctions.filter(a => a.winner !== null).map(a => ({ spotId: a.terms.spotId, auction: a.terms.auction, wallet: a.winner! })),
    distributionVersion: 1, distribution: 'equal-cumulative-per-winning-spot', remainder: 'original-term-encumbered', futureTermReassignmentAuthorized: false };
  const taxCommitment = Buffer.from(hashMiningTaxCommitment({ programId: f.policy.programId, config: new PublicKey(funding.config.address), keepMint: new PublicKey(funding.config.keepMint),
    auctionConfig: f.policy.config, term: new PublicKey(original.term), registry: new PublicKey(original.registry), registryHash: Buffer.from(original.registryHash, 'hex'), round: original.source.round,
    auctionStart: original.auctionStart, auctionEnd: original.auctionEnd, operatingStart: original.operatingStart, operatingEnd: original.operatingEnd, winnerCount: original.winnerCount },
  { day: dayNumber, epoch: miningEpochPda(f.policy.programId, dayNumber) })).toString('hex');
  return { taxManifest, funding, day, taxCommitment };
}
type Capture = Awaited<ReturnType<typeof capture>>;
let original: Capture;
beforeAll(async () => { original = await capture(); });

describe('retained payable original-term tax consistency', () => {
  it('accepts all 100 actual reader results and original King/regular beneficiaries without RPC', () => {
    expect(() => audit(copy(original))).not.toThrow();
  });
  it('preserves two winning spots for one original wallet instead of deduplicating its entitlement', async () => {
    const same = await capture(true);
    expect(same.taxManifest.beneficiaries[0]!.wallet).toBe(same.taxManifest.beneficiaries[1]!.wallet);
    expect(() => audit(same)).not.toThrow();
  });
  it.each([
    ['old held version', (x: Capture) => { x.taxManifest.version = 1; }],
    ['different distribution', (x: Capture) => { x.taxManifest.distribution = 'equal-per-wallet'; }],
    ['reassigned remainder', (x: Capture) => { x.taxManifest.remainder = 'next-term'; }],
    ['replacement beneficiary', (x: Capture) => { x.taxManifest.beneficiaries[0]!.wallet = key().toBase58(); }],
    ['omitted beneficiary', (x: Capture) => { x.taxManifest.beneficiaries.pop(); }],
    ['reordered beneficiaries', (x: Capture) => { x.taxManifest.beneficiaries.reverse(); }],
    ['incomplete registry', (x: Capture) => { x.taxManifest.source.auctions.pop(); }],
    ['reordered auctions', (x: Capture) => { x.taxManifest.source.auctions.reverse(); }],
    ['duplicate spot', (x: Capture) => { x.taxManifest.source.auctions[1] = copy(x.taxManifest.source.auctions[0]); }],
    ['foreign auction PDA', (x: Capture) => { x.taxManifest.source.auctions[0].terms.auction = key().toBase58(); }],
    ['altered canonical class', (x: Capture) => { x.taxManifest.source.auctions[0].terms.class = 0; }],
    ['altered realm mask', (x: Capture) => { x.taxManifest.source.auctions[0].terms.realmMask = 0; }],
    ['altered terms hash', (x: Capture) => { x.taxManifest.source.auctions[0].termsHash = '00'.repeat(32); }],
    ['winner with zero bid', (x: Capture) => { x.taxManifest.source.auctions[0].highBid = '0'; }],
    ['unsold with a bid', (x: Capture) => { x.taxManifest.source.auctions[1].highBid = '1'; }],
    ['wrong winner count', (x: Capture) => { x.taxManifest.source.winnerCount++; }],
    ['late completion', (x: Capture) => { x.taxManifest.source.completedAt = String(BigInt(x.taxManifest.source.completedAt) + 1n); }],
    ['incomplete earning day', (x: Capture) => { x.taxManifest.source.operatingStart = String(dayNumber * 86_400n + 1n); }],
    ['missing settlement provenance', (x: Capture) => { delete x.taxManifest.source.auctions[0].settlement; }],
    ['settlement slot substitution', (x: Capture) => { x.taxManifest.source.auctions[0].settlement.slot = '1001'; }],
    ['invalid settlement signature', (x: Capture) => { x.taxManifest.source.auctions[0].settlement.signature = '1'.repeat(64); }],
    ['lost provenance guard', (x: Capture) => { x.taxManifest.source.auctions[0].settlement.requiresFinalizedAccountsAndReviewedDeployment = false; }],
    ['foreign genesis', (x: Capture) => { x.funding.source.genesisHash = key().toBase58(); }],
    ['different reviewed binary', (x: Capture) => { x.funding.source.reviewedProgramDataSha256 = '00'.repeat(32); }],
    ['settlement predates reviewed deployment', (x: Capture) => { x.funding.source.reviewedDeploymentSlot = 1000; x.taxManifest.source.deployment.deployedSlot = '1000'; }],
    ['wrong commitment', (x: Capture) => { x.taxCommitment = '00'.repeat(32); }],
    ['different KEEP mint', (x: Capture) => { x.funding.config.keepMint = key().toBase58(); }],
    ['oversized decimal', (x: Capture) => { x.taxManifest.source.source.round = '1'.repeat(100_000); }],
  ])('refuses %s', (_name, edit) => {
    const changed = copy(original); (edit as (x: Capture) => void)(changed);
    expect(() => audit(changed)).toThrow();
  });
});
