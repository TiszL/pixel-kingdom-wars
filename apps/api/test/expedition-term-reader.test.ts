/** Adapter-only tests. The real chain function is mocked; these supplied rows
 * establish NO finalized RPC, deployment, signature or account authority. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import type { FinalizedSeekerTerm, ReviewedSeekerTermPolicy, SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prefetchExpeditionTermReader } from '../src/game/expeditionTermReader';
import { hashExpeditionTermSnapshot, unavailableExpeditionTermReader } from '../src/game/expeditionTerms';

const chain = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@shardkeep/chain/seeker-terms', () => ({ readFinalizedSeekerTerm: chain.read }));
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const start = '2035-01-01T00:00:00.000Z', observed = '2035-01-01T00:00:01.250Z';
const startSec = BigInt(Date.parse(start) / 1_000);
const endSec = startSec + BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);
const iso = (ms: number) => new Date(Date.parse(observed) + ms).toISOString();
const sig = (i: number) => bs58.encode(new Uint8Array(64).fill(i + 1));

function fixture() {
  const policy: ReviewedSeekerTermPolicy = { genesisHash: key(201), programId: key(203), config: key(204), round: 11n,
    mint: key(205), prizeOwner: key(206), prizeAta: key(207), stateProvenance: 'fresh-reviewed-deployment',
    deployment: { programDataAddress: key(208).toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } };
  const result = {
    source: { genesisHash: policy.genesisHash.toBase58(), programId: policy.programId.toBase58(), config: policy.config.toBase58(), round: policy.round },
    authority: { address: key(209).toBase58(), admissionPaused: true }, registry: key(210).toBase58(), registryHash: 'ac'.repeat(32),
    term: key(211).toBase58(), previousTerm: key(212).toBase58(), decimals: 6, auctionStart: startSec - 1n, auctionEnd: startSec,
    operatingStart: startSec, operatingEnd: endSec, completedAt: startSec, completedSlot: 299n, winnerCount: 1,
    auctions: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({
      terms: { config: policy.config.toBase58(), term: key(211).toBase58(), auction: key(spotId + 1).toBase58(),
        registry: key(210).toBase58(), registryHash: 'ac'.repeat(32), spotId, class: 0 as const, realmMask: 15,
        round: policy.round, auctionStart: startSec - 1n, auctionEnd: startSec, operatingStart: startSec, operatingEnd: endSec,
        mint: policy.mint.toBase58(), tokenProgram: key(213).toBase58(), vault: key(214).toBase58(),
        prizeOwner: policy.prizeOwner.toBase58(), prizeAta: policy.prizeAta.toBase58(), prizeBps: 10000, grace: 600n,
        openingBid: 10_000_000n, registryVersion: 1, auctionFormat: 1, termsFormat: 1 },
      termsHash: spotId.toString(16).padStart(64, '0'), winner: spotId === 0 ? key(215).toBase58() : null,
      highBid: spotId === 0 ? 10_000_000n : 0n, settledAt: startSec, settledSlot: 200n + BigInt(spotId),
      settlement: { signature: sig(spotId), slot: 200n + BigInt(spotId), instructionIndex: 0, method: 'permissionless' as const,
        settler: key(216).toBase58(), policyKey: null, requiresFinalizedAccountsAndReviewedDeployment: true as const },
    })),
    deployment: { ...policy.deployment, deployedSlot: 100n },
    finality: { commitment: 'finalized' as const, contextSlot: 350n, observedAt: observed },
  } satisfies FinalizedSeekerTerm;
  const connect = vi.fn((_signal: AbortSignal): SeekerTermRpc => { throw new Error('adapter must never call RPC directly'); });
  chain.read.mockResolvedValue(result);
  return { policy, result, connect, prefetch: () => prefetchExpeditionTermReader(connect, policy) };
}
beforeEach(() => { chain.read.mockReset(); });

describe('single-use server prefetch to expedition term adapter (mocked chain authority)', () => {
  it('maps every original settled row and sorts independently of provider order, preserving paused finalized ownership', async () => {
    const f = fixture(); f.result.auctions.reverse();
    const reader = await f.prefetch();
    expect(chain.read).toHaveBeenCalledExactlyOnceWith(f.connect, f.policy);
    const proof = await reader.readOperatingTerm(observed);
    expect(proof).not.toBeNull();
    expect(proof!.snapshot.spots).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);
    for (const row of proof!.snapshot.spots) expect(row).toEqual({ spotId: row.spotId,
      ownerWallet: row.spotId === 0 ? key(215).toBase58() : null, auctionAccount: key(row.spotId + 1).toBase58(),
      settlementSignature: sig(row.spotId), settlementSlot: String(200 + row.spotId), termsHash: row.spotId.toString(16).padStart(64, '0') });
    expect(proof!.snapshot.spots.map(x => x.spotId)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(proof!.snapshot.source).toEqual({ kind: 'solana_auction_round', genesisHash: f.result.source.genesisHash,
      programId: f.result.source.programId, auctionConfig: f.result.source.config, round: '11' });
    expect(proof!.snapshot.startsAt).toBe(start); expect(proof!.snapshot.endsAt).toBe(new Date(Number(endSec * 1_000n)).toISOString());
    expect(proof!.finality).toEqual({ commitment: 'finalized', contextSlot: '350', observedAt: observed });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    [201, 11n, '35d3920a-5a84-5979-8c5a-f94a009f8143'],
    [201, 12n, '319af399-3a2a-56de-92a5-b16b6232e12c'],
    [202, 11n, 'e37d583e-eb9f-553d-9d61-84e5ff91e6e0'],
  ] as const)('matches independent Python uuid.uuid5(URL, exact source name) for genesis byte%s round%s', async (genesis, round, expected) => {
    const f = fixture();
    const policy = { ...f.policy, genesisHash: key(genesis), round };
    f.result.source.genesisHash = policy.genesisHash.toBase58(); f.result.source.round = round;
    const proof = await (await prefetchExpeditionTermReader(f.connect, policy)).readOperatingTerm(observed);
    expect(proof!.snapshot.termId).toBe(expected);
  });
  it.each(['programId', 'config'] as const)('includes %s in the immutable UUID name', async field => {
    const f = fixture(); const original = await (await f.prefetch()).readOperatingTerm(observed);
    const policy = { ...f.policy, [field]: key(220) }; f.result.source[field] = key(220).toBase58();
    const changed = await (await prefetchExpeditionTermReader(f.connect, policy)).readOperatingTerm(observed);
    expect(changed!.snapshot.termId).not.toBe(original!.snapshot.termId);
  });
  it.each([0, PHASE_E_SEEKER_AUCTION.observationMaxAgeMs])('accepts age%s at the inclusive freshness boundary', async age => {
    const f = fixture(); expect(await (await f.prefetch()).readOperatingTerm(iso(age))).not.toBeNull();
  });
  it.each([
    ['stale', (): string => iso(PHASE_E_SEEKER_AUCTION.observationMaxAgeMs + 1)],
    ['future observation', (): string => iso(-1)],
    ['rollover', (): string => new Date(Number(endSec * 1_000n)).toISOString()],
    ['before operating start', (): string => new Date(Number(startSec * 1_000n) - 1).toISOString()],
    ['invalid clock', (): string => 'not-a-clock'],
  ] as const)('consumes even an invalid %s attempt; retry cannot reuse the observation', async (_label, at) => {
    const f = fixture(), reader = await f.prefetch();
    await expect(reader.readOperatingTerm(at())).rejects.toThrow();
    await expect(reader.readOperatingTerm(observed)).rejects.toThrow('already consumed');
    expect(chain.read).toHaveBeenCalledTimes(1); expect(f.connect).not.toHaveBeenCalled();
  });
  it('permits only one concurrent consumption and never repeats RPC under a caller lock', async () => {
    const f = fixture(), reader = await f.prefetch();
    const result = await Promise.allSettled([reader.readOperatingTerm(observed), reader.readOperatingTerm(observed)]);
    expect(result.map(x => x.status)).toEqual(['fulfilled', 'rejected']);
    expect(chain.read).toHaveBeenCalledTimes(1); expect(f.connect).not.toHaveBeenCalled();
  });
  it('clones original observation values, not read time, and exposes deeply frozen evidence', async () => {
    const f = fixture(), reader = await f.prefetch();
    f.result.finality.observedAt = iso(999); f.result.finality.contextSlot = 999n;
    f.result.auctions[0]!.winner = key(221).toBase58(); f.result.auctions.reverse();
    const proof = (await reader.readOperatingTerm(iso(1)))!;
    expect(proof.finality).toEqual({ commitment: 'finalized', contextSlot: '350', observedAt: observed });
    expect(proof.snapshot.spots[0]!.ownerWallet).toBe(key(215).toBase58());
    for (const value of [reader, proof, proof.finality, proof.snapshot, proof.snapshot.source, proof.snapshot.spots, proof.snapshot.spots[0]])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it('keeps UUID/source independent of genuine later observations and preserves SHA256 snapshot identity', async () => {
    const f = fixture(); const first = (await (await f.prefetch()).readOperatingTerm(observed))!;
    f.result.finality.observedAt = iso(1); f.result.finality.contextSlot = 351n;
    const later = (await (await f.prefetch()).readOperatingTerm(iso(1)))!;
    expect(later.snapshot.termId).toBe(first.snapshot.termId);
    expect(hashExpeditionTermSnapshot(later.snapshot)).toBe(hashExpeditionTermSnapshot(first.snapshot));
    expect(later.finality).not.toEqual(first.finality);
  });
  it('propagates chain unavailability without fabricating zero winners or altering the default unavailable reader', async () => {
    const f = fixture(); chain.read.mockRejectedValue(new Error('actual chain unavailable'));
    await expect(f.prefetch()).rejects.toThrow('actual chain unavailable');
    expect(await unavailableExpeditionTermReader.readOperatingTerm(observed)).toBeNull();
  });
  it.each(['partial', 'duplicate', 'signature', 'slot', 'context', 'source', 'clock overflow', 'integer coercion', 'null result'] as const)(
    'rejects malformed mocked verified output: %s (no adapter fallback)', async bad => {
      const f = fixture();
      if (bad === 'partial') f.result.auctions.pop();
      if (bad === 'duplicate') f.result.auctions[1] = f.result.auctions[0]!;
      if (bad === 'signature') f.result.auctions[0]!.settlement.signature = 'invalid';
      if (bad === 'slot') f.result.auctions[0]!.settlement.slot = 201n;
      if (bad === 'context') f.result.finality.contextSlot = 298n;
      if (bad === 'source') f.result.source.programId = key(221).toBase58();
      if (bad === 'clock overflow') f.result.operatingEnd = (1n << 63n) - 1n;
      if (bad === 'integer coercion') Reflect.set(f.result.finality, 'contextSlot', 350);
      if (bad === 'null result') chain.read.mockResolvedValue(null);
      await expect(f.prefetch()).rejects.toThrow();
    });
});
