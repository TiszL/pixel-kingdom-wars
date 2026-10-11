/** Adapter-only tests. The real chain function is mocked; these supplied rows
 * establish NO finalized RPC, deployment, signature or account authority. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import type { FinalizedSeekerTerm, ReviewedSeekerSourcePolicy, SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prefetchCurrentExpeditionTermReader } from '../src/game/expeditionCurrentTermReader';
import { hashExpeditionTermSnapshot } from '../src/game/expeditionTerms';

const chain = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@shardkeep/chain/seeker-terms', () => ({ readFinalizedCurrentSeekerTerm: chain.read }));
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const start = '2035-01-01T00:00:00.000Z', observed = '2035-01-01T00:00:01.250Z';
const startSec = BigInt(Date.parse(start) / 1_000);
const endSec = startSec + BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);
const iso = (ms: number) => new Date(Date.parse(observed) + ms).toISOString();
const sig = (i: number) => bs58.encode(new Uint8Array(64).fill(i + 1));

function fixture() {
  const round = 11n;
  const policy: ReviewedSeekerSourcePolicy = { genesisHash: key(201), programId: key(203), config: key(204),
    mint: key(205), prizeOwner: key(206), prizeAta: key(207), stateProvenance: 'fresh-reviewed-deployment',
    deployment: { programDataAddress: key(208).toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } };
  const result = {
    source: { genesisHash: policy.genesisHash.toBase58(), programId: policy.programId.toBase58(), config: policy.config.toBase58(), round: round },
    authority: { address: key(209).toBase58(), admissionPaused: true }, registry: key(210).toBase58(), registryHash: 'ac'.repeat(32),
    term: key(211).toBase58(), previousTerm: key(212).toBase58(), decimals: 6, auctionStart: startSec - 1n, auctionEnd: startSec,
    operatingStart: startSec, operatingEnd: endSec, completedAt: startSec, completedSlot: 299n, winnerCount: 1,
    auctions: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({
      terms: { config: policy.config.toBase58(), term: key(211).toBase58(), auction: key(spotId + 1).toBase58(),
        registry: key(210).toBase58(), registryHash: 'ac'.repeat(32), spotId, class: 0 as const, realmMask: 15,
        round: round, auctionStart: startSec - 1n, auctionEnd: startSec, operatingStart: startSec, operatingEnd: endSec,
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
  return { policy, result, connect, prefetch: () => prefetchCurrentExpeditionTermReader(connect, policy) };
}
beforeEach(() => { chain.read.mockReset(); });

describe('single-use current discovery adapter (mocked chain authority)', () => {
  it('maps the discovered round and original winners without a fixed-round policy or RPC inside consumption', async () => {
    const f=fixture(),reader=await f.prefetch(),proof=(await reader.readOperatingTerm(observed))!;
    expect(chain.read).toHaveBeenCalledExactlyOnceWith(f.connect,f.policy);
    expect(f.policy).not.toHaveProperty('round');expect(proof.snapshot.source.round).toBe('11');
    expect(proof.snapshot.spots[0]!.ownerWallet).toBe(key(215).toBase58());
    expect(proof.finality).toEqual({commitment:'finalized',contextSlot:'350',observedAt:observed});
    expect(f.connect).not.toHaveBeenCalled();
    await expect(reader.readOperatingTerm(observed)).rejects.toThrow('already consumed');
  });
  it.each([0,PHASE_E_SEEKER_AUCTION.observationMaxAgeMs])('accepts inclusive age%s',async age=>{
    const f=fixture();expect(await (await f.prefetch()).readOperatingTerm(iso(age))).not.toBeNull();
  });
  it.each([
    ['stale',():string=>iso(PHASE_E_SEEKER_AUCTION.observationMaxAgeMs+1)],
    ['future',():string=>iso(-1)],['invalid',():string=>'not-a-clock'],
    ['rollover',():string=>new Date(Number(endSec*1000n)).toISOString()],
  ] as const)('consumes a rejected %s attempt so retry requires fresh discovery',async(_reason,at)=>{
    const f=fixture(),reader=await f.prefetch();await expect(reader.readOperatingTerm(at())).rejects.toThrow();
    await expect(reader.readOperatingTerm(observed)).rejects.toThrow('already consumed');expect(chain.read).toHaveBeenCalledTimes(1);
  });
  it('allows only one concurrent consumer and returns detached deeply frozen source evidence',async()=>{
    const f=fixture(),reader=await f.prefetch();f.result.auctions[0]!.winner=key(220).toBase58();f.result.finality.contextSlot=999n;
    const results=await Promise.allSettled([reader.readOperatingTerm(observed),reader.readOperatingTerm(observed)]);
    expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
    const first=results[0]!,proof=first.status==='fulfilled'?first.value!:null;expect(proof!.snapshot.spots[0]!.ownerWallet).toBe(key(215).toBase58());
    expect(proof!.finality.contextSlot).toBe('350');
    for(const value of [reader,proof,proof!.finality,proof!.snapshot,proof!.snapshot.source,proof!.snapshot.spots,proof!.snapshot.spots[0]])expect(Object.isFrozen(value)).toBe(true);
  });
  it('uses discovered round in immutable identity while later observations preserve the same snapshot',async()=>{
    const f=fixture(),first=(await (await f.prefetch()).readOperatingTerm(observed))!;
    f.result.finality.observedAt=iso(1);const later=(await (await f.prefetch()).readOperatingTerm(iso(1)))!;
    expect(hashExpeditionTermSnapshot(later.snapshot)).toBe(hashExpeditionTermSnapshot(first.snapshot));
    f.result.source.round=12n;const next=(await (await f.prefetch()).readOperatingTerm(iso(1)))!;expect(next.snapshot.termId).not.toBe(first.snapshot.termId);
  });
  it.each(['genesisHash','programId','config'] as const)('rejects a discovered %s outside copied source policy',async field=>{
    const f=fixture();f.result.source[field]=key(220).toBase58();await expect(f.prefetch()).rejects.toThrow('differs from reviewed policy');
  });
  it.each(['round','partial','signature','settlement slot','context'] as const)('refuses malformed %s discovery output',async bad=>{
    const f=fixture();if(bad==='round')Reflect.set(f.result.source,'round',11);
    if(bad==='partial')f.result.auctions.pop();if(bad==='signature')f.result.auctions[0]!.settlement.signature='bad';
    if(bad==='settlement slot')f.result.auctions[0]!.settlement.slot=999n;if(bad==='context')f.result.finality.contextSlot=298n;
    await expect(f.prefetch()).rejects.toThrow();
  });
  it('propagates unavailable current discovery without a historical or zero-winner fallback',async()=>{
    const f=fixture();chain.read.mockRejectedValue(Error('current round unavailable'));await expect(f.prefetch()).rejects.toThrow('current round unavailable');
  });
});
