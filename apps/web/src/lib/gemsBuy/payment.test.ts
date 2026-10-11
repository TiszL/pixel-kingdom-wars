import { PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { CLASSIC_TOKEN_PROGRAM } from './contracts';
import { assertGemsBuyPaymentLive, broadcastGemsBuyPayment, prepareGemsBuyPayment, signGemsBuyPayment } from './payment';
import { address, admission, connection, owner, quote, signature, wallet } from './fixtures.test-support';
const prepare = (rpc = connection()) => prepareGemsBuyPayment(admission(), rpc, 'expected-registry-genesis');
describe('wallet Gems sign-only transfer', () => {
  it('assembles exactly one Classic SPL TransferChecked with pinned amount/accounts and fee payer', async () => {
    const rpc = connection(), prepared = await prepare(rpc), q = quote(), ix = prepared.transaction.instructions[0]!;
    expect(prepared.transaction.instructions).toHaveLength(1);
    expect(ix.programId.equals(CLASSIC_TOKEN_PROGRAM)).toBe(true);
    expect(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [q.source, false, true], [q.mint, false, false], [q.destination, false, true], [q.wallet, true, false], [q.reference, false, false],
    ]);
    expect(ix.data[0]).toBe(12); expect(ix.data.readBigUInt64LE(1)).toBe(10000000n); expect(ix.data[9]).toBe(6);
    expect(prepared.transaction.feePayer?.equals(owner.publicKey)).toBe(true);
    expect(prepared.networkFee).toBe(5000); expect(prepared.lastValidBlockHeight).toBe(123);
    expect(rpc.getTokenAccountBalance).toHaveBeenCalledWith(new PublicKey(q.source), 'confirmed');
  });
  it('fails before any wallet call on wrong network, unknown fee, insufficient SOL or tokens, decimals and expired blockhash', async () => {
    const cases = [() => { const c = connection(); c.getGenesisHash.mockResolvedValue('wrong'); return c; },
      () => { const c = connection(); c.getFeeForMessage.mockResolvedValue({ context: { slot: 1 }, value: null }); return c; },
      () => { const c = connection(); c.getBalance.mockResolvedValue(4999); return c; },
      () => { const c = connection(); c.getTokenAccountBalance.mockResolvedValue({ context: { slot: 1 }, value: { amount: '9999999', decimals: 6, uiAmount: 10 } }); return c; },
      () => { const c = connection(); c.getTokenAccountBalance.mockResolvedValue({ context: { slot: 1 }, value: { amount: '10000000', decimals: 7, uiAmount: 10 } }); return c; },
      () => { const c = connection(); c.getBlockHeight.mockResolvedValue(124); return c; }];
    for (const make of cases) await expect(prepare(make())).rejects.toThrow();
  });
  it('validates one original-wallet cryptographic signature without using sign-and-send', async () => {
    const p = await prepare(), w = { ...wallet(), sendTransaction: vi.fn() };
    const signed = await signGemsBuyPayment(p, w);
    expect(Transaction.from(signed.wire).verifySignatures()).toBe(true);
    expect(w.signTransaction).toHaveBeenCalledTimes(1); expect(w.sendTransaction).not.toHaveBeenCalled();
    const wrong = { ...wallet(), publicKey: new PublicKey(address(40)) };
    await expect(signGemsBuyPayment(await prepare(), wrong)).rejects.toThrow('original purchase wallet');
    expect(wrong.signTransaction).not.toHaveBeenCalled();
    await expect(signGemsBuyPayment(await prepare(), { ...wallet(), signTransaction: null })).rejects.toThrow('sign-only');
  });
  it('refuses pre-prompt mutation and wallet substitution even if signed; public snapshot cannot replace frozen evidence', async () => {
    const p = await prepare(); p.message.fill(0); const w = wallet();
    expect((await signGemsBuyPayment(p, w)).signature).toBeTruthy();
    const changed = await prepare(); changed.transaction.instructions[0]!.keys[2]!.pubkey = new PublicKey(address(40));
    const unused = wallet(); await expect(signGemsBuyPayment(changed, unused)).rejects.toThrow('changed before'); expect(unused.signTransaction).not.toHaveBeenCalled();
    for (const mutate of [(tx: Transaction) => { tx.instructions[0]!.data[1] = 1; tx.sign(owner); },
      (tx: Transaction) => { tx.sign(owner); tx.signatures[0]!.signature!.fill(0); },
      (tx: Transaction) => { tx.recentBlockhash = address(40); tx.sign(owner); }]) {
      await expect(signGemsBuyPayment(await prepare(), wallet(async tx => { mutate(tx); return tx; }))).rejects.toThrow('different or invalid');
    }
  });
  it('returns a valid signature after wallet timeout so it can be saved, but expired quote/blockhash cannot be broadcast as live', async () => {
    let time = 0; const rpc = connection(), p = await prepareGemsBuyPayment(admission(() => time), rpc, 'expected-registry-genesis');
    const signed = await signGemsBuyPayment(p, wallet(async tx => { time = 60000; tx.sign(owner); return tx; }));
    expect(signed.signature).toBeTruthy();
    await expect(assertGemsBuyPaymentLive(p, rpc)).rejects.toThrow('no longer payable');
    const live = await prepare(rpc); rpc.getBlockHeight.mockResolvedValue(124);
    await expect(assertGemsBuyPaymentLive(live, rpc)).rejects.toThrow('blockhash has expired');
    rpc.getBlockHeight.mockResolvedValue(100); rpc.getGenesisHash.mockResolvedValue('wrong');
    await expect(assertGemsBuyPaymentLive(live, rpc)).rejects.toThrow('different Solana');
  });
  it('broadcasts the saved wire exactly once with zero retries and preserves uncertainty', async () => {
    const signed = await signGemsBuyPayment(await prepare(), wallet());
    const sendRawTransaction = vi.fn().mockRejectedValue(new Error('response lost'));
    await expect(broadcastGemsBuyPayment({ sendRawTransaction }, signed.wire, signed.signature)).rejects.toThrow('response lost');
    expect(sendRawTransaction).toHaveBeenCalledExactlyOnceWith(signed.wire, { maxRetries: 0, skipPreflight: false, preflightCommitment: 'confirmed' });
    sendRawTransaction.mockClear();
    await expect(broadcastGemsBuyPayment({ sendRawTransaction }, signed.wire, signature(2))).rejects.toThrow('does not match');
    expect(sendRawTransaction).not.toHaveBeenCalled();
    sendRawTransaction.mockResolvedValue(signature(3));
    await expect(broadcastGemsBuyPayment({ sendRawTransaction }, signed.wire, signed.signature)).rejects.toThrow('different signature');
  });
});
