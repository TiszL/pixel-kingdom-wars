/** Complete owned local Core transfer/lock acceptance. Fixture policy signatures
 * are not gameplay clearance, DB fence release or a public signing service. */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { VEHICLE_CRAFT_PROGRAM } from '../packages/chain/src/vehicleIssuanceProtocol';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import {AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,Keypair,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY,SYSVAR_INSTRUCTIONS_PUBKEY,TransactionInstruction,VersionedTransaction} from '../packages/chain/node_modules/@solana/web3.js';
import {PHASE_E_SEEKER_AUCTION} from '../packages/shared/src/constants';
import {withCharterValidator,type ExpectedError,type CharterFixtureInput} from './charter-local-fixture';
import {verifyCharterAuthority} from './charter-local-authority';
import {charterConfigPda,charterPda,charterAssetPda,charterMintPda,charterCreationPda,charterFreezePda,charterExecutorPda,charterClanIdBytes,hashCharterMetadata,hashCharterRegistrationPayload,encodeCharterRegistrationPermit} from '../packages/chain/src/charterProtocol';
import {seekerAuthorityPda,seekerPermitReceiptPda} from '../packages/chain/src/seekerAuctionProtocol';
import {buildCharterTransferInstruction,buildCharterLockInstruction,hashCharterTransferPayload,hashCharterLockPayload,encodeCharterPurposePermit,charterTransferAccounts,charterTransferConfigPda,matchCharterTransferReceipt,type CharterTransferTerms,type CharterTransferPermit} from '../packages/chain/src/charterTransferProtocol';
import {createCharterTransferEvidenceReader,type CharterTransferSaved,type CharterTransferRpc} from '../packages/chain/src/charterTransferEvidence';
import type {CharterCreationEvidenceTrust} from '../packages/chain/src/charterCreationAccounts';
import type {ShardkeepEconomy} from './target/types/shardkeep_economy';
import type {ShardkeepCraft} from './target/types/shardkeep_craft';
import type {SeekerCpiProbe} from './target/types/seeker_cpi_probe';
const MINING_PROGRAM_ADDRESS = economyIdl.address;
const ECONOMY=new PublicKey(MINING_PROGRAM_ADDRESS),CRAFT=new PublicKey(VEHICLE_CRAFT_PROGRAM),CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),PROBE=new PublicKey('GGRZUzCunNTqAkny7sLZW6ZkCcj918nDJuzt7SQUYNbK'),LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const CLAN='12345678-1234-5678-9abc-def012345678',INTENT='87654321-4321-4321-8abc-def012345678',SALE='12345678-1234-4678-9abc-def012345678',FENCE='12345678-1234-4678-9abc-def012345679',LOCK='12345678-1234-4678-9abc-def012345680';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),pda=(p:PublicKey,s:string)=>PublicKey.findProgramAddressSync([Buffer.from(s)],p)[0];
function check(v:unknown,why:string):asserts v {if(!v)throw new Error(why);}
const nap=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function main(){
 const names=['core-binary','craft-binary','craft-idl','economy-binary','economy-idl','probe-binary','probe-idl'];const args=process.argv.slice(2);check(args.length===names.length*2&&names.every((n,i)=>args[i*2]==='--'+n),'Explicit local binary/IDL paths required');
 const paths=Object.fromEntries(names.map((n,i)=>[n,resolve(args[i*2+1]!)]));const binaries=await Promise.all(['core','craft','economy','probe'].map(n=>readFile(paths[n+'-binary']!)));
 check(binaries[0]!.length===809696&&sha(binaries[0]!)==='69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee','Wrong reviewed Core0.15.2');
 const idlBytes=await Promise.all(['craft','economy','probe'].map(n=>readFile(paths[n+'-idl']!)));const [craftIdl,economyIdl,probeIdl]=idlBytes.map(b=>JSON.parse(b.toString()));
 check(craftIdl.address===CRAFT.toBase58()&&economyIdl.address===ECONOMY.toBase58()&&probeIdl.address===PROBE.toBase58(),'Wrong program identities');
 const version=spawnSync('solana-test-validator',['--version'],{encoding:'utf8',timeout:10000});check(version.status===0&&/solana-test-validator 2\.3\.13/.test(version.stdout),'Pinned validator required');
 const sdk=JSON.parse(await readFile(resolve('packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'),'utf8')).version;const umi=JSON.parse(await readFile(resolve('packages/chain/node_modules/@metaplex-foundation/umi/package.json'),'utf8')).version;check(sdk==='1.10.0'&&umi==='1.5.1','Pinned SDKs required');
 const input:CharterFixtureInput={corePath:paths['core-binary']!,craftPath:paths['craft-binary']!,coreBinary:binaries[0]!,craftBinary:binaries[1]!,craft:CRAFT,additionalPrograms:[{id:ECONOMY,path:paths['economy-binary']!,binary:binaries[2]!},{id:PROBE,path:paths['probe-binary']!,binary:binaries[3]!}],idlSha256:sha(Buffer.concat(idlBytes)),validatorVersion:version.stdout.trim(),coreSdkVersion:sdk,umiVersion:umi,scope:'Local controlled co-signed transfer and tournament lock only; no backend readiness or public authority'};
 let authorityCases:string[]=[];
 const outcomes=await withCharterValidator(input,'transfer',async fixture=>{
  const {connection,payer:buyer,stranger:seller,execute,executeInstructions,snapshots,record,working}=fixture;const provider=new anchor.AnchorProvider(connection,new anchor.Wallet(buyer),{commitment:'confirmed'});
  const economy=new anchor.Program<ShardkeepEconomy>(economyIdl,provider),craft=new anchor.Program<ShardkeepCraft>(craftIdl,provider),probe=new anchor.Program<SeekerCpiProbe>(probeIdl,provider);
  const policy=Keypair.generate(),treasury=Keypair.generate().publicKey,domain={economy:ECONOMY,craft:CRAFT,buyer:new PublicKey(buyer.publicKey.toBytes()),seller:new PublicKey(seller.publicKey.toBytes()),treasury};
  const authority=seekerAuthorityPda(ECONOMY),config=charterConfigPda(ECONOMY),craftControl=pda(CRAFT,'charter_control'),collection=pda(CRAFT,'charter_collection'),collectionAuthority=pda(CRAFT,'charter_collection_authority');
  const craftData=PublicKey.findProgramAddressSync([CRAFT.toBytes()],LOADER)[0],economyData=PublicKey.findProgramAddressSync([ECONOMY.toBytes()],LOADER)[0],genesis=new PublicKey(await connection.getGenesisHash());
  const clock=async()=>{const row=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed');check(row?.data.length===40,'Clock absent');return row.data.readBigInt64LE(32);};
  const err=(name:string,program:typeof economy|typeof craft=economy):ExpectedError=>{const e=program.rawIdl.errors?.find(e=>e.name===name);check(e,'Missing error '+name);return {program:program.programId,code:e.code,anchorName:name};};
  await execute('bootstrap',await craft.methods.initializeCharterCollection('Charters','https://invalid.example/charters.json').accountsStrict({admin:buyer.publicKey,program:CRAFT,programData:craftData,config:craftControl,collection,collectionAuthority,mplCoreProgram:CORE,systemProgram:SystemProgram.programId}).instruction());
  await execute('policy',await economy.methods.initializeSeekerAuthority(buyer.publicKey,policy.publicKey,Array.from(genesis.toBytes())).accountsStrict({admin:buyer.publicKey,program:ECONOMY,programData:economyData,authority,systemProgram:SystemProgram.programId}).instruction());
  await execute('creation-config',await economy.methods.initializeCharterConfig().accountsStrict({admin:buyer.publicKey,program:ECONOMY,programData:economyData,authority,config,craftProgram:CRAFT,craftControl,collection,collectionAuthority,systemProgram:SystemProgram.programId}).instruction());
  const transferConfig=charterTransferConfigPda(ECONOMY);
  await execute('transfer-config',await economy.methods.initializeCharterTransferConfig(treasury).accountsStrict({admin:buyer.publicKey,program:ECONOMY,programData:economyData,authority,config,transferConfig,systemProgram:SystemProgram.programId}).instruction());
  const pauseEconomy=(v:boolean)=>economy.methods.setAdmissionPaused(v).accountsStrict({signer:buyer.publicKey,authority}).instruction();
  const pauseCraft=(v:boolean)=>craft.methods.setCharterAdmissionPaused(v).accountsStrict({admin:buyer.publicKey,program:CRAFT,programData:craftData,config:craftControl}).instruction();
  await execute('open-economy',await pauseEconomy(false));await execute('open-craft',await pauseCraft(false));
  const asset=charterMintPda(CRAFT,CLAN),charter=charterPda(ECONOMY,CLAN),creationReceipt=charterCreationPda(ECONOMY,INTENT),assetBinding=charterAssetPda(ECONOMY,asset),freezeAuthority=charterFreezePda(CRAFT,CLAN),executor=charterExecutorPda(ECONOMY,CLAN),creationPermit=randomBytes(16);
  const registration={leader:seller.publicKey,authority,config,charter,assetBinding,creationReceipt,receipt:seekerPermitReceiptPda(ECONOMY,creationPermit),executor,craftProgram:CRAFT,craftControl,asset,collection,collectionAuthority,freezeAuthority,mplCoreProgram:CORE,instructions:SYSVAR_INSTRUCTIONS_PUBKEY,systemProgram:SystemProgram.programId,economyProgram:ECONOMY};
  const terms:CharterTransferTerms={clanId:CLAN,transferId:SALE,fenceId:FENCE,expectedRevision:0,priceLamports:101000003n,termsHash:Buffer.alloc(32,17)};
  const tableKeys=[...Object.values(registration),transferConfig,treasury,PROBE,...Object.values(charterTransferAccounts(domain,terms,randomBytes(16)))].filter((k,i,all)=>all.findIndex(v=>v.equals(k))===i);
  const [createTable,tableKey]=AddressLookupTableProgram.createLookupTable({authority:buyer.publicKey,payer:buyer.publicKey,recentSlot:await connection.getSlot('finalized')});await execute('lookup-create',createTable);
  for(let at=0;at<tableKeys.length;at+=20)await execute('lookup-extend-'+at,AddressLookupTableProgram.extendLookupTable({lookupTable:tableKey,authority:buyer.publicKey,payer:buyer.publicKey,addresses:tableKeys.slice(at,at+20)}));
  await execute('lookup-freeze',AddressLookupTableProgram.freezeLookupTable({lookupTable:tableKey,authority:buyer.publicKey}));const table=(await connection.getAddressLookupTable(tableKey,{commitment:'confirmed'})).value;check(table&&table.state.authority===undefined,'Actual frozen table absent');const tables=[table];
  const expiry=await clock()+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec),name='Transfer Fixture',uri='https://invalid.example/transfer.json',admission=Buffer.alloc(32,19);
  const regHash=hashCharterRegistrationPayload({config,craftProgram:CRAFT,craftControl,collection,collectionAuthority,charter,asset,assetBinding,freezeAuthority,executor,creationReceipt,clanId:CLAN,leader:seller.publicKey,creationIntentId:INTENT,metadataHash:hashCharterMetadata({name,uri}),admissionCommitment:admission});
  const regNative=Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:encodeCharterRegistrationPermit({genesisHash:genesis,programId:ECONOMY,kind:5,permitId:creationPermit,wallet:seller.publicKey,expiry,payloadHash:regHash})});
  const reg=await economy.methods.registerCharter(Array.from(charterClanIdBytes(CLAN)),Array.from(charterClanIdBytes(INTENT)),Array.from(admission),name,uri,{permitId:Array.from(creationPermit),expiry:new anchor.BN(expiry.toString()),ed25519Instruction:1}).accountsStrict(registration).instruction();
  await executeInstructions('actual-creation',[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),regNative,reg],[seller],undefined,tables);record('actual frozen Charter registration precedes transfer');
  const tracked=[asset,collection,charter,assetBinding,creationReceipt,transferConfig,treasury,seller.publicKey];
  function attempt(t:CharterTransferTerms=terms,options:{signedTerms?:CharterTransferTerms;policy?:Keypair;purpose?:1|6;expiry?:bigint}={}){
   const p:CharterTransferPermit={permitId:randomBytes(16),expiry:options.expiry??expiry,ed25519Instruction:1};
   const message=encodeCharterPurposePermit(genesis,ECONOMY,options.purpose??1,domain.buyer,p,hashCharterTransferPayload(domain,options.signedTerms??t));
   const native=Ed25519Program.createInstructionWithPrivateKey({privateKey:(options.policy??policy).secretKey,message});const ix=buildCharterTransferInstruction(domain,t,p);
   return {terms:t,permit:p,ix,native,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),native,ix]};
  }
  async function refuse(label:string,a:ReturnType<typeof attempt>,error:ExpectedError,signers=[seller]){
   const addresses=[...tracked,charterTransferAccounts(domain,a.terms,a.permit.permitId).transferReceipt,seekerPermitReceiptPda(ECONOMY,a.permit.permitId)];const before=JSON.stringify(await snapshots(addresses));
   const result=await executeInstructions(label,a.instructions,signers,error,tables);check(JSON.stringify(await snapshots(addresses))===before,label+': protected bytes/money changed');record(label);return result;
  }
  await execute('pause-economy',await pauseEconomy(true));await refuse('paused economy refuses transfer',attempt(),err('Paused'));await execute('resume-economy',await pauseEconomy(false));
  await execute('pause-craft',await pauseCraft(true));await refuse('paused craft refuses transfer',attempt(),err('Paused'));await execute('resume-craft',await pauseCraft(false));
  await refuse('wrong policy refused',attempt(terms,{policy:Keypair.generate()}),err('InvalidPermit'));await refuse('wrong purpose refused',attempt(terms,{purpose:6}),err('InvalidPermit'));
  for(const [label,change]of [['changed price',{priceLamports:terms.priceLamports+1n}],['changed fence',{fenceId:LOCK}],['changed terms',{termsHash:Buffer.alloc(32,18)}]] as const)await refuse(label,attempt({...terms,...change},{signedTerms:terms}),err('InvalidPermit'));
  await refuse('expired permit refused',attempt(terms,{expiry:await clock()-1n}),err('PermitExpired'));
  const missing=attempt();missing.ix.keys.find(k=>k.pubkey.equals(seller.publicKey))!.isSigner=false;await refuse('missing seller signature refused',missing,{program:ECONOMY,code:3010,anchorName:'AccountNotSigner'},[]);
  const extra=attempt();extra.ix.keys.push({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:false});await refuse('remaining accounts refused',extra,err('CharterIdentity'));
  const foreign=attempt();foreign.ix.keys.find(k=>k.pubkey.equals(CRAFT))!.pubkey=PROBE;await refuse('foreign craft refused',foreign,{program:ECONOMY,code:2012,anchorName:'ConstraintAddress'});
  const direct=await craft.methods.executeCharterTransfer(Array.from(charterClanIdBytes(CLAN)),0).accountsStrict({seller:seller.publicKey,buyer:buyer.publicKey,executor:buyer.publicKey,economyProgram:ECONOMY,config:craftControl,charter,asset,collection,collectionAuthority,freezeAuthority,mplCoreProgram:CORE,systemProgram:SystemProgram.programId}).instruction();const da=attempt();da.instructions=[direct];await refuse('direct craft foreign executor refused',da,{program:CRAFT,code:2006,anchorName:'ConstraintSeeds'});
  for(const catchFailure of [false,true]){const a=attempt();const p={...a.permit,ed25519Instruction:0};const ix=buildCharterTransferInstruction(domain,terms,p);const forwarded=await probe.methods.forward(ix.data,catchFailure).accountsStrict({targetProgram:ECONOMY}).remainingAccounts(ix.keys).instruction();a.instructions=[a.native,forwarded];const r=await refuse('CPI '+(catchFailure?'catch':'forward')+' refused',a,err('CharterTopLevelOnly'));check(r.logs.includes(`Program ${ECONOMY} invoke [2]`)&&!r.logs.some(l=>l.includes('Probe caught CPI failure:')),'CPI caught privileged failure');}
  const insufficient=await refuse('insufficient SOL rolls back actual Core transfer',attempt({...terms,priceLamports:1000000000000n}),{program:SystemProgram.programId,code:1});check(insufficient.logs.includes(`Program ${CORE} invoke [3]`),'Failure did not reach actual Core');
  const later=attempt();later.instructions.push(SystemProgram.transfer({fromPubkey:seller.publicKey,toPubkey:treasury,lamports:1000000000000}));await refuse('later failure rolls back successful executor',later,{program:SystemProgram.programId,code:1,instructionIndex:3});
  async function lock(action:'set'|'clear',revision:number,lockId=LOCK,expected?:ExpectedError){const t={clanId:CLAN,lockId,expectedRevision:revision,termsHash:Buffer.alloc(32,23),action};const p={permitId:randomBytes(16),expiry,ed25519Instruction:1};const native=Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:encodeCharterPurposePermit(genesis,ECONOMY,6,domain.seller,p,hashCharterLockPayload(ECONOMY,CRAFT,domain.seller,t))});return executeInstructions('lock-'+action+'-'+revision,[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),native,buildCharterLockInstruction(ECONOMY,CRAFT,domain.seller,t,p)],[seller],expected,tables);}
  await lock('set',0);check((await economy.account.clanCharter.fetch(charter)).revision===1,'Set did not advance');record('tournament set advances revision before entry');
  await refuse('locked sale cannot pay',attempt({...terms,expectedRevision:1}),err('CharterIdentity'));await lock('clear',1,FENCE,err('CharterIdentity'));record('different tournament cannot clear lock');
  for(const [label,pause]of [['economy',pauseEconomy],['craft',pauseCraft]] as const){await execute('pause-clear-'+label,await pause(true));await lock('clear',1,LOCK,err('Paused'));await execute('resume-clear-'+label,await pause(false));record('paused '+label+' refuses clear');}
  await lock('clear',1);check((await economy.account.clanCharter.fetch(charter)).revision===2,'Clear did not advance');record('matching clear advances revision');
  await refuse('set-clear does not revive stale sale',attempt(),err('CharterIdentity'));
  const valid=attempt({...terms,expectedRevision:2});const before=await connection.getMultipleAccountsInfo([buyer.publicKey,seller.publicKey,treasury,collection],'confirmed');
  const sold=await executeInstructions('actual-controlled-sale',valid.instructions,[seller],undefined,tables);check(sold.logs.filter(l=>l===`Program ${CORE} invoke [3]`).length===3,'Not the complete three-Core-CPI path');
  const after=await connection.getMultipleAccountsInfo([buyer.publicKey,seller.publicKey,treasury,collection],'confirmed');const actual=await economy.account.clanCharter.fetch(charter),saleAccounts=charterTransferAccounts(domain,valid.terms,valid.permit.permitId),rawReceipt=await connection.getAccountInfo(saleAccounts.transferReceipt,'confirmed');
  check(rawReceipt,'Missing permanent sale receipt');const matched=matchCharterTransferReceipt(rawReceipt.data,domain,valid.terms,valid.permit.permitId);
  check(actual.leader.equals(buyer.publicKey)&&actual.revision===3&&actual.lockKind===0,'Registry not projected');check(BigInt(after[1]!.lamports-before[1]!.lamports)===BigInt(matched.sellerLamports)&&BigInt(after[2]!.lamports-(before[2]?.lamports??0))===BigInt(matched.royaltyLamports),'Wrong seller/royalty payment');check(after[3]!.data.equals(before[3]!.data),'Collection mutated');record('actual two-party sale pays exact SOL and preserves frozen stable Charter');
  authorityCases=await verifyCharterAuthority(fixture,asset,collection,buyer);
  await refuse('permanent transfer receipt refuses replay',valid,{program:SystemProgram.programId,code:0});
  const until=Date.now()+45000;while(await connection.getSlot('finalized')<sold.slot){check(Date.now()<until,'Sale finalization deadline');await nap(250);}
  const programs=await Promise.all([ECONOMY,CRAFT,CORE].map(async id=>{const address=PublicKey.findProgramAddressSync([id.toBytes()],LOADER)[0],row=await connection.getAccountInfo(address,'finalized');check(row,'Missing ProgramData');return {programId:id.toBase58(),reviewedDeploymentSlot:Number(row.data.readBigUInt64LE(4)),reviewedProgramDataSha256:sha(row.data),upgradeAuthority:row.data[12]===1?new PublicKey(row.data.subarray(13,45)).toBase58():null};}));
  const trust:CharterCreationEvidenceTrust={expectedGenesisHash:genesis.toBase58(),economy:programs[0]!,craft:programs[1]!,core:programs[2]!,stateProvenance:'fresh-reviewed-deployment'};
  const submissions=JSON.parse(await readFile(join(working,'submitted-transactions.json'),'utf8')) as {label:string;wireBase64:string}[];const submitted=submissions.find(r=>r.label==='actual-controlled-sale');check(submitted,'Missing exact submitted wire');const wire=Buffer.from(submitted.wireBase64,'base64');const saved:CharterTransferSaved={domain,terms:valid.terms,permit:valid.permit,policySigner:policy.publicKey,preparedMessage:VersionedTransaction.deserialize(wire).message.serialize(),signedTransaction:wire};
  const rpc:CharterTransferRpc={getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getTransaction:(s,o)=>connection.getTransaction(s,o),getMultipleAccountsInfoAndContext:async(keys,o)=>{const r=await connection.getMultipleAccountsInfoAndContext(keys,o);return {context:r.context,value:r.value.map((v,i)=>v?{address:keys[i]!,owner:v.owner,executable:v.executable,data:v.data}:null)};}};
  const evidence=await createCharterTransferEvidenceReader(()=>rpc,trust,async()=>saved)(SALE);check(evidence.finalizedTransferObserved&&!evidence.fenceReleaseAuthorized,'Recovery granted DB authority');record('actual finalized original wire and receipt recover lost reply');
  await execute('pause-history',await pauseEconomy(true));check((await createCharterTransferEvidenceReader(()=>rpc,trust,async()=>saved)(SALE)).signature===evidence.signature,'Paused history changed');record('paused original finality recovery remains read only');
  let refused=false;try{await createCharterTransferEvidenceReader(()=>({...rpc,getTransaction:async(s,o)=>{const tx=await rpc.getTransaction(s,o);check(tx?.meta,'Missing fixture transaction');return {...tx,meta:{...tx.meta,postBalances:tx.meta.postBalances.map((n,i)=>i===0?n+1:n)}};}}),trust,async()=>saved)(SALE);}catch{refused=true;}check(refused,'Mutated actual balance evidence accepted');record('altered actual payment evidence refused');
  await writeFile(join(working,'transfer-evidence.json'),JSON.stringify({evidence,trust,matched,artifacts:{economy:sha(binaries[2]!),craft:sha(binaries[1]!) }},null,2));
 });
 console.log(JSON.stringify({status:'passed',cases:outcomes.length+authorityCases.length,executorCases:outcomes.length,coreAuthorityCases:authorityCases.length,scope:'local only; backend issuer and DB fences remain held'}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
