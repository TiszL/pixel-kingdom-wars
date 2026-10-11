/** @vitest-environment happy-dom */
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buyer, blockhash, seller } from '../lib/market/fixtures.test-support';
import { prepareMarketPayment } from '../lib/market/payment';
import { receipt } from '../lib/market/fixtures.test-support';
import type { GameWallet } from './useGameWallet';
const h = vi.hoisted(() => ({ adapter: {} as Record<string, unknown>, wallets: [] as unknown[], session: null as string | null,
  connection: { getLatestBlockhash: vi.fn() } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => h.adapter, useConnection: () => ({ connection: h.connection }) }));
vi.mock('@privy-io/react-auth/solana', () => ({ useWallets: () => ({ wallets: h.wallets }) }));
vi.mock('../state/store', () => ({ useApp: (select: (s: { wallet: string | null }) => unknown) => select({ wallet: h.session }) }));
vi.mock('./loginChallenge', () => ({ useLoginChallenge: (select: (s: { wallet: null }) => unknown) => select({ wallet: null }) }));
let root: Root | null = null; let element: HTMLDivElement;
beforeEach(() => {
  vi.resetModules(); h.session = buyer.publicKey.toBase58(); h.wallets = []; h.connection.getLatestBlockhash.mockReset().mockResolvedValue({ blockhash });
  h.adapter = { publicKey: buyer.publicKey, signMessage: vi.fn(), signTransaction: vi.fn(async (tx: Transaction) => { tx.sign(buyer); return tx; }), sendTransaction: vi.fn(async () => 'old-send') };
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root?.unmount()); element.remove(); vi.unstubAllEnvs(); });
async function render(privy: boolean): Promise<GameWallet> {
  vi.stubEnv('VITE_PRIVY_APP_ID', privy ? 'test-privy' : '');
  const { useGameWallet } = await import('./useGameWallet'); let result!: GameWallet;
  function Harness(): null { result = useGameWallet(); return null; }
  await act(async () => root!.render(<Harness />)); return result;
}
const prepared = () => prepareMarketPayment(receipt().quote, { getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }), getFeeForMessage: async () => ({ context: { slot: 1 }, value: 5 }), getBalance: async () => 2000000 });
describe('opt-in GameWallet marketplace signing', () => {
  it('keeps the opt-in external Charter v0 capability sign-only with the original blockhash', async () => {
    h.adapter.signTransaction=vi.fn(async(tx:VersionedTransaction)=>{tx.sign([buyer]);return tx;});
    const wallet=await render(false),tx=new VersionedTransaction(new TransactionMessage({payerKey:buyer.publicKey,recentBlockhash:blockhash,instructions:[]}).compileToV0Message()),message=tx.message.serialize();
    const signed=await wallet.signVersionedTransaction!(tx);expect(signed.message.serialize()).toEqual(message);expect(signed.signatures[0]?.some(Boolean)).toBe(true);
    expect(h.adapter.signTransaction).toHaveBeenCalledTimes(1);expect(h.adapter.sendTransaction).not.toHaveBeenCalled();expect(h.connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it('uses Privy v0 signTransaction without reinterpreting it as legacy or invoking a send', async () => {
    const sign=vi.fn(async({transaction}:{transaction:Uint8Array})=>{const tx=VersionedTransaction.deserialize(transaction);tx.sign([buyer]);return {signedTransaction:tx.serialize()};}),send=vi.fn();
    h.wallets=[{address:buyer.publicKey.toBase58(),standardWallet:{isPrivyWallet:true},signTransaction:sign,signAndSendTransaction:send}];
    const wallet=await render(true),tx=new VersionedTransaction(new TransactionMessage({payerKey:buyer.publicKey,recentBlockhash:blockhash,instructions:[]}).compileToV0Message()),message=tx.message.serialize();
    const signed=await wallet.signVersionedTransaction!(tx);expect(signed.version).toBe(0);expect(signed.message.serialize()).toEqual(message);expect(sign.mock.calls[0]?.[0]).toMatchObject({chain:'solana:devnet'});
    expect(send).not.toHaveBeenCalled();expect(h.adapter.signTransaction).not.toHaveBeenCalled();expect(h.connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it('uses external sign-only without invoking its existing send path', async () => {
    const wallet = await render(false); const p = await prepared(); await wallet.signTransaction!(p.transaction);
    expect(h.adapter.signTransaction).toHaveBeenCalledTimes(1); expect(h.adapter.sendTransaction).not.toHaveBeenCalled(); expect(h.connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it('keeps the existing adapter send API and connection unchanged', async () => {
    const wallet = await render(false); const p = await prepared(); expect(await wallet.sendTransaction!(p.transaction)).toBe('old-send');
    expect(h.adapter.sendTransaction).toHaveBeenCalledExactlyOnceWith(p.transaction, h.connection);
  });
  it('uses Privy public signTransaction with the original message, cluster and no opaque send', async () => {
    const sign = vi.fn(async ({ transaction }: { transaction: Uint8Array }) => { const tx = Transaction.from(transaction); tx.sign(buyer); return { signedTransaction: new Uint8Array(tx.serialize()) }; });
    const send = vi.fn(); h.wallets = [{ address: buyer.publicKey.toBase58(), standardWallet: { isPrivyWallet: true }, signTransaction: sign, signAndSendTransaction: send }];
    const wallet = await render(true); const p = await prepared(); const message = p.transaction.serializeMessage(); const signed = await wallet.signTransaction!(p.transaction);
    expect(signed.serializeMessage()).toEqual(message); expect(signed.verifySignatures()).toBe(true); expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0]![0]).toMatchObject({ chain: 'solana:devnet' }); expect(send).not.toHaveBeenCalled(); expect(h.adapter.signTransaction).not.toHaveBeenCalled(); expect(h.connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it('preserves the existing Privy send path for all other payment hooks', async () => {
    const send = vi.fn(async () => ({ signature: new Uint8Array(64).fill(1) }));
    h.wallets = [{ address: buyer.publicKey.toBase58(), standardWallet: { isPrivyWallet: true }, signTransaction: vi.fn(), signAndSendTransaction: send }];
    const wallet = await render(true); await wallet.sendTransaction!((await prepared()).transaction);
    expect(send).toHaveBeenCalledTimes(1); expect(h.connection.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });
  it('does not substitute a mismatched adapter for the authenticated Privy session', async () => {
    h.adapter.publicKey = new PublicKey(seller); const wallet = await render(true);
    expect(wallet.publicKey).toBeNull(); expect(wallet.signTransaction).toBeUndefined(); expect(h.adapter.signTransaction).not.toHaveBeenCalled();
  });
});
