/** SA-0 canonical auction packets. Pure construction is neither admission nor
 * permission to sign/send; callers must prove current finalized chain state. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Ed25519Program, Message, PACKET_DATA_SIZE, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, encodeSeekerActionPermit, hashOpenSeekerAuctionPayload, hashSeekerRegistry,
 seekerAuctionConfigPda, seekerAuctionPda, seekerAuthorityPda, seekerBidPda, seekerPermitReceiptPda, seekerRegistryPda, seekerTermPda,
 type SeekerActionPermit, type SeekerAuctionTerms } from './seekerAuctionProtocol';
import { seekerAuctionSecFor } from './devnetTestProfile';
const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const U64_MAX = (1n << 64n) - 1n;
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Seeker auction instruction: ${message}`); }
function fields(value: object, names: string): void {
 need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '), 'unexpected fields');
}
function key(value: PublicKey): PublicKey {
 need(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function', 'key type');
 const bytes = value.toBytes(); need(bytes instanceof Uint8Array && bytes.length === 32, 'key bytes');
 const copy = new PublicKey(bytes); need(copy.toBase58() === value.toBase58(), 'key text'); return copy;
}
function player(value: PublicKey): PublicKey { const result = key(value); need(PublicKey.isOnCurve(result.toBytes()), 'player must sign'); return result; }
function u64(value: bigint): Buffer {
 need(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, 'u64');
 const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b;
}
function ix(program: PublicKey, name: string, accounts: Record<string, PublicKey | null>, data: Buffer = Buffer.alloc(0)): TransactionInstruction {
 const layout = idl.instructions.find(i => i.name === name); need(layout, 'unknown IDL instruction');
 return new TransactionInstruction({ programId: key(program), data: Buffer.concat([Buffer.from(layout.discriminator), data]),
  keys: layout.accounts.map(row => {
   const address = accounts[row.name]; need(address !== undefined, 'missing account');
   need(address !== null || ('optional' in row && row.optional), 'nonoptional account');
   if('address' in row)need(address!==null&&address.toBase58()===row.address,'fixed IDL account');
   return { pubkey: address === null ? key(program) : key(address), isSigner: 'signer' in row && row.signer === true,
    isWritable: address !== null && 'writable' in row && row.writable === true };
  }) });
}
export interface SeekerUnsignedMessage {
 readonly messageBytes: Uint8Array;
 readonly expectedNewAccounts: readonly Readonly<{address: string; space: number}>[];
}
function message(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[], accounts: {address:string;space:number}[] = []): SeekerUnsignedMessage {
 const wallet = player(payer); need(typeof blockhash === 'string' && new PublicKey(blockhash).toBase58() === blockhash, 'blockhash');
 const m = new TransactionMessage({payerKey:wallet,recentBlockhash:blockhash,instructions}).compileToLegacyMessage();
 need(m.header.numRequiredSignatures === 1 && m.header.numReadonlySignedAccounts === 0, 'single payer');
 const bytes = m.serialize(); need(new VersionedTransaction(m).serialize().length <= PACKET_DATA_SIZE, 'packet size');
 need(Buffer.from(Message.from(bytes).serialize()).equals(Buffer.from(bytes)), 'canonical message');
 return Object.freeze({get messageBytes() { return Uint8Array.from(bytes); }, expectedNewAccounts:Object.freeze(accounts.map(a=>Object.freeze({...a}))) });
}
interface Target { readonly wallet: PublicKey; readonly mint: PublicKey; readonly round: bigint; readonly spot: number }
function target(program: PublicKey, input: Target) {
 u64(input.round); const wallet = player(input.wallet), mint = key(input.mint), config = seekerAuctionConfigPda(key(program));
 const auction = seekerAuctionPda(program, config, input.spot, input.round), term = seekerTermPda(program, config, input.round);
 return { wallet, mint, config, auction, term, bid:seekerBidPda(program,auction,wallet), authority:seekerAuthorityPda(program),
  source:getAssociatedTokenAddressSync(mint,wallet), vault:getAssociatedTokenAddressSync(mint,auction,true), token_program:TOKEN_PROGRAM_ID };
}
export interface SeekerBidMessageInput extends Target { readonly blockhash:string; readonly newTotal:bigint; readonly needsBid:boolean }
/** Untrusted routing hint only. A caller must independently decode this auction
 * from a finalized bank and verify the complete canonical signed packet. */
export function seekerPlayerInstructionHint(program:PublicKey,instruction:TransactionInstruction):Readonly<{kind:'bid'|'withdraw';auction:string;newTotal:bigint|null}> {
 need(instruction.programId.equals(program),'player action program');
 for(const [name,kind,length]of [['place_bid','bid',16],['withdraw_bid','withdraw',8]] as const){
  const layout=idl.instructions.find(i=>i.name===name)!;
  if(!instruction.data.subarray(0,8).equals(Buffer.from(layout.discriminator)))continue;
  need(instruction.data.length===length&&instruction.keys.length===layout.accounts.length,'player action layout');
  const at=layout.accounts.findIndex(a=>a.name==='auction');
  return Object.freeze({kind,auction:instruction.keys[at]!.pubkey.toBase58(),newTotal:kind==='bid'?instruction.data.readBigUInt64LE(8):null});
 }
 throw Error('Seeker auction instruction: no player action');
}
/** Target metadata is not proof: the final read must re-derive this exact PDA. */
export function seekerAuctionAccountHint(program:PublicKey,address:PublicKey,raw:{owner:PublicKey;executable:boolean;data:Uint8Array}):Readonly<{round:bigint;spot:number}> {
 const data=Buffer.from(raw.data),layout=idl.accounts.find(a=>a.name==='Auction')!;
 need(raw.owner.equals(program)&&raw.executable===false&&data.length===314&&data.subarray(0,8).equals(Buffer.from(layout.discriminator))&&data[8]===1,'auction hint account');
 // Auction v1: discriminator + version + config/term/registry + Spot{u8,u8,u8}.
 const spot=data[105]!,round=data.readBigUInt64LE(108);
 need(new PublicKey(data.subarray(9,41)).equals(seekerAuctionConfigPda(program))
  &&address.equals(seekerAuctionPda(program,seekerAuctionConfigPda(program),spot,round)),'auction hint identity');
 return Object.freeze({round,spot});
}
export function buildBidMessage(program: PublicKey, input: SeekerBidMessageInput): SeekerUnsignedMessage {
 fields(input,'wallet mint round spot blockhash newTotal needsBid'); need(typeof input.needsBid === 'boolean', 'needsBid');
 const amount=u64(input.newTotal); need(input.newTotal>0n,'positive bid'); const a=target(program,input), instructions:TransactionInstruction[]=[];
 if(input.needsBid) instructions.push(ix(program,'open_bid',{...a,system_program:SystemProgram.programId}));
 instructions.push(ix(program,'place_bid',a,amount));
 return message(a.wallet,input.blockhash,instructions,input.needsBid?[{address:a.bid.toBase58(),space:83}]:[]);
}
export interface SeekerWithdrawMessageInput extends Target { readonly blockhash:string; readonly needsDestination:boolean }
export function buildWithdrawMessage(program: PublicKey, input: SeekerWithdrawMessageInput): SeekerUnsignedMessage {
 fields(input,'wallet mint round spot blockhash needsDestination'); need(typeof input.needsDestination==='boolean','needsDestination');
 const a=target(program,input), instructions:TransactionInstruction[]=[];
 if(input.needsDestination) instructions.push(createAssociatedTokenAccountIdempotentInstruction(a.wallet,a.source,a.wallet,a.mint));
 instructions.push(ix(program,'withdraw_bid',{...a,destination:a.source}));
 return message(a.wallet,input.blockhash,instructions,input.needsDestination?[{address:a.source.toBase58(),space:165}]:[]);
}
export function buildOpenTermIx(program: PublicKey, input: {readonly payer:PublicKey;readonly round:bigint}): TransactionInstruction {
 fields(input,'payer round'); const data=u64(input.round), config=seekerAuctionConfigPda(key(program));
 return ix(program,'open_term',{payer:player(input.payer),config,registry:seekerRegistryPda(program),term:seekerTermPda(program,config,input.round),
  previous_term:input.round===0n?null:seekerTermPda(program,config,input.round-1n),system_program:SystemProgram.programId},data);
}
export interface SeekerOpenAuctionInput {
 readonly payer:PublicKey; readonly terms:SeekerAuctionTerms; readonly permit:SeekerActionPermit;
 readonly policyKey:PublicKey; readonly policySignature:Uint8Array; readonly blockhash:string;
}
export function buildOpenAuctionTx(program:PublicKey,input:SeekerOpenAuctionInput):SeekerUnsignedMessage {
 fields(input,'payer terms permit policyKey policySignature blockhash'); const payer=player(input.payer), t=input.terms, p=input.permit;
 // Encoding checks exact field sets and widths; canonical derivation then binds all account roles.
 const hash=hashOpenSeekerAuctionPayload(t), permitBytes=encodeSeekerActionPermit(p), entries=canonicalSeekerRegistry(), row=entries[t.spotId];
 need(row && row.class===t.class && row.realmMask===t.realmMask,'registry mapping');
 need(key(t.config).equals(seekerAuctionConfigPda(program)) && key(t.registry).equals(seekerRegistryPda(program))
  && key(t.term).equals(seekerTermPda(program,t.config,t.round)) && key(t.auction).equals(seekerAuctionPda(program,t.config,t.spotId,t.round)),'PDA linkage');
 need(Buffer.from(t.registryHash).equals(hashSeekerRegistry(entries)) && key(t.tokenProgram).equals(TOKEN_PROGRAM_ID)
  && key(t.vault).equals(getAssociatedTokenAddressSync(t.mint,t.auction,true))
  && key(t.prizeAta).equals(getAssociatedTokenAddressSync(t.mint,t.prizeOwner,true)) && !t.vault.equals(t.prizeAta),'immutable accounts');
 need(t.auctionEnd===t.operatingStart && t.auctionEnd-t.auctionStart===BigInt(seekerAuctionSecFor(key(program).toBase58()))
  && t.operatingEnd-t.operatingStart===BigInt(P.operatingTermSec) && t.grace===BigInt(A.settlementGraceSec) && t.prizeBps===A.prizeBps,'immutable calendar/policy');
 need(p.kind===7 && key(p.programId).equals(key(program)) && key(p.wallet).equals(payer) && Buffer.from(p.payloadHash).equals(hash),'permit scope');
 need(input.policySignature instanceof Uint8Array && input.policySignature.length===64,'policy signature width');
 const native=Ed25519Program.createInstructionWithPublicKey({publicKey:key(input.policyKey).toBytes(),message:permitBytes,signature:Uint8Array.from(input.policySignature)});
 const expiry=Buffer.alloc(8); expiry.writeBigInt64LE(p.expiry);
 const open=ix(program,'open_auction',{wallet:payer,authority:seekerAuthorityPda(program),config:t.config,registry:t.registry,term:t.term,auction:t.auction,
  vault:t.vault,mint:t.mint,receipt:seekerPermitReceiptPda(program,p.permitId),instructions:SYSVAR_INSTRUCTIONS_PUBKEY,
  token_program:TOKEN_PROGRAM_ID,associated_token_program:ASSOCIATED_TOKEN_PROGRAM_ID,system_program:SystemProgram.programId},
  Buffer.concat([Buffer.of(t.spotId),Buffer.from(p.permitId),expiry,Buffer.alloc(2)]));
 return message(payer,input.blockhash,[native,open],[{address:t.auction.toBase58(),space:314},{address:t.vault.toBase58(),space:165},
  {address:seekerPermitReceiptPda(program,p.permitId).toBase58(),space:107}]);
}
export interface SeekerSettleInput extends Target { readonly prizeOwner:PublicKey;readonly highBidder:PublicKey|null;readonly highBid:bigint }
export function buildSettleIx(program:PublicKey,input:SeekerSettleInput):TransactionInstruction {
 fields(input,'wallet mint round spot prizeOwner highBidder highBid'); u64(input.highBid);
 need((input.highBid===0n)===(input.highBidder===null),'winner/amount'); const a=target(program,input);
 return ix(program,'settle_auction',{...a,prize_ata:getAssociatedTokenAddressSync(a.mint,key(input.prizeOwner),true),
  winner_bid:input.highBidder===null?null:seekerBidPda(program,a.auction,key(input.highBidder))});
}
