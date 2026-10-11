/** Pure unsigned claimant messages. The application must independently establish
 * finalized root authority, positive unclaimed delta, delay and pause admission.
 * Neither a Merkle membership proof nor these messages authorize signing. */
import {createHash} from 'node:crypto';
import {ComputeBudgetProgram,Message,MessageV0,PublicKey,TransactionMessage,VersionedTransaction,type TransactionInstruction} from '@solana/web3.js';
import {ACCOUNT_SIZE,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {MINING_ALLOCATION_MAX_DEPTH,MINING_ALLOCATION_U64_MAX,verifyMiningAllocationProof,type MiningAllocationLeaf,type MiningProofNode} from './miningAllocationProof';
import {buildClaimMiningInstruction,buildOpenMinerRecordsInstruction,MINING_ACCOUNT_BYTES,minerClaimPda,renownRecordPda,type MiningProgramIdentity} from './miningProgramProtocol';

import {PHASE_E_MINING_CLAIM_FORMAT} from '@shardkeep/shared';
import {copyMiningClaimFormat,miningClaimLookupTable,miningClaimV0Accounts,type MiningClaimFormat} from './miningClaimFormat';

// Solana's legacy packet limit, including its actual signature envelope.
const MAX_PACKET_BYTES=1232;
export class MiningClaimMessageError extends Error {
 constructor(readonly code:'INPUT'|'IDENTITY'|'PROOF'|'PACKET'){super(`Mining claim message refused: ${code}`);this.name='MiningClaimMessageError';}
}
export interface MiningClaimMessageInput {
 readonly wallet:PublicKey;readonly root:Uint8Array;readonly sequence:bigint;readonly day:bigint;readonly totalCumulative:bigint;
 readonly leaf:MiningAllocationLeaf;readonly proof:readonly MiningProofNode[];readonly blockhash:string;
 readonly needsAta:boolean;readonly needsMinerRecords:boolean;
}
export interface MiningClaimExpectedAccount {readonly address:string;readonly space:number}
export interface MiningClaimUnsignedTransaction {
 readonly kind:'combined'|'setup'|'claim';
 /** A new owned copy on every access; contains no signatures. */
 readonly messageBytes:Uint8Array;readonly messageSha256:string;readonly packetBytes:number;
 readonly expectedNewAccounts:readonly MiningClaimExpectedAccount[];
}
export interface MiningClaimMessages {
 readonly mode:'combined'|'split';readonly wallet:string;readonly sequence:bigint;readonly day:bigint;
 readonly root:string;readonly totalCumulative:bigint;readonly transactions:readonly MiningClaimUnsignedTransaction[];
 readonly signingAuthorized:false;readonly broadcastAuthorized:false;
}
function requireValue(v:unknown,code:MiningClaimMessageError['code']):asserts v{if(!v)throw new MiningClaimMessageError(code);}
function exact(value:unknown,fields:string):void{
 requireValue(value&&typeof value==='object'&&!Array.isArray(value),'INPUT');const names=fields.split(' '),keys=Object.keys(value);
 requireValue(keys.length===names.length&&keys.every(k=>names.includes(k)),'INPUT');
}
function u64(v:bigint):void{requireValue(typeof v==='bigint'&&v>=0n&&v<=MINING_ALLOCATION_U64_MAX,'INPUT');}
function key(v:PublicKey):PublicKey{
 try{requireValue(v instanceof PublicKey,'INPUT');const copy=new PublicKey(v.toBytes());requireValue(copy.toBase58()===v.toBase58(),'INPUT');return copy;}catch{throw new MiningClaimMessageError('INPUT');}
}
/** All identity and account-existence inputs come from the application's trusted
 * admission snapshot. The optional application-owned format selects the fixed ordered preset; no caller-selected payer or instructions exist. */
export function buildMiningClaimMessages(identity:MiningProgramIdentity,input:MiningClaimMessageInput,formatInput?:MiningClaimFormat):MiningClaimMessages{
 try{
  exact(identity,'programId keepMint reserveOwner');exact(input,'wallet root sequence day totalCumulative leaf proof blockhash needsAta needsMinerRecords');
  const trusted={programId:key(identity.programId),keepMint:key(identity.keepMint),reserveOwner:key(identity.reserveOwner)},wallet=key(input.wallet);
  const format=formatInput===undefined?undefined:copyMiningClaimFormat(formatInput,trusted);
  requireValue(PublicKey.isOnCurve(wallet.toBytes()),'INPUT');u64(input.sequence);u64(input.day);u64(input.totalCumulative);
  requireValue(input.sequence>0n&&input.day>0n&&input.totalCumulative>0n,'INPUT');
  requireValue(typeof input.needsAta==='boolean'&&typeof input.needsMinerRecords==='boolean','INPUT');
  requireValue(typeof input.blockhash==='string'&&input.blockhash.length>=32&&input.blockhash.length<=44,'INPUT');
  let blockhash:string;try{blockhash=new PublicKey(input.blockhash).toBase58();}catch{throw new MiningClaimMessageError('INPUT');}requireValue(blockhash===input.blockhash,'INPUT');
  requireValue(input.root instanceof Uint8Array&&input.root.length===32,'INPUT');
  requireValue(Array.isArray(input.proof)&&input.proof.length<=MINING_ALLOCATION_MAX_DEPTH,'INPUT');
  exact(input.leaf,'wallet cumulativeKeep cumulativeRenown cumulativeDays sequence');
  requireValue(input.leaf.wallet===wallet.toBase58()&&input.leaf.sequence===input.sequence,'IDENTITY');
  u64(input.leaf.cumulativeKeep);requireValue(input.leaf.cumulativeKeep>0n,'INPUT');
  for(const node of input.proof)exact(node,'hash sum isLeft');
  requireValue(verifyMiningAllocationProof(input.leaf,input.proof,input.root,input.totalCumulative),'PROOF');
  const root=Buffer.from(input.root).toString('hex'),leaf={...input.leaf},proof=input.proof.map(n=>({hash:Uint8Array.from(n.hash),sum:n.sum,isLeft:n.isLeft}));
  const claim=buildClaimMiningInstruction(trusted,{leaf,proof}),setup:TransactionInstruction[]=[],accounts:MiningClaimExpectedAccount[]=[];
  if(input.needsAta){
   const ata=getAssociatedTokenAddressSync(trusted.keepMint,wallet);
   setup.push(createAssociatedTokenAccountIdempotentInstruction(wallet,ata,wallet,trusted.keepMint));
   accounts.push({address:ata.toBase58(),space:ACCOUNT_SIZE});
  }
  if(input.needsMinerRecords){
   setup.push(buildOpenMinerRecordsInstruction(trusted,{payer:wallet,wallet}));
   accounts.push({address:minerClaimPda(trusted.programId,wallet).toBase58(),space:MINING_ACCOUNT_BYTES.MinerClaim},{address:renownRecordPda(trusted.programId,wallet).toBase58(),space:MINING_ACCOUNT_BYTES.RenownRecord});
  }
  const serialize=(kind:MiningClaimUnsignedTransaction['kind'],instructions:TransactionInstruction[],newAccounts:readonly MiningClaimExpectedAccount[]):MiningClaimUnsignedTransaction=>{
   try{
    const builder=new TransactionMessage({payerKey:wallet,recentBlockhash:blockhash,instructions:format?[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_MINING_CLAIM_FORMAT.computeUnitLimit}),...instructions]:instructions});
    const message=format?builder.compileToV0Message([miningClaimLookupTable(format)]):builder.compileToLegacyMessage();
    if(format)miningClaimV0Accounts(message as MessageV0,format);
    requireValue(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.staticAccountKeys[0]!.equals(wallet),'IDENTITY');
    const bytes=Uint8Array.from(message.serialize());requireValue(Buffer.from((format?MessageV0.deserialize(bytes):Message.from(bytes)).serialize()).equals(Buffer.from(bytes)),'PACKET');
    // This serializes one zero-filled signature slot; no signing occurs. Its
    // length is identical after the claimant supplies their real signature.
    const packetBytes=new VersionedTransaction(message).serialize().length;
    const expectedNewAccounts=Object.freeze(newAccounts.map(a=>Object.freeze({...a})));
    return Object.freeze({kind,get messageBytes(){return Uint8Array.from(bytes);},messageSha256:createHash('sha256').update(bytes).digest('hex'),packetBytes,expectedNewAccounts});
   }catch(e){if(e instanceof MiningClaimMessageError)throw e;throw new MiningClaimMessageError('PACKET');}
  };
  const claimOnly=serialize('claim',[claim],[]);requireValue(claimOnly.packetBytes<=MAX_PACKET_BYTES,'PACKET');
  if(format){
   const setupOnly=setup.length?serialize('setup',setup,accounts):null;if(setupOnly)requireValue(setupOnly.packetBytes<=MAX_PACKET_BYTES,'PACKET');
   return Object.freeze({mode:setupOnly?'split':'combined',wallet:wallet.toBase58(),sequence:input.sequence,day:input.day,root,totalCumulative:input.totalCumulative,transactions:Object.freeze(setupOnly?[setupOnly,claimOnly]:[claimOnly]),signingAuthorized:false,broadcastAuthorized:false});
  }
  const combined=setup.length?serialize('combined',[...setup,claim],accounts):claimOnly;
  let mode:MiningClaimMessages['mode']='combined',transactions:MiningClaimUnsignedTransaction[];
  if(combined.packetBytes<=MAX_PACKET_BYTES)transactions=[combined];
  else{
   requireValue(setup.length>0,'PACKET');const setupOnly=serialize('setup',setup,accounts);requireValue(setupOnly.packetBytes<=MAX_PACKET_BYTES,'PACKET');
   mode='split';transactions=[setupOnly,claimOnly];
  }
  return Object.freeze({mode,wallet:wallet.toBase58(),sequence:input.sequence,day:input.day,root,totalCumulative:input.totalCumulative,transactions:Object.freeze(transactions),signingAuthorized:false,broadcastAuthorized:false});
 }catch(e){if(e instanceof MiningClaimMessageError)throw e;if(e&&typeof e==='object'&&'code'in e&&e.code==='IDENTITY')throw new MiningClaimMessageError('IDENTITY');throw new MiningClaimMessageError('INPUT');}
}
