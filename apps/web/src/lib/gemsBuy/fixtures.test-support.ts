import { Keypair, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { vi } from 'vitest';
import { gemsBuySourceAta, parseGemsBuyAdmission, type GemsBuyBinding, type GemsBuyQuote, type GemsBuyRequest } from './contracts';
export const owner = Keypair.fromSeed(new Uint8Array(32).fill(31));
export const address = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const signature = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
export const request: GemsBuyRequest = { kind: 'gems_buy', keepIn: 10, idempotencyKey: uuid(1) };
export const binding: GemsBuyBinding = { wallet: owner.publicKey.toBase58(), mint: address(32), decimals: 6 };
export const policy = { destinationAta: address(33), minConvertKeep: 1, maxConvertKeepPerTx: 100 };
export const serverNow = '2026-09-21T10:00:00.000Z';
export const quote = (): GemsBuyQuote => ({ ...binding, ...request, id: uuid(2), reference: address(34),
  source: gemsBuySourceAta(binding.wallet, binding.mint), destination: policy.destinationAta, gemsOut: 10, expiresAt: '2026-09-21T10:01:00.000Z' });
export const response = () => ({ ...quote(), status: 'pending', serverNow });
export const admission = (now = () => 0) => parseGemsBuyAdmission(response(), request, binding, policy, { requestStartedAt: 0, requestStartedWall: 0, now, wall: now });
export const disclosure = () => ({ status: 'pending', txSignature: null as string | null, paymentSignature: null as string | null,
  amount: null as string | null, createdAt: serverNow, finalizedAt: null as string | null, keepIn: 10, gemsOut: 10,
  dustBaseUnits: null as string | null, keepCredited: null as string | null, gemsCredited: null as string | null, receipt: null });
export const recovery = () => ({ version: 1, expiredPaymentRecovery: 1, wallet: binding.wallet, idempotencyKey: request.idempotencyKey, serverNow,
  recoveryOnly: true, status: 'known', deposit: { originalIntent: quote(), ...disclosure() } });
export const credited = (amount = '12000007') => {
  const whole = (BigInt(amount) / 1000000n).toString();
  return { ...disclosure(), status: 'credited', amount, dustBaseUnits: (BigInt(amount) % 1000000n).toString(),
    txSignature: signature(1), paymentSignature: signature(2), finalizedAt: serverNow, keepCredited: whole, gemsCredited: whole,
    receipt: { version: 1, receiptId: uuid(3), acceptedAt: serverNow, wallet: binding.wallet, depositId: quote().id,
      txSignature: signature(1), funding: { currency: 'KEEP', amount: whole, baseUnits: amount }, result: { currency: 'GEMS', amount: whole, rate: 1 } } };
};
export const connection = () => ({
  getGenesisHash: vi.fn(async () => 'expected-registry-genesis'),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: address(35), lastValidBlockHeight: 123 })),
  getFeeForMessage: vi.fn(async () => ({ context: { slot: 1 }, value: 5000 as number | null })),
  getBalance: vi.fn(async () => 5000), getBlockHeight: vi.fn(async () => 100),
  getTokenAccountBalance: vi.fn(async () => ({ context: { slot: 1 }, value: { amount: '10000000', decimals: 6, uiAmount: 10 } })),
});
export const wallet = (sign = async (tx: Transaction) => { tx.sign(owner); return tx; }) => ({ publicKey: owner.publicKey,
  signMessage: null, sendTransaction: null, signTransaction: vi.fn(sign), isEmbedded: false });
