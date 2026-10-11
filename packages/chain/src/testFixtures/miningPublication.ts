import { createHash } from 'node:crypto';
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import { AddressLookupTableAccount,Keypair,PublicKey,TransactionMessage,VersionedTransaction,VersionedMessage,type VersionedTransactionResponse } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { TOKEN,PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import { buildPublishMiningInstruction,miningConfigPda,miningEpochPda,miningRootPda,miningLiabilityFloor,type MiningConfigAccount,type PublishMiningInput } from '../miningProgramProtocol';
import { createMiningPublicationReceiptVerifier,type MiningPublicationReader } from '../miningPublicationReceipt';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl),pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
const le=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
function bn(v:unknown):unknown{if(typeof v==='bigint')return new BN(v.toString());if(v instanceof PublicKey)return v;if(v instanceof Uint8Array)return [...v];if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,bn(x)]));return v;}
export type MiningPublicationPriorFrontier=Pick<MiningConfigAccount,'genesisDay'|'latestDay'|'latestSequence'|'totalPublished'|'totalPublishedHighwater'|'totalClaimed'|'taxHighwater'|'taxPaid'|'recycledTotal'|'grossPublished'|'splitCursor'>;
export interface MiningPublicationFixtureOptions {
 signer?:Keypair;identity?:{programId:PublicKey;keepMint:PublicKey;reserveOwner:PublicKey};args?:PublishMiningInput;genesisHash?:string;programData?:Buffer;intentBytes?:Uint8Array;publicationSlot?:number;
 priorFrontier?:MiningPublicationPriorFrontier;
 /** Actual balances immediately before publication; defaults fund the complete
  * old liability floor plus this budget, with prior recycle in the reserve. */
 vaultBefore?:bigint;reserveBefore?:bigint;
}
const u64=(n:bigint)=>{if(typeof n!=='bigint'||n<0n||n>((1n<<64n)-1n))throw Error('Invalid mining publication fixture amount');return n;};
export async function createMiningPublicationFixture(version:'legacy'|0='legacy',options:MiningPublicationFixtureOptions={}){
 const signer=options.signer??Keypair.generate(),payer=options.intentBytes?signer:Keypair.generate(),identity=options.identity??{programId:new PublicKey(idl.address),keepMint:pk(1),reserveOwner:pk(2)};
 const args=options.args??{sequence:1n,day:100n,kind:0 as const,root:Buffer.alloc(32,3),totalCumulative:80n,leafCount:1,budgetGross:100n,freeGross:5n,deedGross:95n,sourceHash:Buffer.alloc(32,4),taxCommitment:Buffer.alloc(32,5),taxVersion:1};
 const p=options.priorFrontier;
 // Accept the relevant view of a decoded config without retaining its unrelated
 // address/authority fields or aliasing a caller's mutable fixture model.
 const prior:MiningPublicationPriorFrontier=p?{genesisDay:p.genesisDay,latestDay:p.latestDay,latestSequence:p.latestSequence,totalPublished:p.totalPublished,totalPublishedHighwater:p.totalPublishedHighwater,totalClaimed:p.totalClaimed,taxHighwater:p.taxHighwater,taxPaid:p.taxPaid,recycledTotal:p.recycledTotal,grossPublished:p.grossPublished,splitCursor:p.splitCursor}:{genesisDay:args.day-1n,latestDay:args.day-1n,latestSequence:args.sequence-1n,totalPublished:0n,totalPublishedHighwater:0n,totalClaimed:0n,taxHighwater:0n,taxPaid:0n,recycledTotal:0n,grossPublished:0n,splitCursor:0};
 if(options.priorFrontier){
  for(const [name,value] of Object.entries(prior))if(name!=='splitCursor')u64(value as bigint);
  if(!Number.isInteger(prior.splitCursor)||prior.splitCursor<0||prior.splitCursor>=POLICY.splitPeriod||prior.totalPublished>prior.totalPublishedHighwater
   ||args.sequence!==prior.latestSequence+1n||args.day<=prior.latestDay||args.day<prior.genesisDay||args.kind===0&&args.day-prior.latestDay>BigInt(POLICY.publisherMaxGapDays))throw Error('Invalid mining publication fixture predecessor');
 }
 const config=miningConfigPda(identity.programId),epoch=miningEpochPda(identity.programId,args.day),root=miningRootPda(identity.programId,args.sequence),vault=getAssociatedTokenAddressSync(identity.keepMint,config,true),reserve=getAssociatedTokenAddressSync(identity.keepMint,identity.reserveOwner,true);
 const instruction=buildPublishMiningInstruction(identity,{signer:signer.publicKey,args});
 const table=new AddressLookupTableAccount({key:pk(8),state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:50,lastExtendedSlotStartIndex:0,addresses:[config,epoch,root,vault,reserve,identity.keepMint]}});
 const builder=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:pk(9).toBase58(),instructions:[instruction]});
 const message=options.intentBytes?VersionedMessage.deserialize(options.intentBytes):version===0?builder.compileToV0Message([table]):builder.compileToLegacyMessage();
 const signed=new VersionedTransaction(message);signed.sign(signer===payer?[signer]:[signer,payer]);
 const loaded=version===0?{writable:message.addressTableLookups.flatMap(l=>[...l.writableIndexes].map(i=>table.state.addresses[i]!)),readonly:message.addressTableLookups.flatMap(l=>[...l.readonlyIndexes].map(i=>table.state.addresses[i]!))}:{writable:[],readonly:[]};
 const keys=message.getAccountKeys({accountKeysFromLookups:loaded}),index=(key:PublicKey)=>Array.from({length:keys.length},(_,i)=>i).find(i=>keys.get(i)!.equals(key))!;
 const balance=(key:PublicKey,owner:PublicKey,amount:string)=>({accountIndex:index(key),mint:identity.keepMint.toBase58(),owner:owner.toBase58(),programId:TOKEN_PROGRAM_ID.toBase58(),uiTokenAmount:{amount,decimals:TOKEN.decimals,uiAmount:null}});
 const blockTime=Number(args.day+1n)*POLICY.daySec;
 const gross=args.freeGross+args.deedGross,cycles=gross/BigInt(POLICY.splitPeriod),rest=Number(gross%BigInt(POLICY.splitPeriod));let player=cycles*BigInt(POLICY.splitPlayerUnits),recycle=cycles*BigInt(POLICY.splitRecycleUnits),tax=cycles*BigInt(POLICY.splitTaxUnits);for(let i=0;i<rest;i++){const cursor=(prior.splitCursor+i)%POLICY.splitPeriod;if(cursor<POLICY.splitPlayerUnits)player++;else if(cursor<POLICY.splitPlayerUnits+POLICY.splitRecycleUnits)recycle++;else tax++;}
 const nextFrontier:MiningPublicationPriorFrontier={genesisDay:prior.genesisDay,latestDay:args.day,latestSequence:args.sequence,totalPublished:args.totalCumulative,totalPublishedHighwater:args.totalCumulative>prior.totalPublishedHighwater?args.totalCumulative:prior.totalPublishedHighwater,totalClaimed:prior.totalClaimed,taxHighwater:prior.taxHighwater+tax,taxPaid:prior.taxPaid,recycledTotal:prior.recycledTotal+recycle,grossPublished:prior.grossPublished+gross,splitCursor:(prior.splitCursor+rest)%POLICY.splitPeriod};
 const oldFloor=miningLiabilityFloor(prior),vaultBefore=options.vaultBefore??oldFloor+args.budgetGross,reserveBefore=options.reserveBefore??prior.recycledTotal;
 const afterTokenBalance=Object.freeze({vaultAfter:u64(vaultBefore-recycle),reserveAfter:u64(reserveBefore+recycle)});
 if(options.priorFrontier||options.vaultBefore!==undefined||options.reserveBefore!==undefined){
  for(const [name,value] of Object.entries(nextFrontier))if(name!=='splitCursor')u64(value as bigint);
  u64(gross);u64(vaultBefore);u64(reserveBefore);
  if(args.totalCumulative!==u64(prior.totalPublished+player)||vaultBefore-oldFloor<args.budgetGross||afterTokenBalance.vaultAfter<miningLiabilityFloor(nextFrontier))throw Error('Incoherent mining publication fixture funding');
 }
 const tx:VersionedTransactionResponse={slot:100,blockTime,version,transaction:{message,signatures:signed.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee:0,preBalances:Array(keys.length).fill(1),postBalances:Array(keys.length).fill(1),loadedAddresses:loaded,
  preTokenBalances:[balance(vault,config,vaultBefore.toString()),balance(reserve,identity.reserveOwner,reserveBefore.toString())],postTokenBalances:[balance(vault,config,afterTokenBalance.vaultAfter.toString()),balance(reserve,identity.reserveOwner,afterTokenBalance.reserveAfter.toString())],
  innerInstructions:recycle===0n?[]:[{index:message.compiledInstructions.findIndex(ix=>keys.get(ix.programIdIndex)!.equals(identity.programId)),instructions:[{programIdIndex:index(TOKEN_PROGRAM_ID),accounts:[vault,identity.keepMint,reserve,config].map(index),data:bs58.encode(Buffer.concat([Buffer.of(12),le(recycle),Buffer.of(TOKEN.decimals)]))}]}]}};
 const bump=(seed:string,tail?:Buffer)=>PublicKey.findProgramAddressSync([Buffer.from(seed),...(tail?[tail]:[])],identity.programId)[1];
 const models=[{version:1,authority:PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],identity.programId)[0],publisher:signer.publicKey,keep_mint:identity.keepMint,mining_vault:vault,emission_reserve_owner:identity.reserveOwner,emission_reserve_ata:reserve,decimals:TOKEN.decimals,genesis_day:nextFrontier.genesisDay,latest_day:args.day,latest_sequence:args.sequence,total_published:args.totalCumulative,total_published_highwater:nextFrontier.totalPublishedHighwater,total_claimed:nextFrontier.totalClaimed,tax_highwater:nextFrontier.taxHighwater,tax_paid:nextFrontier.taxPaid,recycled_total:nextFrontier.recycledTotal,gross_published:nextFrontier.grossPublished,split_cursor:nextFrontier.splitCursor,flags:0,correction_pending:false,bump:bump('economy')},
 {version:1,config,day:args.day,budget_gross:args.budgetGross,free_gross:args.freeGross,deed_gross:args.deedGross,player_net:player,tax,recycle,source_hash:args.sourceHash,tax_commitment:args.taxCommitment,tax_version:args.taxVersion,split_start:prior.splitCursor,split_end:nextFrontier.splitCursor,funded_at:BigInt(blockTime),bump:bump('mining_epoch',le(args.day))},
 {version:1,config,epoch,sequence:args.sequence,day:args.day,prev_day:prior.latestDay,prev_total:prior.totalPublished,root:args.root,total_cumulative:args.totalCumulative,leaf_count:args.leafCount,claims_count:0n,published_at:BigInt(blockTime),revoked:false,kind:options.priorFrontier?args.kind:0,bump:bump('alloc',le(args.sequence))}];
 const names=['EconomyConfig','MiningEpochReceipt','AllocationRoot'],addresses=[config,epoch,root];
 const accounts=await Promise.all(models.map(async(m,i)=>({address:addresses[i]!,owner:identity.programId,executable:false,data:await coder.accounts.encode(names[i]!,bn(m) as object)})));
 const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),pdAddress=PublicKey.findProgramAddressSync([identity.programId.toBuffer()],loader)[0];
 const pd=options.programData?Buffer.from(options.programData):Buffer.alloc(50);if(!options.programData){pd.writeUInt32LE(3);pd.writeBigUInt64LE(90n,4);pd[49]=7;}
 const deployment=Number(pd.readBigUInt64LE(4));tx.slot=options.publicationSlot??Math.max(100,deployment+10);
 const programBytes=Buffer.alloc(36);programBytes.writeUInt32LE(2);pdAddress.toBuffer().copy(programBytes,4);
 accounts.push({address:identity.programId,owner:loader,executable:true,data:programBytes},{address:pdAddress,owner:loader,executable:false,data:pd});
 const reader:MiningPublicationReader={getGenesisHash:async()=>(options.genesisHash??pk(10).toBase58()),getTransaction:async()=>tx,getSlot:async()=>Math.max(200,deployment+110,tx.slot+100),getMultipleAccountsInfoAndContext:async()=>({context:{slot:Math.max(150,deployment+60,tx.slot+50)},value:accounts})};
 const trusted={...identity,expectedGenesisHash:(options.genesisHash??pk(10).toBase58()),reviewedDeploymentSlot:deployment,reviewedProgramDataSha256:createHash('sha256').update(pd).digest('hex')};
 const request={signature:tx.transaction.signatures[0]!,signedTransaction:signed.serialize(),signer:signer.publicKey,args};
 return {reader,trusted,request,tx,accounts,models,nextFrontier:Object.freeze(nextFrontier),afterTokenBalance,contextSlot:Math.max(150,deployment+60,tx.slot+50),fundedAt:BigInt(blockTime),async encode(i:number){accounts[i]!.data=await coder.accounts.encode(names[i]!,bn(models[i]) as object);}};
}
