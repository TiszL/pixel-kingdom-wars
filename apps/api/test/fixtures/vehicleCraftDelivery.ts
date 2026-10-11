import {sql} from 'drizzle-orm';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import {vi} from 'vitest';
import {VEHICLE_CRAFT_PROGRAM} from '@shardkeep/chain/vehicle-issuance-protocol';
import {createVehicleIssuanceQuoteReader} from '@shardkeep/chain/vehicle-issuance-quote';
import {vehicleIssuanceQuoteFixture} from '../../../../packages/chain/src/testFixtures/vehicleIssuanceQuote';
import type {createDb} from '../../src/db/client';
import {VEHICLE_ISSUER_PURPOSE,vehicleIssuerAttemptFromMaterial,vehicleIssuerReceipt} from '../../src/vehiclePolicyIssuerJournal';
import {createVehicleCraftPreparation} from '../../src/game/vehicleCraftPreparation';
import {createVehicleCraftSignedStore} from '../../src/game/vehicleCraftSignedStore';
import type {VehicleCraftClientFixture} from './vehicleCraftClient';
import {signVehiclePolicy} from './vehiclePolicyIssuer';
import {resealVehicleRequestFixture} from './vehicleCraftPreparation';
/** Rebind only the additive private test seals after inherited earned-source
 * clock setup. No retained request or delivery may exist at this point. */
export async function resealVehicleDeliveryFixture(conn:ReturnType<typeof createDb>):Promise<void>{
 if(!conn.sql.options.host.every(host=>['localhost','127.0.0.1','::1'].includes(host)))throw new Error('vehicle delivery fixture requires loopback');
 const [identity]=await conn.sql`select current_database() name,((select count(*) from public.vehicle_request_dispatches)+(select count(*) from public.vehicle_request_dispatch_acknowledgements)+(select count(*) from public.vehicle_request_delivery_receipts))::int n`;
 if(!identity||!/^\w+_test$/.test(identity.name)||identity.n!==0)throw new Error('vehicle delivery fixture requires empty disposable DB');
 await resealVehicleRequestFixture(conn);
 await conn.db.transaction(async tx=>{
  await tx.execute(sql`select public.shardkeep_vehicle_request_source()`);
  const [contract]=await tx.execute<{record:unknown}>(sql`select public.shardkeep_vehicle_delivery_contract() record`);if(!contract)throw new Error('missing vehicle delivery fixture source');
  await tx.execute(sql`alter table public.vehicle_request_delivery_contract disable trigger vehicle_request_delivery_contract_guard`);
  await tx.execute(sql`update public.vehicle_request_delivery_contract set record=${JSON.stringify(contract.record)}::jsonb where singleton`);
  await tx.execute(sql`alter table public.vehicle_request_delivery_contract enable trigger vehicle_request_delivery_contract_guard`);
  await tx.execute(sql`select public.shardkeep_vehicle_delivery_source()`);
 });
}
/** Genuine held inputs and real local wallet consent; current finalized banks
 * remain the explicit serialized source fixture. No transaction is broadcast. */
export async function prepareVehicleDeliveryFixture(f:VehicleCraftClientFixture){
 const material=await f.reserve(),request={wallet:material.actorWallet,idempotencyKey:material.request.idempotencyKey},policy=Keypair.generate(),publicKey=policy.publicKey.toBase58();
 const attempt=vehicleIssuerAttemptFromMaterial(material,request,publicKey,{purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:material.original.genesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM});
 const receipt=vehicleIssuerReceipt({attempt,signatureHex:Buffer.from(signVehiclePolicy(policy,Buffer.from(attempt.messageHex,'hex'))).toString('hex')})!;
 const bank=vehicleIssuanceQuoteFixture(material.original,policy),quote=createVehicleIssuanceQuoteReader(()=>bank.rpc,bank.trust,publicKey,{costLimits:bank.costLimits});
 const prepared=await createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer:{publicKey,issueOnce:async()=>receipt,lookup:async()=>receipt},quote}).prepare(request,new AbortController().signal);
 const tx=new VersionedTransaction(Message.from(Buffer.from(prepared.preparation!.quote.messageHex,'hex')));tx.sign([f.seller.signer]);const bytes=tx.serialize(),wire=await createVehicleCraftSignedStore(f.db).accept(request,bytes);
 bank.controls.slot=bank.controls.feeSlot=bank.controls.initialBankSlot=bank.controls.finalBankSlot=prepared.preparation!.quote.source.closingSlot;
 const status=vi.fn(async()=>({context:{slot:bank.controls.slot},value:[null] as unknown[]})),send=vi.fn(async(_bytes:Uint8Array,_options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number})=>wire.signature);
 const rpc={...bank.rpc,getSignatureStatuses:status,isBlockhashValid:vi.fn(async()=>({context:{slot:bank.controls.slot},value:true})),sendRawTransaction:send};
 return {material,request,prepared,wire,bytes,bank,policy,receipt,status,send,rpc,saved:{quote:prepared.preparation!.quote,signedTransaction:bytes}};
}
