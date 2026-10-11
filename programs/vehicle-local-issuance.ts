/** D153.207 actual local craft/Core execution against an explicitly synthetic
 * provider. This proves consumer contracts, never live VRF or K140 authority. */
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {PublicKey,Keypair,Ed25519Program,SystemProgram,TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,SYSVAR_INSTRUCTIONS_PUBKEY,SYSVAR_SLOT_HASHES_PUBKEY} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '../packages/shared/src/constants';
import {vehiclePda,vehicleTermsBytes,vehicleTermsHash,vehicleMetadataHash,vehicleIdentity,
  vehicleDiscriminator,vehicleFees,vehicleU32,VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,
  VEHICLE_VRF_QUEUE,VEHICLE_CORE_PROGRAM,vehicleVrfRequest,type VehicleIssuanceOriginal} from '../packages/chain/src/vehicleIssuanceProtocol';
import {normalizeVehicleIssuanceOriginal} from '../packages/chain/src/vehicleIssuanceAccounts';
import {withCharterValidator,type ExpectedError} from './charter-local-fixture';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const CRAFT=new PublicKey(VEHICLE_CRAFT_PROGRAM),CORE=new PublicKey(VEHICLE_CORE_PROGRAM),VRF=new PublicKey(VEHICLE_VRF_PROGRAM),QUEUE=new PublicKey(VEHICLE_VRF_QUEUE);
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const hex=(s:string)=>Buffer.from(s,'hex');
const pda=(seed:string,id?:string)=>new PublicKey(vehiclePda(seed,id)[0].toBytes());
const i64=(v:bigint)=>{const b=Buffer.alloc(8);b.writeBigInt64LE(v);return b;};
const string=(v:string)=>Buffer.concat([vehicleU32(Buffer.byteLength(v)),Buffer.from(v)]);
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const ix=(name:string,data:Buffer[],keys:ReturnType<typeof meta>[])=>new TransactionInstruction({programId:CRAFT,keys,data:Buffer.concat([vehicleDiscriminator('global',name),...data])});
function need(v:unknown,why:string):asserts v{if(!v)throw Error(why);}
type Chain=Parameters<Parameters<typeof withCharterValidator>[2]>[0];
export interface VehicleLocalTrust {expectedGenesisHash:string;stateProvenance:'fresh-reviewed-deployment';
  craft:{programId:string;reviewedDeploymentSlot:number;reviewedProgramDataSha256:string;upgradeAuthority:string|null};
  provider:VehicleLocalTrust['craft'];core:VehicleLocalTrust['craft']}
export interface VehicleLocalMint {chain:Chain;original:VehicleIssuanceOriginal;trust:VehicleLocalTrust}
export interface VehicleLocalRequest extends VehicleLocalMint {policySigner:Keypair}
export interface VehicleLocalSubmitted {signature:string;slot:number;wireBytes:number}

export async function runVehicleIssuanceProgram(options:{payer?:Keypair;
 prepareOriginal?:(input:Pick<VehicleLocalMint,'chain'|'original'>)=>Promise<VehicleIssuanceOriginal>;
 onOriginal?:(input:Pick<VehicleLocalMint,'chain'|'original'>)=>Promise<void>;
 submitRequest?:(input:VehicleLocalRequest)=>Promise<VehicleLocalSubmitted>;
 onPaidResult?:(input:VehicleLocalMint)=>Promise<void>;onMinted?:(input:VehicleLocalMint)=>Promise<void>}={}) {
 const corePath=process.env.PHASE_E_CHARTER_CORE_BINARY;need(corePath,'Explicit pinned Core artifact required');
 const craftPath=join(ROOT,'programs/target/deploy/shardkeep_craft.so'),providerPath=join(ROOT,'programs/target/deploy/vehicle_vrf_provider.so');
 const fixtureController=Keypair.generate(),queueBytes=Buffer.alloc(4096);
 queueBytes.write('SYNVRF01');fixtureController.publicKey.toBuffer().copy(queueBytes,8);queueBytes.writeBigUInt64LE(2_000_000n,41);
 const [coreBinary,craftBinary,providerBinary,idlBytes]=await Promise.all([corePath,craftPath,providerPath,join(ROOT,'programs/target/idl/shardkeep_craft.json')].map(p=>readFile(p)));
 need(coreBinary!.length===809696&&sha(coreBinary!)==='69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee','Unreviewed Core ELF');
 const idl=JSON.parse(idlBytes!.toString()) as {address:string;errors:{code:number;name:string}[]};need(idl.address===CRAFT.toBase58(),'Wrong craft IDL');
 const version=spawnSync('solana-test-validator',['--version'],{encoding:'utf8',timeout:10000});need(version.status===0&&/solana-test-validator 2\.3\.13(?:\s|\(|$)/.test(version.stdout),'Pinned validator required');
 const sdk=JSON.parse(await readFile(join(ROOT,'packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'),'utf8')).version;
 const umi=JSON.parse(await readFile(join(ROOT,'packages/chain/node_modules/@metaplex-foundation/umi/package.json'),'utf8')).version;
 need(sdk==='1.10.0'&&umi==='1.5.1','Pinned Core SDK/UMI required');
 const outcomes=await withCharterValidator({corePath,craftPath,coreBinary:coreBinary!,craftBinary:craftBinary!,craft:CRAFT,
  ...(options.payer?{syntheticPayer:options.payer}:{}),additionalPrograms:[{id:VRF,path:providerPath,binary:providerBinary!}],idlSha256:sha(idlBytes!),validatorVersion:version.stdout.trim(),coreSdkVersion:sdk,umiVersion:umi,
  syntheticGenesisAccounts:[{address:QUEUE,account:{owner:VRF,executable:false,lamports:100_000_000,data:queueBytes,rentEpoch:0}}],
  scope:'Actual craft/Core consumer execution; explicitly synthetic provider, no real randomness/liveness/K140 proof'},'vehicle-issuance',async chain=>{
   const {connection,payer,execute,executeInstructions,snapshots,record,working}=chain;
   const policy=Keypair.generate(),operator=Keypair.generate().publicKey,project=Keypair.generate().publicKey,site=Keypair.generate().publicKey;
   const control=pda('vehicle_control'),collection=pda('vehicle_collection'),authority=pda('vehicle_authority'),identity=pda('identity');
   const programData=PublicKey.findProgramAddressSync([CRAFT.toBuffer()],LOADER)[0],genesis=await connection.getGenesisHash();
   const admin=[meta(payer.publicKey,false,true),meta(CRAFT),meta(programData),meta(control,true)];
   const error=(name:string):ExpectedError=>{const e=idl.errors.find(e=>e.name===name);need(e,'Missing exact error '+name);return {program:CRAFT,code:e.code,anchorName:name};};
   const clock=async()=>{const c=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed');need(c?.data.length===40,'Missing actual Clock');return c.data.readBigInt64LE(32);};
   const waitFinalized=async(slot:number)=>{const end=Date.now()+30000;while(await connection.getSlot('finalized')<slot&&Date.now()<end)await new Promise(done=>setTimeout(done,100));need(await connection.getSlot('finalized')>=slot,'Actual result did not finalize');};
   await execute('initialize separate paused vehicle collection',ix('initialize_vehicle_collection',[new PublicKey(genesis).toBuffer(),policy.publicKey.toBuffer(),string('Local vehicles'),string('https://invalid.example/vehicles.json')],
    [meta(payer.publicKey,true,true),meta(CRAFT),meta(programData),meta(control,true),meta(collection,true),meta(authority),meta(CORE),meta(SystemProgram.programId)]));
   const pause=(paused:boolean)=>ix('set_vehicle_admission_paused',[Buffer.of(Number(paused))],admin);
   const escrowRentReserve=await connection.getMinimumBalanceForRentExemption(0,'confirmed');
   const controlAccount=await connection.getAccountInfo(control,'confirmed');
   need(controlAccount?.data.length===189&&controlAccount.data.readBigUInt64LE(178)===BigInt(escrowRentReserve),'Control must commit the actual empty-System escrow reserve');
   async function pin(program:PublicKey){const address=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0],a=await connection.getAccountInfo(address,'finalized');need(a&&a.data.readUInt32LE(0)===3,'Missing finalized ProgramData');return {programId:program.toBase58(),reviewedDeploymentSlot:Number(a.data.readBigUInt64LE(4)),reviewedProgramDataSha256:sha(a.data),upgradeAuthority:a.data[12]===0?null:new PublicKey(a.data.subarray(13,45)).toBase58()};}
   async function currentTrust():Promise<VehicleLocalTrust>{return {expectedGenesisHash:genesis,stateProvenance:'fresh-reviewed-deployment',craft:await pin(CRAFT),provider:await pin(VRF),core:await pin(CORE)};}
   async function paid(o:VehicleIssuanceOriginal,slot:number){if(options.onPaidResult){await waitFinalized(slot);await options.onPaidResult({chain,original:o,trust:await currentTrust()});}}
   const originals:VehicleIssuanceOriginal[]=[];
   async function original(oddsBps:number,alias:'separate'|'project'|'buyer'='separate'):Promise<VehicleIssuanceOriginal>{
    const rootId=randomBytes(16).toString('hex'),metadata={name:'Local survey balloon',uri:'https://invalid.example/vehicle.json'};
    const value:VehicleIssuanceOriginal={version:1,rootId,attemptId:randomBytes(16).toString('hex'),buyer:payer.publicKey.toBase58(),permitId:randomBytes(16).toString('hex'),
     permitExpiry:(await clock()+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec)).toString(),genesisHash:genesis,escrowRentReserve:escrowRentReserve.toString(),identity:vehicleIdentity(rootId,0,1),metadata,
     terms:{recipeVersion:1,recipeHash:'11'.repeat(32),materialHash:'22'.repeat(32),metadataHash:vehicleMetadataHash(metadata.name,metadata.uri),site:site.toBase58(),operator:(alias==='buyer'?payer.publicKey:alias==='project'?project:operator).toBase58(),project:project.toBase58(),oracleBudget:'2000000',oddsBps,family:0,tier:1},originalHash:''};
    const {originalHash:_,...input}=value;const template=normalizeVehicleIssuanceOriginal(input),saved=options.prepareOriginal?normalizeVehicleIssuanceOriginal(await options.prepareOriginal({chain,original:template})):template;
    need(saved.rootId===template.rootId&&saved.attemptId===template.attemptId&&saved.buyer===template.buyer&&saved.permitId===template.permitId&&JSON.stringify(saved.identity)===JSON.stringify(template.identity),'Material fixture changed original identity');
    originals.push(saved);await options.onOriginal?.({chain,original:saved});return saved;
   }
   const accounts=(o:VehicleIssuanceOriginal)=>[meta(payer.publicKey,true,true),meta(control),meta(pda('vehicle_root',o.rootId),true),meta(pda('vehicle_attempt',o.attemptId),true),meta(pda('vehicle_permit',o.permitId),true),meta(pda('vehicle_app',o.rootId),true),meta(pda('vehicle_oracle',o.rootId),true),meta(pda('vehicle_asset',o.rootId)),meta(identity),meta(QUEUE,true),meta(VRF),meta(SYSVAR_INSTRUCTIONS_PUBKEY),meta(SYSVAR_SLOT_HASHES_PUBKEY),meta(SystemProgram.programId)];
   function request(o:VehicleIssuanceOriginal,signer=policy,kind=3){
    const message=Buffer.concat([Buffer.from('SKPERMT2'),new PublicKey(o.genesisHash).toBuffer(),CRAFT.toBuffer(),Buffer.of(kind),hex(o.permitId),new PublicKey(o.buyer).toBuffer(),i64(BigInt(o.permitExpiry)),hex(vehicleTermsHash(o))]);
    return [Ed25519Program.createInstructionWithPrivateKey({privateKey:signer.secretKey,message}),ix('request_vehicle',[hex(o.rootId),hex(o.attemptId),vehicleTermsBytes(o.terms),hex(o.permitId),i64(BigInt(o.permitExpiry)),Buffer.from([0,0])],accounts(o))];
   }
   const watched=(o:VehicleIssuanceOriginal)=>[pda('vehicle_root',o.rootId),pda('vehicle_attempt',o.attemptId),pda('vehicle_permit',o.permitId),pda('vehicle_app',o.rootId),pda('vehicle_oracle',o.rootId),pda('vehicle_asset',o.rootId),QUEUE];
   async function refuse(label:string,o:VehicleIssuanceOriginal,instructions:TransactionInstruction[],expected:ExpectedError,signers:Keypair[]=[]){const before=await snapshots(watched(o));await executeInstructions(label,instructions,signers,expected);need(JSON.stringify(await snapshots(watched(o)))===JSON.stringify(before),label+' changed original state');record(label);}
   const win=await original(PHASE_E_POLICY.basisPoints);
   await refuse('paused admission leaves no paid attempt',win,request(win),error('Paused'));
   await execute('open only this local collection',pause(false));
   await refuse('wrong policy signer',win,request(win,Keypair.generate()),error('Permit'));
   await refuse('wrong permit kind',win,request(win,policy,7),error('Permit'));
   await refuse('wrong permit genesis',win,request({...win,genesisHash:chain.stranger.publicKey.toBase58()}),error('Permit'));
   await refuse('wrong permit buyer',win,request({...win,buyer:chain.stranger.publicKey.toBase58()}),error('Permit'));
   await refuse('altered quoted escrow reserve invalidates permit',win,request({...win,escrowRentReserve:(escrowRentReserve+1).toString()}),error('Permit'));
   await refuse('expired permit',win,request({...win,permitExpiry:(await clock()-1n).toString()}),error('Expired'));
   const wrongProvider=request(win);wrongProvider[1]!.keys[10]=meta(SystemProgram.programId);
   await refuse('substituted provider program',win,wrongProvider,{program:CRAFT,code:2012,anchorName:'ConstraintAddress'});
   const wrongQueue=request(win);wrongQueue[1]!.keys[9]=meta(chain.stranger.publicKey,true);
   await refuse('foreign queue owner',win,wrongQueue,{program:CRAFT,code:2004,anchorName:'ConstraintOwner'});
   const changed=request(win);changed[1]!.data[8+16+16+4]=changed[1]!.data[8+16+16+4]!^1;
   await refuse('changed frozen recipe',win,changed,error('Permit'));
   const wrapped=request(win);wrapped[1]=new TransactionInstruction({programId:VRF,keys:[...wrapped[1]!.keys,meta(CRAFT)],data:Buffer.concat([Buffer.of(202),wrapped[1]!.data])});
   await refuse('CPI wrapper cannot admit an original',win,wrapped,error('TopLevel'));
   const providerControl=(mode:number,charge=2_000_000n)=>{const b=Buffer.alloc(10);b[0]=200;b[1]=mode;b.writeBigUInt64LE(charge,2);return new TransactionInstruction({programId:VRF,keys:[meta(fixtureController.publicKey,false,true),meta(QUEUE,true)],data:b});};
   const callback=(o:VehicleIssuanceOriginal,index:number,mode=0,randomness=Buffer.alloc(32,255))=>new TransactionInstruction({programId:VRF,
    keys:[meta(fixtureController.publicKey,false,true),meta(QUEUE),meta(CRAFT),meta(PublicKey.findProgramAddressSync(mode===1?[Buffer.from('identity')]:[Buffer.from('identity'),CRAFT.toBuffer()],VRF)[0]),meta(pda('vehicle_root',o.rootId)),meta(pda('vehicle_attempt',o.attemptId),true)],
    data:Buffer.concat([Buffer.of(201),vehicleU32(index),randomness,Buffer.of(mode)])});
   const settle=(o:VehicleIssuanceOriginal)=>ix('settle_vehicle_fee',[hex(o.rootId)],[meta(control),meta(pda('vehicle_root',o.rootId)),meta(pda('vehicle_attempt',o.attemptId),true),meta(pda('vehicle_app',o.rootId),true),meta(new PublicKey(o.terms.operator),true),meta(new PublicKey(o.terms.project),true),meta(SystemProgram.programId)]);
   const mint=(o:VehicleIssuanceOriginal,name=o.metadata.name)=>ix('mint_vehicle',[hex(o.rootId),string(name),string(o.metadata.uri)],[meta(payer.publicKey,true,true),meta(control),meta(pda('vehicle_root',o.rootId)),meta(pda('vehicle_attempt',o.attemptId),true),meta(pda('vehicle_asset',o.rootId),true),meta(collection,true),meta(authority),meta(CORE),meta(SystemProgram.programId)]);
   await execute('fixture requests fail atomically',providerControl(1),[fixtureController]);
   await refuse('provider failure cannot create a paid attempt',win,request(win),{program:VRF,code:9000});
   await execute('fixture oracle charge exceeds original budget',providerControl(2),[fixtureController]);
   await refuse('oracle overspend cannot raid reserve or application fee',win,request(win),error('Conservation'));
   await execute('restore quoted synthetic oracle charge',providerControl(0),[fixtureController]);
   const nextPolicy=Keypair.generate();
   await execute('rotate policy with bounded original-key overlap',ix('rotate_vehicle_policy',[nextPolicy.publicKey.toBuffer(),i64(await clock()+BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec))],admin));
   await executeInstructions('prefund canonical app and future asset',[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:pda('vehicle_app',win.rootId),lamports:1_000_000}),SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:pda('vehicle_asset',win.rootId),lamports:1_000_000})]);
   // Only normal requests may use the retained-wallet delivery composition.
   // Adversarial requests still exercise the original independent encoder.
   async function submit(label:string,o:VehicleIssuanceOriginal,defaultSigner:Keypair){
    if(!options.submitRequest)return executeInstructions(label,request(o,defaultSigner));
    await waitFinalized(await connection.getSlot('confirmed'));
    const sent=await options.submitRequest({chain,original:o,trust:await currentTrust(),policySigner:nextPolicy});
    const tx=await connection.getTransaction(sent.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    need(tx?.slot===sent.slot&&tx.meta?.err===null&&Number.isSafeInteger(sent.wireBytes)&&sent.wireBytes>65&&sent.wireBytes<=1232,'Retained request hook needs exact finalized execution');
    record(label+' through retained wallet wire');return sent;
   }
   const requestResult=await submit('original winning request',win,policy);
   const queue=await connection.getAccountInfo(QUEUE,'confirmed');need(queue?.data.readUInt32LE(49)===1,'Provider must retain one exact request');
   const requestBytes=vehicleVrfRequest(win.rootId,win.attemptId,vehicleTermsHash(win));need(queue.data.readUInt32LE(53)===requestBytes.length&&queue.data.subarray(57,57+requestBytes.length).equals(requestBytes),'Actual CPI differs from SDK-pinned raw request');
   need(await connection.getBalance(pda('vehicle_app',win.rootId),'confirmed')===PHASE_E_POLICY.craft.applicationFeeLamports+escrowRentReserve+1_000_000,'Application escrow lost original obligation or donation');
   need(await connection.getBalance(pda('vehicle_oracle',win.rootId),'confirmed')===escrowRentReserve,'Exact provider charge must retain its independent reserve');
   record('buyer request commits original terms and separate escrows');
   await refuse('pending original cannot settle fee',win,[settle(win)],error('Outcome'));
   await refuse('pending original cannot mint',win,[mint(win)],error('Outcome'));
   await refuse('global provider signer is refused',win,[callback(win,0,1)],{program:CRAFT,code:2006,anchorName:'ConstraintSeeds'},[fixtureController]);
   await refuse('wrong original callback arguments are refused',win,[callback(win,0,2)],{program:CRAFT,code:2006,anchorName:'ConstraintSeeds'},[fixtureController]);
   await refuse('unsigned scoped callback is refused',win,[callback(win,0,3)],{program:CRAFT,code:3010,anchorName:'AccountNotSigner'},[fixtureController]);
   await execute('pause new admissions while original resolves',pause(true));
   const result=await execute('record original winning result while paused',callback(win,0,0,options.prepareOriginal?Buffer.alloc(32):Buffer.alloc(32,255)),[fixtureController]);
   await refuse('duplicate callback cannot change result',win,[callback(win,0,0,Buffer.alloc(32))],error('NotPending'),[fixtureController]);
   await refuse('winning unpaid original cannot mint',win,[mint(win)],error('Outcome'));
   const beforeLegs=await Promise.all([operator,project].map(k=>connection.getBalance(k,'confirmed')));
   const settled=await execute('settle exact original application fee once',settle(win));
   await paid(win,settled.slot);
   const afterLegs=await Promise.all([operator,project].map(k=>connection.getBalance(k,'confirmed'))),fees=vehicleFees();
   need(afterLegs[0]! - beforeLegs[0]! === Number(fees.operator) && afterLegs[1]! - beforeLegs[1]! === Number(fees.project),'Fee legs must conserve exact original obligation');
   need(await connection.getBalance(pda('vehicle_app',win.rootId),'confirmed')===escrowRentReserve+1_000_000,'Reserve and donations must remain after once-only settlement');
   await refuse('second settlement cannot pay again',win,[settle(win)],error('Settled'));
   await refuse('changed successful metadata cannot mint',win,[mint(win,'Changed output')],error('Terms'));
   const wrongCore=mint(win);wrongCore.keys[7]=meta(SystemProgram.programId);
   await refuse('substituted Core program',win,[wrongCore],{program:CRAFT,code:2012,anchorName:'ConstraintAddress'});
   const wrongBuyer=mint(win);wrongBuyer.keys[0]=meta(chain.stranger.publicKey,true,true);
   await refuse('another signer cannot receive the original output',win,[wrongBuyer],{program:CRAFT,code:2012,anchorName:'ConstraintAddress'},[chain.stranger]);
   const balance=await connection.getBalance(payer.publicKey,'confirmed');
   await execute('fixture leaves insufficient buyer SOL for Core creation',SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:chain.stranger.publicKey,lamports:balance-1_000_000}));
   await refuse('Core funding failure rolls back prefund sweep and mint marker',win,[mint(win)],{program:SystemProgram.programId,code:1});
   await execute('fixture restores original buyer SOL',SystemProgram.transfer({fromPubkey:chain.stranger.publicKey,toPubkey:payer.publicKey,lamports:200_000_000}),[chain.stranger]);
   await refuse('later transaction failure rolls back successful Core mint',win,[mint(win),ix('not_a_real_instruction',[],[])],{program:CRAFT,code:101,anchorName:'InstructionFallbackNotFound'});
   const minted=await execute('mint original unfrozen Core asset while paused',mint(win));
   await refuse('second mint cannot create another output',win,[mint(win)],error('Minted'));
   record('winning outcome pays once and mints once despite new admission pause');
   await execute('reopen for separate local losing original',pause(false));
   const loss=await original(0,'project');await submit('original losing request with current rotated policy',loss,nextPolicy);
   await execute('record final losing draw',callback(loss,1,0,options.prepareOriginal?Buffer.alloc(32,255):Buffer.alloc(32)),[fixtureController]);
   await execute('one-lamport donation to otherwise unprefunded application escrow',SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:pda('vehicle_app',loss.rootId),lamports:1}));
   const aliasBefore=await connection.getBalance(project,'confirmed');const lossSettled=await execute('settle aliased project fallback once',settle(loss));
   await paid(loss,lossSettled.slot);
   need(await connection.getBalance(project,'confirmed')-aliasBefore===Number(fees.application),'Aliased destination must receive exactly one entire fee');
   need(await connection.getBalance(pda('vehicle_app',loss.rootId),'confirmed')===escrowRentReserve+1,'One-lamport donation must not obstruct settlement or be paid as fees');
   record('one-lamport post-request donation preserves settlement liveness and reserve');
   await refuse('losing original cannot mint',loss,[mint(loss)],error('Outcome'));
   await refuse('losing result cannot be rerolled',loss,[callback(loss,1)],error('NotPending'),[fixtureController]);
   record('ordinary loss is final and has no output or replacement authority');
   await execute('provider charges one lamport below the quoted maximum',providerControl(0,1_999_999n),[fixtureController]);
   const self=await original(0,'buyer');await submit('original self-operated site request',self,nextPolicy);
   need(await connection.getBalance(pda('vehicle_oracle',self.rootId),'confirmed')===escrowRentReserve+1,'Provider underspend remains above the independent rent reserve');
   record('oracle maximum budget allows under-spend without rent dust failure');
   await execute('record self-operated losing result',callback(self,2),[fixtureController]);
   const selfBefore=await connection.getBalance(payer.publicKey,'confirmed'),selfSettled=await execute('settle quoted self-operator share',settle(self));
   const selfTx=await connection.getTransaction(selfSettled.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});need(selfTx?.meta,'Missing fee observation');
   need(await connection.getBalance(payer.publicKey,'confirmed') - selfBefore + selfTx.meta.fee === Number(fees.operator),'Self-operated site must receive its quoted share once, separate from network fee');
   await paid(self,selfSettled.slot);
   await refuse('self-operated settlement remains once-only',self,[settle(self)],error('Settled'));
   await waitFinalized(minted.slot);
   const trust=await currentTrust();
   const measuredKeys=[control,pda('vehicle_root',win.rootId),pda('vehicle_attempt',win.attemptId),pda('vehicle_permit',win.permitId),collection,pda('vehicle_asset',win.rootId)];
   const measured=await connection.getMultipleAccountsInfoAndContext(measuredKeys,{commitment:'finalized',minContextSlot:minted.slot});
   const rents=await Promise.all(measured.value.map(async(a,i)=>{need(a,'Missing finalized account for rent measurement');return {address:measuredKeys[i]!.toBase58(),bytes:a.data.length,lamports:a.lamports,rentExemptLamports:await connection.getMinimumBalanceForRentExemption(a.data.length,'finalized')};}));
   const proof={scope:'actual finalized local winning request/result/fee/mint; synthetic provider',trust,original:win,escrowRentReserve,escrowChecks:{donationLamports:1,settledDonationEscrow:await connection.getBalance(pda('vehicle_app',loss.rootId),'confirmed'),providerUnderspendLamports:1,underspentOracleEscrow:await connection.getBalance(pda('vehicle_oracle',self.rootId),'confirmed')},rents,signatures:[requestResult,result,settled,minted].map(v=>({signature:v.signature,slot:v.slot,wireBytes:v.wireBytes}))};
   for(const item of proof.signatures){const tx=await connection.getTransaction(item.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(tx?.slot===item.slot&&tx.meta?.err===null,'Missing exact finalized winning transaction');}
   await writeFile(join(working,'vehicle-issuance-proof.json'),JSON.stringify(proof,null,2));
   await options.onMinted?.({chain,original:win,trust});
   await writeFile(join(working,'vehicle-originals.json'),JSON.stringify(originals,null,2));
  });
 return outcomes;
}
