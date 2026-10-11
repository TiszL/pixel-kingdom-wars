/** Read-only original receipts. Never used as mint, ownership or signing proof. */
import {PHASE_E_VEHICLE_CLIENT as P} from '@shardkeep/shared';
import {VehicleCraftRecordSchema,type VehicleCraftRecord} from '@shardkeep/shared/vehicleCraftClientApi';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
const MAX_BYTES=1024*1024;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const immutable=(r:VehicleCraftRecord)=>{const {status:_s,consumedAt:_c,mintedAt:_m,serverNow:_n,...original}=r;return original;};
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export function mergeVehicleCraftReceipt(before:VehicleCraftRecord,next:VehicleCraftRecord){
 need(same(immutable(before),immutable(next)),'The saved craft identity or materials changed.');
 need(!before.consumedAt||before.consumedAt===next.consumedAt,'The original consumption receipt changed.');
 need(!before.mintedAt||before.mintedAt===next.mintedAt,'The original mint receipt changed.');
 need(before.status==='held'||before.status===next.status||before.status==='won_unminted'&&next.status==='minted','The saved craft outcome cannot move backwards or switch results.');
 return next;
}
export class VehicleCraftCache{
 readonly identity:CharterIdentity;readonly key:string;
 constructor(identity:CharterIdentity,private storage:Storage=localStorage,private locks:LockManager|undefined=navigator.locks){this.identity=charterIdentity(identity);this.key='pkw-vehicle-craft-v1:'+JSON.stringify(this.identity);}
 read():VehicleCraftRecord[]{
  const raw=this.storage.getItem(this.key);if(raw===null)return [];
  need(raw.length<=MAX_BYTES,'Saved craft history is too large to read safely.');
  const value=JSON.parse(raw) as {version:unknown;identity:unknown;records:unknown};
  need(value&&Object.keys(value).sort().join(',')==='identity,records,version'&&value.version===1&&same(value.identity,this.identity)&&Array.isArray(value.records)&&value.records.length<=P.localPendingLimit+P.localArchiveLimit,'Saved craft history is damaged.');
  const records=value.records.map(r=>VehicleCraftRecordSchema.parse(r));
  need(records.every(r=>r.wallet===this.identity.wallet)&&new Set(records.map(r=>r.idempotencyKey)).size===records.length,'Saved craft history belongs to another account.');return records;
 }
 async retain(raw:VehicleCraftRecord[]){
  const incoming=raw.map(r=>VehicleCraftRecordSchema.parse(r));need(incoming.every(r=>r.wallet===this.identity.wallet),'Craft response belongs to another account.');
  need(this.locks,'This browser cannot coordinate saved craft history.');
  return this.locks.request(this.key,{mode:'exclusive',ifAvailable:true},lock=>{
   need(lock,'Another tab is saving this craft. Try checking its outcome again.');
   const saved=this.read(),rows=new Map(saved.map(r=>[r.idempotencyKey,r]));
   for(const r of incoming){const prior=rows.get(r.idempotencyKey);rows.set(r.idempotencyKey,prior?mergeVehicleCraftReceipt(prior,r):r);}
   need(rows.size<=P.localPendingLimit+P.localArchiveLimit,'Local craft history is full; existing receipts remain saved.');
   const records=[...rows.values()].sort((a,b)=>b.reservedAt.localeCompare(a.reservedAt)||a.idempotencyKey.localeCompare(b.idempotencyKey));
   const encoded=JSON.stringify({version:1,identity:this.identity,records});need(encoded.length<=MAX_BYTES,'Local craft history storage is full.');this.storage.setItem(this.key,encoded);return records;
  });
 }
}
