import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, TransactionMessage, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { getTransferV1InstructionDataSerializer, getUpdateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
import { readDeedOwnerAtClose, replayDeedOwner } from './deedCloseEvidence';
const key = () => Keypair.generate().publicKey;
const owner = key(), buyer = key(), asset = key(), collection = key(), payer = key();
const core = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
function tx(recipient = buyer, time = 99, slot = 11, data = getTransferV1InstructionDataSerializer().serialize({})): VersionedTransactionResponse {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: key().toBase58(), instructions: [{ programId: core,
    keys: [asset,collection,payer,owner,recipient].map(pubkey => ({ pubkey, isWritable: false, isSigner: false })), data: Buffer.from(data) }] }).compileToV0Message();
  return { slot, blockTime: time, transaction: { message, signatures: ['transfer'] }, meta: { err: null, fee: 0, preBalances: [], postBalances: [], innerInstructions: [] } };
}
function rpc(transactions: Record<string, VersionedTransactionResponse>) {
  return { getSlot: vi.fn().mockResolvedValue(20), getBlockTime: vi.fn().mockImplementation(slot => Promise.resolve(slot === 10 ? 90 : 110)),
    getSignaturesForAddress: vi.fn().mockResolvedValue([...Object.entries(transactions).map(([signature,t]) => ({signature,slot:t.slot,err:null})),{ signature:'anchor', slot:10,err:null }]),
    getTransaction: vi.fn().mockImplementation(sig => Promise.resolve(transactions[sig])),
    getBlockSignatures: vi.fn().mockResolvedValue({ signatures: Object.keys(transactions) }),
  };
}
const input = { assetId: asset.toBase58(), collection: collection.toBase58(), owner: owner.toBase58(), priorSlot:'10', endAt:new Date(100000) };
describe('exact-close deed ownership proof', () => {
  it('finds a pre-close transfer even when observation arrives after close', async () => {
    const proof = await readDeedOwnerAtClose(rpc({transfer:tx()}) as unknown as Connection,input);
    expect(proof.ownerAtClose).toBe(buyer.toBase58()); expect(proof.throughSlot).toBe('20');
  });
  it('excludes transfers exactly at or after close', async () => {
    expect((await readDeedOwnerAtClose(rpc({transfer:tx(buyer,100)}) as unknown as Connection,input)).ownerAtClose).toBe(owner.toBase58());
  });
  it('replays transfer out and back by block order even if RPC rows arrive backwards', async () => {
    const r=rpc({out:tx(),back:tx(owner)}); r.getSignaturesForAddress.mockResolvedValue([{signature:'back',slot:11,err:null},{signature:'out',slot:11,err:null},{signature:'anchor',slot:10,err:null}]);
    expect((await readDeedOwnerAtClose(r as unknown as Connection,input)).ownerAtClose).toBe(owner.toBase58());
  });
  it('requires finalized history bridging the observer anchor and close horizon', async () => {
    const r=rpc({});r.getSignaturesForAddress.mockResolvedValue([]);
    await expect(readDeedOwnerAtClose(r as unknown as Connection,input)).rejects.toThrow('reach observer anchor');
    r.getBlockTime.mockResolvedValue(90);
    await expect(readDeedOwnerAtClose(r as unknown as Connection,input)).rejects.toThrow('bracket');
  });
  it('rejects caught CPI owner mutations and unknown/burned asset transitions', () => {
    const t=tx(), ix=t.transaction.message.compiledInstructions[0]!;
    t.meta!.innerInstructions=[{index:0,instructions:[{programIdIndex:ix.programIdIndex,accounts:[...ix.accountKeyIndexes],data:bs58.encode(ix.data)}]}];
    expect(()=>replayDeedOwner(t,input.assetId,input.collection,input.owner)).toThrow('CPI');
    expect(()=>replayDeedOwner(tx(buyer,99,11,new Uint8Array([12])),input.assetId,input.collection,input.owner)).toThrow('unsupported');
  });
  it('refuses successful outer calls with unavailable inner traces', () => {
    const t=tx(); t.meta!.innerInstructions=null;
    expect(()=>replayDeedOwner(t,input.assetId,input.collection,input.owner)).toThrow('trace unavailable');
  });
  it('allows ordinary metadata updates without confusing them for transfers', () => {
    const t=tx(core,99,11,getUpdateV2InstructionDataSerializer().serialize({newUri:'https://example.org/new'}));
    expect(replayDeedOwner(t,input.assetId,input.collection,input.owner)).toBe(input.owner);
  });
});
