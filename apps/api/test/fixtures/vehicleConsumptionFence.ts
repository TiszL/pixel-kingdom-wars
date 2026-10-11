/** Independent pending initial consent for the cross-table SQL fence. Registry
 * identity remains owner-attested; ownership/finality use encoded Core accounts
 * and an actually signed packet. No consumption is posted by this helper. */
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {vi} from 'vitest';
import {Keypair,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {createVehicleBurnFinalityReader,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {createVehicleActivationReservations} from '../../src/game/vehicleActivationReservations';
import {createVehicleBurnPreparations} from '../../src/game/vehicleBurnPreparations';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {vehicleServiceAsset} from './vehicleService';
import {vehicleBurnDatabase} from './vehicleBurn';
import * as migrations from '../../src/db/migrate';

export async function pendingInitialVehicleBurn(f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,sameAsset?:Awaited<ReturnType<typeof vehicleServiceAsset>>){
 const wallet=sameAsset?f.wallet:Keypair.generate(),actor=wallet.publicKey.toBase58(),baseId=randomUUID(),berthId=randomUUID(),jobId=randomUUID();
 await f.conn.sql`insert into players(wallet) values(${actor}) on conflict do nothing`;
 await f.conn.sql`insert into bases(id,owner_wallet) values(${baseId},${actor})`;
 await f.conn.sql`insert into base_slots(wallet,slot,base_id) select ${actor},coalesce(max(slot),0)+1,${baseId} from base_slots where wallet=${actor}`;
 await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berthId},${actor},${baseId},'berth',8,8)`;
 await f.conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${jobId},${actor},${baseId},${berthId},'build',date_trunc('milliseconds',now())-interval '2 hours',date_trunc('milliseconds',now())-interval '1 hour',date_trunc('milliseconds',now())-interval '1 hour')`;
 const asset=sameAsset??await vehicleServiceAsset(f,{owner:actor}),reservations=createVehicleActivationReservations(f.conn.db);
 // Deliberate defense-in-depth fixture: only the earlier reservation exclusion
 // is bypassed, never a consumption, completeness or identifier-fence guard.
 if(sameAsset)await f.conn.sql`alter table vehicle_activation_reservations disable trigger vehicle_activation_asset_service_exclusion`;
 let reservation:Awaited<ReturnType<typeof reservations.reserve>>;
 try{reservation=await reservations.reserve({wallet:actor,assetId:asset.identity.assetId,berthId,idempotencyKey:randomUUID()},{baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}});}
 finally{if(sameAsset)await f.conn.sql`alter table vehicle_activation_reservations enable trigger vehicle_activation_asset_service_exclusion`;}
 let slot=300,transaction:VersionedTransactionResponse|null=null;
 const rpc:VehicleBurnFinalityRpc={...asset.rpc,getSlot:async()=>slot,getMultipleAccountsInfoAndContext:async(...args)=>({...await asset.rpc.getMultipleAccountsInfoAndContext(...args),context:{slot}}),
  getSignaturesForAddress:async()=>[...transaction?[{signature:transaction.transaction.signatures[0]!,slot:transaction.slot,err:null,memo:null,blockTime:transaction.blockTime??null,confirmationStatus:'finalized' as const}]:[],{signature:bs58.encode(Buffer.alloc(64,1)),slot:290,err:null,memo:null,blockTime:null,confirmationStatus:'finalized' as const}],
  getTransaction:async signature=>transaction?.transaction.signatures[0]===signature?transaction:null,
  getBlockSignatures:async requested=>({signatures:transaction?.slot===requested?[transaction.transaction.signatures[0]!]:[]})};
 let preparations:ReturnType<typeof createVehicleBurnPreparations>;
 const reader=createVehicleBurnFinalityReader(()=>rpc,f.trust,id=>preparations.loadSavedReservation(id));
 preparations=createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner:reader.captureOwner,getBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:slot,lastValidBlockHeight:1000})});
 const preparation=await preparations.prepare(actor,reservation.id),message=Message.from(Buffer.from(preparation.messageHex,'hex')),signed=new VersionedTransaction(message);signed.sign([wallet]);
 const signature=bs58.encode(signed.signatures[0]!),pre=message.accountKeys.map(()=>10_000_000),post=[...pre],index=message.accountKeys.findIndex(k=>k.toBase58()===asset.identity.assetId);post[0]!+=995_000;post[index]!-=1_000_000;
 transaction={slot:310,blockTime:1_700_000_000,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};slot=320;
 const proof=await reader.verify({reservationId:reservation.id,signedTransaction:signed.serialize()});
 return {wallet,actor,baseId,berthId,reservation,preparation,proof};
}

/** Run the real isolated fixture against the real0213 migration prefix. Only
 * migration-folder selection changes; no migration, source guard or proof does. */
export async function preServiceApplicationVehicleBurn(){
 const root=fileURLToPath(new URL('../../drizzle',import.meta.url)),folder=await mkdtemp(path.join(tmpdir(),'vehicle-consumption-prefix-'));
 const real=migrations.runMigrations;
 try{
  const journal=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
  const index=journal.entries.findIndex(e=>e.tag==='0214_vehicle_service_applications');if(index<0)throw Error('Registered0214 fixture required');
  await mkdir(path.join(folder,'meta'));for(const entry of journal.entries.slice(0,index))await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,index)}));
  const spy=vi.spyOn(migrations,'runMigrations').mockImplementationOnce(db=>real(db,{migrationsFolder:folder}));
  try{return await vehicleBurnDatabase();}finally{spy.mockRestore();}
 }finally{await rm(folder,{recursive:true,force:true});}
}
