/** Lazy browser-only original KEEP tax crypto. Static proof is not current
 * admission, finalized setup, permission to relay, or journal-clear authority. */
import {Message,PublicKey,SystemProgram,Transaction,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {MiningTaxClaimPreparationSchema,type MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import type {GameWallet} from '../../auth/useGameWallet';
/** Independently configured application pins; never copied from API bootstrap. */
export interface MiningTaxClaimSigningTrust {readonly genesisHash:string;readonly programId:string;readonly configAddress:string;readonly keepMint:string;readonly reserveOwner:string;readonly reviewedDeploymentSlot:number;readonly reviewedProgramDataSha256:string}
export interface PreparedMiningTaxClaimSigning {readonly ordinal:number;readonly wallet:string;readonly signingAuthorized:false;readonly broadcastAuthorized:false}
export interface SignedMiningTaxClaim {readonly ordinal:number;readonly wire:string;readonly signature:string;readonly messageSha256:string;readonly wireSha256:string}
export class MiningTaxClaimSigningError extends Error{constructor(readonly code:'INPUT'|'TRUST'|'MESSAGE'|'WALLET'|'SIGNATURE'){super(`Mining tax signing refused: ${code}`);this.name='MiningTaxClaimSigningError';}}
function need(v:unknown,code:MiningTaxClaimSigningError['code']):asserts v{if(!v)throw new MiningTaxClaimSigningError(code);}
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
// Reviewed classic SPL/ATA and Anchor v2 ABI bytes/sizes, cross-tested against
// the real SDK/IDL without importing its Node/Anchor graph into the browser.
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const OPEN_POOL=[126,149,231,46,129,35,107,255],OPEN_SPOT=[162,201,237,110,123,177,57,107],ACCRUE=[236,121,192,221,194,38,171,205],CLAIM=[251,158,247,186,156,3,136,150];
const ATA_BYTES=165,POOL_BYTES=125,ACCRUAL_BYTES=123,CURSOR_BYTES=116,MAX_PACKET=1232,DAY=BigInt(PHASE_E_MINING_PUBLICATION.daySec);
const proofs=new WeakMap<PreparedMiningTaxClaimSigning,{p:MiningTaxClaimPreparation;messages:Buffer[];ordinal:number}>();
function key(v:unknown):PublicKey{need(typeof v==='string'&&v.length>=32&&v.length<=44,'TRUST');try{const p=new PublicKey(v);need(p.toBase58()===v&&!p.equals(PublicKey.default),'TRUST');return p;}catch{throw new MiningTaxClaimSigningError('TRUST');}}
const le=(v:string)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
function preparation(v:MiningTaxClaimPreparation):MiningTaxClaimPreparation{const parsed=MiningTaxClaimPreparationSchema.safeParse(v);need(parsed.success,'INPUT');return parsed.data;}
function canonicalMessages(p:MiningTaxClaimPreparation):Buffer[]{
 try{
  const i=p.identity,program=key(i.programId),wallet=key(p.wallet),mint=key(i.keepMint);need(PublicKey.isOnCurve(wallet.toBytes())&&p.term.winnerCount<=255,'MESSAGE');
  const pda=(seed:string,...tails:Uint8Array[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],program)[0],ata=(owner:PublicKey)=>PublicKey.findProgramAddressSync([owner.toBytes(),TOKEN.toBytes(),mint.toBytes()],ATA)[0];
  const config=pda('economy'),auctionConfig=pda('auction_config'),registry=pda('seeker_registry'),term=pda('seeker_term',auctionConfig.toBytes(),le(p.round));
  const pool=pda('mining_tax_pool',config.toBytes(),term.toBytes()),cursor=pda('mining_tax_spot',pool.toBytes(),Buffer.of(p.spot)),auction=pda('auction',auctionConfig.toBytes(),Buffer.of(p.spot),le(p.round)),destination=ata(wallet),vault=ata(config);
  const roles=[wallet,program,mint,config,auctionConfig,registry,term,pool,cursor,auction,destination,vault,SystemProgram.programId,TOKEN,ATA].map(k=>k.toBase58());need(new Set(roles).size===roles.length,'MESSAGE');
  // Reserve owner may itself be the original winning claimant; it is not an
  // instruction role and must not be added to this alias prohibition.
  for(const [name,address] of Object.entries({configAddress:config,auctionConfig,registry,term,pool,cursor,auction,claimantAta:destination}))need(i[name as keyof typeof i]===address.toBase58(),'MESSAGE');
  // Historical range/roster and packet bounds are saved facts. Today's term
  // duration and accrual eligibility belong to live server admission instead.
  for(const day of p.setup.accrualDays){const start=BigInt(day)*DAY,end=start+DAY;need(start>0n&&start>=BigInt(p.term.operatingStart)&&start>=BigInt(p.term.completedAt)&&end<=BigInt(p.term.operatingEnd)&&end<=BigInt(p.snapshot.unixTimestamp),'MESSAGE');}
  const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner}),payer=meta(wallet,true,true),system=meta(SystemProgram.programId),common=[meta(config),meta(auctionConfig),meta(registry),meta(term)];
  const instruction=(data:number[],keys:ReturnType<typeof meta>[])=>new TransactionInstruction({programId:program,data:Buffer.from(data),keys});
  const setup:TransactionInstruction[]=[],accounts:{address:string;space:number}[]=[];
  if(p.setup.needsAta){setup.push(new TransactionInstruction({programId:ATA,data:Buffer.of(1),keys:[payer,meta(destination,true),meta(wallet),meta(mint),system,meta(TOKEN)]}));accounts.push({address:destination.toBase58(),space:ATA_BYTES});}
  if(p.setup.needsPool){setup.push(instruction(OPEN_POOL,[payer,...common,meta(pool,true),system]));accounts.push({address:pool.toBase58(),space:POOL_BYTES});}
  for(const day of p.setup.accrualDays){const epoch=pda('mining_epoch',le(day)),accrual=pda('mining_tax_epoch',config.toBytes(),epoch.toBytes());setup.push(instruction(ACCRUE,[payer,...common,meta(pool,true),meta(epoch),meta(accrual,true),system]));accounts.push({address:accrual.toBase58(),space:ACCRUAL_BYTES});}
  if(p.setup.needsCursor){setup.push(instruction(OPEN_SPOT,[payer,...common,meta(pool),meta(auction),meta(cursor,true),system]));accounts.push({address:cursor.toBase58(),space:CURSOR_BYTES});}
  const claim=instruction(CLAIM,[meta(wallet,false,true),meta(config,true),...common.slice(1),meta(pool,true),meta(auction),meta(cursor,true),meta(vault,true),meta(destination,true),meta(mint),meta(TOKEN)]);
  const compile=(instructions:TransactionInstruction[])=>Buffer.from(new TransactionMessage({payerKey:wallet,recentBlockhash:key(p.blockhash).toBase58(),instructions}).compileToLegacyMessage().serialize());
  const combined=compile([...setup,claim]),messages=combined.length+65>MAX_PACKET?[compile(setup),compile([claim])]:[combined];need(messages.length===p.transactions.length,'MESSAGE');
  for(const [ordinal,message] of messages.entries()){const tx=p.transactions[ordinal]!,saved=Buffer.from(tx.messageHex,'hex'),expected=ordinal===0?accounts:[];
   need(message.length+65<=MAX_PACKET&&message[0]===1&&same(saved,message)&&tx.packetBytes===message.length+65&&tx.newAccounts.length===expected.length,'MESSAGE');
   for(const [j,a] of tx.newAccounts.entries())need(a.address===expected[j]!.address&&a.space===expected[j]!.space,'MESSAGE');
   const decoded=Message.from(message);need(decoded.header.numRequiredSignatures===1&&decoded.header.numReadonlySignedAccounts===0&&decoded.accountKeys[0]?.equals(wallet)&&same(decoded.serialize(),message),'MESSAGE');
  }return messages;
 }catch(error){if(error instanceof MiningTaxClaimSigningError)throw error;throw new MiningTaxClaimSigningError('MESSAGE');}
}
async function sha(bytes:Uint8Array):Promise<string>{try{return Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))).toString('hex');}catch{throw new MiningTaxClaimSigningError('MESSAGE');}}
async function checkedMessages(p:MiningTaxClaimPreparation):Promise<Buffer[]>{const messages=canonicalMessages(p);for(const [ordinal,message] of messages.entries())need(await sha(message)===p.transactions[ordinal]!.messageSha256,'MESSAGE');return messages;}
function selected(p:MiningTaxClaimPreparation,ordinal:number){need(Number.isInteger(ordinal)&&ordinal>=0&&ordinal<p.transactions.length,'INPUT');}
/** Static original consent only. Caller must separately establish fresh quote,
 * provider/height and per-ordinal setup admission before requesting approval. */
export async function prepareMiningTaxClaimSigning(value:MiningTaxClaimPreparation,trust:MiningTaxClaimSigningTrust,ordinal=0):Promise<PreparedMiningTaxClaimSigning>{
 const p=preparation(value);selected(p,ordinal);need(trust&&typeof trust==='object','TRUST');
 for(const name of ['genesisHash','programId','configAddress','keepMint','reserveOwner'] as const)need(key(trust[name]).toBase58()===p.identity[name],'TRUST');
 need(trust.reviewedDeploymentSlot===p.source.reviewedDeploymentSlot&&trust.reviewedProgramDataSha256===p.source.reviewedProgramDataSha256,'TRUST');
 const messages=await checkedMessages(p),prepared=Object.freeze({ordinal,wallet:p.wallet,signingAuthorized:false as const,broadcastAuthorized:false as const});proofs.set(prepared,{p,messages,ordinal});return prepared;
}
/** Historical byte/signature verification deliberately ignores current expiry,
 * flags and eligibility. An ordinal1 wire is not proof that setup finalized. */
export async function verifySignedMiningTaxClaim(value:MiningTaxClaimPreparation,raw:unknown,ordinal=0):Promise<SignedMiningTaxClaim>{
 const p=preparation(value);selected(p,ordinal);
 need(typeof raw==='string'&&raw.length>=88&&raw.length<=1644&&raw.length%4===0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw),'INPUT');
 const wire=Buffer.from(raw,'base64');need(wire.length<=MAX_PACKET&&wire.toString('base64')===raw,'INPUT');const messages=await checkedMessages(p),message=messages[ordinal]!;
 need(wire[0]===1&&wire.length===message.length+65&&same(wire.subarray(65),message),'MESSAGE');
 try{const tx=Transaction.from(wire),owner=key(p.wallet),signature=tx.signatures[0];need(tx.signatures.length===1&&tx.feePayer?.equals(owner)&&signature?.publicKey.equals(owner)&&signature.signature&&same(tx.serializeMessage(),message)&&tx.verifySignatures(true),'SIGNATURE');need(same(tx.serialize({requireAllSignatures:true,verifySignatures:false}),wire),'SIGNATURE');return Object.freeze({ordinal,wire:raw,signature:bs58.encode(signature!.signature!),messageSha256:p.transactions[ordinal]!.messageSha256,wireSha256:await sha(wire)});
 }catch(error){if(error instanceof MiningTaxClaimSigningError)throw error;throw new MiningTaxClaimSigningError('SIGNATURE');}
}
/** Sign only. The caller must durably retain a valid late result before testing
 * expiry, session or lifecycle changes. This function never sends/relays. */
export async function signMiningTaxClaim(prepared:PreparedMiningTaxClaimSigning,wallet:GameWallet):Promise<SignedMiningTaxClaim>{
 const proof=proofs.get(prepared);need(proof,'INPUT');const sign=wallet.signTransaction;need(wallet.publicKey?.toBase58()===proof.p.wallet&&typeof sign==='function','WALLET');const message=proof.messages[proof.ordinal]!;
 const tx=Transaction.populate(Message.from(message),[bs58.encode(new Uint8Array(64))]);need(same(tx.serializeMessage(),message),'MESSAGE');const signed=await sign.call(wallet,tx),original=Transaction.populate(Message.from(message));
 // Inspect bounded ordinary fields before any wallet-supplied serializer runs.
 need(signed instanceof Transaction&&Array.isArray(signed.instructions)&&signed.instructions.length===original.instructions.length&&signed.instructions.length<=11&&Array.isArray(signed.signatures)&&signed.signatures.length===1&&signed.nonceInfo===undefined&&signed.recentBlockhash===proof.p.blockhash&&(signed.signatures[0]?.signature===null||signed.signatures[0]?.signature instanceof Uint8Array&&signed.signatures[0].signature.length===64),'MESSAGE');
 for(const [i,ix] of signed.instructions.entries()){const expected=original.instructions[i]!;need(ix instanceof TransactionInstruction&&ix.programId instanceof PublicKey&&ix.programId.equals(expected.programId)&&ix.data instanceof Uint8Array&&ix.data.length<=8&&same(ix.data,expected.data)&&Array.isArray(ix.keys)&&ix.keys.length===expected.keys.length&&ix.keys.length<=12,'MESSAGE');for(const [j,k] of ix.keys.entries()){const e=expected.keys[j]!;need(k.pubkey instanceof PublicKey&&k.pubkey.equals(e.pubkey)&&k.isSigner===e.isSigner&&k.isWritable===e.isWritable,'MESSAGE');}}
 need(signed.feePayer instanceof PublicKey&&signed.feePayer.equals(original.feePayer!)&&signed.signatures[0]?.publicKey instanceof PublicKey&&signed.signatures[0].publicKey.equals(original.feePayer!)&&same(signed.serializeMessage(),message),'MESSAGE');
 try{return await verifySignedMiningTaxClaim(proof.p,signed.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),proof.ordinal);}catch(error){if(error instanceof MiningTaxClaimSigningError)throw error;throw new MiningTaxClaimSigningError('SIGNATURE');}
}
