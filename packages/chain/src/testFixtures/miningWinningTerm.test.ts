import { Keypair, PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { seekerBidPda } from '../seekerAuctionProtocol';
import { readFinalizedSeekerTerm } from '../seekerTerms';
import { createMiningTermFixture, createMiningZeroWinnerTermFixture } from './miningZeroWinnerTerm';

const P = PHASE_E_POLICY.seekerIsland;
const day = '2020-01-01', dayStart = BigInt(Date.parse(day + 'T00:00:00Z') / 1000);
const input = () => ({ day, genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
const king = 0, regular = P.kingSpots;

describe('mining positive original-term injected RPC fixture', () => {
  it.each([
    { name: 'one original King owner', spots: [king], sameWallet: false },
    { name: 'one original regular owner', spots: [regular], sameWallet: false },
    { name: 'two original owners across classes', spots: [king, regular], sameWallet: false },
    { name: 'one original wallet winning both classes', spots: [king, regular], sameWallet: true },
  ])('authenticates $name without inventing the other spot owners', async ({ spots, sameWallet }) => {
    const first = Keypair.generate().publicKey;
    const winners = spots.map((spotId, i) => ({ spotId, wallet: i === 0 || sameWallet ? first : Keypair.generate().publicKey }));
    const f = await createMiningTermFixture({ ...input(), winners });
    const result = await readFinalizedSeekerTerm(f.connect, f.policy);
    expect(result.winnerCount).toBe(winners.length);
    expect(result.auctions).toHaveLength(P.totalSpots);
    expect(result.operatingStart).toBe(dayStart - BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec));
    expect(result.operatingEnd).toBeGreaterThanOrEqual(dayStart + 86_400n);
    expect(result.completedAt).toBe(dayStart);
    expect(result.completedSlot).toBe(1099n);
    expect(result.finality).toMatchObject({ commitment: 'finalized', contextSlot: 2000n });
    for (const auction of result.auctions) {
      const original = winners.find(winner => winner.spotId === auction.terms.spotId);
      expect(auction.winner).toBe(original?.wallet.toBase58() ?? null);
      expect(auction.highBid).toBe(original ? BigInt(PHASE_E_SEEKER_AUCTION.openingBidSkr) * 10n ** BigInt(result.decimals) : 0n);
      expect(auction.terms.class).toBe(auction.terms.spotId < P.kingSpots ? 1 : 0);
      expect(auction.settledAt).toBe(dayStart);
      expect(auction.settledSlot).toBe(BigInt(1000 + auction.terms.spotId));
      expect(auction.settlement.method).toBe('permissionless');
    }
  });

  it('preserves the zero-winner wrapper contract', async () => {
    const f = await createMiningZeroWinnerTermFixture(input());
    const result = await readFinalizedSeekerTerm(f.connect, f.policy);
    expect(result.winnerCount).toBe(0);
    expect(result.auctions).toHaveLength(P.totalSpots);
    expect(result.auctions.every(a => a.winner === null && a.highBid === 0n)).toBe(true);
  });

  it.each([-1, P.totalSpots, 0.5])('refuses invalid winner spot %s instead of silently omitting it', async spotId => {
    await expect(createMiningTermFixture({ ...input(), winners: [{ spotId, wallet: Keypair.generate().publicKey }] }))
      .rejects.toThrow('Invalid fixture winners');
  });

  it('refuses duplicate winner spots even when the wallet is identical', async () => {
    const winner = { spotId: king, wallet: Keypair.generate().publicKey };
    await expect(createMiningTermFixture({ ...input(), winners: [winner, winner] })).rejects.toThrow('Invalid fixture winners');
  });

  it('refuses the zero public key as a positive owner', async () => {
    await expect(createMiningTermFixture({ ...input(), winners: [{ spotId: king, wallet: PublicKey.default }] }))
      .rejects.toThrow('Invalid fixture winners');
  });

  it('requires the original winning-bid PDA in the successful settlement transaction', async () => {
    const original = Keypair.generate().publicKey;
    const f = await createMiningTermFixture({ ...input(), winners: [{ spotId: king, wallet: original }] });
    const result = await readFinalizedSeekerTerm(f.connect, f.policy);
    const winner = result.auctions[king]!;
    const bid = seekerBidPda(f.policy.programId, new PublicKey(winner.terms.auction), original);
    const body = [...f.bodies.values()].find(tx => BigInt(tx.slot) === winner.settledSlot)!;
    const keys = body.transaction.message.staticAccountKeys;
    const bidIndex = keys.findIndex(key => key.equals(bid));
    expect(bidIndex).toBeGreaterThanOrEqual(0);
    keys[bidIndex] = Keypair.generate().publicKey;
    await expect(readFinalizedSeekerTerm(f.connect, f.policy)).rejects.toThrow('unavailable');
  });

  it('refuses a failed original positive settlement rather than reducing the beneficiary count', async () => {
    const f = await createMiningTermFixture({ ...input(), winners: [{ spotId: king, wallet: Keypair.generate().publicKey }] });
    f.bodies.values().next().value!.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    await expect(readFinalizedSeekerTerm(f.connect, f.policy)).rejects.toThrow('unavailable');
  });
});
