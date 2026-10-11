/** Pure ABI/identity helpers for the implemented mining program. Account bytes
 * are not finalized source authority; unsigned instructions are not admission,
 * funding, eligibility, or proof-of-fair-allocation decisions. Subpath only. */
import type {Idl} from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import { PublicKey,TransactionInstruction,SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN,PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import { encodeMiningAllocationLeaf,encodeMiningAllocationProof,MINING_ALLOCATION_MAX_LEAVES,MINING_ALLOCATION_U64_MAX,type MiningAllocationLeaf,type MiningProofNode } from './miningAllocationProof';
const {BorshCoder,BN}=anchorPkg,coder=new BorshCoder(idl as Idl);
// Keep the cross-copy runtime check without relying on bn.js declarations.
// The predicate names `words` (an array BN.isBN itself requires) so the false
// branch stays unknown: a toString-only shape also matches {} and narrowed it to null|undefined.
function isAnchorBN(value: unknown): value is { readonly words: readonly unknown[]; toString(): string } { return BN.isBN(value); }
export const MINING_PROGRAM_ADDRESS=idl.address;
export class MiningProgramProtocolError extends Error {constructor(readonly code:'INPUT'|'ACCOUNT'|'IDENTITY'|'LIABILITY'){super(`Mining program protocol refused: ${code}`);this.name='MiningProgramProtocolError';}}
function requireValue(v:unknown,code:'INPUT'|'ACCOUNT'|'IDENTITY'|'LIABILITY'):asserts v{if(!v)throw new MiningProgramProtocolError(code);}
function key(value:PublicKey):string{
 try{requireValue(value&&typeof value.toBytes==='function'&&typeof value.toBase58==='function','INPUT');const bytes=value.toBytes();requireValue(bytes instanceof Uint8Array&&bytes.length===32,'INPUT');const text=new PublicKey(bytes).toBase58();requireValue(value.toBase58()===text,'INPUT');return text;}catch{throw new MiningProgramProtocolError('INPUT');}
}
function program(value:PublicKey):PublicKey{requireValue(key(value)===MINING_PROGRAM_ADDRESS,'IDENTITY');return new PublicKey(MINING_PROGRAM_ADDRESS);}
function u64(value:bigint):bigint{requireValue(typeof value==='bigint'&&value>=0n&&value<=MINING_ALLOCATION_U64_MAX,'INPUT');return value;}
function positive(value:bigint):bigint{u64(value);requireValue(value>0n,'INPUT');return value;}
function uint(value:number,max:number):number{requireValue(Number.isInteger(value)&&value>=0&&value<=max,'INPUT');return value;}
function hash(value:Uint8Array):number[]{requireValue(value instanceof Uint8Array&&value.length===32,'INPUT');return [...value];}
function exact(value:object,names:string){requireValue(value&&typeof value==='object'&&!Array.isArray(value),'INPUT');const list=names.split(' ');requireValue(Object.keys(value).length===list.length&&Object.keys(value).every(k=>list.includes(k)),'INPUT');}
function le(value:bigint):Buffer{const b=Buffer.alloc(8);b.writeBigUInt64LE(u64(value));return b;}
function pda(programId:PublicKey,seed:string,tail?:Uint8Array):readonly[PublicKey,number]{return PublicKey.findProgramAddressSync([Buffer.from(seed),...(tail?[Buffer.from(tail)]:[])],program(programId));}
export const miningConfigPda=(p:PublicKey):PublicKey=>pda(p,'economy')[0];
export const miningRootPda=(p:PublicKey,sequence:bigint):PublicKey=>pda(p,'alloc',le(positive(sequence)))[0];
export const miningEpochPda=(p:PublicKey,day:bigint):PublicKey=>pda(p,'mining_epoch',le(positive(day)))[0];
export const minerClaimPda=(p:PublicKey,wallet:PublicKey):PublicKey=>pda(p,'miner',new PublicKey(key(wallet)).toBytes())[0];
export const renownRecordPda=(p:PublicKey,wallet:PublicKey):PublicKey=>pda(p,'renown',new PublicKey(key(wallet)).toBytes())[0];
export interface MiningProgramIdentity {readonly programId:PublicKey;readonly keepMint:PublicKey;readonly reserveOwner:PublicKey}
export interface MiningRawAccount {readonly address:PublicKey;readonly owner:PublicKey;readonly executable:boolean;readonly data:Uint8Array}
const names=['EconomyConfig','AllocationRoot','MiningEpochReceipt','MinerClaim','RenownRecord'] as const;
type AccountName=typeof names[number];
export const MINING_ACCOUNT_BYTES:Readonly<Record<AccountName,number>>=Object.freeze(Object.fromEntries(names.map(n=>[n,coder.accounts.size(n)])) as Record<AccountName,number>);
interface AccountBase {readonly address:string;readonly version:number;readonly bump:number}
export interface MiningConfigAccount extends AccountBase {
 readonly authority:string;readonly publisher:string;readonly keepMint:string;readonly miningVault:string;readonly emissionReserveOwner:string;readonly emissionReserveAta:string;readonly decimals:number;
 readonly genesisDay:bigint;readonly latestDay:bigint;readonly latestSequence:bigint;readonly totalPublished:bigint;readonly totalPublishedHighwater:bigint;readonly totalClaimed:bigint;readonly taxHighwater:bigint;readonly taxPaid:bigint;readonly recycledTotal:bigint;readonly grossPublished:bigint;readonly splitCursor:number;readonly flags:number;readonly correctionPending:boolean;
}
export interface MiningRootAccount extends AccountBase {readonly config:string;readonly epoch:string;readonly sequence:bigint;readonly day:bigint;readonly prevDay:bigint;readonly prevTotal:bigint;readonly root:string;readonly totalCumulative:bigint;readonly leafCount:number;readonly claimsCount:bigint;readonly publishedAt:bigint;readonly revoked:boolean;readonly kind:number}
export interface MiningEpochAccount extends AccountBase {readonly config:string;readonly day:bigint;readonly budgetGross:bigint;readonly freeGross:bigint;readonly deedGross:bigint;readonly playerNet:bigint;readonly tax:bigint;readonly recycle:bigint;readonly sourceHash:string;readonly taxCommitment:string;readonly taxVersion:number;readonly splitStart:number;readonly splitEnd:number;readonly fundedAt:bigint}
export interface MinerClaimAccount extends AccountBase {readonly wallet:string;readonly claimedTotal:bigint;readonly lastSequence:bigint;readonly lastClaimAt:bigint}
export interface RenownRecordAccount extends AccountBase {readonly wallet:string;readonly renownTotal:bigint;readonly daysAttested:bigint;readonly lastSequence:bigint;readonly syncedAt:bigint}
function decode<T extends AccountBase>(raw:MiningRawAccount,name:AccountName,programId:PublicKey,expected:readonly[PublicKey,number]):Readonly<T>{
 try{
  requireValue(raw&&key(raw.address)===expected[0].toBase58()&&key(raw.owner)===program(programId).toBase58()&&raw.executable===false,'IDENTITY');
  requireValue(raw.data instanceof Uint8Array&&raw.data.length===MINING_ACCOUNT_BYTES[name],'ACCOUNT');
  const bytes=Buffer.from(raw.data),decoded=coder.accounts.decode(name,bytes) as Record<string,unknown>;
  // Anchor's decoder alone accepts noncanonical boolean bytes. A complete exact
  // re-encoding proves field tags and forbids ignored trailing/padding bytes.
  requireValue(coder.types.encode(name,decoded).equals(bytes.subarray(8)),'ACCOUNT');
  const normalized:Record<string,unknown>={address:expected[0].toBase58()};
  for(const [field,value] of Object.entries(decoded)){
   const n=field.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
   normalized[n]=isAnchorBN(value)?BigInt(value.toString()):value instanceof PublicKey?value.toBase58():Array.isArray(value)?Buffer.from(value).toString('hex'):value;
  }
  requireValue(normalized.version===1&&normalized.bump===expected[1],'ACCOUNT');return Object.freeze(normalized) as unknown as Readonly<T>;
 }catch(e){if(e instanceof MiningProgramProtocolError)throw e;throw new MiningProgramProtocolError('ACCOUNT');}
}
export function decodeMiningConfig(raw:MiningRawAccount,identity:MiningProgramIdentity):Readonly<MiningConfigAccount>{
 const p=program(identity.programId),c=decode<MiningConfigAccount>(raw,'EconomyConfig',p,pda(p,'economy'));
 const mint=key(identity.keepMint),reserve=key(identity.reserveOwner),config=miningConfigPda(p);
 requireValue(c.authority===pda(p,'seeker_authority')[0].toBase58()&&c.keepMint===mint&&c.emissionReserveOwner===reserve,'IDENTITY');
 requireValue(c.miningVault===getAssociatedTokenAddressSync(new PublicKey(mint),config,true).toBase58()&&c.emissionReserveAta===getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(reserve),true).toBase58()&&c.miningVault!==c.emissionReserveAta,'IDENTITY');
 requireValue(c.decimals===TOKEN.decimals&&c.splitCursor<PHASE_E_MINING_PUBLICATION.splitPeriod,'ACCOUNT');miningLiabilityFloor(c);return c;
}
export function decodeMiningRoot(raw:MiningRawAccount,expected:{programId:PublicKey;sequence:bigint}):Readonly<MiningRootAccount>{
 const sequence=positive(expected.sequence),p=program(expected.programId),r=decode<MiningRootAccount>(raw,'AllocationRoot',p,pda(p,'alloc',le(sequence)));
 requireValue(r.config===miningConfigPda(p).toBase58()&&r.sequence===sequence&&r.epoch===miningEpochPda(p,r.day).toBase58(),'IDENTITY');return r;
}
export function decodeMiningEpoch(raw:MiningRawAccount,expected:{programId:PublicKey;day:bigint}):Readonly<MiningEpochAccount>{
 const day=positive(expected.day),p=program(expected.programId),e=decode<MiningEpochAccount>(raw,'MiningEpochReceipt',p,pda(p,'mining_epoch',le(day)));
 requireValue(e.config===miningConfigPda(p).toBase58()&&e.day===day,'IDENTITY');return e;
}
export function decodeMinerClaim(raw:MiningRawAccount,expected:{programId:PublicKey;wallet:PublicKey}):Readonly<MinerClaimAccount>{
 const wallet=key(expected.wallet),p=program(expected.programId),m=decode<MinerClaimAccount>(raw,'MinerClaim',p,pda(p,'miner',new PublicKey(wallet).toBytes()));requireValue(m.wallet===wallet,'IDENTITY');return m;
}
export function decodeRenownRecord(raw:MiningRawAccount,expected:{programId:PublicKey;wallet:PublicKey}):Readonly<RenownRecordAccount>{
 const wallet=key(expected.wallet),p=program(expected.programId),r=decode<RenownRecordAccount>(raw,'RenownRecord',p,pda(p,'renown',new PublicKey(wallet).toBytes()));requireValue(r.wallet===wallet,'IDENTITY');return r;
}
/** Arithmetic over the supplied decoded counters, never independent backing proof. */
export function miningLiabilityFloor(c:Pick<MiningConfigAccount,'totalPublishedHighwater'|'totalClaimed'|'taxHighwater'|'taxPaid'>):bigint{
 const player=u64(c.totalPublishedHighwater)-u64(c.totalClaimed),tax=u64(c.taxHighwater)-u64(c.taxPaid);
 requireValue(player>=0n&&tax>=0n&&player+tax<=MINING_ALLOCATION_U64_MAX,'LIABILITY');return player+tax;
}
export interface CorrectMiningInput {readonly sequence:bigint;readonly root:Uint8Array;readonly totalCumulative:bigint;readonly leafCount:number;readonly kind:0|2}
export interface PublishMiningInput extends CorrectMiningInput {readonly day:bigint;readonly budgetGross:bigint;readonly freeGross:bigint;readonly deedGross:bigint;readonly sourceHash:Uint8Array;readonly taxCommitment:Uint8Array;readonly taxVersion:number}
function correction(value:CorrectMiningInput){requireValue(value.kind===0||value.kind===2,'INPUT');requireValue(value.leafCount>0,'INPUT');return {sequence:new BN(positive(value.sequence).toString()),root:hash(value.root),total_cumulative:new BN(u64(value.totalCumulative).toString()),leaf_count:uint(value.leafCount,MINING_ALLOCATION_MAX_LEAVES),kind:value.kind};}
function accounts(identity:MiningProgramIdentity){const p=program(identity.programId),config=miningConfigPda(p),mint=new PublicKey(key(identity.keepMint)),reserve=new PublicKey(key(identity.reserveOwner));const vault=getAssociatedTokenAddressSync(mint,config,true),reserveAta=getAssociatedTokenAddressSync(mint,reserve,true);requireValue(!vault.equals(reserveAta),'IDENTITY');return {authority:pda(p,'seeker_authority')[0],config,mint,mining_vault:vault,reserve_ata:reserveAta,token_program:TOKEN_PROGRAM_ID,system_program:SystemProgram.programId};}
function instruction(programId:PublicKey,name:string,args:object,keys:Record<string,PublicKey>):TransactionInstruction{
 const p=program(programId),definition=idl.instructions.find(i=>i.name===name);requireValue(definition,'INPUT');
 const metas=definition.accounts.map(a=>{const pubkey=keys[a.name];requireValue(pubkey,'INPUT');const normalized=new PublicKey(key(pubkey));if('address' in a)requireValue(normalized.toBase58()===a.address,'IDENTITY');return {pubkey:normalized,isSigner:'signer' in a&&a.signer===true,isWritable:'writable' in a&&a.writable===true};});
 return new TransactionInstruction({programId:p,keys:metas,data:coder.instruction.encode(name,args)});
}
export function buildPublishMiningInstruction(identity:MiningProgramIdentity,input:{signer:PublicKey;args:PublishMiningInput}):TransactionInstruction{
 exact(input,'signer args');const a=input.args;exact(a,'sequence root totalCumulative leafCount kind day budgetGross freeGross deedGross sourceHash taxCommitment taxVersion');
 const args={...correction(a),day:new BN(positive(a.day).toString()),budget_gross:new BN(u64(a.budgetGross).toString()),free_gross:new BN(u64(a.freeGross).toString()),deed_gross:new BN(u64(a.deedGross).toString()),source_hash:hash(a.sourceHash),tax_commitment:hash(a.taxCommitment),tax_version:uint(a.taxVersion,0xffff)};
 return instruction(identity.programId,'publish_allocation_root',{args},{...accounts(identity),signer:input.signer,root:miningRootPda(identity.programId,a.sequence),epoch:miningEpochPda(identity.programId,a.day)});
}
export function buildCorrectMiningInstruction(identity:MiningProgramIdentity,input:{signer:PublicKey;revokedSequence:bigint;day:bigint;args:CorrectMiningInput}):TransactionInstruction{
 exact(input,'signer revokedSequence day args');exact(input.args,'sequence root totalCumulative leafCount kind');requireValue(input.args.sequence===positive(input.revokedSequence)+1n,'INPUT');
 return instruction(identity.programId,'correct_allocation_root',{args:correction(input.args)},{...accounts(identity),signer:input.signer,revoked_root:miningRootPda(identity.programId,input.revokedSequence),epoch:miningEpochPda(identity.programId,input.day),root:miningRootPda(identity.programId,input.args.sequence)});
}
export function buildRevokeMiningInstruction(identity:{programId:PublicKey},input:{admin:PublicKey;sequence:bigint}):TransactionInstruction{
 exact(input,'admin sequence');const p=program(identity.programId);return instruction(p,'revoke_allocation_root',{}, {admin:input.admin,authority:pda(p,'seeker_authority')[0],config:miningConfigPda(p),root:miningRootPda(p,input.sequence)});
}
function claimArgs(leaf:MiningAllocationLeaf,proof:readonly MiningProofNode[]){
 exact(leaf,'wallet cumulativeKeep cumulativeRenown cumulativeDays sequence');encodeMiningAllocationLeaf(leaf);encodeMiningAllocationProof(proof);positive(leaf.sequence);
 return {sequence:new BN(leaf.sequence.toString()),cumulative_keep:new BN(leaf.cumulativeKeep.toString()),cumulative_renown:new BN(leaf.cumulativeRenown.toString()),cumulative_days:new BN(leaf.cumulativeDays.toString()),proof:proof.map(n=>({hash:[...n.hash],sum:new BN(n.sum.toString()),is_left:n.isLeft}))};
}
export function buildClaimMiningInstruction(identity:MiningProgramIdentity,input:{leaf:MiningAllocationLeaf;proof:readonly MiningProofNode[]}):TransactionInstruction{
 exact(input,'leaf proof');const args=claimArgs(input.leaf,input.proof),wallet=new PublicKey(input.leaf.wallet),a=accounts(identity),p=identity.programId;
 return instruction(p,'claim_mining',args,{claimant:wallet,config:a.config,root:miningRootPda(p,input.leaf.sequence),miner:minerClaimPda(p,wallet),renown:renownRecordPda(p,wallet),vault:a.mining_vault,destination:getAssociatedTokenAddressSync(a.mint,wallet,true),keep_mint:a.mint,token_program:TOKEN_PROGRAM_ID});
}
export function buildSyncRenownInstruction(identity:{programId:PublicKey},input:{payer:PublicKey;leaf:MiningAllocationLeaf;proof:readonly MiningProofNode[]}):TransactionInstruction{
 exact(input,'payer leaf proof');const args=claimArgs(input.leaf,input.proof),wallet=new PublicKey(input.leaf.wallet),p=program(identity.programId);
 return instruction(p,'sync_renown',{wallet,...args},{payer:input.payer,config:miningConfigPda(p),root:miningRootPda(p,input.leaf.sequence),miner:minerClaimPda(p,wallet),renown:renownRecordPda(p,wallet)});
}
export function buildOpenMinerRecordsInstruction(identity:{programId:PublicKey},input:{payer:PublicKey;wallet:PublicKey}):TransactionInstruction{
 exact(input,'payer wallet');const p=program(identity.programId),wallet=new PublicKey(key(input.wallet));return instruction(p,'open_miner_records',{wallet},{payer:input.payer,miner:minerClaimPda(p,wallet),renown:renownRecordPda(p,wallet),system_program:SystemProgram.programId});
}
