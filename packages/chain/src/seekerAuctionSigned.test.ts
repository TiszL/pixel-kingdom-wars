/** T7: single-player authorization; signatures authenticate every returned byte. */
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, Message, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, type Signer } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildBidMessage, buildWithdrawMessage } from './seekerAuctionInstructions';
import { assertPlayerSignedSeekerTx } from './seekerAuctionSigned';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
const pk = (n: number) => new PublicKey(Buffer.alloc(32,n));
const player = Keypair.fromSeed(Buffer.alloc(32,1)), other = Keypair.fromSeed(Buffer.alloc(32,2));
const program = new PublicKey(idl.address), hash = pk(3).toBase58();
const input = {wallet: player.publicKey, mint: pk(4), round: 0n, spot: 20, blockhash: hash};
const cap = 10000000n;
function expected() { return Transaction.populate(Message.from(buildBidMessage(program, {...input, newTotal: 10000000n, needsBid: true}).messageBytes)).instructions; }
function wire(ixs: TransactionInstruction[], signers: Signer[] = [player], blockhash = hash) {
 const tx = new VersionedTransaction(new TransactionMessage({payerKey: signers[0]!.publicKey, recentBlockhash: blockhash, instructions: ixs}).compileToLegacyMessage());
 tx.sign(signers); return tx.serialize();
}
const check = (bytes: Uint8Array, ixs = expected(), bound = cap) => assertPlayerSignedSeekerTx(bytes, player.publicKey, ixs, bound);
const budget = (tag: number, data = Buffer.alloc(4), keys: TransactionInstruction['keys'] = []) => new TransactionInstruction({programId: ComputeBudgetProgram.programId, keys, data: Buffer.concat([Buffer.of(tag),data])});

describe('SA-0 T7 D-141 semantic Seeker signed-wire boundary', () => {
 it('accepts the canonical one-player signature and allows a changed recent blockhash', () => {
  for (const blockhash of [hash, pk(9).toBase58()]) {
   const bytes = wire(expected(), [player], blockhash);
   expect(check(bytes)).toEqual({signature: bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!), mutation: 'none'});
  }
 });
 it('accepts the observed D-141 limit/price rewrite without changing the reviewed instructions', () => {
  const ixs = expected();
  const bytes = wire([ComputeBudgetProgram.setComputeUnitLimit({units: 200000}), ixs[0]!, ComputeBudgetProgram.setComputeUnitPrice({microLamports: 375000n}), ixs[1]!]);
  expect(check(bytes).mutation).toBe('compute-budget-added');
 });
 it('accepts the exact fee ceiling and refuses one micro-lamport above it with ceil arithmetic', () => {
  for (const [price, accepted] of [[50000000n,true],[50000001n,false]] as const) {
   const bytes = wire([ComputeBudgetProgram.setComputeUnitLimit({units: 200000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports: price}), ...expected()]);
   if (accepted) expect(check(bytes).mutation).toBe('compute-budget-added'); else expect(() => check(bytes)).toThrow();
  }
 });
 it('charges a price-only rewrite against the runtime maximum rather than a guessed low limit', () => {
  expect(() => check(wire([ComputeBudgetProgram.setComputeUnitPrice({microLamports: 10000000n}), ...expected()]))).toThrow();
 });
 it('refuses a different fee payer or an extra signer even with valid signatures', () => {
  expect(() => check(wire(expected(),[other,player]))).toThrow();
  const ixs = expected(); ixs[1]!.keys.push({pubkey:other.publicKey,isSigner:true,isWritable:false});
  expect(() => check(wire(ixs,[player,other]))).toThrow();
 });
 it.each(['transfer','memo','duplicate-bid','nonce','budget-under-wrong-program'] as const)('refuses injected %s', kind => {
  const ixs = expected();
  const extra = kind === 'transfer' ? SystemProgram.transfer({fromPubkey:player.publicKey,toPubkey:other.publicKey,lamports:1})
   : kind === 'memo' ? new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[],data:Buffer.from('x')})
   : kind === 'duplicate-bid' ? ixs[1]!
   : kind === 'nonce' ? SystemProgram.nonceAdvance({noncePubkey:pk(7),authorizedPubkey:player.publicKey})
   : new TransactionInstruction({programId:program,keys:[],data:budget(2).data});
  expect(() => check(wire([extra,...ixs]))).toThrow();
 });
 it('refuses redirecting a withdrawal to another token account', () => {
  const original = Transaction.populate(Message.from(buildWithdrawMessage(program,{...input,needsDestination:false}).messageBytes)).instructions;
  const changed = Transaction.populate(Message.from(buildWithdrawMessage(program,{...input,needsDestination:false}).messageBytes)).instructions;
  changed[0]!.keys[5]!.pubkey = pk(8);
  expect(() => check(wire(changed),original)).toThrow();
 });
 it('compares resolved global privileges, including an unchanged key promoted writable', () => {
  const ixs = expected(); ixs[1]!.keys[1]!.isWritable = true;
  expect(() => check(wire(ixs))).toThrow();
 });
 it.each([0,1,4,255])('refuses unsupported ComputeBudget tag %s', tag => {
  expect(() => check(wire([budget(tag),...expected()]))).toThrow();
 });
 it.each(['duplicate-limit','duplicate-price','accounts','trailing-byte','short-price'] as const)('refuses malformed budget %s', kind => {
  const limit = ComputeBudgetProgram.setComputeUnitLimit({units:200000}), price = ComputeBudgetProgram.setComputeUnitPrice({microLamports:1});
  const additions = kind === 'duplicate-limit' ? [limit,limit] : kind === 'duplicate-price' ? [price,price]
   : kind === 'accounts' ? [budget(2,Buffer.alloc(4),[{pubkey:player.publicKey,isSigner:true,isWritable:true}])]
   : kind === 'trailing-byte' ? [budget(2,Buffer.alloc(5))] : [budget(3,Buffer.alloc(4))];
  expect(() => check(wire([...additions,...expected()]))).toThrow();
 });
 it('refuses v0 even without lookups, malformed wire, trailing bytes, oversized wire and bad signatures', () => {
  const tx = new VersionedTransaction(new TransactionMessage({payerKey:player.publicKey,recentBlockhash:hash,instructions:expected()}).compileToV0Message()); tx.sign([player]);
  const good = wire(expected()), bad = Uint8Array.from(good); bad[1] = bad[1]! ^ 1;
  for (const value of [tx.serialize(), good.subarray(0,good.length-1), Buffer.concat([good,Buffer.of(0)]), Buffer.alloc(1233), bad])
   expect(() => check(value)).toThrow();
 });
 it('refuses a caller-supplied ceiling above the locked D-141 cap and invalid ceilings', () => {
  for (const bound of [cap+1n,-1n]) expect(() => check(wire(expected()),expected(),bound)).toThrow();
 });
});
