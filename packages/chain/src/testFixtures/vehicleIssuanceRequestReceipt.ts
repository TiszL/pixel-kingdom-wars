/** Synthetic raw JSON history for an exact saved local test wire. */
import {Message,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vehicleIssuanceFixture} from './vehicleIssuance';
import {copyVehicleRequestSaved,type VehicleIssuanceRequestSaved,type VehicleIssuanceRequestRef} from '../vehicleIssuanceCurrent';
import {vehiclePda,vehicleTermsBytes,vehicleTermsHash,vehicleKeccak,vehicleVrfRequest,vehicleFees,VEHICLE_VRF_QUEUE} from '../vehicleIssuanceProtocol';
import type {VehicleIssuanceRequestReceiptRpc} from '../vehicleIssuanceRequestReceipt';
export function vehicleIssuanceRequestReceiptFixture(savedInput:VehicleIssuanceRequestSaved,ref:VehicleIssuanceRequestRef){
 const saved=copyVehicleRequestSaved(savedInput,ref),q=saved.quote,o=q.original,f=vehicleIssuanceFixture(o.rootId),rows=f.rows.filter((_,j)=>j!==10&&j!==11).map(r=>({...r,data:Buffer.from(r.data)}));
 const txSlot=q.source.closingSlot+1,accountSlot=txSlot+4,at=BigInt(q.source.final.admission.unixTimestamp),control={slot:accountSlot,missing:false};
 rows[6]!.data=Buffer.from(q.source.final.controlHex,'hex');rows[6]!.data[177]=1; // Historical proof permits later admission pause.
 const r=rows[7]!.data,a=rows[8]!.data,p=rows[9]!.data;
 const key=(b:Buffer,n:number,s:string)=>new PublicKey(s).toBuffer().copy(b,n),hex=(b:Buffer,n:number,s:string)=>Buffer.from(s,'hex').copy(b,n),terms=vehicleTermsHash(o);
 rows[7]!.address=vehiclePda('vehicle_root',o.rootId)[0];rows[8]!.address=vehiclePda('vehicle_attempt',o.attemptId)[0];rows[9]!.address=vehiclePda('vehicle_permit',o.permitId)[0];
 hex(r,9,o.rootId);hex(r,25,o.attemptId);key(r,41,o.buyer);key(r,73,rows[8]!.address.toBase58());key(r,105,o.identity.assetId);hex(r,137,terms);r[169]=vehiclePda('vehicle_root',o.rootId)[1];
 key(a,9,rows[7]!.address.toBase58());hex(a,41,o.rootId);hex(a,57,o.attemptId);key(a,73,o.buyer);hex(a,105,o.permitId);key(a,121,o.identity.collection);key(a,153,o.identity.assetId);vehicleTermsBytes(o.terms).copy(a,185);hex(a,393,terms);vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,terms)).copy(a,425);
 const fees=vehicleFees();a.writeBigUInt64LE(fees.application,457);a.writeBigUInt64LE(fees.operator,465);a.writeBigUInt64LE(fees.project,473);a.fill(0,481,516);a.writeBigInt64LE(at,516);a.writeBigUInt64LE(BigInt(txSlot),524);a.fill(0,532,556);a[556]=vehiclePda('vehicle_attempt',o.attemptId)[1];
 hex(p,9,o.permitId);key(p,25,o.buyer);key(p,57,rows[7]!.address.toBase58());key(p,89,rows[8]!.address.toBase58());hex(p,121,terms);p.writeBigInt64LE(BigInt(o.permitExpiry),153);p.writeBigInt64LE(at,161);p[169]=vehiclePda('vehicle_permit',o.permitId)[1];
 const clock=rows.find(r=>r.address.equals(SYSVAR_CLOCK_PUBKEY))!;clock.data.writeBigUInt64LE(BigInt(accountSlot));clock.data.writeBigInt64LE(at+1n,32);
 const m=Message.from(Buffer.from(q.messageHex,'hex')),keys=m.accountKeys.map(k=>k.toBase58()),pre=keys.map(k=>Number(q.source.final.balances.find(b=>b.address===k)?.lamports??'1000000')),post=[...pre],fee=Number(q.costs.networkFeeLamports),delta=(address:string,amount:bigint)=>{const i=keys.indexOf(address);post[i]=Number(BigInt(post[i]!)+amount);};
 for(const alloc of q.costs.allocations)delta(alloc.address,BigInt(alloc.topUpLamports));delta(o.buyer,-BigInt(q.costs.requiredLamports));delta(vehiclePda('vehicle_app',o.rootId)[0].toBase58(),BigInt(q.costs.applicationFundingLamports));delta(vehiclePda('vehicle_oracle',o.rootId)[0].toBase58(),BigInt(q.costs.oracleFundingLamports));
 const tx={slot:txSlot,version:'legacy',transaction:{signatures:[saved.wire.signature],message:{header:{...m.header},accountKeys:keys,recentBlockhash:m.recentBlockhash,instructions:m.instructions.map(i=>({...i,accounts:[...i.accounts]}))}},meta:{err:null as unknown,fee,preBalances:pre,postBalances:post,preTokenBalances:[],postTokenBalances:[]}};
 const rpc:VehicleIssuanceRequestReceiptRpc={getGenesisHash:async()=>o.genesisHash,getSlot:async()=>control.slot,getTransaction:async()=>control.missing?null:tx,getMultipleAccountsInfoAndContext:async addresses=>({context:{slot:control.slot},value:addresses.map(k=>rows.find(r=>r.address.equals(k))??null)})};
 function revert(){tx.meta.err={InstructionError:[1,{Custom:6000}]};tx.meta.postBalances=tx.meta.preBalances.map((n,i)=>n-(i===0?fee:0));}
 function spendOracle(amount:bigint){delta(vehiclePda('vehicle_oracle',o.rootId)[0].toBase58(),-amount);delta(VEHICLE_VRF_QUEUE,amount);}
 return {saved:{quote:saved.quote,signedTransaction:saved.signedTransaction},wire:saved.wire,ref,trust:f.trust,rows,tx,rpc,control,revert,spendOracle};
}
