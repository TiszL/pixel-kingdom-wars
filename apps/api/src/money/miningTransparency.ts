/** Read-only mining backing disclosure. Never changes custodial payout coverage. */
import { keepAta } from '@shardkeep/chain';
import { createMiningBackingSnapshotReader,type MiningBackingReader,type MiningBackingTrust } from '@shardkeep/chain/mining-backing';
import { TOKEN } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { EconomyChainBinding } from './economyIdentity';
import { assertPhaseEKeepIdentity, type PhaseEKeepIdentity } from './phaseEKeepIdentity';

// Public-read transport/cache bounds; no game economics. Scope is one factory,
// including its database, fixed identity, and trusted reader configuration.
const DEADLINE_MS=5_000,SUCCESS_TTL_MS=60_000,FAILURE_TTL_MS=15_000;
type Reason='CONFIGURATION'|'DATABASE_IDENTITY'|'BACKING_UNAVAILABLE'|'IDENTITY'|'TIMEOUT';
const unavailable=(reason:Reason)=>Object.freeze({status:'unavailable' as const,reason});
export interface MiningTransparencySources{
 readonly economy:EconomyChainBinding;
 readonly phaseE?:PhaseEKeepIdentity;
 readonly expectedGenesisHash:string;
 readonly hotWallet:string;
 readonly source:MiningBackingReader|((signal:AbortSignal)=>MiningBackingReader);
 readonly trust:MiningBackingTrust;
}
function address(value:string):string{if(typeof value!=='string'||value.length>44)throw Error('address');const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default))throw Error('address');return value;}
function copyKey(value:PublicKey):PublicKey{return new PublicKey(address(value.toBase58()));}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Application-owned source only: the callable accepts no wallet, amount,
 * claimed snapshot, alternate mint, or alleged backing from a request body. */
export function createMiningTransparencyReader(db:Db,input:MiningTransparencySources){
 let settings:{economy:EconomyChainBinding;phaseE:PhaseEKeepIdentity|undefined;genesis:string;hotAta:string;trust:MiningBackingTrust;source:MiningTransparencySources['source']}|null=null;
 try{
  const economy={...input.economy};
  const phaseE=input.phaseE?Object.freeze({...input.phaseE,economyDeployment:Object.freeze({...input.phaseE.economyDeployment})}):undefined;
  if(!['devnet','mainnet-beta'].includes(economy.cluster))throw Error('cluster');
  for(const key of ['keepMint','coreProgram','configPda'] as const)address(economy[key]);
  const genesis=address(input.expectedGenesisHash),hot=address(input.hotWallet);
  const trust={...input.trust,programId:copyKey(input.trust.programId),keepMint:copyKey(input.trust.keepMint),reserveOwner:copyKey(input.trust.reserveOwner)};
  if(trust.expectedGenesisHash!==genesis||trust.keepMint.toBase58()!==(phaseE?.keepMint??economy.keepMint))throw Error('identity');
  if(phaseE&&(phaseE.cluster!==economy.cluster||phaseE.genesisHash!==genesis||phaseE.economyProgram!==trust.programId.toBase58()
   ||phaseE.reserveOwner!==trust.reserveOwner.toBase58()||phaseE.economyDeployment.reviewedDeploymentSlot!==trust.reviewedDeploymentSlot
   ||phaseE.economyDeployment.reviewedProgramDataSha256!==trust.reviewedProgramDataSha256))throw Error('identity');
  const hotAta=keepAta(new PublicKey(hot),trust.keepMint,true).toBase58();
  settings={economy,phaseE,genesis,hotAta,trust,source:input.source};
 }catch{settings=null;}
 async function observe(signal:AbortSignal){
  if(!settings)return unavailable('CONFIGURATION');const {economy,phaseE,genesis,hotAta,trust,source}=settings;
  let reserveOwner:string,reserveAta:string;
  if(phaseE){
   try{const row=await assertPhaseEKeepIdentity(db,phaseE);reserveOwner=row.reserveOwner;reserveAta=row.reserveAta;}
   catch{signal.throwIfAborted();return unavailable('DATABASE_IDENTITY');}
  }else{
   const [row]=await db.execute<{cluster:string;keep_mint:string;core_program:string;config_pda:string;gems_reserve_owner:string|null;gems_reserve_ata:string|null}>(sql`
   select cluster,keep_mint,core_program,config_pda,gems_reserve_owner,gems_reserve_ata from public.economy_chain_identity where singleton=true`);
   if(!row||row.cluster!==economy.cluster||row.keep_mint!==economy.keepMint||row.core_program!==economy.coreProgram||row.config_pda!==economy.configPda
   ||row.gems_reserve_owner!==trust.reserveOwner.toBase58()||row.gems_reserve_ata===null)return unavailable('DATABASE_IDENTITY');
   reserveOwner=row.gems_reserve_owner;reserveAta=row.gems_reserve_ata;
  }
  signal.throwIfAborted();
  let snapshot;
  try{snapshot=await createMiningBackingSnapshotReader(typeof source==='function'?source(signal):source,trust)();}
  catch{signal.throwIfAborted();return unavailable('BACKING_UNAVAILABLE');}
  signal.throwIfAborted();const c=snapshot.config;
  if(snapshot.source.genesisHash!==genesis||c.keepMint!==(phaseE?.keepMint??economy.keepMint)||c.emissionReserveOwner!==reserveOwner||c.emissionReserveAta!==reserveAta
   ||new Set([hotAta,c.miningVault,c.emissionReserveAta]).size!==3)return unavailable('IDENTITY');
  // Snapshot amounts already subtract the persistent player/tax highwaters,
  // including revoked-root rights and undistributed original-term tax holds.
  // Reserve holdings and recycledTotal are not additional funded vault assets.
  return freeze({status:'available' as const,cluster:economy.cluster,genesisHash:genesis,mint:c.keepMint,decimals:TOKEN.decimals,
   commitment:'finalized' as const,slot:snapshot.slot,chainUnixTimestamp:snapshot.unixTimestamp.toString(),
   vault:{account:c.miningVault,owner:c.address,balanceBaseUnits:snapshot.vaultAmount.toString()},
   liabilities:{playerBaseUnits:snapshot.playerOutstanding.toString(),taxBaseUnits:snapshot.taxOutstanding.toString(),totalBaseUnits:snapshot.totalOutstanding.toString()},
   unallocatedVaultBaseUnits:snapshot.availableBudget.toString(),
   emissionReserve:{account:c.emissionReserveAta,owner:c.emissionReserveOwner,balanceBaseUnits:snapshot.reserveAmount.toString(),countsAsMiningBacking:false as const},
   source:snapshot.source,custodialCoverageAffected:false as const,publicationAuthorized:false as const,claimsAuthorized:false as const});
 }
 type Result=Awaited<ReturnType<typeof observe>>;
 let cache:{at:number;result:Result}|null=null,flight:Promise<Result>|null=null,sourcePending:Promise<Result>|null=null;
 return function read():Promise<Result>{
  const now=performance.now();if(cache&&now-cache.at<(cache.result.status==='available'?SUCCESS_TTL_MS:FAILURE_TTL_MS))return Promise.resolve(cache.result);
  if(flight)return flight;
  // A non-cooperative transport may ignore abort. Never fan out new work while
  // its old request remains pending, and never admit its eventual late result.
  if(sourcePending)return Promise.resolve(unavailable('TIMEOUT'));
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const pending=observe(controller.signal).catch(()=>unavailable(controller.signal.aborted?'TIMEOUT':'BACKING_UNAVAILABLE'));
  sourcePending=pending;
  void pending.then(()=>{if(sourcePending===pending)sourcePending=null;});
  flight=Promise.race([pending,new Promise<Result>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable('TIMEOUT'));},DEADLINE_MS);})])
   .then(result=>{cache={at:performance.now(),result};return result;})
   .finally(()=>{if(timer!==undefined)clearTimeout(timer);controller.abort();flight=null;});
  return flight;
 };
}
export type MiningTransparency=Awaited<ReturnType<ReturnType<typeof createMiningTransparencyReader>>>;
