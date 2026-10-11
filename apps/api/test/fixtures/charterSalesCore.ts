/** One real D170→D175→SQL journey. Only upstream paid-land qualification and
 * opening SHARDS are fixture inputs; no completed Charter/Core state is seeded. */
import { MINING_PROGRAM_ADDRESS } from '@shardkeep/chain/mining-program';
import { VEHICLE_CRAFT_PROGRAM } from '@shardkeep/chain/vehicle-issuance-protocol';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import * as anchor from '../../../../programs/node_modules/@coral-xyz/anchor';
import {AddressLookupTableProgram,Ed25519Program,Keypair,PublicKey,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {expect} from 'vitest';
import {CharterClientSchema,CharterDeliverySchema,type CharterClient} from '@shardkeep/shared/charterApi';
import {prepareCharterSigning,signCharter,verifyCharterWire,type CharterSigningTrust} from '../../../web/src/lib/charter/signing';
import {createClanCharterClient} from '../../src/game/clanCharterClient';
import type {CharterClientDeliveryRpc} from '../../src/game/clanCharterClientDelivery';
import bs58 from 'bs58';
import type {FastifyInstance} from 'fastify';
import {CLANS,PHASE_E_SEEKER_AUCTION,PHASE_E_CHARTER_TRANSFER,PHASE_E_POLICY} from '@shardkeep/shared';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import {charterConfigPda,decodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import {seekerAuthorityPda} from '@shardkeep/chain/seeker-auction-protocol';
import {charterTransferConfigPda,CORE_PROGRAM} from '@shardkeep/chain/charter-transfer-protocol';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import type {CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import type {CharterTransferRpc} from '@shardkeep/chain/charter-transfer-evidence';
import {withCharterValidator,type CharterFixtureInput} from '../../../../programs/charter-local-fixture';
import type {ShardkeepEconomy} from '../../../../programs/target/types/shardkeep_economy';
import type {ShardkeepCraft} from '../../../../programs/target/types/shardkeep_craft';
import {createClanCharterSalesStore,type SaleDomain} from '../../src/db/charterSales';
import type {CharterTournamentsOptions} from '../../src/game/clanCharterTournaments';
import {createCharterCreationWorkflow,type CharterCreationWorkflowOptions,type CharterCreationWorkflowState} from '../../src/game/clanCharterCreationWorkflow';
import {createCharterCreationPreparation,type CharterIssueReceipt,type TypedCharterIssuer} from '../../src/game/clanCharterCreationPreparation';
import {createClanCharterSales,type CharterSalesOptions,type CharterSaleView,type TypedCharterSaleIssuer} from '../../src/game/clanCharterSales';
import {registerCharterCreationRoutes} from '../../src/game/clanCharterCreationRoutes';
import {registerCharterSalesRoutes} from '../../src/game/clanCharterSalesRoutes';
import {buildApp} from '../../src/app';
import {sessions} from '../../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../../src/auth/session';
import {TEST_CONFIG} from '../helpers';
import {charterSalesSigningFixture,type CharterSalesSigningFixture} from './charterSalesSigning';

const ROOT=fileURLToPath(new URL('../../../../',import.meta.url));
const ECONOMY=new PublicKey(MINING_PROGRAM_ADDRESS);
const CRAFT=new PublicKey(VEHICLE_CRAFT_PROGRAM);
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const nap=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
function need(value:unknown,why:string):asserts value{if(!value)throw Error(why);}
const pda=(program:PublicKey,seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],program)[0];
const artifacts={
 core:'69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee',
 craft:'702efa44374d473f862fb5e49bea49c87c6aec736fbc712f392939c9ca7423cd',
 economy:'1f729b39868b84cea8f2e5e8aacb13e1b317d0f7a06292bee226e6a674db532c',
 craftIdl:'8a4e3832e05e6085e30d16a9faf710a902384f34173cd797b2eee46942f63749',
 economyIdl:'e3d20bd91bcd0d2ef639878f6602656e33f798773f1a41b2b8c7e813a4247ff5',
};
// Explicit accepted purpose-9 build; unchanged D175 cases retain their original pins.
const retirementArtifacts={...artifacts,
 craft:'bc4dd28b2c4a00c73eea7e2e7eac7a8057774294c9fcd9ce8ed5716b024f8455',
 economy:'a3c0705debe2f870fd362804317ebef80e9eb2be35cb82e8375fbd40dba45423',
 craftIdl:'4acd75980bb0cacea8b9168b057a74ff7db60d13256afec05c6676a5c9985abe',
 economyIdl:'1f6e56cbf4a4280e6a88fd1a0c87bf7ee7ee5d7e0368ef93a05af2713f444f6a',
};
export interface CharterSalesCoreRetirementContext {
 fixture:CharterSalesSigningFixture;domain:SaleDomain;clanId:string;creationIntentId:string;saleId:string;saleFenceId:string;
 chain:NonNullable<CharterTournamentsOptions['chain']>;delivery:CharterClientDeliveryRpc&CharterTransferRpc;
 policy:Keypair;leader:Keypair;working:string;creation:CharterCreationWorkflowState;sale:CharterSaleView;
 deeds:(asset:string)=>Promise<Awaited<ReturnType<CharterSalesSigningFixture['source']['proof']>>|null>;
 submitExact:(label:string,wire:Buffer,lastValidBlockHeight:number,submit?:()=>Promise<void>)=>Promise<VersionedTransactionResponse>;
}
export interface CharterSalesCoreMigrationContext {
 fixture:CharterSalesSigningFixture;domain:SaleDomain;policy:Keypair;leader:Keypair;buyer:Keypair;working:string;
 chain:NonNullable<CharterCreationWorkflowOptions['chain']>;transferChain:NonNullable<CharterTournamentsOptions['chain']>;
 delivery:CharterClientDeliveryRpc&CharterTransferRpc;deeds:CharterSalesCoreRetirementContext['deeds'];
 submitExact:CharterSalesCoreRetirementContext['submitExact'];
}
export interface CharterSalesCoreTournamentContext {
 fixture:CharterSalesSigningFixture;domain:SaleDomain;clanId:string;chain:NonNullable<CharterTournamentsOptions['chain']>;
 delivery:CharterClientDeliveryRpc;trust:CharterSigningTrust;policy:Keypair;leader:Keypair;
 saleApp:FastifyInstance;sellerAuth:Record<string,string>;salesPath:string;
 submitExact:(label:string,wire:Buffer,lastValidBlockHeight:number,submit?:()=>Promise<void>)=>Promise<VersionedTransactionResponse>;
}
export interface CharterSalesCoreTournamentResult {
 epochId:string;revision:2;entryId:string;setSignature:string;clearSignature:string;verifyHistory:()=>Promise<void>;
}
export async function actualCharterSalesCoreJourney(settings:{clientFacade?:boolean;migration?:(context:CharterSalesCoreMigrationContext)=>Promise<void>;tournament?:(context:CharterSalesCoreTournamentContext)=>Promise<CharterSalesCoreTournamentResult>;retirement?:(context:CharterSalesCoreRetirementContext)=>Promise<void>}={}){
 const clientMode=settings.clientFacade===true,artifactProfile=settings.retirement||settings.migration?retirementArtifacts:artifacts;
 const corePath=process.env['PHASE_E_CHARTER_CORE_BINARY'];need(corePath,'Explicit PHASE_E_CHARTER_CORE_BINARY required; no download or skipped acceptance');
 const craftPath=resolve(ROOT,'programs/target/deploy/shardkeep_craft.so'),economyPath=resolve(ROOT,'programs/target/deploy/shardkeep_economy.so');
 const paths={core:corePath,craft:craftPath,economy:economyPath,craftIdl:resolve(ROOT,'programs/target/idl/shardkeep_craft.json'),economyIdl:resolve(ROOT,'programs/target/idl/shardkeep_economy.json')};
 const blobs=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await readFile(path)]))) as Record<keyof typeof paths,Buffer>;
 for(const key of Object.keys(paths) as (keyof typeof paths)[])need(sha(blobs[key])===artifactProfile[key],'Unreviewed Charter artifact '+key);
 const craftIdl=JSON.parse(blobs.craftIdl.toString()) as ShardkeepCraft,economyIdl=JSON.parse(blobs.economyIdl.toString()) as ShardkeepEconomy;
 const version=spawnSync('solana-test-validator',['--version'],{encoding:'utf8',timeout:10000});need(version.status===0&&/solana-test-validator 2\.3\.13/.test(version.stdout),'Pinned Agave2.3.13 required');
 const sdk=JSON.parse(await readFile(resolve(ROOT,'packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'),'utf8')).version;
 const umi=JSON.parse(await readFile(resolve(ROOT,'packages/chain/node_modules/@metaplex-foundation/umi/package.json'),'utf8')).version;
 need(sdk==='1.10.0'&&umi==='1.5.1','Pinned Core SDK and Umi required');
 const input:CharterFixtureInput={corePath,craftPath,coreBinary:blobs.core,craftBinary:blobs.craft,craft:CRAFT,
  additionalPrograms:[{id:ECONOMY,path:economyPath,binary:blobs.economy}],idlSha256:sha(Buffer.concat([blobs.craftIdl,blobs.economyIdl])),
  validatorVersion:version.stdout.trim(),coreSdkVersion:sdk,umiVersion:umi,scope:settings.migration?'Actual existing-clan registration + Core sale + permanent retirement; authentic captured legacy prefix, no repeated creation SHARDS; no release':settings.retirement?'Actual DB creation + real Core mint + sale + positive member payout + purpose-9 retirement + finalized SQL removal; upstream deed and combat-gross fixtures; no release':settings.tournament?'D181 actual creation + tournament set/clear + fresh sale through independent browser approvals and exact server delivery; fixture calendar and upstream deeds; no release':clientMode?'D180 normal client facade + independent browser approval + exact server delivery through actual Core; fixture upstream deeds; no live issuer or release':'D176 actual authenticated creation and ordinary sale; fixture upstream deed qualification; no live issuer or release'};
 await withCharterValidator(input,settings.migration?'Charter migration E2E':settings.retirement?'Charter retirement E2E':settings.tournament?'D181 client tournament':clientMode?'D180 client sale':'D176 API sale',async local=>{
  const f=await charterSalesSigningFixture(),apps:FastifyInstance[]=[];
  try{
   const {connection,payer,execute,working}=local,provider=new anchor.AnchorProvider(connection,new anchor.Wallet(payer),{commitment:'confirmed'});
   const economy=new anchor.Program<ShardkeepEconomy>(economyIdl,provider),craft=new anchor.Program<ShardkeepCraft>(craftIdl,provider);
   const policy=Keypair.generate(),treasury=Keypair.generate().publicKey,genesis=await connection.getGenesisHash();
   const domain={genesisHash:genesis,economyProgram:ECONOMY.toBase58(),craftProgram:CRAFT.toBase58(),treasury:treasury.toBase58()};
   const authority=seekerAuthorityPda(ECONOMY),config=charterConfigPda(ECONOMY),craftControl=pda(CRAFT,'charter_control'),collection=pda(CRAFT,'charter_collection'),collectionAuthority=pda(CRAFT,'charter_collection_authority');
   const craftData=PublicKey.findProgramAddressSync([CRAFT.toBytes()],LOADER)[0],economyData=PublicKey.findProgramAddressSync([ECONOMY.toBytes()],LOADER)[0];
   await execute('bootstrap',await craft.methods.initializeCharterCollection('Charters','https://invalid.example/charters.json').accountsStrict({admin:payer.publicKey,program:CRAFT,programData:craftData,config:craftControl,collection,collectionAuthority,mplCoreProgram:CORE_PROGRAM,systemProgram:SystemProgram.programId}).instruction());
   await execute('policy',await economy.methods.initializeSeekerAuthority(payer.publicKey,policy.publicKey,Array.from(new PublicKey(genesis).toBytes())).accountsStrict({admin:payer.publicKey,program:ECONOMY,programData:economyData,authority,systemProgram:SystemProgram.programId}).instruction());
   await execute('creation-config',await economy.methods.initializeCharterConfig().accountsStrict({admin:payer.publicKey,program:ECONOMY,programData:economyData,authority,config,craftProgram:CRAFT,craftControl,collection,collectionAuthority,systemProgram:SystemProgram.programId}).instruction());
   await execute('transfer-config',await economy.methods.initializeCharterTransferConfig(treasury).accountsStrict({admin:payer.publicKey,program:ECONOMY,programData:economyData,authority,config,transferConfig:charterTransferConfigPda(ECONOMY),systemProgram:SystemProgram.programId}).instruction());
   await execute('open-economy',await economy.methods.setAdmissionPaused(false).accountsStrict({signer:payer.publicKey,authority}).instruction());
   const opened=await execute('open-craft',await craft.methods.setCharterAdmissionPaused(false).accountsStrict({admin:payer.publicKey,program:CRAFT,programData:craftData,config:craftControl}).instruction());
   const seller=f.keys.get(f.source.wallet)!,buyer=f.keys.get(f.buyer.wallet)!;need(seller&&buyer,'Actual DB actor keys missing');
   for(const wallet of [seller.publicKey,buyer.publicKey])await execute('fund-actual-actor',SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:wallet,lamports:500_000_000}));
   async function finalized(slot:number){const deadline=Date.now()+60000;while(await connection.getSlot('finalized')<slot){need(Date.now()<deadline,'Owned finality deadline');await nap(200);}}
   await finalized(opened.slot);
   const pins=await Promise.all([ECONOMY,CRAFT,CORE_PROGRAM].map(async program=>{
    const address=PublicKey.findProgramAddressSync([program.toBytes()],LOADER)[0],row=await connection.getAccountInfo(address,'finalized');need(row,'ProgramData absent');
    return {programId:program.toBase58(),reviewedDeploymentSlot:Number(row.data.readBigUInt64LE(4)),reviewedProgramDataSha256:sha(row.data),upgradeAuthority:row.data[12]===1?new PublicKey(row.data.subarray(13,45)).toBase58():null};
   }));
   const trust:CharterCreationEvidenceTrust={expectedGenesisHash:genesis,economy:pins[0]!,craft:pins[1]!,core:pins[2]!,stateProvenance:'fresh-reviewed-deployment'};
   // Normalize SDK instances while preserving the actual RPC bytes and context.
   const rpc:CharterCreationQuoteRpc&CharterTransferRpc&CharterClientDeliveryRpc={getGenesisHash:()=>connection.getGenesisHash(),getSlot:commitment=>connection.getSlot(commitment),
    getMultipleAccountsInfoAndContext:async(addresses,options)=>{const r=await connection.getMultipleAccountsInfoAndContext(addresses,options);return {context:r.context,value:r.value.map((row,i)=>row?{address:new PublicKey(addresses[i]!.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)}:null)};},
    getAccountInfoAndContext:async(address,options)=>{const r=await connection.getAccountInfoAndContext(address,options);return {context:r.context,value:r.value?{owner:new PublicKey(r.value.owner.toBytes()),executable:r.value.executable,data:Buffer.from(r.value.data)}:null};},
    getLatestBlockhashAndContext:options=>connection.getLatestBlockhashAndContext(options),getFeeForMessage:(message,commitment)=>connection.getFeeForMessage(message,commitment),
    getMinimumBalanceForRentExemption:(bytes,commitment)=>connection.getMinimumBalanceForRentExemption(bytes,commitment),getBlockHeight:options=>connection.getBlockHeight(options),getTransaction:(signature,options)=>connection.getTransaction(signature,options),
    getSignatureStatuses:(signatures,options)=>connection.getSignatureStatuses(signatures,options),sendRawTransaction:(bytes,options)=>connection.sendRawTransaction(bytes,options)};
   const connect=(_signal:AbortSignal)=>rpc;
   let deedSlot=1000;
   const deeds=async(asset:string)=>asset===f.source.deed?f.source.proof(f.source.wallet,++deedSlot):asset===f.buyer.deed?f.buyer.proof(f.buyer.wallet,++deedSlot):null;
   const salesStore=createClanCharterSalesStore(f.db,{finalizedDeedReader:deeds,deedCollection:f.buyer.collection});
   await salesStore.initializeEpoch(domain); // Must precede the actual clan INSERT.
   const creationOptions:CharterCreationWorkflowOptions={newCreation:{domain:{genesisHash:genesis,economyProgram:domain.economyProgram,craftProgram:domain.craftProgram},metadataUriPrefix:clientMode?'https://invalid.example/'+'x'.repeat(231)+'/':'https://invalid.example/charters/'},chain:null,issuer:null,finalizedDeedReader:deeds,deedCollection:f.source.collection};
   async function session(wallet:string){const [saved]=await f.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,saved!.id)};}
   const sellerAuth=await session(f.source.wallet),buyerAuth=await session(f.buyer.wallet);
   async function open(creation:CharterCreationWorkflowOptions,sales?:CharterSalesOptions){const prior=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';
    try{const chain=sales?.chain??creation.chain,app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.db,clientMode?{charterClientProvider:createClanCharterClient(f.db,{creation,...(sales?{sales}:{}),delivery:chain?{connect,trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:chain.lookupTable}:null})}:{});apps.push(app);if(!clientMode){registerCharterCreationRoutes(app,createCharterCreationWorkflow(f.db,creation));if(sales)registerCharterSalesRoutes(app,createClanCharterSales(f.db,sales));}await app.ready();return app;}
    finally{if(prior===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=prior;}}
   const envelopes=new Map<string,CharterClient>();
   const clientPath=(url:string)=>clientMode?url.replace('/clans/charter/','/clans/charter/client/'):url;
   async function post<T>(app:FastifyInstance,url:string,payload:Record<string,unknown>={},cookies=sellerAuth,expected=200){const r=await app.inject({method:'POST',url:clientPath(url),payload,cookies});expect(r.statusCode,r.body).toBe(expected);
    if(clientMode){const envelope=CharterClientSchema.parse(r.json());envelopes.set(envelope.key,envelope);return envelope.state as T;}return r.json<T>();}
   async function provisionLookup(tableKeys:PublicKey[]){
    const [createTable,tableKey]=AddressLookupTableProgram.createLookupTable({authority:payer.publicKey,payer:payer.publicKey,recentSlot:await connection.getSlot('finalized')});await execute('lookup-create',createTable);
    for(let at=0;at<tableKeys.length;at+=20)await execute('lookup-extend-'+at,AddressLookupTableProgram.extendLookupTable({lookupTable:tableKey,authority:payer.publicKey,payer:payer.publicKey,addresses:tableKeys.slice(at,at+20)}));
    const frozen=await execute('lookup-freeze',AddressLookupTableProgram.freezeLookupTable({lookupTable:tableKey,authority:payer.publicKey}));await finalized(frozen.slot+1);
    const table=await connection.getAccountInfo(tableKey,'finalized');need(table,'Actual frozen ALT missing');return {address:tableKey.toBase58(),dataSha256:sha(table.data)};
   }
   // This real static table is frozen before the server allocates any clan/asset.
   const transactions:unknown[]=[];
   const staticLookup=clientMode||settings.migration?await provisionLookup([authority,config,charterTransferConfigPda(ECONOMY),CRAFT,craftControl,collection,collectionAuthority,CORE_PROGRAM,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,ECONOMY,treasury]):null;
   if(settings.migration){
    need(staticLookup,'Migration uses the pre-created frozen static ALT');
    const migrationChain={connect,trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:staticLookup,coreCostProfile:{version:1 as const,profile:'mpl-core-0.15.2-charter-pfd-seq-none' as const,reviewedProgramDataSha256:trust.core.reviewedProgramDataSha256},costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000000n,maxTotalLamports:101000000n}};
    const transferChain={connect,trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:staticLookup,costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000000n,maxAdditionalLamports:101000000n}};
    await settings.migration({fixture:f,domain,policy,leader:seller,buyer,working,chain:migrationChain,transferChain,delivery:rpc,deeds,submitExact});
    local.record('actual existing-clan migration→Core registration→controlled sale→retirement; stable clan and captured liabilities, no second SHARDS charge');return;
   }
   const intentId=randomUUID(),creationPath='/clans/charter/creations',creationInput={creationIntentId:intentId,baseId:f.source.baseId,name:clientMode?'X'.repeat(CLANS.nameMaxLen):'Actual Core Clan',tag:'CORE',inviteMode:'invite'};
   const fundingApp=await open(creationOptions),funded=await post<CharterCreationWorkflowState>(fundingApp,creationPath,creationInput,sellerAuth,201);
   const inventory=await f.inventory().read(f.source.wallet,intentId),original=inventory.reservation.consent,c=original.chain;
   expect(funded.original.price.shards).toBe(f.cost.toString());
   // One immutable table serves both creation and the future server-chosen sale.
   // Future permit/transfer receipts stay static; their IDs are never predicted.
   const tableKeys=[authority,...Object.entries(c).filter(([name])=>!['genesisHash'].includes(name)).map(([,value])=>new PublicKey(value)),CORE_PROGRAM,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,charterTransferConfigPda(ECONOMY),treasury]
    .filter((key,index,all)=>all.findIndex(v=>v.equals(key))===index);
   const lookupTable=staticLookup??await provisionLookup(tableKeys);
   const clientTrust:CharterSigningTrust={version:1,revision:'owned-D180-fixture',deployment:trust,policySigner:policy.publicKey.toBase58(),treasury:treasury.toBase58(),royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[lookupTable]};
   const wallet=(key:Keypair)=>({publicKey:key.publicKey,signMessage:null,sendTransaction:null,isEmbedded:false,signVersionedTransaction:async(tx:VersionedTransaction)=>{tx.sign([key]);return tx;}});
   const creationChain={connect,trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable,coreCostProfile:{version:1 as const,profile:'mpl-core-0.15.2-charter-pfd-seq-none' as const,reviewedProgramDataSha256:trust.core.reviewedProgramDataSha256},costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000000n,maxTotalLamports:101000000n}};
   const saleChain={connect,trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable,costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000000n,maxAdditionalLamports:101000000n}};
   const receipts=new Map<string,CharterIssueReceipt>(),admission=createCharterAdmissionReader(connect,trust,policy.publicKey.toBase58());let saleId:string|undefined;
   const copy=(r:CharterIssueReceipt)=>({...r,message:Buffer.from(r.message),signature:Buffer.from(r.signature)});
   async function issue(request:{kind:string;requestId:string;message:Uint8Array},signal:AbortSignal){
    const bytes=Buffer.from(request.message),prior=receipts.get(request.requestId);if(prior){need(Buffer.from(prior.message).equals(bytes),'Fixture issuer conflict');return copy(prior);}
    need(bytes.length===161&&bytes.subarray(0,8).toString()==='SKPERMT2'&&new PublicKey(bytes.subarray(8,40)).toBase58()===genesis&&new PublicKey(bytes.subarray(40,72)).equals(ECONOMY),'Fixture issuer domain');
    if(request.kind==='charter-registration-v1'){
     decodeCharterRegistrationPermit(bytes);const saved=await createCharterCreationPreparation(f.db,{chain:null,issuer:null}).read(f.source.wallet,intentId);
     need(saved?.attempt.id===request.requestId&&saved.attempt.candidateHex===bytes.toString('hex'),'Creation candidate must already be committed');
    }else{need(request.kind==='charter-transfer-v1'&&bytes[72]===1&&saleId,'Ordinary transfer only');const saved=await salesStore.read(f.source.wallet,saleId);
     need(saved.attempt?.id===request.requestId&&saved.attempt.candidateHex===bytes.toString('hex'),'Sale exposure must already be committed');}
    const observed=await admission(),expiry=bytes.readBigInt64LE(121);need(!signal.aborted&&expiry>observed.unixTimestamp&&expiry-observed.unixTimestamp<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'Fixture issuer current policy/expiry');
    const receipt={requestId:request.requestId,publicKey:policy.publicKey.toBase58(),message:bytes,signature:Buffer.from(Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:bytes}).data.subarray(48,112))};receipts.set(request.requestId,copy(receipt));return copy(receipt);
   }
   const lookup=async(id:string)=>receipts.has(id)?copy(receipts.get(id)!):null;
   const creationIssuer:TypedCharterIssuer={issueOnce:issue,lookup},saleIssuer:TypedCharterSaleIssuer={issueOnce:issue,lookup};
   const app=await open({...creationOptions,chain:creationChain,issuer:creationIssuer},{newSaleDomain:domain,chain:saleChain,issuer:saleIssuer,finalizedDeedReader:deeds,deedCollection:f.buyer.collection});
   await f.source.refresh(f.source.wallet,++deedSlot); // Real upstream qualification refresh after ALT finality wait.
   const prepared=await post<CharterCreationWorkflowState>(app,`${creationPath}/${intentId}/prepare`);need(prepared.preparation,'Creation preparation absent');
   let mintBytes:Buffer;
   if(clientMode){const envelope=envelopes.get(intentId)!;need(envelope.signing,'Client creation signing absent');const approval=await signCharter(await prepareCharterSigning(envelope.signing,clientTrust,f.source.wallet),wallet(seller));need(approval.kind==='creation','Creation approval kind');mintBytes=Buffer.from(approval.wire.signedTransaction,'base64');expect(mintBytes.length).toBe(1228);}
   else{const mintWire=VersionedTransaction.deserialize(Buffer.from(prepared.preparation.packet.unsignedTransactionHex,'hex'));mintWire.sign([seller]);mintBytes=Buffer.from(mintWire.serialize());}
   await post(app,`${creationPath}/${intentId}/signed`,{signedTransaction:mintBytes.toString('base64')});
   async function submitExact(label:string,wire:Buffer,lastValidBlockHeight:number,submit?:()=>Promise<void>){
    const expected=bs58.encode(VersionedTransaction.deserialize(wire).signatures[0]!);const entry={label,signature:expected,wireSha256:sha(wire),wireBase64:wire.toString('base64'),lastValidBlockHeight};transactions.push(entry);
    await writeFile(join(working,'api-submitted-transactions.json'),JSON.stringify(transactions,null,2),{mode:0o600});
    if(submit)await submit();
    else if(clientMode){const key=label==='creation'?intentId:saleId!,family=label==='creation'?'creations':'sales',response=await app.inject({method:'POST',url:`/clans/charter/client/${family}/${key}/deliver`,payload:{},cookies:label==='creation'?sellerAuth:buyerAuth});expect(response.statusCode,response.body).toBe(200);const delivery=CharterDeliverySchema.parse(response.json());expect(delivery.status,JSON.stringify(delivery)).toBe('submitted');expect(delivery.signature).toBe(expected);expect(delivery.original.wire!.signedTransaction).toBe(wire.toString('base64'));}
    else expect(await connection.sendRawTransaction(wire,{skipPreflight:true,maxRetries:0})).toBe(expected);
    const deadline=Date.now()+60000;for(;;){const status=(await connection.getSignatureStatuses([expected],{searchTransactionHistory:true})).value[0];
     if(status){if(status.err)await writeFile(join(working,label+'-failed.json'),JSON.stringify(await connection.getTransaction(expected,{commitment:'confirmed',maxSupportedTransactionVersion:0}),null,2),{mode:0o600});
      expect(status.err,JSON.stringify(status)).toBeNull();if(status.confirmationStatus==='finalized')break;}
     need(Date.now()<deadline&&await connection.getBlockHeight('confirmed')<=lastValidBlockHeight,'Exact submitted packet expired or finality deadline');await nap(200);}
    const actual=await connection.getTransaction(expected,{commitment:'finalized',maxSupportedTransactionVersion:0});need(actual?.meta&&actual.meta.err===null,'Actual finalized transaction missing');
    await writeFile(join(working,label+'-actual.json'),JSON.stringify(actual,null,2),{mode:0o600});return actual;
   }
   const minted=await submitExact('creation',mintBytes,prepared.preparation.lastValidBlockHeight);
   await f.source.refresh(f.source.wallet,++deedSlot);
   const activated=await post<CharterCreationWorkflowState>(app,`${creationPath}/${intentId}/recover`);expect(activated.status).toBe('activated');
   const tournament=settings.tournament?await settings.tournament({fixture:f,domain,clanId:original.clanId,chain:saleChain,delivery:rpc,trust:clientTrust,policy,leader:seller,saleApp:app,sellerAuth,salesPath:clientPath('/clans/charter/sales'),submitExact}):null;
   if(tournament){await f.source.refresh(f.source.wallet,++deedSlot);await f.buyer.refresh(f.buyer.wallet,++deedSlot);}
   const [beforeClan]=await f.sql`select leader_wallet,invite_mode,invite_code from clans where id=${original.clanId}`;need(beforeClan?.invite_code,'Real invite clan secret missing');
   const salesPath='/clans/charter/sales',draft=await post<CharterSaleView>(app,salesPath,{clanId:original.clanId,buyer:f.buyer.wallet,priceLamports:'101000003',sellerLeaves:true,idempotencyKey:randomUUID()},sellerAuth,201);saleId=draft.id;
   if(tournament){expect((await salesStore.read(f.source.wallet,saleId)).original.epochId).toBe(tournament.epochId);expect(draft.original.expectedRevision).toBe(tournament.revision);}
   await post(app,`${salesPath}/${saleId}/accept`,{termsHash:draft.original.termsHash,buyerBaseId:f.buyer.baseId},buyerAuth);
   const sale=await post<CharterSaleView>(app,`${salesPath}/${saleId}/prepare`);need(sale.preparation,'Sale preparation missing');expect(sale.memberPayment?.totalShards).toBe('0');
   let saleBytes:Buffer;
   if(clientMode){
    for(const [key,cookies] of [[buyer,buyerAuth],[seller,sellerAuth]] as const){const envelope=envelopes.get(saleId)!;need(envelope.signing,'Client sale signing absent');const approval=await signCharter(await prepareCharterSigning(envelope.signing,clientTrust,key.publicKey.toBase58()),wallet(key));need(approval.kind==='sale','Sale approval kind');const {wallet:_wallet,...contribution}=approval.contribution;await post(app,`${salesPath}/${saleId}/signature`,contribution,cookies);}
    const envelope=envelopes.get(saleId)!;need(envelope.signing&&envelope.wire,'Complete original two-party wire absent');const verified=await verifyCharterWire(envelope.signing,envelope.wire);saleBytes=Buffer.from(verified.signedTransaction,'base64');
   }else{const saleWire=VersionedTransaction.deserialize(Buffer.from(sale.preparation.packet.unsignedTransactionHex,'hex'));saleWire.sign([buyer,seller]);saleBytes=Buffer.from(saleWire.serialize());await post(app,`${salesPath}/${saleId}/signed`,{signedTransaction:saleBytes.toString('base64')},buyerAuth);}
   const saved=await salesStore.read(f.source.wallet,saleId);need(saved.attempt,'Actual persisted sale attempt missing');
   const quote=saved.attempt.quote as {packetInput:{lastValidBlockHeight:number}};
   const before=await connection.getMultipleAccountsInfo([seller.publicKey,treasury,collection],'finalized');
   const sold=await submitExact('sale',saleBytes,quote.packetInput.lastValidBlockHeight);
   expect(sold.meta!.logMessages!.filter(line=>line===`Program ${CORE_PROGRAM} invoke [3]`)).toHaveLength(3);
   const complete=await post<CharterSaleView>(app,`${salesPath}/${saleId}/recover`);expect(complete.status).toBe('completed');
   const after=await connection.getMultipleAccountsInfo([seller.publicKey,treasury,collection],'finalized'),price=101000003n,royalty=price*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints);
   expect(BigInt(after[0]!.lamports-before[0]!.lamports)).toBe(price-royalty);expect(BigInt(after[1]!.lamports-(before[1]?.lamports??0))).toBe(royalty);expect(after[2]!.data).toEqual(before[2]!.data);
   const [afterClan]=await f.sql`select leader_wallet,invite_mode,invite_code from clans where id=${original.clanId}`;
   expect(afterClan).toMatchObject({leader_wallet:f.buyer.wallet,invite_mode:'invite'});expect(afterClan!.invite_code).not.toBe(beforeClan.invite_code);
   expect(await f.sql`select player_wallet from clan_members where clan_id=${original.clanId}`).toEqual([{player_wallet:f.buyer.wallet}]);
   expect(await f.sql`select id from clan_charter_member_payments where fence_id=${saved.original.fenceId}`).toHaveLength(1);
   const terminal=await salesStore.read(f.source.wallet,saleId);expect(terminal.original.creation.payer).toBe(f.source.wallet);expect(terminal.original.creation.clanId).toBe(original.clanId);
   const registry=await economy.account.clanCharter.fetch(new PublicKey(c.charter));expect(registry.leader.toBase58()).toBe(f.buyer.wallet);expect(registry.revision).toBe((tournament?.revision??0)+1);expect(registry.lockKind).toBe(0);
   await tournament?.verifyHistory();
   const offline=createClanCharterSales(f.db,{});expect(await offline.read(f.source.wallet,saleId)).toEqual(complete);
   if(clientMode){const history=await createClanCharterClient(f.db).readSale(f.source.wallet,saleId);expect(history.state).toEqual(complete);expect(history.contributions).toHaveLength(2);expect(history.wire!.signedTransaction).toBe(saleBytes.toString('base64'));}
   if(settings.retirement)await settings.retirement({fixture:f,domain,clanId:original.clanId,creationIntentId:intentId,saleId,saleFenceId:saved.fenceId!,chain:saleChain,delivery:rpc,policy,leader:buyer,working,creation:activated,sale:complete,deeds,submitExact});
   await writeFile(join(working,'api-sale-result.json'),JSON.stringify({scope:input.scope,domain,trust,epochId:terminal.original.epochId,creationIntentId:intentId,clanId:original.clanId,saleId,fenceId:saved.original.fenceId,termsHash:draft.original.termsHash,
    mintSignature:minted.transaction.signatures[0],saleSignature:sold.transaction.signatures[0],wireSha256:sha(saleBytes),memberPayment:terminal.memberPayment,terminal:terminal.terminal,
    sellerLamports:(price-royalty).toString(),royaltyLamports:royalty.toString(),roster:[f.buyer.wallet],inviteSecretRotated:true,providerlessReplay:true,clientFacade:clientMode,independentBrowserApprovals:clientMode,exactServerDeliveries:clientMode,precreatedStaticLookup:staticLookup,...(tournament?{tournament:{epochId:tournament.epochId,entryId:tournament.entryId,setSignature:tournament.setSignature,clearSignature:tournament.clearSignature,finalRevision:registry.revision}}:{}),artifacts:artifactProfile},null,2),{mode:0o600});
   local.record('actual HTTP creation→real Core mint→server sale terms→two signatures→real Core transfer→SQL roster and invite rotation');
  }finally{try{await Promise.all(apps.map(app=>app.close()));}finally{await f.dispose();}}
 });
}
