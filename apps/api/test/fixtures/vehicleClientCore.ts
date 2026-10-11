/** D182 executes ordinary Core mint/burn consent against the pinned owned local
 * validator, then the real private API installation/service source. Mint registry
 * enrollment remains explicitly owner-attested; no production mint claim. */
import { VEHICLE_CRAFT_PROGRAM } from '@shardkeep/chain/vehicle-issuance-protocol';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {Keypair,PublicKey,TransactionInstruction,Message,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {expect} from 'vitest';
import {makeVehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {vehicleClientCurrentRpcConnection} from '@shardkeep/chain/vehicle-client-current';
import {withCharterValidator} from '../../../../programs/charter-local-fixture';
import {resourceClaimsDatabase} from './resourceClaimsDatabase';
import {createVehicleActivationReservations} from '../../src/game/vehicleActivationReservations';
import {createVehicleClient} from '../../src/game/vehicleClient';
const ROOT=fileURLToPath(new URL('../../../../',import.meta.url)),CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),CRAFT=new PublicKey(VEHICLE_CRAFT_PROGRAM);
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const requireChain=createRequire(new URL('../../../../packages/chain/package.json',import.meta.url));
type UmiInstruction={programId:string;keys:{pubkey:string;isSigner:boolean;isWritable:boolean}[];data:Uint8Array};
type Builder=(context:unknown,input:Record<string,unknown>)=>{getInstructions:()=>UmiInstruction[]};
const {createV2,createCollectionV2}=requireChain('@metaplex-foundation/mpl-core') as {createV2:Builder;createCollectionV2:Builder};
const {createNoopSigner,publicKey}=requireChain('@metaplex-foundation/umi') as {createNoopSigner:(v:string)=>unknown;publicKey:(v:string)=>string};
const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default;
function need(v:unknown,why:string):asserts v{if(!v)throw Error(why);}
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
export async function actualVehicleClientCoreJourney(){
 const corePath=process.env['PHASE_E_CHARTER_CORE_BINARY'];need(corePath,'Explicit pinned local Core binary required');
 const craftPath=resolve(ROOT,'programs/target/deploy/shardkeep_craft.so'),coreBinary=await readFile(corePath),craftBinary=await readFile(craftPath);
 need(hash(coreBinary)==='69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee','Unreviewed Core ELF');need(hash(craftBinary)==='702efa44374d473f862fb5e49bea49c87c6aec736fbc712f392939c9ca7423cd','Unreviewed craft ELF');
 const version=spawnSync('solana-test-validator',['--version'],{encoding:'utf8',timeout:10000});need(version.status===0&&/solana-test-validator 2\.3\.13/.test(version.stdout),'Pinned Agave2.3.13 required');
 const sdk=JSON.parse(await readFile(resolve(ROOT,'packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'),'utf8')).version,umi=JSON.parse(await readFile(resolve(ROOT,'packages/chain/node_modules/@metaplex-foundation/umi/package.json'),'utf8')).version;
 need(sdk==='1.10.0'&&umi==='1.5.1','Pinned Core SDK/UMI required');
 await withCharterValidator({corePath,craftPath,coreBinary,craftBinary,craft:CRAFT,idlSha256:hash(await readFile(resolve(ROOT,'programs/target/idl/shardkeep_craft.json'))),validatorVersion:version.stdout.trim(),coreSdkVersion:sdk,umiVersion:umi,scope:'D182 actual ordinary vehicle client Core burns'},'vehicle-client',async chain=>{
  const {connection,payer}=chain,actor=payer.publicKey.toBase58(),collection=Keypair.generate(),asset=Keypair.generate(),serviceAsset=Keypair.generate();
  const signer=(pair:Keypair)=>createNoopSigner(publicKey(pair.publicKey.toBase58()));
  const context={payer:signer(payer),programs:{getPublicKey:(_name:string,fallback:string)=>publicKey(fallback)}};
  const instructions=(builder:Builder,input:Record<string,unknown>)=>builder(context,input).getInstructions().map(ix=>new TransactionInstruction({programId:new PublicKey(ix.programId),keys:ix.keys.map(k=>({...k,pubkey:new PublicKey(k.pubkey)})),data:Buffer.from(ix.data)}));
  await chain.executeInstructions('ordinary vehicle collection',instructions(createCollectionV2,{collection:signer(collection),updateAuthority:publicKey(actor),name:'D182 local vehicle collection',uri:'',plugins:null,externalPluginAdapters:null}),[collection]);
  async function mint(pair:Keypair,label:string){const minted=await chain.executeInstructions(label,instructions(createV2,{asset:signer(pair),collection:publicKey(collection.publicKey.toBase58()),authority:signer(payer),payer:signer(payer),owner:publicKey(actor),systemProgram:publicKey(SystemProgram.programId.toBase58()),name:label,uri:'',plugins:null,externalPluginAdapters:null}),[pair]);
   // executeInstructions establishes confirmed execution; owner admission requires finalized accounts.
   const until=Date.now()+30000;while(await connection.getSlot('finalized')<minted.slot&&Date.now()<until)await sleep(100);need(await connection.getSlot('finalized')>=minted.slot,'Mint did not finalize');
  }
  await mint(asset,'ordinary initial vehicle');
  const pd=PublicKey.findProgramAddressSync([CORE.toBuffer()],LOADER)[0],code=await connection.getAccountInfo(pd,'finalized');need(code,'Core ProgramData missing');
  const trust={expectedGenesisHash:await connection.getGenesisHash(),reviewedDeploymentSlot:Number(code.data.readBigUInt64LE(4)),reviewedProgramDataSha256:hash(code.data),upgradeAuthority:code.data[12]===0?null:new PublicKey(code.data.subarray(13,45)).toBase58()};
  const db=resourceClaimsDatabase();await db.setup();const baseId=randomUUID(),berthId=randomUUID(),jobId=randomUUID();
  try{
   await db.sql`insert into players(wallet) values(${actor})`;await db.sql`insert into bases(id,owner_wallet) values(${baseId},${actor})`;await db.sql`insert into base_slots(wallet,slot,base_id) values(${actor},1,${baseId})`;
   await db.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berthId},${actor},${baseId},'berth',2,2)`;
   await db.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${jobId},${actor},${baseId},${berthId},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
   const registry=createVehicleActivationReservations(db.db),identity={assetId:asset.publicKey.toBase58(),collection:collection.publicKey.toBase58(),family:'survey_balloon' as const,tier:1 as const};
   await registry.register(identity,{fixture:'actual local Core mint; registry enrollment remains owner-attested'});
   const deps={connect:(signal:AbortSignal)=>makeVehicleBurnFinalityRpc(connection.rpcEndpoint,signal),trust,getBlockhash:async()=>{const r=await connection.getLatestBlockhashAndContext('finalized');return {...r.value,contextSlot:r.context.slot};}};
   const connectCurrent=vehicleClientCurrentRpcConnection(connection.rpcEndpoint);
   const client=createVehicleClient(db.db,{installation:deps,service:deps,current:{connect:signal=>{const rpc=connectCurrent(signal);return {...rpc,sendRawTransaction:async(...args)=>{try{return await rpc.sendRawTransaction(...args);}catch(error){console.error('Actual Core vehicle send failed',error);throw error;}}};},trust}}),signatures:{label:string;signature:string;slot:number}[]=[];
   async function finish(ref:{kind:'installation'|'service';id:string},label:string){
    const prepared=await client.prepare(actor,ref);expect(await client.review(actor,ref)).toMatchObject({status:'ready'});const p=prepared.record.preparation!;
    const tx=new VersionedTransaction(Message.from(Buffer.from(p.messageHex,'hex')));tx.sign([payer]);const signature=bs58.encode(tx.signatures[0]!);
    await client.retainSigned(actor,ref,tx.serialize());const sent=await client.deliver(actor,ref);expect(sent.status,JSON.stringify(sent)).toBe('submitted');expect(sent.signature).toBe(signature);
    await connection.confirmTransaction({signature,blockhash:p.blockhash,lastValidBlockHeight:p.lastValidBlockHeight},'finalized');
    const original=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(original&&original.meta?.err===null,'Core burn failed');
    // History verifier requires a closing bank strictly after the burn. Bounded
    // local validator progress, no mocked finality or synthesized transaction.
    const until=Date.now()+30000;while(await connection.getSlot('finalized')<=original.slot&&Date.now()<until)await sleep(100);need(await connection.getSlot('finalized')>original.slot,'Closing bank did not advance');
    const result=await client.recover(actor,ref);expect(result.burnReceipt?.signature).toBe(signature);expect(result.burnReceipt?.slot).toBe(original.slot);signatures.push({label,signature,slot:original.slot});return result;
   }
   const reservation=await client.reserve(actor,'installation',{baseId,berthId,assetId:identity.assetId,idempotencyKey:randomUUID()});need(reservation.kind==='installation','Wrong initial kind');const installationId=reservation.record.reservation.reservationId;
   expect(await finish({kind:'installation',id:installationId},'initial burn/install')).toMatchObject({record:{status:'installed',installation:{installationId,baseId,berthId}}});
   await mint(serviceAsset,'ordinary service vehicle');await registry.register({...identity,assetId:serviceAsset.publicKey.toBase58()},{fixture:'actual local Core service mint; owner-attested registry'});
   const service=await client.reserve(actor,'service',{installationId,assetId:serviceAsset.publicKey.toBase58(),operation:'upgrade',idempotencyKey:randomUUID()});need(service.kind==='service','Wrong service kind');
   const applied=await finish({kind:'service',id:service.record.intent.intentId},'service burn/upgrade');expect(applied).toMatchObject({record:{status:'applied',application:{tierAfter:2,revisionAfter:1}}});
   const offline=createVehicleClient(db.db);expect(await offline.read(actor,{kind:'installation',id:installationId})).toMatchObject({record:{status:'installed'}});expect(await offline.deliver(actor,{kind:'service',id:service.record.intent.intentId})).toMatchObject({status:'terminal'});
   expect(await db.sql`select count(*)::int n from vehicle_burn_consumptions`).toEqual([{n:1}]);expect(await db.sql`select count(*)::int n from vehicle_service_consumptions`).toEqual([{n:1}]);
   await writeFile(join(chain.working,'vehicle-client-submitted-transactions.json'),JSON.stringify(signatures,null,2));chain.record('D182 actual initial and service API consent/burn/application pass');
  }finally{await db.close();}
 });
}
