/** Actual controlled retirement on owned loopback SBF. Fixture policy clearance
 * is explicit test authority, never gameplay clearance or DB dissolution. */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { VEHICLE_CRAFT_PROGRAM } from '../packages/chain/src/vehicleIssuanceProtocol';
import {createHash,randomBytes,createPrivateKey,sign} from 'node:crypto';
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
import {buildCharterRetirementInstruction,hashCharterRetirementPayload,encodeCharterRetirementPermit,charterRetirementAccounts,matchCharterRetirementReceipt,type CharterRetirementTerms} from '../packages/chain/src/charterRetirementProtocol';
import {createCharterRetirementQuoter,buildCharterRetirementPacket,type CharterRetirementOriginal,type CharterRetirementQuoteRpc} from '../packages/chain/src/charterRetirementPreparation';
import {createCharterRetirementReader,type CharterRetirementRpc} from '../packages/chain/src/charterRetirementEvidence';
import {verifyCharterRetirementSignedWire} from '../packages/chain/src/charterRetirementWire';
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
 const input:CharterFixtureInput={corePath:paths['core-binary']!,craftPath:paths['craft-binary']!,coreBinary:binaries[0]!,craftBinary:binaries[1]!,craft:CRAFT,additionalPrograms:[{id:ECONOMY,path:paths['economy-binary']!,binary:binaries[2]!},{id:PROBE,path:paths['probe-binary']!,binary:binaries[3]!}],idlSha256:sha(Buffer.concat(idlBytes)),validatorVersion:version.stdout.trim(),coreSdkVersion:sdk,umiVersion:umi,scope:'Actual controlled retirement and permanent history; synthetic policy clearance, no backend dissolution authority'};
 let authorityCases:string[]=[];
 const outcomes=await withCharterValidator(input,'retirement',async fixture=>{
  const {connection,payer:buyer,stranger,execute,executeInstructions,snapshots,record,working}=fixture;const seller=buyer;const provider=new anchor.AnchorProvider(connection,new anchor.Wallet(buyer),{commitment:'confirmed'});
  const economy=new anchor.Program<ShardkeepEconomy>(economyIdl,provider),craft=new anchor.Program<ShardkeepCraft>(craftIdl,provider),probe=new anchor.Program<SeekerCpiProbe>(probeIdl,provider);
  const policy=Keypair.generate(),treasury=Keypair.generate().publicKey,domain={economy:ECONOMY,craft:CRAFT,buyer:new PublicKey(stranger.publicKey.toBytes()),seller:new PublicKey(seller.publicKey.toBytes()),treasury};
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
  const tableKeys=[...Object.values(registration),transferConfig,treasury,PROBE,...Object.values(charterTransferAccounts(domain,terms,randomBytes(16))),...Object.values(charterRetirementAccounts(ECONOMY,CRAFT,new PublicKey(seller.publicKey.toBytes()),{clanId:CLAN,retirementId:SALE,fenceId:FENCE,expectedRevision:0,clearanceHash:Buffer.alloc(32,29)},randomBytes(16)))].filter((k,i,all)=>all.findIndex(v=>v.equals(k))===i);
  const [createTable,tableKey]=AddressLookupTableProgram.createLookupTable({authority:buyer.publicKey,payer:buyer.publicKey,recentSlot:await connection.getSlot('finalized')});await execute('lookup-create',createTable);
  for(let at=0;at<tableKeys.length;at+=20)await execute('lookup-extend-'+at,AddressLookupTableProgram.extendLookupTable({lookupTable:tableKey,authority:buyer.publicKey,payer:buyer.publicKey,addresses:tableKeys.slice(at,at+20)}));
  await execute('lookup-freeze',AddressLookupTableProgram.freezeLookupTable({lookupTable:tableKey,authority:buyer.publicKey}));const table=(await connection.getAddressLookupTable(tableKey,{commitment:'confirmed'})).value;check(table&&table.state.authority===undefined,'Actual frozen table absent');const tables=[table];
  const expiry=await clock()+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec),name='Retirement Fixture',uri='https://invalid.example/retirement.json',admission=Buffer.alloc(32,19);
  const regHash=hashCharterRegistrationPayload({config,craftProgram:CRAFT,craftControl,collection,collectionAuthority,charter,asset,assetBinding,freezeAuthority,executor,creationReceipt,clanId:CLAN,leader:seller.publicKey,creationIntentId:INTENT,metadataHash:hashCharterMetadata({name,uri}),admissionCommitment:admission});
  const regNative=Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:encodeCharterRegistrationPermit({genesisHash:genesis,programId:ECONOMY,kind:5,permitId:creationPermit,wallet:seller.publicKey,expiry,payloadHash:regHash})});
  const reg=await economy.methods.registerCharter(Array.from(charterClanIdBytes(CLAN)),Array.from(charterClanIdBytes(INTENT)),Array.from(admission),name,uri,{permitId:Array.from(creationPermit),expiry:new anchor.BN(expiry.toString()),ed25519Instruction:1}).accountsStrict(registration).instruction();
  await executeInstructions('actual-creation',[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),regNative,reg],[],undefined,tables);record('actual frozen Charter registration precedes retirement');
  const retirement:CharterRetirementTerms={clanId:CLAN,retirementId:SALE,fenceId:FENCE,expectedRevision:0,clearanceHash:Buffer.alloc(32,29)};
  const leader=new PublicKey(seller.publicKey.toBytes()),tracked=[asset,collection,charter,assetBinding,creationReceipt,transferConfig,treasury];
  async function attempt(t=retirement,options:{signedTerms?:CharterRetirementTerms;policy?:Keypair;purpose?:6;expiry?:bigint}={}){
   const p={permitId:randomBytes(16),expiry:options.expiry??await clock()+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec),ed25519Instruction:1};
   const payload=hashCharterRetirementPayload(ECONOMY,CRAFT,leader,options.signedTerms??t);
   const message=options.purpose?encodeCharterPurposePermit(genesis,ECONOMY,options.purpose,leader,p,payload):encodeCharterRetirementPermit(genesis,ECONOMY,leader,p,payload);
   const native=Ed25519Program.createInstructionWithPrivateKey({privateKey:(options.policy??policy).secretKey,message}),ix=buildCharterRetirementInstruction(ECONOMY,CRAFT,leader,t,p);
   return {terms:t,permit:p,native,ix,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),native,ix]};
  }
  async function refuse(label:string,a:Awaited<ReturnType<typeof attempt>>,error:ExpectedError){
   const accounts=charterRetirementAccounts(ECONOMY,CRAFT,leader,a.terms,a.permit.permitId),addresses=[...tracked,accounts.retirementReceipt,accounts.permitReceipt],before=JSON.stringify(await snapshots(addresses));
   const result=await executeInstructions(label,a.instructions,[],error,tables);check(JSON.stringify(await snapshots(addresses))===before,label+': protected bytes or balances changed');record(label);return result;
  }
  for(const [label,pause]of [['economy',pauseEconomy],['craft',pauseCraft]] as const){await execute('pause-'+label,await pause(true));await refuse('paused '+label+' refuses retirement',await attempt(),err('Paused'));await execute('resume-'+label,await pause(false));}
  await refuse('wrong policy refuses retirement',await attempt(retirement,{policy:Keypair.generate()}),err('InvalidPermit'));
  await refuse('wrong purpose refuses retirement',await attempt(retirement,{purpose:6}),err('InvalidPermit'));
  for(const [label,change]of [['changed retirement id',{retirementId:LOCK}],['changed fence',{fenceId:LOCK}],['changed clearance',{clearanceHash:Buffer.alloc(32,30)}]] as const)await refuse(label,await attempt({...retirement,...change},{signedTerms:retirement}),err('InvalidPermit'));
  await refuse('expired retirement permit refuses',await attempt(retirement,{expiry:await clock()-1n}),err('PermitExpired'));
  await refuse('wrong revision refuses retirement',await attempt({...retirement,expectedRevision:1}),err('CharterIdentity'));
  const extra=await attempt();extra.ix.keys.push({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:false});await refuse('remaining accounts refuse retirement',extra,err('CharterIdentity'));
  const foreign=await attempt();foreign.ix.keys.find(k=>k.pubkey.equals(CRAFT))!.pubkey=PROBE;await refuse('foreign craft refuses retirement',foreign,{program:ECONOMY,code:2012,anchorName:'ConstraintAddress'});
  for(const catchFailure of [false,true]){const a=await attempt(),ix=buildCharterRetirementInstruction(ECONOMY,CRAFT,leader,retirement,{...a.permit,ed25519Instruction:0});
   const forwarded=await probe.methods.forward(ix.data,catchFailure).accountsStrict({targetProgram:ECONOMY}).remainingAccounts(ix.keys).instruction();a.instructions=[a.native,forwarded];
   const result=await refuse('CPI '+(catchFailure?'catch':'forward')+' refuses retirement',a,err('CharterTopLevelOnly'));check(result.logs.includes(`Program ${ECONOMY} invoke [2]`)&&!result.logs.some(l=>l.includes('Probe caught CPI failure:')),'CPI caught privileged failure');}
  const later=await attempt();later.instructions.push(SystemProgram.transfer({fromPubkey:seller.publicKey,toPubkey:treasury,lamports:1000000000000}));await refuse('later failure rolls retirement and both receipts back',later,{program:SystemProgram.programId,code:1,instructionIndex:3});
  async function lock(action:'set'|'clear',revision:number,expected?:ExpectedError){
   const t={clanId:CLAN,lockId:LOCK,expectedRevision:revision,termsHash:Buffer.alloc(32,23),action},p={permitId:randomBytes(16),expiry:await clock()+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec),ed25519Instruction:1};
   const native=Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:encodeCharterPurposePermit(genesis,ECONOMY,6,leader,p,hashCharterLockPayload(ECONOMY,CRAFT,leader,t))});
   return executeInstructions('lock-'+action+'-'+revision,[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),native,buildCharterLockInstruction(ECONOMY,CRAFT,leader,t,p)],[],expected,tables);
  }
  await lock('set',0);await refuse('active tournament lock refuses retirement',await attempt({...retirement,expectedRevision:1}),err('CharterIdentity'));
  await lock('clear',1);check((await economy.account.clanCharter.fetch(charter)).revision===2,'Real matching lock-clear did not advance');record('actual tournament set-clear advances original revision');
  await refuse('lock-clear cannot revive stale retirement consent',await attempt(),err('CharterIdentity'));
  const latest=await connection.getSlot('confirmed'),until=Date.now()+45000;while(await connection.getSlot('finalized')<latest){check(Date.now()<until,'Original finalization deadline');await nap(250);}
  const programs=await Promise.all([ECONOMY,CRAFT,CORE].map(async id=>{const address=PublicKey.findProgramAddressSync([id.toBytes()],LOADER)[0],row=await connection.getAccountInfo(address,'finalized');check(row,'Missing ProgramData');return {programId:id.toBase58(),reviewedDeploymentSlot:Number(row.data.readBigUInt64LE(4)),reviewedProgramDataSha256:sha(row.data),upgradeAuthority:row.data[12]===1?new PublicKey(row.data.subarray(13,45)).toBase58():null};}));
  const trust:CharterCreationEvidenceTrust={expectedGenesisHash:genesis.toBase58(),economy:programs[0]!,craft:programs[1]!,core:programs[2]!,stateProvenance:'fresh-reviewed-deployment'};
  const original:CharterRetirementOriginal={creation:{creationIntentId:INTENT,clanId:CLAN,payer:leader.toBase58(),metadata:{name,uri,hash:Buffer.from(hashCharterMetadata({name,uri})).toString('hex')},
   chain:{genesisHash:genesis.toBase58(),economyProgram:ECONOMY.toBase58(),craftProgram:CRAFT.toBase58(),...Object.fromEntries(Object.entries({config,craftControl,collection,collectionAuthority,charter,asset,assetBinding,freezeAuthority,executor,creationReceipt}).map(([k,v])=>[k,v.toBase58()]))} as CharterRetirementOriginal['creation']['chain'],admissionCommitment:admission.toString('hex'),issuedPermitIds:[creationPermit.toString('hex')]},
   retirement:{id:SALE,fenceId:FENCE,clanId:CLAN,leader:leader.toBase58(),expectedRevision:2,clearanceHash:Buffer.from(retirement.clearanceHash).toString('hex')}};
  const rpc:CharterRetirementQuoteRpc&CharterRetirementRpc={getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getTransaction:(s,o)=>connection.getTransaction(s,o),
   getMultipleAccountsInfoAndContext:async(keys,o)=>{const r=await connection.getMultipleAccountsInfoAndContext(keys,o);return {context:r.context,value:r.value.map((v,i)=>v?{address:new PublicKey(keys[i]!.toBytes()),owner:new PublicKey(v.owner.toBytes()),executable:v.executable,data:Buffer.from(v.data)}:null)};},
   getAccountInfoAndContext:async(key,o)=>{const r=await connection.getAccountInfoAndContext(key,o);return {context:r.context,value:r.value?{owner:new PublicKey(r.value.owner.toBytes()),executable:r.value.executable,data:Buffer.from(r.value.data)}:null};},
   getLatestBlockhashAndContext:o=>connection.getLatestBlockhashAndContext(o),getFeeForMessage:(m,c)=>connection.getFeeForMessage(m,c),getMinimumBalanceForRentExemption:(n,c)=>connection.getMinimumBalanceForRentExemption(n,c),getBlockHeight:o=>connection.getBlockHeight(o)};
  const alt=await connection.getAccountInfo(tableKey,'finalized');check(alt,'Missing real immutable ALT');
  const quote=await createCharterRetirementQuoter(()=>rpc,{trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:{address:tableKey.toBase58(),dataSha256:sha(alt.data)},costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:10000000n,maxAdditionalLamports:10100000n}})(original,randomBytes(16));
  const policyPrivate=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(policy.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
  const packetInput={...quote.packetInput,policySignatureHex:sign(null,Buffer.from(quote.packetInput.candidateHex,'hex'),policyPrivate).toString('hex')},packet=buildCharterRetirementPacket(packetInput),tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));
  tx.sign([seller]);const signed=Buffer.from(tx.serialize()),checked=verifyCharterRetirementSignedWire({leader,intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:signed});
  const beforeCore=JSON.stringify(await snapshots([asset,collection])),signature=await connection.sendRawTransaction(signed,{skipPreflight:true,maxRetries:0});check(signature===checked.signature,'Submission changed exact wire');
  await writeFile(join(working,'retirement-submitted.json'),JSON.stringify({signature,wireBase64:signed.toString('base64'),packetInput,quote},null,2));
  const confirmation=await connection.confirmTransaction({signature,blockhash:packetInput.blockhash,lastValidBlockHeight:packetInput.lastValidBlockHeight},'finalized');check(confirmation.value.err===null,'Actual retirement failed '+JSON.stringify(confirmation.value.err));
  const result=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});check(result?.meta&&!result.meta.err,'Missing successful actual finalized transaction');check(!result.meta.logMessages?.some(l=>l===`Program ${CORE} invoke [2]`),'Retirement invoked Core');
  check(JSON.stringify(await snapshots([asset,collection]))===beforeCore,'Retirement changed frozen Core bytes or balances');
  const current=await economy.account.clanCharter.fetch(charter),candidate=Buffer.from(packetInput.candidateHex,'hex'),permitId=candidate.subarray(73,89),a=charterRetirementAccounts(ECONOMY,CRAFT,leader,{...retirement,expectedRevision:2},permitId),receipt=await connection.getAccountInfo(a.retirementReceipt,'finalized');
  check(receipt&&current.state===2&&current.revision===3&&current.lockKind===0&&current.leader.equals(leader),'Missing permanent terminal registry');
  const matched=matchCharterRetirementReceipt(receipt.data,ECONOMY,CRAFT,leader,{...retirement,expectedRevision:2},permitId);check(receipt.data.length===250,'Wrong receipt wire length');record('actual fresh quote and exactly signed packet retire original registry without Core mutation');
  const saved={packetInput,signedTransactionHex:signed.toString('hex')},reader=createCharterRetirementReader(()=>rpc,trust,async()=>saved),evidence=await reader(SALE,undefined);
  check(evidence.signature===signature&&evidence.finalizedTransitionObserved&&!evidence.retirementAuthorized&&!evidence.fenceReleaseAuthorized,'Historical proof granted backend dissolution');record('actual finalized original transaction and permanent receipt recover lost retirement reply');
  const frozenTerminal=JSON.stringify(await snapshots([charter,a.retirementReceipt,asset,collection]));
  await refuse('permanent retirement receipt refuses replacement id',await attempt({...retirement,retirementId:LOCK,expectedRevision:3}),{program:SystemProgram.programId,code:0});
  await lock('set',3,err('CharterIdentity'));record('retired Charter cannot reopen tournament authority');
  const salePermit={permitId:randomBytes(16),expiry:await clock()+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec),ed25519Instruction:1},saleTerms={...terms,expectedRevision:3};
  const saleNative=Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:encodeCharterPurposePermit(genesis,ECONOMY,1,domain.buyer,salePermit,hashCharterTransferPayload(domain,saleTerms))});
  await executeInstructions('retired-transfer-refusal',[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),saleNative,buildCharterTransferInstruction(domain,saleTerms,salePermit)],[stranger],err('CharterIdentity'),tables);record('retired Charter cannot transfer or pay a new seller');
  check(JSON.stringify(await snapshots([charter,a.retirementReceipt,asset,collection]))===frozenTerminal,'Terminal refusal changed permanent history');
  authorityCases=await verifyCharterAuthority(fixture,asset,collection,seller);
  await execute('pause-terminal-history',await pauseEconomy(true));const pauseSlot=await connection.getSlot('confirmed'),pauseDeadline=Date.now()+45000;while(await connection.getSlot('finalized')<pauseSlot){check(Date.now()<pauseDeadline,'Pause finalization deadline');await nap(250);}
  check((await reader(SALE,undefined)).signature===signature,'Paused history lost original evidence');record('paused terminal history remains recoverable');
  const badRpc={...rpc,getTransaction:async(s:string,o:{commitment:'finalized';maxSupportedTransactionVersion:0})=>{const r=await rpc.getTransaction(s,o);check(r?.meta,'Missing actual transaction for labelled corruption');return {...r,meta:{...r.meta,postBalances:r.meta.postBalances.map((v,i)=>i===0?v+1:v)}};}};
  let denied=false;try{await createCharterRetirementReader(()=>badRpc,trust,async()=>saved)(SALE,undefined);}catch{denied=true;}check(denied,'Altered actual transaction evidence accepted');record('altered actual fee and rent evidence refuses history');
  await writeFile(join(working,'retirement-evidence.json'),JSON.stringify({evidence,matched,trust,signature,wireBytes:signed.length,actualTransaction:result,artifacts:{economy:sha(binaries[2]!),craft:sha(binaries[1]!)}},null,2));
 });
 console.log(JSON.stringify({status:'passed',cases:outcomes.length+authorityCases.length,retirementCases:outcomes.length,coreAuthorityCases:authorityCases.length,scope:'owned local programs; backend dissolution remains separately held'}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
