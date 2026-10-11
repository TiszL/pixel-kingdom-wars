/** Original publication/funding evidence from an application-owned finalized RPC.
 * Trust includes the configured genesis and reviewed ProgramData revision. This
 * does not prove fair scores, tax beneficiaries, or authority to claim today.
 * No signing, broadcasting, DB access or fallback to unfinalized evidence. */
import { createHash } from 'node:crypto';
import { ComputeBudgetProgram,PublicKey,SystemProgram,VersionedTransaction,type VersionedTransactionResponse } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { TOKEN,PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { buildPublishMiningInstruction,decodeMiningConfig,decodeMiningEpoch,decodeMiningRoot,miningConfigPda,miningEpochPda,miningRootPda,type MiningProgramIdentity,type MiningRawAccount,type PublishMiningInput } from './miningProgramProtocol';
import { decodeUpgradeableProgramDataAddress,decodeProgramDataUpgradeAuthority } from './registryAttestation';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),U64=(1n<<64n)-1n;
// Operational limits: a single Solana packet, one publication plus two budget
// instructions, and the reviewed executable account; not economic policy.
const MAX_WIRE=1232,MAX_KEYS=32,MAX_PROGRAM_DATA=8*1024*1024,MAX_INNER=16;
type Code='INPUT'|'UNAVAILABLE'|'TRANSACTION'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'ECONOMICS';
export class MiningPublicationReceiptError extends Error {constructor(readonly code:Code){super(`Mining publication receipt refused: ${code}`);this.name='MiningPublicationReceiptError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningPublicationReceiptError(code);}
const digest=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function key(v:PublicKey):PublicKey{need(v&&typeof v.toBytes==='function','INPUT');const b=v.toBytes();need(b.length===32,'INPUT');return new PublicKey(b);}
function address(v:string):string{need(typeof v==='string'&&v.length<=44,'INPUT');const p=new PublicKey(v);need(p.toBase58()===v,'INPUT');return v;}
function signature(v:string):string{need(typeof v==='string'&&v.length<=88,'INPUT');const b=bs58.decode(v);need(b.length===64&&b.some(x=>x!==0)&&bs58.encode(b)===v,'INPUT');return v;}
function slot(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;}
function amount(v:unknown):bigint{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'ECONOMICS');const n=BigInt(v);need(n<=U64,'ECONOMICS');return n;}
export interface MiningPublicationReader {
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(MiningRawAccount|null)[]}>;
}
export interface MiningPublicationTrust extends MiningProgramIdentity {
 readonly expectedGenesisHash:string;
 readonly reviewedDeploymentSlot:number;
 /** SHA-256 of the entire reviewed ProgramData account, including metadata. */
 readonly reviewedProgramDataSha256:string;
}
export interface MiningPublicationRequest {readonly signature:string;readonly signedTransaction:Uint8Array;readonly signer:PublicKey;readonly args:PublishMiningInput}
export function createMiningPublicationReceiptVerifier(reader:MiningPublicationReader,trust:MiningPublicationTrust){
 // Snapshot application configuration once; request data cannot change this authority.
 const identity={programId:key(trust.programId),keepMint:key(trust.keepMint),reserveOwner:key(trust.reserveOwner)};
 const genesis=address(trust.expectedGenesisHash),deployment=trust.reviewedDeploymentSlot,programHash=trust.reviewedProgramDataSha256;
 need(slot(deployment)&&typeof programHash==='string'&&/^[0-9a-f]{64}$/.test(programHash),'INPUT');
 const configAddress=miningConfigPda(identity.programId),programDataAddress=PublicKey.findProgramAddressSync([identity.programId.toBuffer()],LOADER)[0];
 const vault=getAssociatedTokenAddressSync(identity.keepMint,configAddress,true),reserve=getAssociatedTokenAddressSync(identity.keepMint,identity.reserveOwner,true);
 return async function verify(request:MiningPublicationRequest){
  try{
   need(request&&Object.keys(request).sort().join(',')==='args,signature,signedTransaction,signer','INPUT');
   need(request.signedTransaction instanceof Uint8Array&&request.signedTransaction.length>0&&request.signedTransaction.length<=MAX_WIRE,'INPUT');
   const wire=Buffer.from(request.signedTransaction),sig=signature(request.signature),signer=key(request.signer);
   const expected=buildPublishMiningInstruction(identity,{signer,args:request.args});
   const a={...request.args,root:Buffer.from(request.args.root),sourceHash:Buffer.from(request.args.sourceHash),taxCommitment:Buffer.from(request.args.taxCommitment)};
   const original=VersionedTransaction.deserialize(wire),messageBytes=Buffer.from(original.message.serialize());
   need(Buffer.from(original.serialize()).equals(wire)&&(original.version==='legacy'||original.version===0),'INPUT');
   need(original.signatures.length===original.message.header.numRequiredSignatures&&original.signatures.length>=1&&original.signatures.length<=2,'INPUT');
   const originalSignatures=original.signatures.map(s=>signature(bs58.encode(s)));need(originalSignatures[0]===sig,'INPUT');
   need(await reader.getGenesisHash()===genesis,'IDENTITY');
   const tx=await reader.getTransaction(sig,{commitment:'finalized',maxSupportedTransactionVersion:0});
   // Slot equality cannot establish whether publication preceded that upgrade.
   need(tx&&tx.meta&&tx.meta.err===null&&slot(tx.slot)&&tx.slot>deployment&&slot(tx.blockTime),'TRANSACTION');
   need((tx.version===undefined||tx.version==='legacy'||tx.version===0)&&tx.transaction&&tx.transaction.message,'TRANSACTION');
   const message=tx.transaction.message;
   need(Array.isArray(message.staticAccountKeys)&&message.staticAccountKeys.length<=MAX_KEYS&&Array.isArray(message.compiledInstructions)&&message.compiledInstructions.length<=3,'TRANSACTION');
   for(const ix of message.compiledInstructions)need(ix.data instanceof Uint8Array&&ix.data.length<=MAX_WIRE&&ix.accountKeyIndexes.length<=MAX_KEYS,'TRANSACTION');
   need(message.version===original.version&&(tx.version===undefined||tx.version===message.version)&&Buffer.from(message.serialize()).equals(messageBytes),'TRANSACTION');
   need(Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===originalSignatures.length&&tx.transaction.signatures.every((s,i)=>s===originalSignatures[i]),'TRANSACTION');
   const loaded=tx.meta.loadedAddresses;
   need(!loaded||(Array.isArray(loaded.writable)&&Array.isArray(loaded.readonly)&&loaded.writable.length+loaded.readonly.length<=MAX_KEYS),'TRANSACTION');
   if(message.version==='legacy')need(!loaded||loaded.writable.length+loaded.readonly.length===0,'TRANSACTION');
   else need(loaded&&loaded.writable.length===message.addressTableLookups.reduce((n,l)=>n+l.writableIndexes.length,0)&&loaded.readonly.length===message.addressTableLookups.reduce((n,l)=>n+l.readonlyIndexes.length,0),'TRANSACTION');
   const keys=message.getAccountKeys({accountKeysFromLookups:loaded??null});need(keys.length>0&&keys.length<=MAX_KEYS,'TRANSACTION');
   const strings=Array.from({length:keys.length},(_,i)=>key(keys.get(i)!).toBase58());need(new Set(strings).size===strings.length,'TRANSACTION');
   const at=(n:number)=>{need(Number.isInteger(n)&&n>=0&&n<strings.length,'TRANSACTION');return strings[n]!;};
   need(message.compiledInstructions.length>=1&&message.compiledInstructions.length<=3,'TRANSACTION');
   let publicationIndex=-1;const budgetTags=new Set<number>();
   for(const [i,ix] of message.compiledInstructions.entries()){
    if(at(ix.programIdIndex)===ComputeBudgetProgram.programId.toBase58()){
     const data=Buffer.from(ix.data),tag=data[0];need(ix.accountKeyIndexes.length===0&&((tag===2&&data.length===5)||(tag===3&&data.length===9))&&!budgetTags.has(tag),'TRANSACTION');budgetTags.add(tag);continue;
    }
    need(publicationIndex===-1&&at(ix.programIdIndex)===identity.programId.toBase58()&&Buffer.from(ix.data).equals(expected.data)&&ix.accountKeyIndexes.length===expected.keys.length,'TRANSACTION');
    for(const [j,k] of expected.keys.entries()){const n=ix.accountKeyIndexes[j]!;need(at(n)===k.pubkey.toBase58()&&message.isAccountSigner(n)===k.isSigner&&message.isAccountWritable(n)===k.isWritable,'TRANSACTION');}
    publicationIndex=i;
   }
   need(publicationIndex>=0,'TRANSACTION');
   const epochAddress=miningEpochPda(identity.programId,a.day),rootAddress=miningRootPda(identity.programId,a.sequence);
   const addresses=[configAddress,epochAddress,rootAddress,identity.programId,programDataAddress];
   const response=await reader.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized',minContextSlot:tx.slot});
   const horizon=await reader.getSlot('finalized');need(slot(horizon)&&response&&slot(response.context?.slot)&&response.context.slot>=tx.slot&&response.context.slot<=horizon,'ACCOUNTS');
   need(await reader.getGenesisHash()===genesis,'IDENTITY');
   need(Array.isArray(response.value)&&response.value.length===addresses.length,'ACCOUNTS');
   const rows=response.value.map((r,i)=>{need(r&&key(r.address).equals(addresses[i]!),'ACCOUNTS');return r;});
   const program=rows[3]!,programData=rows[4]!;
   need(key(program.owner).equals(LOADER)&&program.executable===true&&program.data instanceof Uint8Array&&program.data.length===36&&decodeUpgradeableProgramDataAddress(Buffer.from(program.data)).equals(programDataAddress),'DEPLOYMENT');
   need(key(programData.owner).equals(LOADER)&&programData.executable===false&&programData.data instanceof Uint8Array&&programData.data.length>=45&&programData.data.length<=MAX_PROGRAM_DATA,'DEPLOYMENT');
   const pd=Buffer.from(programData.data);decodeProgramDataUpgradeAuthority(pd);
   need(pd.readBigUInt64LE(4)===BigInt(deployment)&&digest(pd)===programHash,'DEPLOYMENT');
   const c=decodeMiningConfig(rows[0]!,identity),e=decodeMiningEpoch(rows[1]!,{programId:identity.programId,day:a.day}),r=decodeMiningRoot(rows[2]!,{programId:identity.programId,sequence:a.sequence});
   need(e.budgetGross===a.budgetGross&&e.freeGross===a.freeGross&&e.deedGross===a.deedGross&&e.sourceHash===a.sourceHash.toString('hex')&&e.taxCommitment===a.taxCommitment.toString('hex')&&e.taxVersion===a.taxVersion,'ACCOUNTS');
   need(r.root===a.root.toString('hex')&&r.totalCumulative===a.totalCumulative&&r.leafCount===a.leafCount&&r.kind===a.kind&&r.day===a.day&&r.publishedAt===e.fundedAt&&r.prevDay<r.day&&e.fundedAt/BigInt(POLICY.daySec)>e.day,'ACCOUNTS');
   const gross=e.freeGross+e.deedGross,freeCap=e.budgetGross*BigInt(PHASE_E_POLICY.mining.freePoolBps)/10000n;
   need(e.budgetGross>0n&&e.budgetGross<=BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals)&&e.freeGross<=freeCap&&e.deedGross<=e.budgetGross-freeCap&&gross<=e.budgetGross&&e.taxVersion>0,'ECONOMICS');
   need(e.splitStart<POLICY.splitPeriod&&e.splitEnd<POLICY.splitPeriod,'ECONOMICS');
   const period=BigInt(POLICY.splitPeriod),whole=gross/period,tail=Number(gross%period);let player=whole*BigInt(POLICY.splitPlayerUnits),recycle=whole*BigInt(POLICY.splitRecycleUnits),tax=whole*BigInt(POLICY.splitTaxUnits);
   for(let i=0;i<tail;i++){const cursor=(e.splitStart+i)%POLICY.splitPeriod;if(cursor<POLICY.splitPlayerUnits)player++;else if(cursor<POLICY.splitPlayerUnits+POLICY.splitRecycleUnits)recycle++;else tax++;}
   need(e.splitEnd===(e.splitStart+tail)%POLICY.splitPeriod&&e.playerNet===player&&e.recycle===recycle&&e.tax===tax&&r.prevTotal+player===r.totalCumulative,'ECONOMICS');
   need(c.latestSequence>=a.sequence&&c.totalPublishedHighwater>=r.totalCumulative&&c.taxHighwater>=tax&&c.recycledTotal>=recycle&&c.grossPublished>=gross,'ACCOUNTS');
   const tokenAmount=(phase:'preTokenBalances'|'postTokenBalances',account:PublicKey,owner:PublicKey)=>{
    const balances=tx.meta![phase];need(Array.isArray(balances)&&balances.length===2,'ECONOMICS');
    const matches=balances.filter(b=>at(b.accountIndex)===account.toBase58());need(matches.length===1,'ECONOMICS');const b=matches[0]!;
    need(b.mint===identity.keepMint.toBase58()&&b.owner===owner.toBase58()&&b.programId===TOKEN_PROGRAM_ID.toBase58()&&b.uiTokenAmount?.decimals===TOKEN.decimals,'ECONOMICS');return amount(b.uiTokenAmount.amount);
   };
   const vaultBefore=tokenAmount('preTokenBalances',vault,configAddress),vaultAfter=tokenAmount('postTokenBalances',vault,configAddress),reserveBefore=tokenAmount('preTokenBalances',reserve,identity.reserveOwner),reserveAfter=tokenAmount('postTokenBalances',reserve,identity.reserveOwner);
   need(vaultBefore>=a.budgetGross&&vaultBefore-vaultAfter===recycle&&reserveAfter-reserveBefore===recycle,'ECONOMICS');
   need(Array.isArray(tx.meta.innerInstructions)&&tx.meta.innerInstructions.length<=3,'TRANSACTION');let tokenCalls=0,innerCount=0;
   for(const group of tx.meta.innerInstructions){need(group.index===publicationIndex&&Array.isArray(group.instructions),'TRANSACTION');for(const ix of group.instructions){need(++innerCount<=MAX_INNER,'TRANSACTION');const programId=at(ix.programIdIndex);if(programId===SystemProgram.programId.toBase58())continue;
    need(programId===TOKEN_PROGRAM_ID.toBase58()&&typeof ix.data==='string'&&ix.data.length<=32,'TRANSACTION');const data=bs58.decode(ix.data);
    need(recycle>0n&&++tokenCalls===1&&data.length===10&&data[0]===12&&Buffer.from(data).readBigUInt64LE(1)===recycle&&data[9]===TOKEN.decimals&&ix.accounts.length===4&&ix.accounts.map(at).join(',')===[vault,identity.keepMint,reserve,configAddress].map(k=>k.toBase58()).join(','),'ECONOMICS');
   }}
   need(tokenCalls===(recycle>0n?1:0),'ECONOMICS');
   return Object.freeze({version:1 as const,trust:'trusted-finalized-rpc-reviewed-program' as const,genesisHash:genesis,programId:identity.programId.toBase58(),reviewedDeploymentSlot:deployment,reviewedProgramDataSha256:programHash,
    signature:sig,slot:tx.slot,blockTime:tx.blockTime,observedAccountSlot:response.context.slot,originalMessageSha256:digest(messageBytes),signedTransactionSha256:digest(wire),
    config:configAddress.toBase58(),epoch:epochAddress.toBase58(),allocationRoot:rootAddress.toBase58(),mint:identity.keepMint.toBase58(),reserveAta:reserve.toBase58(),day:a.day,sequence:a.sequence,root:r.root,sourceHash:e.sourceHash,
    totalCumulative:r.totalCumulative,budgetGross:e.budgetGross,freeGross:e.freeGross,deedGross:e.deedGross,playerNet:e.playerNet,tax:e.tax,recycle:e.recycle,taxCommitment:e.taxCommitment,taxVersion:e.taxVersion,splitStart:e.splitStart,splitEnd:e.splitEnd,fundedAt:e.fundedAt,
    currentClaimsAuthorized:false as const,scoreFairnessVerified:false as const});
  }catch(error){if(error instanceof MiningPublicationReceiptError)throw error;throw new MiningPublicationReceiptError('UNAVAILABLE');}
 };
}
export type MiningPublicationReceipt=Awaited<ReturnType<ReturnType<typeof createMiningPublicationReceiptVerifier>>>;
