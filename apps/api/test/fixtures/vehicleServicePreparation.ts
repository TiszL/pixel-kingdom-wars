/** Dedicated B5r fixture: actual initial burn/install and private service intent.
 * Encoded Core RPC and locally signed packets, never live-chain attestation. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {createVehicleServiceBurnFinalityReader,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-service-burn-finality';
import {vehicleBurnDatabase} from './vehicleBurn';
import type {PhaseEVehicleFamily,PhaseEVehicleTier} from '@shardkeep/shared/phaseEVehicles';
import {vehicleServiceAsset} from './vehicleService';
import {createVehicleInstallations} from '../../src/game/vehicleInstallations';
import {createVehicleServiceIntents} from '../../src/game/vehicleServiceIntents';
import {createVehicleServiceBurnPreparations,type VehicleServiceBurnPreparation} from '../../src/game/vehicleServiceBurnPreparations';
export async function vehicleServiceInstalledFixture(options:{family?:PhaseEVehicleFamily;tier?:PhaseEVehicleTier}={}){
 const f=await vehicleBurnDatabase(options.family,options.tier,{}, {completedAt:new Date(Date.now()-7*86400000)});
 try{
  for(const file of ['0212_vehicle_service_burn_preparations.sql'])await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../../drizzle/'+file,import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});
  f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
  return f;
 }catch(error){await f.dispose();throw error;}
}
export async function vehicleServiceConsentFixture(f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,options:{operation?:'upgrade'|'restore_uses';tier?:PhaseEVehicleTier}={}){
  const asset=await vehicleServiceAsset(f,options.tier===undefined?{}:{tier:options.tier}),intent=await createVehicleServiceIntents(f.conn.db,{captureOwner:asset.reader.captureOwner}).reserve({wallet:f.actor,installationId:f.reservation.id,assetId:asset.identity.assetId,operation:options.operation??'upgrade',idempotencyKey:randomUUID()});
  let slot=200,transaction:VersionedTransactionResponse|null=null;
  const blockhash={blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:slot,lastValidBlockHeight:1000};
  const rpc:VehicleBurnFinalityRpc={...asset.rpc,getSlot:async()=>slot,getMultipleAccountsInfoAndContext:async(...args)=>({...await asset.rpc.getMultipleAccountsInfoAndContext(...args),context:{slot}}),getSignaturesForAddress:async()=>[...transaction?[{signature:transaction.transaction.signatures[0]!,slot:transaction.slot,err:null,memo:null,blockTime:transaction.blockTime??null,confirmationStatus:'finalized' as const}]:[],{signature:bs58.encode(Buffer.alloc(64,1)),slot:190,err:null,memo:null,blockTime:null,confirmationStatus:'finalized' as const}],getTransaction:async signature=>transaction?.transaction.signatures[0]===signature?transaction:null,getBlockSignatures:async requested=>({signatures:transaction?.slot===requested?[transaction.transaction.signatures[0]!]:[]})};
  let preparations:ReturnType<typeof createVehicleServiceBurnPreparations>;
  const reader=createVehicleServiceBurnFinalityReader(()=>rpc,f.trust,id=>preparations.loadSavedReservation(id));
  preparations=createVehicleServiceBurnPreparations(f.conn.db,{captureOwner:reader.captureOwner,getBlockhash:async()=>blockhash});
  function finalizeService(p:VehicleServiceBurnPreparation){const message=Message.from(Buffer.from(p.messageHex,'hex')),signed=new VersionedTransaction(message);signed.sign([f.wallet]);const signature=bs58.encode(signed.signatures[0]!),pre=message.accountKeys.map(()=>10_000_000),post=[...pre],index=message.accountKeys.findIndex(k=>k.toBase58()===asset.identity.assetId);post[0]!+=995_000;post[index]!-=1_000_000;transaction={slot:210,blockTime:1_700_000_000,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};slot=220;return {signature,signedTransaction:signed.serialize(),transaction};}
  return {asset,intent,preparations,reader,rpc,blockhash,finalizeService};
}
export async function vehicleServicePreparationFixture(){
 const f=await vehicleServiceInstalledFixture();
 try{return {...f,initial:f,...await vehicleServiceConsentFixture(f)};}
 catch(error){await f.dispose();throw error;}
}
