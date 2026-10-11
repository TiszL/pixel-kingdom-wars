import { Keypair, Message, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { describe, expect, it, vi } from 'vitest';
import type { GameWallet } from '../../auth/useGameWallet';
import { buildMiningClaimMessages } from '../../../../../packages/chain/src/miningClaimMessage';
import { hashMiningAllocationNode } from '../../../../../packages/chain/src/miningAllocationProof';
import { miningClaimFixture } from './fixtures.test-support';
import { prepareMiningClaimSigning, signMiningClaim, verifySignedMiningClaim } from './signing';

function wallet(f: ReturnType<typeof miningClaimFixture>, sign?: (tx: Transaction) => Promise<Transaction>): GameWallet {
  return { publicKey: f.signer.publicKey, signMessage: null, isEmbedded: false, sendTransaction: vi.fn(),
    signTransaction: vi.fn(sign ?? (async tx => { tx.partialSign(f.signer); return tx; })) };
}
function rebuilt(f: ReturnType<typeof miningClaimFixture>) {
  const p = f.preparation;
  const plan = buildMiningClaimMessages({ programId: new PublicKey(p.identity.programId), keepMint: new PublicKey(p.identity.keepMint), reserveOwner: new PublicKey(p.identity.reserveOwner) },
    { wallet: f.signer.publicKey, root: Buffer.from(p.root, 'hex'), sequence: BigInt(p.rootSequence), day: BigInt(p.day), totalCumulative: BigInt(p.totalCumulativeBaseUnits),
      leaf: { wallet: p.wallet, sequence: BigInt(p.rootSequence), cumulativeKeep: BigInt(p.leaf.cumulativeKeepBaseUnits), cumulativeRenown: BigInt(p.leaf.cumulativeRenown), cumulativeDays: BigInt(p.leaf.cumulativeDays) },
      proof: p.proof.map(n => ({ hash: Buffer.from(n.hash, 'hex'), sum: BigInt(n.sumBaseUnits), isLeft: n.isLeft })),
      blockhash: p.transactions[0]!.blockhash, needsAta: p.needsAta, needsMinerRecords: p.needsMinerRecords });
  p.transactions = plan.transactions.map((tx, ordinal) => ({ ...p.transactions[0]!, ordinal, kind: tx.kind, message: Buffer.from(tx.messageBytes).toString('base64'), rentLamports: tx.kind === 'claim' ? '0' : '10000' }));
  p.fees.rentLamports = p.transactions[0]!.rentLamports;
  p.fees.totalLamports = String(BigInt(p.fees.feeLamports) + BigInt(p.fees.rentLamports));
}
describe('mining claim sign-only approval', () => {
  it.each(['combined', 'claim'] as const)('accepts the actual server %s message and signs only with the original claimant', async kind => {
    const f = miningClaimFixture();
    if (kind === 'claim') { f.preparation.needsAta = false; f.preparation.needsMinerRecords = false; rebuilt(f); }
    const w = wallet(f), prepared = prepareMiningClaimSigning(f.preparation, f.trust);
    const result = await signMiningClaim(prepared, w);
    expect(verifySignedMiningClaim(f.preparation, result.wire)).toEqual(result);
    expect(Transaction.from(Buffer.from(result.wire, 'base64')).verifySignatures()).toBe(true);
    expect(result.ordinal).toBe(0); expect(w.signTransaction).toHaveBeenCalledTimes(1); expect(w.sendTransaction).not.toHaveBeenCalled();
  });
  it.each(['genesisHash', 'programId', 'configAddress', 'keepMint', 'reserveOwner'] as const)('requires the independent %s pin before wallet approval', key => {
    const f = miningClaimFixture();
    expect(() => prepareMiningClaimSigning(f.preparation, { ...f.trust, [key]: Keypair.generate().publicKey.toBase58() })).toThrow(/TRUST/);
  });
  it('rejects arbitrary extra instructions, changed accounts and claim data even if the claimant could sign them', () => {
    for (const mutate of [
      (tx: Transaction) => { tx.add(SystemProgram.transfer({ fromPubkey: tx.feePayer!, toPubkey: Keypair.generate().publicKey, lamports: 1 })); },
      (tx: Transaction) => { tx.instructions.at(-1)!.keys[6]!.pubkey = Keypair.generate().publicKey; },
      (tx: Transaction) => { tx.instructions.at(-1)!.programId = Keypair.generate().publicKey; },
      (tx: Transaction) => { tx.instructions.at(-1)!.data[16] = 81; },
      (tx: Transaction) => { tx.feePayer = Keypair.generate().publicKey; },
    ]) {
      const f = miningClaimFixture(), tx = Transaction.populate(Message.from(Buffer.from(f.preparation.transactions[0]!.message, 'base64')));
      mutate(tx); f.preparation.transactions[0]!.message = tx.serializeMessage().toString('base64');
      expect(() => prepareMiningClaimSigning(f.preparation, f.trust)).toThrow(/MESSAGE/);
    }
  });
  it('binds the displayed leaf and every proof node to the canonical instruction', () => {
    const f = miningClaimFixture(); f.preparation.leaf.cumulativeKeepBaseUnits = '79';
    expect(() => prepareMiningClaimSigning(f.preparation, f.trust)).toThrow(/MESSAGE/);
    const g = miningClaimFixture(); g.preparation.proof = [{ hash: '00'.repeat(32), sumBaseUnits: '0', isLeft: false }];
    expect(() => prepareMiningClaimSigning(g.preparation, g.trust)).toThrow(/MESSAGE/);
  });
  it('accepts server-verified left and right proof nodes without changing their sums or order', async () => {
    const f = miningClaimFixture(), p = f.preparation, right = Buffer.alloc(32, 7), left = Buffer.alloc(32, 9);
    const intermediate = hashMiningAllocationNode(Buffer.from(p.root, 'hex'), 80n, right, 5n);
    p.root = Buffer.from(hashMiningAllocationNode(left, 7n, intermediate, 85n)).toString('hex'); p.totalCumulativeBaseUnits = '92';
    p.proof = [{ hash: right.toString('hex'), sumBaseUnits: '5', isLeft: false }, { hash: left.toString('hex'), sumBaseUnits: '7', isLeft: true }];
    rebuilt(f);
    const result = await signMiningClaim(prepareMiningClaimSigning(p, f.trust), wallet(f));
    expect(verifySignedMiningClaim(p, result.wire)).toEqual(result);
    p.proof[0]!.isLeft = true;
    expect(() => verifySignedMiningClaim(p, result.wire)).toThrow(/MESSAGE/);
  });
  it('rejects split plans and nonzero ordinals before signing', () => {
    const f = miningClaimFixture(), p = f.preparation;
    p.transactions = [{ ...p.transactions[0]!, kind: 'setup' }, { ...p.transactions[0]!, ordinal: 1, kind: 'claim', rentLamports: '0' }];
    p.fees.feeLamports = '10000'; p.fees.totalLamports = '20000';
    expect(() => prepareMiningClaimSigning(p, f.trust)).toThrow(/UNSUPPORTED/);
    const g = miningClaimFixture(); expect(() => prepareMiningClaimSigning(g.preparation, g.trust, 1)).toThrow(/UNSUPPORTED/);
  });
  it('rejects versioned messages, oversized inputs and invalid canonical base64 without deserializing arbitrary data', () => {
    const f = miningClaimFixture(), legacy = Message.from(Buffer.from(f.preparation.transactions[0]!.message, 'base64'));
    const instructions = Transaction.populate(legacy).instructions;
    const versioned = new TransactionMessage({ payerKey: f.signer.publicKey, recentBlockhash: legacy.recentBlockhash, instructions }).compileToV0Message();
    f.preparation.transactions[0]!.message = Buffer.from(versioned.serialize()).toString('base64');
    expect(() => prepareMiningClaimSigning(f.preparation, f.trust)).toThrow(/MESSAGE/);
    for (const raw of ['A'.repeat(1648), '!!!!', 'AQ==', null, { wire: 'AAAA' }]) expect(() => verifySignedMiningClaim(miningClaimFixture().preparation, raw)).toThrow();
    const g = miningClaimFixture(); g.preparation.proof = Array.from({ length: 1000 }, () => ({ hash: '00'.repeat(32), sumBaseUnits: '0', isLeft: false }));
    expect(() => prepareMiningClaimSigning(g.preparation, g.trust)).toThrow(/INPUT/);
  });
  it('rejects unsigned, corrupted or foreign-wallet wires and a valid signature over another message', () => {
    const f = miningClaimFixture(), p = f.preparation, message = Message.from(Buffer.from(p.transactions[0]!.message, 'base64'));
    const unsigned = new VersionedTransaction(message).serialize();
    expect(() => verifySignedMiningClaim(p, Buffer.from(unsigned).toString('base64'))).toThrow(/SIGNATURE/);
    const corrupt = Buffer.from(f.signed().wire, 'base64'); corrupt[1] = corrupt[1]! ^ 1;
    expect(() => verifySignedMiningClaim(p, corrupt.toString('base64'))).toThrow(/SIGNATURE/);
    expect(() => verifySignedMiningClaim(p, miningClaimFixture().signed().wire)).toThrow(/MESSAGE/);
    const changed = Transaction.populate(message); changed.recentBlockhash = Keypair.generate().publicKey.toBase58(); changed.partialSign(f.signer);
    expect(() => verifySignedMiningClaim(p, changed.serialize().toString('base64'))).toThrow(/MESSAGE/);
  });
  it('requires a genuine opaque preparation and an original-wallet sign-only capability', async () => {
    const f = miningClaimFixture(), prepared = prepareMiningClaimSigning(f.preparation, f.trust);
    await expect(signMiningClaim({ ...prepared }, wallet(f))).rejects.toThrow(/INPUT/);
    const wrong = wallet(f); wrong.publicKey = Keypair.generate().publicKey;
    await expect(signMiningClaim(prepared, wrong)).rejects.toThrow(/WALLET/); expect(wrong.signTransaction).not.toHaveBeenCalled();
    await expect(signMiningClaim(prepared, { ...wallet(f), signTransaction: null })).rejects.toThrow(/WALLET/);
  });
  it('rejects an oversized wallet-returned blockhash before serialization can decode it', async () => {
    const f = miningClaimFixture();
    const serialize = vi.fn();
    const w = wallet(f, async tx => {
      tx.recentBlockhash = '1'.repeat(100_000);
      tx.serializeMessage = serialize;
      return tx;
    });
    await expect(signMiningClaim(prepareMiningClaimSigning(f.preparation, f.trust), w)).rejects.toThrow(/MESSAGE/);
    expect(serialize).not.toHaveBeenCalled();
  });
  it('rejects wallet mutation and invalid signatures while retaining a valid late signature after view/account changes', async () => {
    const f = miningClaimFixture();
    await expect(signMiningClaim(prepareMiningClaimSigning(f.preparation, f.trust), wallet(f, async tx => { tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); tx.partialSign(f.signer); return tx; }))).rejects.toThrow(/MESSAGE/);
    await expect(signMiningClaim(prepareMiningClaimSigning(f.preparation, f.trust), wallet(f, async tx => { tx.partialSign(f.signer); tx.signature!.fill(0); return tx; }))).rejects.toThrow(/SIGNATURE/);
    const original = structuredClone(f.preparation), prepared = prepareMiningClaimSigning(f.preparation, f.trust);
    const w = wallet(f, async tx => { f.preparation.leaf.cumulativeKeepBaseUnits = '1'; f.preparation.expiresAt = '2000-01-01T00:00:00.000Z'; w.publicKey = null; tx.partialSign(f.signer); return tx; });
    const result = await signMiningClaim(prepared, w);
    expect(verifySignedMiningClaim(original, result.wire)).toEqual(result); expect(w.sendTransaction).not.toHaveBeenCalled();
  });
});
