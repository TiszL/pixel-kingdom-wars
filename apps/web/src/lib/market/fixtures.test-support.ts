import { Keypair } from '@solana/web3.js';
import type { MarketCommand, MarketIdentity, MarketPurchase, ReservationReceipt } from './journal';
export const buyer = Keypair.fromSeed(new Uint8Array(32).fill(1));
export const seller = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
export const treasury = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
export const reference = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
export const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
export const identity: MarketIdentity = { api: 'https://example.test/api', wallet: buyer.publicKey.toBase58(), cluster: 'devnet' };
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const receipt = (): ReservationReceipt => ({
  quote: { version: 1, idempotencyKey: id(1), reservationId: id(2), listingId: id(3), itemId: 'iron_sword',
    buyer: identity.wallet, seller, sourceBaseId: id(4), buyerBaseId: id(5), cluster: 'devnet', reference,
    priceLamports: '1000000', feeBps: 500, sellerLamports: '950000', feeLamports: '50000', feeTreasury: treasury,
    createdAt: '2026-09-13T00:00:00.000Z', payableUntil: '2026-09-13T00:02:00.000Z' },
  serverNow: '2026-09-13T00:00:00.000Z', payable: true, state: 'reserved', paymentSignature: null, txSignature: null, resolvedAt: null,
});
export const purchase = (): MarketPurchase => ({ receipt: receipt(), attempted: false, signature: null, hydrated: null });
export const reserveCommand = (): MarketCommand => ({ kind: 'reserve', listingId: id(3), receipt: null,
  request: { idempotencyKey: id(1), itemId: 'iron_sword', sourceBaseId: id(4), buyerBaseId: id(5), seller, priceLamports: '1000000' } });
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
