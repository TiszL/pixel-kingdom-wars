/** Browser-only SA-4 consent boundary. The chain SDK/IDL and its Node verifier
 * are test oracles, never runtime imports. Server admission remains authoritative. */
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {ed25519} from '@noble/curves/ed25519';
import {ComputeBudgetProgram,Message,PublicKey,SystemProgram,Transaction,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION_RUNTIME} from '@shardkeep/shared';
import {SeekerAuctionSourcedRoundViewSchema,SeekerAuctionPreparedSchema,SeekerBidPrepareRequestSchema,
 SeekerWithdrawPrepareRequestSchema,SeekerAuctionSubmitRequestSchema,
 type SeekerAuctionSourcedRoundView,type SeekerAuctionPrepared,type SeekerBidPrepareRequest,
 type SeekerWithdrawPrepareRequest,type SeekerAuctionSubmitRequest} from '@shardkeep/shared/seekerAuctionApi';
import {SeekerAuctionRefundsPageSchema,type SeekerAuctionRefundsPage} from '@shardkeep/shared/seekerAuctionRefundsApi';
import type {GameWallet} from '../../auth/useGameWallet';

/** Inject the independently admitted MS-G/registry identity; never learn any pin from a response. */
export interface SeekerAuctionIdentity {readonly programId:string;readonly mint:string;readonly decimals:number}
interface SigningContext {readonly view:SeekerAuctionSourcedRoundView;readonly prepared:SeekerAuctionPrepared;readonly identity:SeekerAuctionIdentity}
export type SeekerAuctionSigningInput=SigningContext&(
 {readonly kind:'bid';readonly request:SeekerBidPrepareRequest}|
 {readonly kind:'withdraw';readonly request:SeekerWithdrawPrepareRequest});
export interface PreparedSeekerAuctionSigning {readonly wallet:string}
export interface SignedSeekerAuction {
 readonly submission:SeekerAuctionSubmitRequest;
 readonly signature:string;
 /** Null after an opaque send or a wallet blockhash refresh; quote height is then unrelated. */
 readonly lastValidBlockHeight:string|null;
}
export class SeekerAuctionSigningError extends Error {
 constructor(readonly code:'INPUT'|'IDENTITY'|'MESSAGE'|'WALLET'|'SIGNATURE') {super(`Seeker auction signing refused: ${code}`);this.name='SeekerAuctionSigningError';}
}
function need(value:unknown,code:SeekerAuctionSigningError['code']):asserts value {if(!value)throw new SeekerAuctionSigningError(code);}
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((value,i)=>value===b[i]);
// Reviewed Anchor v1 ABI discriminators and classic SPL identities, not tuning.
const OPEN_BID=[47,244,91,248,119,250,130,129],PLACE_BID=[238,77,148,91,200,151,92,146],WITHDRAW_BID=[110,53,157,195,147,100,110,73];
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PACKET_BYTES=1232,SINGLE_SIGNATURE_PREFIX_BYTES=65;
interface Proof {readonly message:Buffer;readonly wallet:string;readonly blockhash:string;readonly lastValidBlockHeight:string}
const proofs=new WeakMap<PreparedSeekerAuctionSigning,Proof>(),used=new WeakSet<PreparedSeekerAuctionSigning>();
function fields(value:unknown,names:string):void {
 need(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(' ')===names.split(' ').sort().join(' '),'INPUT');
}
function key(value:unknown):PublicKey {
 need(typeof value==='string'&&value.length>=32&&value.length<=44,'IDENTITY');
 try{const result=new PublicKey(value);need(result.toBase58()===value,'IDENTITY');return result;}
 catch{throw new SeekerAuctionSigningError('IDENTITY');}
}
function le(value:string):Buffer {const out=Buffer.alloc(8);out.writeBigUInt64LE(BigInt(value));return out;}
function ata(owner:PublicKey,mint:PublicKey):PublicKey {return PublicKey.findProgramAddressSync([owner.toBuffer(),TOKEN.toBuffer(),mint.toBuffer()],ASSOCIATED)[0];}
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
function withdrawalInstructions(v:{wallet:PublicKey;program:PublicKey;config:PublicKey;auction:PublicKey;bid:PublicKey;mint:PublicKey;source:PublicKey;vault:PublicKey},setup:boolean):TransactionInstruction[]{
 const {wallet,program,config,auction,bid,mint,source,vault}=v,instructions:TransactionInstruction[]=[];
 if(setup)instructions.push(new TransactionInstruction({programId:ASSOCIATED,keys:[meta(wallet,true,true),meta(source,true),meta(wallet),meta(mint),meta(SystemProgram.programId),meta(TOKEN)],data:Buffer.of(1)}));
 instructions.push(new TransactionInstruction({programId:program,keys:[meta(wallet,false,true),meta(config),meta(auction,true),meta(bid,true),meta(mint),meta(source,true),meta(vault,true),meta(TOKEN)],data:Buffer.from(WITHDRAW_BID)}));
 return instructions;
}
function canonical(input:SeekerAuctionSigningInput,setup:boolean):Buffer {
 const v=input.view,c=v.config,r=input.request,wallet=key(v.wallet),program=key(input.identity.programId),mint=key(input.identity.mint);
 need(PublicKey.isOnCurve(wallet.toBytes())&&!program.equals(PublicKey.default)&&!mint.equals(PublicKey.default),'IDENTITY');
 const pda=(seed:string,...tails:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],program)[0];
 const config=pda('auction_config'),auction=pda('auction',config.toBuffer(),Buffer.of(r.spot),le(r.round));
 const bid=pda('bid',auction.toBuffer(),wallet.toBuffer()),source=ata(wallet,mint),vault=ata(auction,mint);
 need(c.address===config.toBase58()&&c.prizeAta===ata(key(c.prizeOwner),mint).toBase58(),'IDENTITY');
 const instructions:TransactionInstruction[]=[];
 if(input.kind==='bid'){
  if(setup)instructions.push(new TransactionInstruction({programId:program,keys:[meta(wallet,true,true),meta(config),meta(auction),meta(bid,true),meta(SystemProgram.programId)],data:Buffer.from(OPEN_BID)}));
  instructions.push(new TransactionInstruction({programId:program,keys:[meta(wallet,false,true),meta(pda('seeker_authority')),meta(config),
   meta(pda('seeker_term',config.toBuffer(),le(r.round))),meta(auction,true),meta(bid,true),meta(mint),meta(source,true),meta(vault,true),meta(TOKEN)],
   data:Buffer.concat([Buffer.from(PLACE_BID),le(input.request.newTotalRaw)])}));
 }else instructions.push(...withdrawalInstructions({wallet,program,config,auction,bid,mint,source,vault},setup));
 return Buffer.from(new TransactionMessage({payerKey:wallet,recentBlockhash:input.prepared.blockhash,instructions}).compileToLegacyMessage().serialize());
}

/** Snapshot and rebuild before any wallet access. Optional setup is a finite
 * grammar choice, not a trusted account list copied from the server message. */
export async function prepareSeekerAuctionSigning(value:SeekerAuctionSigningInput):Promise<PreparedSeekerAuctionSigning> {
 try{
  fields(value,'kind request view prepared identity');fields(value.identity,'programId mint decimals');
  need(value.kind==='bid'||value.kind==='withdraw','INPUT');
  need(value.view&&Array.isArray(value.view.spots)&&value.view.spots.length===PHASE_E_POLICY.seekerIsland.totalSpots,'INPUT');
  const view=SeekerAuctionSourcedRoundViewSchema.parse(value.view),prepared=SeekerAuctionPreparedSchema.parse(value.prepared);
  const identity={programId:key(value.identity.programId).toBase58(),mint:key(value.identity.mint).toBase58(),decimals:value.identity.decimals};
  need(identity.programId===view.config.programId&&Number.isInteger(identity.decimals)&&identity.decimals>=0&&identity.decimals<=255
   &&identity.mint===view.config.mint&&identity.decimals===view.config.decimals,'IDENTITY');
  need(view.source==='chain','IDENTITY');
  const input:SeekerAuctionSigningInput=value.kind==='bid'?{kind:'bid',request:SeekerBidPrepareRequestSchema.parse(value.request),view,prepared,identity}:
   {kind:'withdraw',request:SeekerWithdrawPrepareRequestSchema.parse(value.request),view,prepared,identity};
  need(input.request.round===view.round,'MESSAGE');const row=view.spots[input.request.spot];need(row?.opened,'MESSAGE');
  if(input.kind==='bid'){
   const total=BigInt(input.request.newTotalRaw),high=BigInt(row.highBidRaw),own=BigInt(row.yourBidRaw);
   need(!view.admissionPaused&&view.openedCount===PHASE_E_POLICY.seekerIsland.totalSpots&&view.round===view.biddingRound&&!row.settled
    &&total>high&&total>=BigInt(view.config.openingBidRaw)&&total>own&&(row.highBidder!==view.wallet||own===high)&&BigInt(prepared.incrementRaw)===total-own,'MESSAGE');
  }else need(row.refundable&&row.yourBidRaw!=='0'&&row.highBidder!==view.wallet&&prepared.incrementRaw==='0','MESSAGE');
  const bytes=Buffer.from(prepared.messageBase64,'base64');
  need(bytes.toString('base64')===prepared.messageBase64&&bytes.length+SINGLE_SIGNATURE_PREFIX_BYTES<=PACKET_BYTES&&bytes[0]===1,'MESSAGE');
  const decoded=Message.from(bytes);need(decoded.instructions.length===1||decoded.instructions.length===2,'MESSAGE');
  const expected=canonical(input,decoded.instructions.length===2);
  need(same(expected,bytes)&&same(decoded.serialize(),bytes)&&decoded.recentBlockhash===prepared.blockhash,'MESSAGE');
  const result=Object.freeze({wallet:view.wallet});proofs.set(result,{message:Buffer.from(expected),wallet:view.wallet,blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight});return result;
 }catch(error){if(error instanceof SeekerAuctionSigningError)throw error;throw new SeekerAuctionSigningError('INPUT');}
}

export interface SeekerAuctionRefundSigningInput {
 readonly page:SeekerAuctionRefundsPage;readonly request:SeekerWithdrawPrepareRequest;
 readonly prepared:SeekerAuctionPrepared;readonly identity:SeekerAuctionIdentity;
}
/** An older refund has its own bounded proof page; never fabricate a full
 * historical round just to reuse signing. It shares the exact wallet verifier. */
export async function prepareSeekerAuctionRefundSigning(value:SeekerAuctionRefundSigningInput):Promise<PreparedSeekerAuctionSigning>{
 try{
  fields(value,'page request prepared identity');fields(value.identity,'programId mint decimals');
  const page=SeekerAuctionRefundsPageSchema.parse(value.page),request=SeekerWithdrawPrepareRequestSchema.parse(value.request),prepared=SeekerAuctionPreparedSchema.parse(value.prepared);
  const identity={programId:key(value.identity.programId).toBase58(),mint:key(value.identity.mint).toBase58(),decimals:value.identity.decimals};
  need(identity.programId===page.programId&&identity.mint===page.mint&&identity.decimals===page.decimals,'IDENTITY');need(prepared.incrementRaw==='0','MESSAGE');
  const row=page.entries.find(entry=>entry.round===request.round&&entry.spot===request.spot);need(row,'MESSAGE');
  const wallet=key(page.wallet),program=key(identity.programId),mint=key(identity.mint);
  need(PublicKey.isOnCurve(wallet.toBytes())&&!program.equals(PublicKey.default)&&!mint.equals(PublicKey.default),'IDENTITY');
  const pda=(seed:string,...tails:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],program)[0];
  const config=pda('auction_config'),auction=pda('auction',config.toBuffer(),Buffer.of(request.spot),le(request.round)),bid=pda('bid',auction.toBuffer(),wallet.toBuffer());
  need(page.config===config.toBase58()&&row.auction===auction.toBase58()&&row.bid===bid.toBase58(),'IDENTITY');
  const bytes=Buffer.from(prepared.messageBase64,'base64');need(bytes.toString('base64')===prepared.messageBase64&&bytes.length+SINGLE_SIGNATURE_PREFIX_BYTES<=PACKET_BYTES&&bytes[0]===1,'MESSAGE');
  const decoded=Message.from(bytes);need(decoded.instructions.length===1||decoded.instructions.length===2,'MESSAGE');
  const instructions=withdrawalInstructions({wallet,program,config,auction,bid,mint,source:ata(wallet,mint),vault:ata(auction,mint)},decoded.instructions.length===2);
  const expected=Buffer.from(new TransactionMessage({payerKey:wallet,recentBlockhash:prepared.blockhash,instructions}).compileToLegacyMessage().serialize());
  need(same(expected,bytes)&&same(decoded.serialize(),bytes),'MESSAGE');
  const result=Object.freeze({wallet:page.wallet});proofs.set(result,{message:Buffer.from(expected),wallet:page.wallet,blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight});return result;
 }catch(error){if(error instanceof SeekerAuctionSigningError)throw error;throw new SeekerAuctionSigningError('INPUT');}
}

function resolved(message:Message,index:number){
 need(Number.isInteger(index)&&index>=0&&index<message.accountKeys.length,'MESSAGE');
 return {key:message.accountKeys[index]!.toBase58(),signer:message.isAccountSigner(index),writable:message.isAccountWritable(index)};
}
function instructions(message:Message){return message.compiledInstructions.map(ix=>({program:resolved(message,ix.programIdIndex),
 accounts:ix.accountKeyIndexes.map(index=>resolved(message,index)),data:Buffer.from(ix.data)}));}
/** Accept only the original application instructions plus D-141 budget tags 2/3.
 * Compare transaction-resolved privileges, so account aliases cannot elevate a role. */
function verifyWalletReply(proof:Proof,signed:Transaction):SignedSeekerAuction {
 try{
  need(signed instanceof Transaction&&signed.nonceInfo===undefined&&Array.isArray(signed.instructions)&&signed.instructions.length>=1&&signed.instructions.length<=4
   &&Array.isArray(signed.signatures)&&signed.signatures.length===1,'MESSAGE');
  need(signed.feePayer instanceof PublicKey&&signed.feePayer.toBase58()===proof.wallet,'WALLET');
  key(signed.recentBlockhash);
  for(const ix of signed.instructions){
   need(ix instanceof TransactionInstruction&&ix.programId instanceof PublicKey&&ix.data instanceof Uint8Array&&ix.data.length<=16&&Array.isArray(ix.keys)&&ix.keys.length<=10,'MESSAGE');
   for(const account of ix.keys)need(account.pubkey instanceof PublicKey&&typeof account.isSigner==='boolean'&&typeof account.isWritable==='boolean','MESSAGE');
  }
  const signature=signed.signatures[0]!;need(signature.publicKey instanceof PublicKey&&signature.publicKey.toBase58()===proof.wallet
   &&signature.signature instanceof Uint8Array&&signature.signature.length===64,'SIGNATURE');
  const bytes=Buffer.from(Transaction.prototype.serializeMessage.call(signed)),sig=Buffer.from(signature.signature);
  need(bytes.length+SINGLE_SIGNATURE_PREFIX_BYTES<=PACKET_BYTES&&bytes[0]===1,'MESSAGE');const message=Message.from(bytes);
  need(same(message.serialize(),bytes)&&message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0
   &&message.accountKeys[0]?.toBase58()===proof.wallet&&message.header.numReadonlyUnsignedAccounts<=message.accountKeys.length-1
   &&new Set(message.accountKeys.map(k=>k.toBase58())).size===message.accountKeys.length,'MESSAGE');
  const expected=new TransactionMessage({payerKey:key(proof.wallet),recentBlockhash:message.recentBlockhash,
   instructions:Transaction.populate(Message.from(proof.message)).instructions}).compileToLegacyMessage();
  const before=instructions(expected),after=instructions(message),budget=ComputeBudgetProgram.programId.toBase58(),usedKeys=new Set([proof.wallet]);
  let at=0,limit:bigint|null=null,price:bigint|null=null;
  for(const ix of after){
   usedKeys.add(ix.program.key);ix.accounts.forEach(a=>usedKeys.add(a.key));
   if(ix.program.key!==budget){
    const original=before[at++];need(original&&JSON.stringify({...ix,data:undefined})===JSON.stringify({...original,data:undefined})&&same(ix.data,original.data),'MESSAGE');continue;
   }
   need(!ix.program.signer&&!ix.program.writable&&ix.accounts.length===0,'MESSAGE');
   if(ix.data.length===5&&ix.data[0]===2&&limit===null)limit=BigInt(ix.data.readUInt32LE(1));
   else if(ix.data.length===9&&ix.data[0]===3&&price===null)price=ix.data.readBigUInt64LE(1);
   else throw new SeekerAuctionSigningError('MESSAGE');
  }
  need(at===before.length&&usedKeys.size===message.accountKeys.length,'MESSAGE');
  // Solana's runtime CU maximum supplies the conservative price-only bound.
  const fee=((limit??1_400_000n)*(price??0n)+999_999n)/1_000_000n;
  need(fee<=BigInt(PHASE_E_SEEKER_AUCTION_RUNTIME.maxWalletAddedPriorityFeeLamports),'MESSAGE');
  need(ed25519.verify(sig,bytes,key(proof.wallet).toBytes(),{zip215:false}),'SIGNATURE');
  const wire=Buffer.concat([Buffer.of(1),sig,bytes]);
  return Object.freeze({submission:Object.freeze({signedTransaction:wire.toString('base64')}),signature:bs58.encode(sig),
   lastValidBlockHeight:message.recentBlockhash===proof.blockhash?proof.lastValidBlockHeight:null});
 }catch(error){if(error instanceof SeekerAuctionSigningError)throw error;throw new SeekerAuctionSigningError('SIGNATURE');}
}

/** One wallet call per opaque proof. A failed sign-only call never falls through
 * to sendTransaction. Late valid evidence is returned for the controller to retain. */
export async function signSeekerAuction(prepared:PreparedSeekerAuctionSigning,wallet:GameWallet):Promise<SignedSeekerAuction> {
 const proof=proofs.get(prepared);need(proof&&!used.has(prepared),'INPUT');
 need(wallet&&wallet.publicKey?.toBase58()===proof.wallet,'WALLET');
 const sign=wallet.signTransaction,send=wallet.sendTransaction;
 need((sign===null||sign===undefined||typeof sign==='function')&&(typeof sign==='function'||typeof send==='function'),'WALLET');
 const tx=Transaction.populate(Message.from(proof.message),[bs58.encode(new Uint8Array(64))]);need(same(tx.serializeMessage(),proof.message),'MESSAGE');
 used.add(prepared);
 if(typeof sign==='function')return verifyWalletReply(proof,await sign.call(wallet,tx));
 const signature=await send!.call(wallet,tx),submission=SeekerAuctionSubmitRequestSchema.parse({signature});
 return Object.freeze({submission:Object.freeze(submission),signature,lastValidBlockHeight:null});
}
