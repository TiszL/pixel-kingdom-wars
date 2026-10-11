/** Actual craft -> plain Core -> finalized original -> private registry -> the
 * existing original Core burn/install path. No owner attestation is fabricated. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {Message,VersionedTransaction,PublicKey,type AccountInfo} from '@solana/web3.js';
import {expect} from 'vitest';
import {createVehicleIssuanceEvidenceReader,type VehicleIssuanceEvidenceRpc} from '@shardkeep/chain/vehicle-issuance-evidence';
import {makeVehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {vehicleClientCurrentRpcConnection} from '@shardkeep/chain/vehicle-client-current';
import {runVehicleIssuanceProgram} from '../../../../programs/vehicle-local-issuance';
import {createVehicleIssuanceAcquisitions} from '../../src/game/vehicleIssuanceAcquisitions';
import {createVehicleClient} from '../../src/game/vehicleClient';
import {resourceClaimsDatabase} from './resourceClaimsDatabase';
const requireChain=createRequire(new URL('../../../../packages/chain/package.json',import.meta.url));
const ChainPublicKey=(requireChain('@solana/web3.js') as {PublicKey:typeof PublicKey}).PublicKey;
const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function need(v:unknown,why:string):asserts v{if(!v)throw Error(why);}
export async function actualVehicleIssuanceAcquisition(){
 const db=resourceClaimsDatabase();await db.setup();const storage=createVehicleIssuanceAcquisitions(db.db);
 try{await runVehicleIssuanceProgram({onOriginal:async({original})=>{await storage.saveOriginal(original);},onMinted:async({chain,original,trust})=>{
  const {connection,payer}=chain,actor=payer.publicKey.toBase58();expect(await storage.loadOriginal(original.rootId)).toEqual(original);
  const connect=():VehicleIssuanceEvidenceRpc=>({getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   const result=await connection.getMultipleAccountsInfoAndContext(addresses.map(a=>new PublicKey(a.toBytes())),options);return {context:result.context,value:result.value.map((a:AccountInfo<Buffer>|null,i:number)=>a===null?null:{address:addresses[i]!,owner:new ChainPublicKey(a.owner.toBytes()),executable:a.executable,data:Buffer.from(a.data)})};
  }});
  const readFinalized=createVehicleIssuanceEvidenceReader(connect,trust,storage.loadOriginal),acquisitions=createVehicleIssuanceAcquisitions(db.db,{readFinalized});
  const acquisition=await acquisitions.acquire(original.rootId);expect(acquisition.buyer).toBe(actor);
  expect(await db.sql`select provenance,owner_attestation,issuance_root from vehicle_mint_registry where asset_id=${original.identity.assetId}`).toEqual([{provenance:'finalized_issuance',owner_attestation:null,issuance_root:original.rootId}]);
  const baseId=randomUUID(),berthId=randomUUID(),jobId=randomUUID();
  await db.sql`insert into players(wallet) values(${actor})`;await db.sql`insert into bases(id,owner_wallet) values(${baseId},${actor})`;await db.sql`insert into base_slots(wallet,slot,base_id) values(${actor},1,${baseId})`;
  await db.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berthId},${actor},${baseId},'berth',2,2)`;
  await db.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${jobId},${actor},${baseId},${berthId},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
  const coreTrust={expectedGenesisHash:trust.expectedGenesisHash,reviewedDeploymentSlot:trust.core.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.core.reviewedProgramDataSha256,upgradeAuthority:trust.core.upgradeAuthority};
  const deps={connect:(signal:AbortSignal)=>makeVehicleBurnFinalityRpc(connection.rpcEndpoint,signal),trust:coreTrust,getBlockhash:async()=>{const r=await connection.getLatestBlockhashAndContext('finalized');return {...r.value,contextSlot:r.context.slot};}};
  const client=createVehicleClient(db.db,{installation:deps,current:{connect:vehicleClientCurrentRpcConnection(connection.rpcEndpoint),trust:coreTrust}});
  const reservation=await client.reserve(actor,'installation',{baseId,berthId,assetId:original.identity.assetId,idempotencyKey:randomUUID()});need(reservation.kind==='installation','Wrong installation kind');
  const installationId=reservation.record.reservation.reservationId,ref={kind:'installation' as const,id:installationId};
  const prepared=await client.prepare(actor,ref);expect(await client.review(actor,ref)).toMatchObject({status:'ready'});const p=prepared.record.preparation!;
  const tx=new VersionedTransaction(Message.from(Buffer.from(p.messageHex,'hex')));tx.sign([payer]);const signature=bs58.encode(tx.signatures[0]!);
  await client.retainSigned(actor,ref,tx.serialize());expect(await client.deliver(actor,ref)).toMatchObject({status:'submitted',signature});
  await connection.confirmTransaction({signature,blockhash:p.blockhash,lastValidBlockHeight:p.lastValidBlockHeight},'finalized');
  const burn=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(burn&&burn.meta?.err===null,'Original vehicle Core burn did not finalize');
  const deadline=Date.now()+30000;while(await connection.getSlot('finalized')<=burn.slot&&Date.now()<deadline)await sleep(100);need(await connection.getSlot('finalized')>burn.slot,'No closing bank after burn');
  const result=await client.recover(actor,ref);expect(result).toMatchObject({record:{status:'installed',installation:{installationId,baseId,berthId}},burnReceipt:{signature,slot:burn.slot}});
  // The exact acquisition remains available after destruction, without RPC or
  // a fresh claim that the burned asset still exists/currently belongs to buyer.
  expect(await storage.acquire(original.rootId)).toEqual(acquisition);expect(await createVehicleClient(db.db).read(actor,ref)).toMatchObject({record:{status:'installed'}});
  expect(await db.sql`select count(*)::int n from vehicle_burn_consumptions`).toEqual([{n:1}]);
  await writeFile(join(chain.working,'vehicle-issuance-acquisition-install.json'),JSON.stringify({scope:'actual local program/Core/private API; synthetic provider only',original,acquisition,burn:{signature,slot:burn.slot},installation:result},null,2));
  chain.record('actual original issuance -> finalized acquisition -> ordinary Core burn -> installed; immutable acquisition replay after burn');
 }});}finally{await db.close();}
}
