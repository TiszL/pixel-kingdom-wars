/** Current claimant facts from ONE finalized bank. No leaf, proof, entitlement,
 * signing or send authority is accepted or inferred by this reader. */
import { createHash } from 'node:crypto';
import { PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { ACCOUNT_SIZE,MINT_SIZE,AccountLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PHASE_E_POLICY as POLICY,PHASE_E_MINING_PUBLICATION as SPLIT,TOKEN } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader,MiningBackingSnapshotError,type MiningBackingTrust } from './miningBackingSnapshot';
import { decodeMiningRoot,decodeMiningEpoch,decodeMinerClaim,decodeRenownRecord,MiningProgramProtocolError,MINING_ACCOUNT_BYTES,miningConfigPda,miningRootPda,miningEpochPda,minerClaimPda,renownRecordPda,type MiningRawAccount } from './miningProgramProtocol';
import { MINING_ALLOCATION_MAX_LEAVES,MINING_ALLOCATION_U64_MAX as U64 } from './miningAllocationProof';
import { SEEKER_TERM_ACCOUNT_BYTES } from './seekerTermAccounts';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),MAX_PROGRAM_DATA=8*1024*1024;
type Code='INPUT'|'UNAVAILABLE'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'TOKEN'|'INSOLVENT';
export class MiningClaimSnapshotError extends Error{constructor(readonly code:Code){super(`Mining claim snapshot refused: ${code}`);this.name='MiningClaimSnapshotError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningClaimSnapshotError(code);}
function key(v:PublicKey):PublicKey{try{need(v&&typeof v.toBytes==='function','INPUT');const bytes=v.toBytes();need(bytes instanceof Uint8Array&&bytes.length===32,'INPUT');return new PublicKey(bytes);}catch{throw new MiningClaimSnapshotError('INPUT');}}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const digest=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function lamports(v:unknown):bigint{if(typeof v==='bigint'){need(v>=0n&&v<=U64,'ACCOUNTS');return v;}need(slot(v),'ACCOUNTS');return BigInt(v);}
export interface MiningClaimRawAccount extends MiningRawAccount{readonly lamports?:number|bigint}
export interface MiningClaimSnapshotReader{
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(MiningClaimRawAccount|null)[]}>;
}
export type MiningClaimSnapshotTrust=MiningBackingTrust;
export interface MiningClaimSnapshotInput{readonly wallet:PublicKey;readonly sequence:bigint;readonly day:bigint}
export interface MiningClaimSnapshotOptions{
 /** Application-owned choice. Historical account facts cannot admit a new claim. */
 readonly claimantAccountPolicy?:'admission'|'historical';
}

export function createMiningClaimSnapshotReader(reader:MiningClaimSnapshotReader,inputTrust:MiningClaimSnapshotTrust,options:MiningClaimSnapshotOptions={}){
 try{
 need(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(k=>k==='claimantAccountPolicy')
  &&(options.claimantAccountPolicy===undefined||options.claimantAccountPolicy==='admission'||options.claimantAccountPolicy==='historical'),'INPUT');
 const historical=options.claimantAccountPolicy==='historical';
 const trust={...inputTrust,programId:key(inputTrust.programId),keepMint:key(inputTrust.keepMint),reserveOwner:key(inputTrust.reserveOwner)};
 need(typeof trust.expectedGenesisHash==='string'&&trust.expectedGenesisHash.length<=44,'INPUT');
 const genesis=new PublicKey(trust.expectedGenesisHash);need(genesis.toBase58()===trust.expectedGenesisHash&&!genesis.equals(PublicKey.default)&&slot(trust.reviewedDeploymentSlot),'INPUT');
 const config=miningConfigPda(trust.programId),vault=getAssociatedTokenAddressSync(trust.keepMint,config,true),reserve=getAssociatedTokenAddressSync(trust.keepMint,trust.reserveOwner,true);
 const programData=PublicKey.findProgramAddressSync([trust.programId.toBuffer()],LOADER)[0],authority=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],trust.programId)[0];
 const common=[config,vault,reserve,trust.keepMint,trust.programId,programData,authority,SYSVAR_CLOCK_PUBKEY];
 return async function read(request:MiningClaimSnapshotInput){
  try{
   need(request&&Object.keys(request).sort().join(',')==='day,sequence,wallet','INPUT');const wallet=key(request.wallet),{sequence,day}=request;
   need(typeof sequence==='bigint'&&sequence>0n&&sequence<=U64&&typeof day==='bigint'&&day>0n&&day<=U64,'INPUT');
   const claimantAta=getAssociatedTokenAddressSync(trust.keepMint,wallet,true),addresses=[...common,miningRootPda(trust.programId,sequence),miningEpochPda(trust.programId,day),minerClaimPda(trust.programId,wallet),renownRecordPda(trust.programId,wallet),claimantAta,wallet];
   need(await reader.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');const before=await reader.getSlot('finalized');need(slot(before)&&before>=trust.reviewedDeploymentSlot,'DEPLOYMENT');
   const response=await reader.getMultipleAccountsInfoAndContext(addresses.map(key),{commitment:'finalized',minContextSlot:before});
   need(response&&slot(response.context?.slot)&&response.context.slot>=before&&Array.isArray(response.value)&&response.value.length===14,'ACCOUNTS');const observedSlot=response.context.slot;
   const caps=[MINING_ACCOUNT_BYTES.EconomyConfig,ACCOUNT_SIZE,ACCOUNT_SIZE,MINT_SIZE,36,MAX_PROGRAM_DATA,SEEKER_TERM_ACCOUNT_BYTES.SeekerAuthority,40,MINING_ACCOUNT_BYTES.AllocationRoot,MINING_ACCOUNT_BYTES.MiningEpochReceipt,MINING_ACCOUNT_BYTES.MinerClaim,MINING_ACCOUNT_BYTES.RenownRecord,ACCOUNT_SIZE,0];
   // All lengths and keys are checked and copied before another await. Absent
   // records/accounts are facts from this bank, never synthesized zero values.
   const rows=Array.from(response.value,(r,i):MiningClaimRawAccount|null=>{
    if(r===null){need(i>=10,'ACCOUNTS');return null;}
    need(r&&r.data instanceof Uint8Array&&r.data.length<=caps[i]!&&typeof r.executable==='boolean','ACCOUNTS');
    const address=key(r.address);need(address.equals(addresses[i]!),'IDENTITY');
    return {address,owner:key(r.owner),executable:r.executable,data:Buffer.from(r.data),...(i===13?{lamports:lamports(r.lamports)}:{})};
   });
   // A permitted wallet/reserve identity may request the same ATA twice. Both
   // positions must describe the identical account, never two apparent balances.
   for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++)if(addresses[i]!.equals(addresses[j]!)){
    const a=rows[i],b=rows[j];need(a===null&&b===null||a&&b&&a.owner.equals(b.owner)&&a.executable===b.executable&&Buffer.from(a.data).equals(Buffer.from(b.data)),'ACCOUNTS');
   }
   const after=await reader.getSlot('finalized');need(slot(after)&&after>=observedSlot,'ACCOUNTS');need(await reader.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');
   // Reuse the complete accepted backing validator through a sealed adapter.
   // Every answer is drawn from this copied bank; no second provider read exists.
   const backing=await createMiningBackingSnapshotReader({getGenesisHash:async()=>trust.expectedGenesisHash,getSlot:async()=>observedSlot,
    getMultipleAccountsInfoAndContext:async(keys,options)=>{need(keys.length===common.length&&keys.every((k,i)=>k.equals(common[i]!))&&options.commitment==='finalized'&&options.minContextSlot===observedSlot,'ACCOUNTS');return {context:{slot:observedSlot},value:rows.slice(0,8)};}
   },trust)();
   const root=decodeMiningRoot(rows[8]!,{programId:trust.programId,sequence}),epoch=decodeMiningEpoch(rows[9]!,{programId:trust.programId,day}),c=backing.config,now=backing.unixTimestamp;
   need(root.day===day&&root.epoch===epoch.address&&root.sequence<=c.latestSequence&&(root.kind===0||root.kind===2)&&root.day>=c.genesisDay&&root.prevDay<root.day
    &&root.leafCount>0&&root.leafCount<=MINING_ALLOCATION_MAX_LEAVES&&root.root!=='0'.repeat(64)&&root.totalCumulative<=c.totalPublishedHighwater
    &&root.prevTotal+epoch.playerNet===root.totalCumulative&&root.publishedAt>=epoch.fundedAt&&root.publishedAt<=now&&epoch.fundedAt>=0n
    &&epoch.fundedAt/BigInt(SPLIT.daySec)>day&&epoch.sourceHash!=='0'.repeat(64)&&epoch.taxCommitment!=='0'.repeat(64)&&epoch.taxVersion>0,'ACCOUNTS');
   // Recompute the immutable epoch conservation against the accepted program
   // constants. Revocation may roll back totalPublished, never these highwaters.
   const ceiling=BigInt(POLICY.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals),freeCap=epoch.budgetGross*BigInt(POLICY.mining.freePoolBps)/BigInt(POLICY.basisPoints),gross=epoch.freeGross+epoch.deedGross;
   need(epoch.budgetGross>0n&&epoch.budgetGross<=ceiling&&epoch.freeGross<=freeCap&&epoch.deedGross<=epoch.budgetGross-freeCap&&gross<=epoch.budgetGross&&epoch.splitStart<SPLIT.splitPeriod&&epoch.splitEnd<SPLIT.splitPeriod,'ACCOUNTS');
   const cycles=gross/BigInt(SPLIT.splitPeriod),tail=Number(gross%BigInt(SPLIT.splitPeriod));let player=cycles*BigInt(SPLIT.splitPlayerUnits),recycle=cycles*BigInt(SPLIT.splitRecycleUnits),tax=cycles*BigInt(SPLIT.splitTaxUnits);
   for(let i=0;i<tail;i++){const at=(epoch.splitStart+i)%SPLIT.splitPeriod;if(at<SPLIT.splitPlayerUnits)player++;else if(at<SPLIT.splitPlayerUnits+SPLIT.splitRecycleUnits)recycle++;else tax++;}
   need(epoch.playerNet===player&&epoch.recycle===recycle&&epoch.tax===tax&&epoch.splitEnd===(epoch.splitStart+tail)%SPLIT.splitPeriod
    &&tax<=c.taxHighwater&&recycle<=c.recycledTotal&&gross<=c.grossPublished,'ACCOUNTS');
   need((rows[10]===null)===(rows[11]===null),'ACCOUNTS');
   const minerClaim=rows[10]===null?null:decodeMinerClaim(rows[10]!,{programId:trust.programId,wallet}),renownRecord=rows[11]===null?null:decodeRenownRecord(rows[11]!,{programId:trust.programId,wallet});
   if(minerClaim&&renownRecord){
    need(minerClaim.lastSequence<=c.latestSequence&&renownRecord.lastSequence<=c.latestSequence&&renownRecord.lastSequence>=minerClaim.lastSequence
     &&minerClaim.claimedTotal<=c.totalClaimed&&renownRecord.renownTotal<=renownRecord.daysAttested&&minerClaim.lastClaimAt>=0n&&minerClaim.lastClaimAt<=now&&renownRecord.syncedAt>=0n&&renownRecord.syncedAt<=now,'ACCOUNTS');
    if(minerClaim.lastSequence===0n)need(minerClaim.claimedTotal===0n&&minerClaim.lastClaimAt===0n,'ACCOUNTS');
    if(renownRecord.lastSequence===0n)need(renownRecord.renownTotal===0n&&renownRecord.daysAttested===0n&&renownRecord.syncedAt===0n,'ACCOUNTS');
   }
   // A closed canonical ATA address can later receive SOL and become a plain
   // System account. Preserve that actual occupant in source.accounts while
   // representing absence of a token ATA for historical reads only.
   let balance:bigint|null=null;const occupant=rows[12];
   const ata=historical&&occupant&&occupant.owner.equals(SystemProgram.programId)&&!occupant.executable&&occupant.data.length===0?null:occupant;
   if(ata){need(ata.owner.equals(TOKEN_PROGRAM_ID)&&ata.executable===false&&ata.data.length===ACCOUNT_SIZE,'TOKEN');const token=AccountLayout.decode(Buffer.from(ata.data));
    need((historical||token.owner.equals(wallet))&&token.mint.equals(trust.keepMint)&&token.isNativeOption===0,'TOKEN');
    // Later AccountOwner reassignment, delegation, freezing or close authority
    // cannot erase payment history. The observed balance belongs to this current
    // account, not necessarily the claimant; admission remains strict by default.
    need((token.state===1||historical&&token.state===2)
     &&(token.delegateOption===0&&token.delegatedAmount===0n||historical&&token.delegateOption===1)
     &&(token.closeAuthorityOption===0||historical&&token.closeAuthorityOption===1),'TOKEN');balance=token.amount;
    if(!claimantAta.equals(vault)&&!claimantAta.equals(reserve))need(backing.vaultAmount+backing.reserveAmount+balance<=backing.mintSupply,'TOKEN');
   }
   const payer=rows[13];if(payer)need(payer.owner.equals(SystemProgram.programId)&&payer.executable===false&&payer.data.length===0,'ACCOUNTS');
   return Object.freeze({slot:observedSlot,backing,root,epoch,minerClaim,renownRecord,
    claimantAta:Object.freeze({address:claimantAta.toBase58(),exists:ata!==null,balanceBaseUnits:balance}),
    payer:Object.freeze({address:wallet.toBase58(),exists:payer!==null,lamports:payer?lamports(payer.lamports):null}),
    chainClock:Object.freeze({slot:observedSlot,unixTimestamp:now}),
    source:Object.freeze({...backing.source,accounts:Object.freeze(rows.map((r,i)=>Object.freeze(r?{address:addresses[i]!.toBase58(),exists:true,owner:r.owner.toBase58(),executable:r.executable,dataSha256:digest(r.data),...(i===13?{lamports:lamports(r.lamports).toString()}:{})}:{address:addresses[i]!.toBase58(),exists:false})))}),
    currentClaimsAuthorized:false as const});
  }catch(error){if(error instanceof MiningClaimSnapshotError)throw error;if(error instanceof MiningBackingSnapshotError)throw new MiningClaimSnapshotError(error.code);if(error instanceof MiningProgramProtocolError)throw new MiningClaimSnapshotError(error.code==='IDENTITY'?'IDENTITY':'ACCOUNTS');throw new MiningClaimSnapshotError('UNAVAILABLE');}
 };
 }catch(error){if(error instanceof MiningClaimSnapshotError)throw error;throw new MiningClaimSnapshotError('INPUT');}
}
export type MiningClaimSnapshot=Awaited<ReturnType<ReturnType<typeof createMiningClaimSnapshotReader>>>;
