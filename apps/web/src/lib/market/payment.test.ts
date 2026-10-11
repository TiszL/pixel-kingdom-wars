import { PublicKey, SystemInstruction, Transaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { broadcastMarketPayment, prepareMarketPayment, signMarketPayment } from './payment';
import { blockhash, buyer, receipt, reference, seller, treasury } from './fixtures.test-support';
const connection = (balance = 1005000, fee: number | null = 5000) => ({
  getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: 123 })),
  getFeeForMessage: vi.fn(async () => ({ context: { slot: 1 }, value: fee })),
  getBalance: vi.fn(async () => balance),
});
const wallet = (sign: (tx: Transaction) => Promise<Transaction>) => ({ publicKey: buyer.publicKey, signMessage: null, sendTransaction: null, signTransaction: sign, isEmbedded: false });
describe('market sign-only payment', () => {
  it('builds the canonical two SOL legs with reference on seller only', async () => {
    const p = await prepareMarketPayment(receipt().quote, connection());
    const [a, b] = p.transaction.instructions;
    expect(a?.keys.map((k) => k.pubkey.toBase58())).toEqual([buyer.publicKey.toBase58(), seller, reference]);
    expect(b?.keys.map((k) => k.pubkey.toBase58())).toEqual([buyer.publicKey.toBase58(), treasury]);
    expect(SystemInstruction.decodeTransfer(a!).lamports).toBe(950000n);
    expect(SystemInstruction.decodeTransfer(b!).lamports).toBe(50000n);
    expect(p.transaction.feePayer?.equals(buyer.publicKey)).toBe(true); expect(p.networkFee).toBe(5000);
  });
  it('retains the canonical zero-fee leg instead of inventing another wire format', async () => {
    const q = receipt().quote; q.feeBps = 0; q.sellerLamports = q.priceLamports; q.feeLamports = '0';
    const p = await prepareMarketPayment(q, connection());
    expect(p.transaction.instructions).toHaveLength(2); expect(SystemInstruction.decodeTransfer(p.transaction.instructions[1]!).lamports).toBe(0n);
  });
  it('requires full price plus network fee and refuses unknown fee', async () => {
    await expect(prepareMarketPayment(receipt().quote, connection(1004999))).rejects.toThrow('full quoted');
    await expect(prepareMarketPayment(receipt().quote, connection(1005000, null))).rejects.toThrow('fee is unavailable');
  });
  it('validates an actual single-buyer cryptographic signature without sending', async () => {
    const p = await prepareMarketPayment(receipt().quote, connection());
    const sign = vi.fn(async (tx: Transaction) => { tx.sign(buyer); return tx; });
    const result = await signMarketPayment(p, buyer.publicKey.toBase58(), wallet(sign));
    expect(Transaction.from(result.wire).verifySignatures()).toBe(true); expect(result.signature.length).toBeGreaterThanOrEqual(64); expect(sign).toHaveBeenCalledTimes(1);
  });
  it('catches wallet in-place message mutation and invalid returned signatures', async () => {
    for (const mutate of [(tx: Transaction) => { tx.instructions[0]!.keys[1]!.pubkey = new PublicKey(treasury); tx.sign(buyer); }, (tx: Transaction) => { tx.sign(buyer); tx.signatures[0]!.signature!.fill(0); }]) {
      const p = await prepareMarketPayment(receipt().quote, connection());
      await expect(signMarketPayment(p, buyer.publicKey.toBase58(), wallet(async (tx) => { mutate(tx); return tx; }))).rejects.toThrow('different or invalid');
    }
  });
  it('never opens another identity wallet or falls back to opaque send', async () => {
    const p = await prepareMarketPayment(receipt().quote, connection()); const sign = vi.fn(); const w = wallet(sign); w.publicKey = new PublicKey(seller);
    await expect(signMarketPayment(p, buyer.publicKey.toBase58(), w)).rejects.toThrow('original buyer'); expect(sign).not.toHaveBeenCalled();
    await expect(signMarketPayment(p, buyer.publicKey.toBase58(), { ...wallet(sign), signTransaction: null })).rejects.toThrow('sign-only');
  });
  it('submits once with zero RPC retries and propagates uncertainty', async () => {
    const sendRawTransaction = vi.fn().mockRejectedValue(new Error('response lost'));
    await expect(broadcastMarketPayment({ sendRawTransaction }, new Uint8Array([1]), 'saved')).rejects.toThrow('response lost');
    expect(sendRawTransaction).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1]), { maxRetries: 0, skipPreflight: false, preflightCommitment: 'confirmed' });
  });
});
