/** Actual fourteen-day DB custody and finalized publication composition. All
 * account/transaction fixtures are local; history is retained rather than reset. */
import { randomUUID } from 'node:crypto';
import { Keypair,PublicKey } from '@solana/web3.js';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { createMiningBackingFixture } from '../../../../packages/chain/src/testFixtures/miningBacking';
import { createMiningPublicationFixture } from '../../../../packages/chain/src/testFixtures/miningPublication';
import { fixture as deedBank,tx as deedTx } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createInitialFreePublicationSources } from './initialFreePublication';
import { withFundedMiningFixture, type FundedMiningFixtureOptions } from './fundedMining';
import { fundedMiningTerms } from '../../../../packages/chain/src/testFixtures/fundedMiningTerms';
import { createFundedMiningPublicationPreparer,createResourceMiningPublicationPreparer } from '../../src/mining/fundedMiningAllocation';
import { projectMiningClaimEntitlements } from '../../src/mining/claimEntitlement';
import { createMiningPublicationOutbox } from '../../src/mining/publicationOutbox';
import { createMiningPublicationSettlement,createResourceMiningPublicationSettlement } from '../../src/mining/publicationSettlement';
import type { PreparedMiningPublication } from '../../src/mining/publicationPreparation';
import type { GemsFinalizedOriginWiring } from '../../src/mining/gemsFinalizedOrigins';
import type { FundedMiningAllocationSources } from '../../src/mining/fundedMiningAllocation';
import type { SeekerMiningQualificationWiring } from '../../src/mining/seekerMiningQualification';
import type { MiningClaimSnapshot } from '@shardkeep/chain/mining-claim-snapshot';
import type { createMiningClaimFixture } from '../../../../packages/chain/src/testFixtures/miningClaim';
type Base=Parameters<Parameters<typeof withFundedMiningFixture>[0]>[0];
type Backing=Awaited<ReturnType<typeof createMiningBackingFixture>>;
type Chain=Awaited<ReturnType<typeof createMiningPublicationFixture>>;
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import type { MiningContributionLine } from '@shardkeep/shared/miningContribution';
import { reserveMiningContribution } from '../../src/game/miningContributions';
import { abortPendingMiningEpoch } from '../../src/game/miningIngotReservations';
import { refreshBaseOwnership } from '../../src/game/baseOwnership';

type ReplayOptions=FundedMiningFixtureOptions&{replayFirstDay?:string;resourceClock?:()=>Date};
const args=(p:PreparedMiningPublication)=>{const d=p.publication;return {sequence:BigInt(d.sequence),day:BigInt(d.day),kind:0 as const,root:Buffer.from(d.root,'hex'),totalCumulative:BigInt(d.total),leafCount:d.leafCount,
  budgetGross:BigInt(d.budgetGross),freeGross:BigInt(d.freeGross),deedGross:BigInt(d.deedGross),sourceHash:Buffer.from(p.sourceHash,'hex'),taxCommitment:Buffer.from(d.taxCommitment,'hex'),taxVersion:d.taxVersion};};
export async function withFundedMiningReplayFixture(run:(f:Awaited<ReturnType<typeof extend>>)=>Promise<void>,options:ReplayOptions={}){return withFundedMiningFixture(async f=>run(await extend(f,options)),options);}
async function extend(f:Base,options:ReplayOptions){
  const firstDay=options.replayFirstDay??'2020-01-01',first=Date.parse(firstDay)/1000;
  const initial=await createInitialFreePublicationSources(f),signer=Keypair.generate(),identity={genesisHash:initial.backing.trust.expectedGenesisHash,programId:initial.backing.trust.programId.toBase58(),configAddress:miningConfigPda(initial.backing.trust.programId).toBase58(),keepMint:initial.backing.trust.keepMint.toBase58()};
  const terms=fundedMiningTerms({genesisHash:new PublicKey(identity.genesisHash),programId:initial.backing.trust.programId,
    programData:initial.backing.programData,programDataAddress:initial.backing.programDataAddress,upgradeAuthority:initial.backing.upgradeAuthority},firstDay);
  const id=new PublicKey(f.assetId),owner=new PublicKey(f.buyer),originalRows=[deedTx('collection',1),deedTx('mint',10,owner,id)];
  originalRows[0]!.blockTime=first-100;originalRows[1]!.blockTime=first-1;
  const seed=deedBank(originalRows,[{id,owner}]),collectionAccount=(await seed.reader.getAccountInfoAndContext()).value;
  let last:Pick<FundedReplayPublication,'chain'|'prepared'|'backing'>|null=null;
  function qualification(day:string,slot:number){
    const end=Date.parse(day)/1000+86400;
    const source=()=>{const q=deedBank(originalRows,[{id,owner}]);let reads=0;
      q.reader.getSlot.mockResolvedValue(slot+5);q.reader.getAccountInfoAndContext.mockReset().mockImplementation(async()=>({context:{slot:reads++===0?slot:slot+2},value:collectionAccount}));
      q.reader.getProgramAccounts.mockResolvedValue({context:{slot:slot+1},value:q.entries});
      q.reader.getBlockTime.mockImplementation(async n=>n===1?first-100:n===10?first-1:n>=slot&&n<=slot+5?end+n-slot:null);
      q.reader.getBlockSignatures.mockImplementation(async n=>({blockTime:n===1?first-100:n===10?first-1:end+n-slot,signatures:originalRows.filter(r=>r.slot===n).map(r=>r.transaction.signatures[0])}));
      return q.reader as unknown as DeedMiningWalletReader;};
    return {source,collection:seed.input.collection,expectedGenesisHash:seed.input.expectedGenesisHash};
  }
  async function complete(p:PreparedMiningPublication,backing:Backing){
    const original=await createMiningBackingSnapshotReader(backing.reader,backing.trust)(),request={epochId:p.epochId,attemptKey:p.attemptKey};
    const outbox=createMiningPublicationOutbox(f.conn.db,{reader:backing.reader,trust:backing.trust}),reservation=await outbox.reserveSigning(request);
    const chain=await createMiningPublicationFixture('legacy',{signer,identity:backing.trust,args:args(p),genesisHash:identity.genesisHash,programData:backing.programData,
      intentBytes:Buffer.from(p.intentHex,'hex'),priorFrontier:original.config,vaultBefore:original.vaultAmount,reserveBefore:original.reserveAmount,publicationSlot:original.slot+1});
    const signed=await outbox.acceptSigned({...request,signedTransaction:chain.request.signedTransaction});
    const settle=()=>createMiningPublicationSettlement(f.conn.db,{reader:chain.reader,trust:chain.trusted})({...request,signature:chain.request.signature,signedTransaction:chain.request.signedTransaction});
    const settlement=await settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:p.epochId});const result={prepared:p,original,reservation,signed,chain,settlement,settle,request,backing,outbox};last=result;return result;
  }
  async function completeResource(p:PreparedMiningPublication,backing:Backing){
    const original=await createMiningBackingSnapshotReader(backing.reader,backing.trust)(),request={epochId:p.epochId,attemptKey:p.attemptKey};
    const outbox=createMiningPublicationOutbox(f.conn.db,{reader:backing.reader,trust:backing.trust}),reservation=await outbox.reserveSigning(request);
    const chain=await createMiningPublicationFixture('legacy',{signer,identity:backing.trust,args:args(p),genesisHash:identity.genesisHash,programData:backing.programData,
      intentBytes:Buffer.from(p.intentHex,'hex'),priorFrontier:original.config,vaultBefore:original.vaultAmount,reserveBefore:original.reserveAmount,publicationSlot:original.slot+1});
    const signed=await outbox.acceptSigned({...request,signedTransaction:chain.request.signedTransaction});
    const settle=()=>createResourceMiningPublicationSettlement(f.conn.db,{reader:chain.reader,trust:chain.trusted,...(options.resourceClock?{resourceClock:options.resourceClock}:{})})({...request,signature:chain.request.signature,signedTransaction:chain.request.signedTransaction});
    const settlement=await settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:p.epochId});const result={prepared:p,original,reservation,signed,chain,settlement,settle,request,backing,outbox};last=result;return result;
  }
  async function stage(day:string,options:{paidQuantity?:number;freeQuantity?:number;gems?:GemsFinalizedOriginWiring;policyVersion?:1|2}={}){
    const n=(Date.parse(day)/1000-first)/86400;if(!Number.isInteger(n)||n<0||n>13)throw Error('Fourteen-day replay scope');
    if(last&&BigInt(Date.parse(day)/86400000)!==last.chain.nextFrontier.latestDay+1n)throw Error('Replay cannot skip or repeat a day');
    const stock=await f.admit(day,options),slot=3000+n*10000;
    const backing=await createMiningBackingFixture({day,genesisHash:new PublicKey(identity.genesisHash),programId:initial.backing.trust.programId,
      programData:initial.backing.programData,programDataAddress:initial.backing.programDataAddress,upgradeAuthority:initial.backing.upgradeAuthority,virginConfig:true,budgetGross:0n});
    backing.rows[3]!.data=Buffer.from(initial.backing.rows[3]!.data);
    if(last){const p=last.chain.nextFrontier;Object.assign(backing.model,{genesis_day:p.genesisDay,latest_day:p.latestDay,latest_sequence:p.latestSequence,total_published:p.totalPublished,
      total_published_highwater:p.totalPublishedHighwater,total_claimed:p.totalClaimed,tax_highwater:p.taxHighwater,tax_paid:p.taxPaid,recycled_total:p.recycledTotal,gross_published:p.grossPublished,split_cursor:p.splitCursor});
      backing.rows[1]!.data.writeBigUInt64LE(last.chain.afterTokenBalance.vaultAfter,64);backing.rows[2]!.data.writeBigUInt64LE(last.chain.afterTokenBalance.reserveAfter,64);
    }else {backing.rows[1]!.data=Buffer.from(initial.backing.rows[1]!.data);backing.rows[2]!.data=Buffer.from(initial.backing.rows[2]!.data);}
    backing.model.publisher=signer.publicKey;backing.model.flags=0;await backing.config();backing.rows[7]!.data.writeBigUInt64LE(BigInt(slot));backing.rows[7]!.data.writeBigInt64LE(BigInt(Date.parse(day)/1000+86400),32);
    backing.reader.getSlot=async()=>slot;backing.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot},value:backing.rows});
    const tax=await terms(day,slot),sources={qualification:qualification(day,slot-10),backing:{reader:backing.reader,trust:backing.trust},tax,...(options.gems?{gems:options.gems}:{})};
    const request={epochId:stock.free.receipt.epochId,day,policyVersion:options.policyVersion??1,attemptKey:randomUUID()};
    const optionsForPrepare={sources,signer:signer.publicKey,blockhashSource:()=>({getGenesisHash:async()=>identity.genesisHash,getLatestBlockhashAndContext:async()=>({context:{slot},value:{blockhash:new PublicKey(Buffer.alloc(32,n+91)).toBase58(),lastValidBlockHeight:slot+200}})})};
    const prepare=createFundedMiningPublicationPreparer(f.conn.db,optionsForPrepare);
    return {request,stock,sources,backing,tax,prepare,optionsForPrepare,publish:async()=>{const p=await prepare(request);if(p.status!=='prepared')throw Error('Funded daily source did not prepare');return complete(p,backing);}};
  }
  /** Reuse the authentic facilities/activity/source bank. The legacy opening
   * ingots are returned by the real abort writer before any native commitment. */
  async function stageResources(day:string,lines:{free:MiningContributionLine[];paid:MiningContributionLine[]},seeker?:SeekerMiningQualificationWiring,resourceOptions:{gems?:GemsFinalizedOriginWiring;policyVersion?:2|3;seedOpeningStock?:boolean;seekerEnrollment?:FundedMiningAllocationSources['seekerEnrollment'];existingWallet?:FundedMiningAllocationSources['existingWallet'];seekerAbsence?:FundedMiningAllocationSources['seekerAbsence']}={}){
    const legacy=await stage(day,{policyVersion:2,freeQuantity:1,paidQuantity:1,...(resourceOptions.gems?{gems:resourceOptions.gems}:{})});
    await abortPendingMiningEpoch(f.conn.db,{epochId:legacy.request.epochId,decisionKey:randomUUID(),reason:'fixture-native-resource-migration'},new Date(day+'T13:00:00Z'));
    const at=new Date(day+'T13:00:00Z');
    const commit=async(wallet:string,baseId:string,basket:MiningContributionLine[])=>{
      for(const line of resourceOptions.seedOpeningStock===false?[]:basket){
        if(line.resourceId==='shards'||line.resourceId==='forge_ingot'||line.resourceId==='crystal_fragment')continue;
        // Explicit disposable opening stock, not an earned-output bypass.
        if((PHASE_E_RAW_RESOURCE_IDS as readonly string[]).includes(line.resourceId))await f.conn.sql`insert into resource_stocks(base_id,resource_id,available) values(${baseId},${line.resourceId},${line.quantity}::bigint) on conflict(base_id,resource_id) do update set available=resource_stocks.available+excluded.available`;
        else await f.conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${baseId},${line.resourceId},${line.quantity}::bigint) on conflict(base_id,item_id) do update set available=crafting_stocks.available+excluded.available`;
      }
      if(baseId===f.paidBaseId){
        const [floor]=await f.conn.sql`select coalesce(max(slot),25)::text slot from deed_ownership_observations where base_id=${baseId}`;
        await refreshBaseOwnership(f.conn.db,baseId,async()=>({owner:f.buyer,slot:Number(floor!.slot)+1,collection:legacy.stock.bank.input.collection,frozen:false,delegate:null}),legacy.stock.bank.input.collection);
      }
      const command={idempotencyKey:randomUUID(),baseId,policyVersion:resourceOptions.policyVersion??2,expectedDay:day,lines:basket};
      const envelope=await reserveMiningContribution(f.conn.db,wallet,command,{...f.context,baseId},{clock:()=>at});
      if(!envelope.receipt)throw Error('Native original missing');return {command,envelope};
    };
    const free=await commit(f.wallet,f.baseId,lines.free),paid=await commit(f.buyer,f.paidBaseId,lines.paid);
    const request={...legacy.request,epochId:free.envelope.receipt!.epochId,policyVersion:resourceOptions.policyVersion??2};
    const optionsForPrepare={...legacy.optionsForPrepare,sources:{...legacy.sources,...(options.resourceClock?{resourceClock:options.resourceClock}:{}),...(seeker?{seeker}:{}),...(resourceOptions.seekerEnrollment?{seekerEnrollment:resourceOptions.seekerEnrollment}:{}),...(resourceOptions.existingWallet?{existingWallet:resourceOptions.existingWallet}:{}),...(resourceOptions.seekerAbsence?{seekerAbsence:resourceOptions.seekerAbsence}:{})}};
    const prepare=createResourceMiningPublicationPreparer(f.conn.db,optionsForPrepare);
    return {...legacy,request,free,paid,prepare,optionsForPrepare,publish:async()=>{const p=await prepare(request);if(p.status!=='prepared')throw Error('Resource daily source did not prepare');return completeResource(p,legacy.backing);}};
  }
  function acceptClaim(claim:{postSnapshot:MiningClaimSnapshot;post:Awaited<ReturnType<typeof createMiningClaimFixture>>}){
    if(!last)throw Error('Claim before publication');const s=claim.postSnapshot,c=last.chain;
    if(s.backing.config.latestSequence!==c.nextFrontier.latestSequence||s.backing.config.totalClaimed<c.nextFrontier.totalClaimed)throw Error('Claim must advance exact latest publication');
    const models=c.models.map(row=>({...row}));Object.assign(models[0]!,{total_claimed:s.backing.config.totalClaimed});Object.assign(models[2]!,{claims_count:claim.post.root.claims_count});
    last={...last,chain:{...c,contextSlot:s.backing.slot,nextFrontier:{...c.nextFrontier,totalClaimed:s.backing.config.totalClaimed},
      afterTokenBalance:{...c.afterTokenBalance,vaultAfter:s.backing.vaultAmount},models,
      accounts:[0,9,8].map(i=>({...claim.post.rows[i]!,data:Buffer.from(claim.post.rows[i]!.data)}))}};
    return last;
  }
  return {...f,identity,signer,stage,stageResources,acceptClaim,originalDeedSignatures:originalRows.map(r=>r.transaction.signatures[0]!),current:()=>last};
}
export type FundedReplayFixture=Parameters<Parameters<typeof withFundedMiningReplayFixture>[0]>[0];
export type FundedReplayPublication={prepared:PreparedMiningPublication;original:Awaited<ReturnType<ReturnType<typeof createMiningBackingSnapshotReader>>>;
 reservation:Awaited<ReturnType<ReturnType<typeof createMiningPublicationOutbox>['reserveSigning']>>;signed:Awaited<ReturnType<ReturnType<typeof createMiningPublicationOutbox>['acceptSigned']>>;
 chain:Chain;settlement:Awaited<ReturnType<ReturnType<typeof createMiningPublicationSettlement>>>;settle:()=>Promise<Awaited<ReturnType<ReturnType<typeof createMiningPublicationSettlement>>>>;
 request:{epochId:string;attemptKey:string};backing:Backing;outbox:ReturnType<typeof createMiningPublicationOutbox>};
