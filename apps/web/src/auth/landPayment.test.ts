import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { prepareLandPayment, ENTRY_PLAYER_ACCOUNT_BYTES } from './landPayment';

function connection() {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    getBalance: vi.fn().mockResolvedValue(200_000_000),
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(1_245_840),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000 }),
  };
}
const wallet = Keypair.generate().publicKey;
const reference = Keypair.generate().publicKey;
describe('reserved land funding', () => {
  it('includes first-entry account rent and the fee for the actual prepared transaction', async () => {
    const rpc = connection();
    const result = await prepareLandPayment(rpc as unknown as Connection, wallet, reference, { kind: 'entry', amountLamports: 200_000_000 });
    expect(result.estimate).toEqual({ paymentLamports: 200_000_000, networkFeeLamports: 5000,
      accountRentLamports: 1_245_840, requiredLamports: 201_250_840, balanceLamports: 200_000_000 });
    expect(rpc.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(ENTRY_PLAYER_ACCOUNT_BYTES, 'confirmed');
    expect(rpc.getFeeForMessage.mock.calls[0]![0].serialize()).toEqual(result.transaction.compileMessage().serialize());
  });
  it('uses the reserved additional-deed amount without creating or charging another Player account', async () => {
    const rpc = connection();
    const { estimate } = await prepareLandPayment(rpc as unknown as Connection, wallet, reference, { kind: 'deed', amountLamports: 321_000_000 });
    expect(estimate.requiredLamports).toBe(321_005_000);
    expect(rpc.getAccountInfo).not.toHaveBeenCalled();
    expect(rpc.getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
  });
  it('does not estimate rent twice when the entry account already exists', async () => {
    const rpc = connection(); rpc.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(ENTRY_PLAYER_ACCOUNT_BYTES) });
    expect((await prepareLandPayment(rpc as unknown as Connection, wallet, reference, { kind: 'entry', amountLamports: 200_000_000 })).estimate.accountRentLamports).toBe(0);
    expect(rpc.getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
  });
  it.each([null, -1, Number.NaN])('an unavailable or invalid fee (%s) never becomes a zero-fee quote', async (value) => {
    const rpc = connection(); rpc.getFeeForMessage.mockResolvedValue({ value });
    await expect(prepareLandPayment(rpc as unknown as Connection, wallet, reference, { kind: 'deed', amountLamports: 200_000_000 }))
      .rejects.toThrow('funding estimate unavailable');
  });
});
