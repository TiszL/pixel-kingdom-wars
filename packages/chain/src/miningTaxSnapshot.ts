/** Read-only original-term KEEP rights. Finalized provenance and a single copied
 * tax/backing bank are observations, never permission to sign, relay or pay. */
import {createHash} from 'node:crypto';
import {PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY,type Connection} from '@solana/web3.js';
import {AccountLayout,ACCOUNT_SIZE,MINT_SIZE,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PHASE_E_POLICY as P,PHASE_E_MINING_PUBLICATION as SPLIT,TOKEN} from '@shardkeep/shared';
import {createMiningBackingSnapshotReader,MiningBackingSnapshotError,type MiningBackingTrust} from './miningBackingSnapshot';
import {decodeMiningEpoch,miningConfigPda,miningEpochPda,MINING_ACCOUNT_BYTES,type MiningRawAccount} from './miningProgramProtocol';
import {decodeMiningTaxPool,decodeMiningTaxSpot,decodeMiningTaxAccrual,hashMiningTaxCommitment,miningTermTaxPoolPda,miningTaxSpotCursorPda,miningTaxEpochReceiptPda,MINING_TAX_ACCOUNT_BYTES,type MiningTaxTermIdentity} from './miningTaxProtocol';
import {readFinalizedHistoricalSeekerTerm,type SeekerTermRpc,type ReviewedSeekerTermPolicy} from './seekerTerms';
import {seekerAuthorityPda,seekerRegistryPda,seekerTermPda,seekerAuctionPda} from './seekerAuctionProtocol';
import {SEEKER_TERM_ACCOUNT_BYTES} from './seekerTermAccounts';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000,MAX_PROGRAM_DATA=8*1024*1024,U64=(1n<<64n)-1n;
type Code='INPUT'|'UNAVAILABLE'|'TIMEOUT'|'BUSY'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'TOKEN'|'INSOLVENT'|'NOT_WINNER';
export class MiningTaxSnapshotError extends Error{constructor(readonly code:Code){super(`Mining tax snapshot refused: ${code}`);this.name='MiningTaxSnapshotError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningTaxSnapshotError(code);}
function exact(v:unknown,fields:string){need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const keys=Reflect.ownKeys(v),wanted=fields.split(' ');need(keys.length===wanted.length&&keys.every(k=>typeof k==='string'&&wanted.includes(k)),'INPUT');}
function key(v:PublicKey):PublicKey{try{need(v&&typeof v.toBytes==='function'&&typeof v.toBase58==='function','INPUT');const b=v.toBytes();need(b instanceof Uint8Array&&b.length===32,'INPUT');const p=new PublicKey(b);need(p.toBase58()===v.toBase58(),'INPUT');return p;}catch{throw new MiningTaxSnapshotError('INPUT');}}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const same=(a:MiningRawAccount,b:MiningRawAccount)=>a.address.equals(b.address)&&a.owner.equals(b.owner)&&a.executable===b.executable&&Buffer.from(a.data).equals(Buffer.from(b.data));
export type MiningTaxSnapshotRpc=SeekerTermRpc&Pick<Connection,'getSlot'>;
export interface MiningTaxSnapshotTrust{readonly mining:MiningBackingTrust;readonly seeker:Omit<ReviewedSeekerTermPolicy,'round'>}
export interface MiningTaxSnapshotRequest{readonly wallet:PublicKey;readonly round:bigint;readonly spot:number}
export interface MiningTaxSnapshotOptions{readonly timeoutMs?:number;readonly maxPending?:number}

export function createMiningTaxSnapshotReader(connect:(signal:AbortSignal)=>MiningTaxSnapshotRpc,inputTrust:MiningTaxSnapshotTrust,options:MiningTaxSnapshotOptions={}){
 exact(inputTrust,'mining seeker');exact(inputTrust.mining,'programId keepMint reserveOwner expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256');
 exact(inputTrust.seeker,'programId config mint prizeOwner prizeAta genesisHash deployment stateProvenance');exact(inputTrust.seeker.deployment,'programDataAddress programDataSha256 upgradeAuthority');
 need(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(k=>k==='timeoutMs'||k==='maxPending'),'INPUT');
 const timeout=options.timeoutMs??MAX_TIMEOUT_MS,maxPending=options.maxPending??MAX_PENDING;
 need(typeof connect==='function'&&slot(timeout)&&timeout>0&&timeout<=MAX_TIMEOUT_MS&&slot(maxPending)&&maxPending>0&&maxPending<=MAX_PENDING,'INPUT');
 const mining={...inputTrust.mining,programId:key(inputTrust.mining.programId),keepMint:key(inputTrust.mining.keepMint),reserveOwner:key(inputTrust.mining.reserveOwner)};
 const s=inputTrust.seeker,seeker={...s,programId:key(s.programId),config:key(s.config),mint:key(s.mint),prizeOwner:key(s.prizeOwner),prizeAta:key(s.prizeAta),genesisHash:key(s.genesisHash),deployment:{...s.deployment}};
 need(seeker.programId.equals(mining.programId)&&seeker.genesisHash.toBase58()===mining.expectedGenesisHash&&seeker.deployment.programDataSha256===mining.reviewedProgramDataSha256&&seeker.stateProvenance==='fresh-reviewed-deployment','IDENTITY');
 // Validate copied backing trust at construction without reading a provider.
 createMiningBackingSnapshotReader({} as Parameters<typeof createMiningBackingSnapshotReader>[0],mining);
 const p=mining.programId,config=miningConfigPda(p),vault=getAssociatedTokenAddressSync(mining.keepMint,config,true),reserve=getAssociatedTokenAddressSync(mining.keepMint,mining.reserveOwner,true),pd=PublicKey.findProgramAddressSync([p.toBuffer()],LOADER)[0];
 const common=[config,vault,reserve,mining.keepMint,p,pd,seekerAuthorityPda(p),SYSVAR_CLOCK_PUBKEY];
 let pending=0;
 return async function read(value:MiningTaxSnapshotRequest){
  exact(value,'wallet round spot');const request={wallet:key(value.wallet),round:value.round,spot:value.spot};
  need(PublicKey.isOnCurve(request.wallet.toBytes())&&!request.wallet.equals(PublicKey.default)&&typeof request.round==='bigint'&&request.round>=0n&&request.round<=U64&&Number.isInteger(request.spot)&&request.spot>=0&&request.spot<P.seekerIsland.totalSpots,'INPUT');
  need(pending<maxPending,'BUSY');pending++;
  const controller=new AbortController();let calls=0,finished=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(finished&&calls===0&&!released){released=true;pending--;}};
  const active=()=>{if(controller.signal.aborted)throw new MiningTaxSnapshotError('TIMEOUT');};
  async function rpcCall<T>(fn:()=>Promise<T>):Promise<T>{active();calls++;try{const result=await fn();active();return result;}finally{calls--;release();}}
  const work=async()=>{
   const rawRpc=connect(controller.signal),captured=new Map<string,MiningRawAccount>();
   const termKey=seekerTermPda(p,seeker.config,request.round),registry=seekerRegistryPda(p),auction=seekerAuctionPda(p,seeker.config,request.spot,request.round);
   const caps=new Map<string,number>(common.map((a,i)=>[a.toBase58(),[MINING_ACCOUNT_BYTES.EconomyConfig,ACCOUNT_SIZE,ACCOUNT_SIZE,MINT_SIZE,36,MAX_PROGRAM_DATA,SEEKER_TERM_ACCOUNT_BYTES.SeekerAuthority,40][i]!]));
   caps.set(seeker.config.toBase58(),SEEKER_TERM_ACCOUNT_BYTES.AuctionConfig);caps.set(registry.toBase58(),SEEKER_TERM_ACCOUNT_BYTES.SeekerRegistry);caps.set(termKey.toBase58(),SEEKER_TERM_ACCOUNT_BYTES.SeekerTerm);
   for(let spot=0;spot<P.seekerIsland.totalSpots;spot++)caps.set(seekerAuctionPda(p,seeker.config,spot,request.round).toBase58(),SEEKER_TERM_ACCOUNT_BYTES.Auction);
   const rpc:MiningTaxSnapshotRpc={
    getGenesisHash:()=>rpcCall(()=>rawRpc.getGenesisHash()),getSlot:c=>rpcCall(()=>rawRpc.getSlot(c)),
    getMultipleAccountsInfoAndContext:async(keys,opts)=>{
     const addresses=keys.map(key);need(addresses.length<=100,'ACCOUNTS');
     const r=await rpcCall(()=>rawRpc.getMultipleAccountsInfoAndContext(addresses.map(key),opts));
     need(r&&slot(r.context?.slot)&&Array.isArray(r.value)&&r.value.length===addresses.length,'ACCOUNTS');
     const rows=r.value.map((row,i)=>{if(row===null)return null;const address=addresses[i]!,cap=caps.get(address.toBase58());need(row&&cap!==undefined&&row.data instanceof Uint8Array&&row.data.length<=cap&&typeof row.executable==='boolean','ACCOUNTS');
      const copy={...row,owner:key(row.owner),data:Buffer.from(row.data)};captured.set(address.toBase58(),{address,owner:key(copy.owner),executable:copy.executable,data:Buffer.from(copy.data)});return copy;});
     return {context:{slot:r.context.slot},value:rows};
    },
    getSignaturesForAddress:(...args)=>rpcCall(()=>rawRpc.getSignaturesForAddress(...args)),
    getTransaction:((...args:Parameters<SeekerTermRpc['getTransaction']>)=>rpcCall(()=>rawRpc.getTransaction(...args))) as SeekerTermRpc['getTransaction'],
    getBlock:((...args:Parameters<SeekerTermRpc['getBlock']>)=>rpcCall(()=>rawRpc.getBlock(...args))) as SeekerTermRpc['getBlock'],
   };
   const term=await readFinalizedHistoricalSeekerTerm(()=>rpc,{...seeker,round:request.round},{deadlineMs:timeout});active();
   need(term.deployment.deployedSlot===BigInt(mining.reviewedDeploymentSlot),'DEPLOYMENT');
   const original=term.auctions[request.spot];need(term.winnerCount>0&&original?.winner===request.wallet.toBase58(),'NOT_WINNER');
   const identity:MiningTaxTermIdentity={programId:p,config,keepMint:mining.keepMint,auctionConfig:seeker.config,term:termKey,registry,registryHash:Buffer.from(term.registryHash,'hex'),round:request.round,auctionStart:term.auctionStart,auctionEnd:term.auctionEnd,operatingStart:term.operatingStart,operatingEnd:term.operatingEnd,winnerCount:term.winnerCount};
   const provenanceClock=captured.get(SYSVAR_CLOCK_PUBKEY.toBase58());need(provenanceClock&&provenanceClock.data.length===40,'ACCOUNTS');
   const originalClock=Buffer.from(provenanceClock.data).readBigInt64LE(32);
   const immutable=[seeker.config,registry,termKey,auction],originalRows=immutable.map(a=>captured.get(a.toBase58())!);
   need(originalRows.every(Boolean),'ACCOUNTS');
   const poolKey=miningTermTaxPoolPda(p,termKey),cursorKey=miningTaxSpotCursorPda(p,poolKey,request.spot),ata=getAssociatedTokenAddressSync(mining.keepMint,request.wallet,true);
   const sec=BigInt(SPLIT.daySec),first=(term.operatingStart+sec-1n)/sec,last=term.operatingEnd/sec,days:bigint[]=[];
   for(let day=first;day<last;day++)if(day>0n&&day*sec>=term.completedAt)days.push(day);
   need(days.length<=Math.ceil(P.seekerIsland.operatingTermSec/SPLIT.daySec),'ACCOUNTS');
   const addresses=[...common,...immutable,poolKey,cursorKey,ata,request.wallet,...days.flatMap(day=>{const epoch=miningEpochPda(p,day);return [epoch,miningTaxEpochReceiptPda(p,epoch)];})];
   const extraCaps=[MINING_TAX_ACCOUNT_BYTES.MiningTaxPool,MINING_TAX_ACCOUNT_BYTES.MiningTaxSpot,ACCOUNT_SIZE,0,...days.flatMap(()=>[MINING_ACCOUNT_BYTES.MiningEpochReceipt,MINING_TAX_ACCOUNT_BYTES.MiningTaxAccrual])];
   addresses.slice(12).forEach((a,i)=>caps.set(a.toBase58(),extraCaps[i]!));
   const before=await rpc.getSlot('finalized');need(slot(before)&&BigInt(before)>=term.finality.contextSlot,'ACCOUNTS');
   const response=await rpc.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized',minContextSlot:before});
   const observedSlot=response.context.slot;need(observedSlot>=before,'ACCOUNTS');
   const rows=response.value.map((r,i)=>(r?{address:addresses[i]!,owner:key(r.owner),executable:r.executable,data:Buffer.from(r.data),...(i===15?{lamports:r.lamports}:{})}:null));
   need(rows.slice(0,12).every(Boolean),'ACCOUNTS');
   for(let i=0;i<immutable.length;i++)need(same(rows[8+i]!,originalRows[i]!),'ACCOUNTS');
   for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++)if(addresses[i]!.equals(addresses[j]!))need(rows[i]===null&&rows[j]===null||rows[i]!==null&&rows[j]!==null&&same(rows[i]!,rows[j]!),'ACCOUNTS');
   const after=await rpc.getSlot('finalized');need(slot(after)&&after>=observedSlot,'ACCOUNTS');need(await rpc.getGenesisHash()===mining.expectedGenesisHash,'IDENTITY');
   const backing=await createMiningBackingSnapshotReader({getGenesisHash:async()=>mining.expectedGenesisHash,getSlot:async()=>observedSlot,getMultipleAccountsInfoAndContext:async(keys)=>{need(keys.length===common.length&&keys.every((k,i)=>k.equals(common[i]!)),'ACCOUNTS');return {context:{slot:observedSlot},value:rows.slice(0,8)};}},mining)();
   need(backing.unixTimestamp>=originalClock&&backing.unixTimestamp>=term.completedAt,'ACCOUNTS');
   const context={identity:{programId:p,keepMint:mining.keepMint,reserveOwner:mining.reserveOwner},term:identity,config:rows[0]!};
   const pool=rows[12]===null?null:decodeMiningTaxPool(rows[12]!,context);
   need(pool!==null||rows[13]===null,'ACCOUNTS');
   const cursor=rows[13]===null?null:decodeMiningTaxSpot(rows[13]!,{...context,pool:rows[12]!,spot:request.spot,winner:request.wallet});
   let accrued=0n;
   const epochs=days.map((day,i)=>{
    const raw=rows[16+i*2],accrualRaw=rows[17+i*2];need(raw!==undefined&&accrualRaw!==undefined,'ACCOUNTS');
    if(raw===null){need(accrualRaw===null,'ACCOUNTS');return Object.freeze({day,epoch:null,accrual:null});}
    const epoch=decodeMiningEpoch(raw,{programId:p,day});
    need(epoch.taxVersion===2&&day>=backing.config.genesisDay&&day<=backing.config.latestDay&&epoch.sourceHash!=='00'.repeat(32)&&epoch.taxCommitment===Buffer.from(hashMiningTaxCommitment(identity,{day,epoch:miningEpochPda(p,day)})).toString('hex')&&epoch.fundedAt>=(day+1n)*sec&&epoch.fundedAt<=backing.unixTimestamp,'ACCOUNTS');
    const gross=epoch.freeGross+epoch.deedGross,ceiling=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals),free=epoch.budgetGross*BigInt(P.mining.freePoolBps)/BigInt(P.basisPoints);
    need(epoch.budgetGross>0n&&epoch.budgetGross<=ceiling&&epoch.freeGross<=free&&epoch.deedGross<=epoch.budgetGross-free&&gross<=epoch.budgetGross&&epoch.splitStart<SPLIT.splitPeriod&&epoch.splitEnd<SPLIT.splitPeriod,'ACCOUNTS');
    const cycles=gross/BigInt(SPLIT.splitPeriod),tail=Number(gross%BigInt(SPLIT.splitPeriod));let player=cycles*BigInt(SPLIT.splitPlayerUnits),recycle=cycles*BigInt(SPLIT.splitRecycleUnits),tax=cycles*BigInt(SPLIT.splitTaxUnits);
    for(let at=0;at<tail;at++){const index=(epoch.splitStart+at)%SPLIT.splitPeriod;if(index<SPLIT.splitPlayerUnits)player++;else if(index<SPLIT.splitPlayerUnits+SPLIT.splitRecycleUnits)recycle++;else tax++;}
    need(epoch.playerNet===player&&epoch.recycle===recycle&&epoch.tax===tax&&epoch.splitEnd===(epoch.splitStart+tail)%SPLIT.splitPeriod&&tax<=backing.config.taxHighwater&&recycle<=backing.config.recycledTotal&&gross<=backing.config.grossPublished,'ACCOUNTS');
    need(accrualRaw===null||pool!==null,'ACCOUNTS');
    const accrual=accrualRaw===null?null:decodeMiningTaxAccrual(accrualRaw,{...context,pool:rows[12]!,epoch:raw,day});
    if(accrual){need(accrual.accruedAt<=backing.unixTimestamp,'ACCOUNTS');accrued+=accrual.amount;}
    return Object.freeze({day,epoch,accrual});
   });
   need(pool===null?accrued===0n:pool.accrued===accrued,'ACCOUNTS');
   const cumulative=pool?pool.accrued/BigInt(term.winnerCount):null,claimed=cursor?.claimedTotal??0n;
   if(pool)need(pool.paid<=cumulative!*BigInt(term.winnerCount),'ACCOUNTS');
   const payer=rows[15];if(payer)need(payer.owner.equals(SystemProgram.programId)&&payer.executable===false&&payer.data.length===0&&slot(payer.lamports),'ACCOUNTS');
   let balance:bigint|null=null;const account=rows[14];if(account){need(account.owner.equals(TOKEN_PROGRAM_ID)&&!account.executable&&account.data.length===ACCOUNT_SIZE,'TOKEN');const t=AccountLayout.decode(Buffer.from(account.data));need(t.mint.equals(mining.keepMint)&&t.owner.equals(request.wallet)&&t.state===1&&t.delegateOption===0&&t.delegatedAmount===0n&&t.closeAuthorityOption===0&&t.isNativeOption===0,'TOKEN');balance=t.amount;if(!ata.equals(vault)&&!ata.equals(reserve))need(backing.vaultAmount+backing.reserveAmount+balance<=backing.mintSupply,'TOKEN');}
   return Object.freeze({wallet:request.wallet.toBase58(),spot:request.spot,term,slot:observedSlot,backing,pool,cursor,epochs:Object.freeze(epochs),entitlement:pool?Object.freeze({cumulative:cumulative!,claimed,available:cumulative!-claimed,dust:pool.accrued%BigInt(term.winnerCount)}):null,
    claimantAta:Object.freeze({address:ata.toBase58(),exists:account!==null,balanceBaseUnits:balance}),payer:Object.freeze({address:request.wallet.toBase58(),exists:payer!==null,lamports:payer?BigInt(payer.lamports!):null}),
    chainClock:Object.freeze({slot:observedSlot,unixTimestamp:backing.unixTimestamp}),claimsPaused:(backing.config.flags&1)!==0,
    source:Object.freeze({...backing.source,accounts:Object.freeze(rows.map((r,i)=>Object.freeze(r?{address:addresses[i]!.toBase58(),exists:true,owner:r.owner.toBase58(),executable:r.executable,dataSha256:hash(r.data),...(i===15?{lamports:String(r.lamports)}:{})}:{address:addresses[i]!.toBase58(),exists:false})))}),claimsAuthorized:false as const,signingAuthorized:false as const});
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxSnapshotError('TIMEOUT'));},timeout);});
  const task=work().catch(error=>{if(error instanceof MiningTaxSnapshotError)throw error;if(error instanceof MiningBackingSnapshotError)throw new MiningTaxSnapshotError(error.code);throw new MiningTaxSnapshotError('UNAVAILABLE');}).finally(()=>{finished=true;release();});
  try{return await Promise.race([task,deadline]);}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
export type MiningTaxSnapshot=Awaited<ReturnType<ReturnType<typeof createMiningTaxSnapshotReader>>>;
