/** SA-0 T1-T5: the player's only permitted actions are a canonical bid/refund.
 * These tests stay byte-identical between the the content pipeline RED and GREEN commits. */
import { describe, expect, it } from 'vitest';
import { Ed25519Program, Keypair, Message, PublicKey, Transaction, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { buildBidMessage, buildWithdrawMessage, buildOpenTermIx, buildOpenAuctionTx, buildSettleIx } from './seekerAuctionInstructions';
import { canonicalSeekerRegistry, hashSeekerRegistry, hashOpenSeekerAuctionPayload, encodeSeekerActionPermit, seekerAuctionConfigPda, seekerAuctionPda, seekerAuthorityPda, seekerBidPda, seekerRegistryPda, seekerTermPda } from './seekerAuctionProtocol';
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const program = new PublicKey(idl.address), wallet = Keypair.fromSeed(Buffer.alloc(32, 6)).publicKey;
const mint = pk(3), config = seekerAuctionConfigPda(program), round = 2n, spot = 20;
const auction = seekerAuctionPda(program, config, spot, round), term = seekerTermPda(program, config, round);
const common = { wallet, mint, round, spot, blockhash: pk(4).toBase58() };
const decode = (bytes: Uint8Array) => Transaction.populate(Message.from(bytes)).instructions;
const disc = (name: string) => Buffer.from(idl.instructions.find(i => i.name === name)!.discriminator);

describe('SA-0 T1-T5 canonical Seeker auction messages', () => {
 it.each([true, false])('T1 adds open_bid iff absent (%s); legacy, one player, no extras', needsBid => {
  const result = buildBidMessage(program, { ...common, newTotal: 123456789n, needsBid });
  const msg = Message.from(result.messageBytes), ixs = decode(result.messageBytes);
  expect(msg.header.numRequiredSignatures).toBe(1); expect(msg.accountKeys[0]).toEqual(wallet);
  expect(ixs.map(i => i.data.subarray(0, 8))).toEqual([...(needsBid ? [disc('open_bid')] : []), disc('place_bid')]);
  expect(ixs.every(i => i.programId.equals(program))).toBe(true);
  expect(ixs.at(-1)!.data.readBigUInt64LE(8)).toBe(123456789n);
  expect(new VersionedTransaction(msg).serialize().length).toBeLessThanOrEqual(1232);
 });
 it('T2 follows the reviewed IDL and derives source/vault with classic SPL Token', () => {
  const result = buildBidMessage(program, { ...common, newTotal: 10n, needsBid: true });
  const ixs = decode(result.messageBytes), place = ixs[1]!;
  const accounts = [wallet, seekerAuthorityPda(program), config, term, auction, seekerBidPda(program, auction, wallet), mint,
   getAssociatedTokenAddressSync(mint, wallet), getAssociatedTokenAddressSync(mint, auction, true), TOKEN_PROGRAM_ID];
  expect(place.keys.map(k => k.pubkey)).toEqual(accounts);
  // Resolved transaction privileges: payer becomes writable through the header.
  expect(place.keys.map(k => [k.isSigner, k.isWritable])).toEqual([[true,true],[false,false],[false,false],[false,false],[false,true],[false,true],[false,false],[false,true],[false,true],[false,false]]);
  expect(ixs[0]!.keys.map(k => k.pubkey)).toEqual([wallet, config, auction, seekerBidPda(program, auction, wallet), SystemProgram.programId]);
 });
 it.each([true, false])('T3 creates the player ATA idempotently iff missing (%s)', needsDestination => {
  const ixs = decode(buildWithdrawMessage(program, { ...common, needsDestination }).messageBytes);
  expect(ixs).toHaveLength(needsDestination ? 2 : 1);
  if (needsDestination) {
   expect(ixs[0]!.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID); expect(ixs[0]!.data).toEqual(Buffer.of(1));
   expect(ixs[0]!.keys[0]!.pubkey).toEqual(wallet); expect(ixs[0]!.keys[2]!.pubkey).toEqual(wallet);
  }
  const withdraw = ixs.at(-1)!;
  expect(withdraw.data).toEqual(disc('withdraw_bid'));
  expect(withdraw.keys.map(k => k.pubkey)).toEqual([wallet, config, auction, seekerBidPda(program, auction, wallet), mint,
   getAssociatedTokenAddressSync(mint, wallet), getAssociatedTokenAddressSync(mint, auction, true), TOKEN_PROGRAM_ID]);
 });
 it('derives each predecessor and the Anchor absent optional-account sentinel', () => {
  for (const r of [0n, 1n, 2n]) {
   const ix = buildOpenTermIx(program, { payer: wallet, round: r });
   expect(ix.data.subarray(0,8)).toEqual(disc('open_term')); expect(ix.data.readBigUInt64LE(8)).toBe(r);
   expect(ix.keys[3]!.pubkey).toEqual(seekerTermPda(program, config, r));
   expect(ix.keys[4]!.pubkey).toEqual(r === 0n ? program : seekerTermPda(program, config, r - 1n));
  }
 });
 it('T4 places self-contained native Ed25519 evidence at index 0 and binds the crank/payload', () => {
  const operatingStart = 1791158400n, P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
  const terms = { config, term, auction, registry: seekerRegistryPda(program), registryHash: hashSeekerRegistry(canonicalSeekerRegistry()),
   spotId: spot, class: 0 as const, realmMask: 15, round, auctionStart: operatingStart - BigInt(P.overlappingAuctionSec),
   auctionEnd: operatingStart, operatingStart, operatingEnd: operatingStart + BigInt(P.operatingTermSec),
   mint, tokenProgram: TOKEN_PROGRAM_ID, vault: getAssociatedTokenAddressSync(mint, auction, true), prizeOwner: pk(8),
   prizeAta: getAssociatedTokenAddressSync(mint, pk(8), true), prizeBps: A.prizeBps, grace: BigInt(A.settlementGraceSec),
   openingBid: 10000000n, registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
  const permit = { genesisHash: pk(7), programId: program, kind: 7 as const, permitId: Buffer.alloc(16, 9), wallet,
   expiry: operatingStart - 90000n, payloadHash: hashOpenSeekerAuctionPayload(terms) };
  const input = { payer: wallet, terms, permit, policyKey: pk(10), policySignature: Buffer.alloc(64, 11), blockhash: common.blockhash };
  const ixs = decode(buildOpenAuctionTx(program, input).messageBytes);
  expect(ixs).toHaveLength(2); expect(ixs[0]!.programId).toEqual(Ed25519Program.programId);
  for (const at of [4,8,14]) expect(ixs[0]!.data.readUInt16LE(at)).toBe(65535);
  const at = ixs[0]!.data.readUInt16LE(10);
  expect(ixs[0]!.data.subarray(at)).toEqual(encodeSeekerActionPermit(permit));
  expect(ixs[1]!.data).toEqual(Buffer.concat([disc('open_auction'), Buffer.of(spot), permit.permitId,
   (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(permit.expiry); return b; })(), Buffer.alloc(2)]));
  for (const changed of [{wallet: pk(12)}, {payloadHash: Buffer.alloc(32)}, {kind: 8}, {programId: pk(12)}])
   expect(() => buildOpenAuctionTx(program, {...input, permit: {...permit, ...changed}} as never)).toThrow();
 });
 it('T5 selects a winner Bid only for a nonzero high bid', () => {
  for (const highBidder of [wallet, null]) {
   const ix = buildSettleIx(program, { wallet, mint, round, spot, prizeOwner: pk(8), highBidder, highBid: highBidder ? 10n : 0n });
   expect(ix.data).toEqual(disc('settle_auction'));
   expect(ix.keys[7]!.pubkey).toEqual(highBidder ? seekerBidPda(program, auction, highBidder) : program);
   expect(ix.keys[7]!.isWritable).toBe(highBidder !== null);
   expect(ix.keys[6]!.pubkey).toEqual(getAssociatedTokenAddressSync(mint, pk(8), true));
  }
  expect(() => buildSettleIx(program, { wallet, mint, round, spot, prizeOwner: pk(8), highBidder: null, highBid: 1n })).toThrow();
 });
 it('rejects malformed scope, amounts, injected fields and payer identities before producing signable bytes', () => {
  const input = { ...common, newTotal: 10n, needsBid: true };
  for (const patch of [{ spot: -1 }, { spot: 100 }, { round: -1n }, { newTotal: 1n << 64n }, { newTotal: 0n },
   { needsBid: 1 }, { blockhash: 'bad' }, { instructions: [] }, { wallet: auction }])
   expect(() => buildBidMessage(program, { ...input, ...patch } as never)).toThrow();
 });
});
