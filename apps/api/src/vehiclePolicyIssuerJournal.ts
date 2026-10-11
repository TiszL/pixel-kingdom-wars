/** Vehicle-only once-only policy journal. Independent from Charter and custody keys. */
import {createPublicKey,verify} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {normalizeVehicleIssuanceOriginal,type VehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {vehiclePermitMessage} from '@shardkeep/chain/vehicle-issuance-request';
import {VEHICLE_CRAFT_PROGRAM,vehicleKeccak} from '@shardkeep/chain/vehicle-issuance-protocol';
import {PhaseEVehicleRecipeSnapshotSchema,vehicleRecipeCanonical,VEHICLE_RECIPE_HASH_DOMAIN} from '@shardkeep/shared/phaseEVehicleRecipes';
import {vehicleCraftMaterialHash,type VehicleCraftMaterialRecord} from './game/vehicleCraftMaterials';
export const VEHICLE_ISSUER_PURPOSE='vehicle-request-v1' as const;
export class VehicleIssuerError extends Error {constructor(readonly code:string){super('Vehicle issuer refused: '+code);this.name='VehicleIssuerError';}}
export function vehicleIssuerNeed(value:unknown,code:string):asserts value{if(!value)throw new VehicleIssuerError(code);}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),hash=z.string().regex(/^[0-9a-f]{64}$/);
const address=z.string().refine(value=>{try{const k=new PublicKey(value);return k.toBase58()===value&&!k.equals(PublicKey.default);}catch{return false;}});
const timestamp=z.iso.datetime({precision:6});
const requestSchema=z.object({wallet:address,idempotencyKey:uuid}).strict();
const domainSchema=z.object({purpose:z.literal(VEHICLE_ISSUER_PURPOSE),genesisHash:address,craftProgram:z.literal(VEHICLE_CRAFT_PROGRAM)}).strict();
const materialSchema=z.object({reservationId:uuid,baseId:uuid,nonce:hash,reservedAt:timestamp,recipe:PhaseEVehicleRecipeSnapshotSchema,recipeHash:hash,materialHash:hash}).strict();
const attemptSchema=requestSchema.extend({purpose:z.literal(VEHICLE_ISSUER_PURPOSE),publicKey:address,material:materialSchema,original:z.unknown(),messageHex:z.string().regex(/^[0-9a-f]{322}$/)}).strict();
const signatureSchema=z.string().regex(/^[0-9a-f]{128}$/);
export type VehicleIssuerRequest=z.infer<typeof requestSchema>;
export type VehicleIssuerDomain=z.infer<typeof domainSchema>;
export type VehicleIssuerMaterial=z.infer<typeof materialSchema>;
export interface VehicleIssuerAttempt extends VehicleIssuerRequest{readonly purpose:typeof VEHICLE_ISSUER_PURPOSE;readonly publicKey:string;readonly material:VehicleIssuerMaterial;readonly original:VehicleIssuanceOriginal;readonly messageHex:string}
export interface VehicleIssuerEntry{readonly attempt:VehicleIssuerAttempt;readonly signatureHex:string|null}
export interface VehicleIssuerReceipt extends VehicleIssuerRequest{readonly version:1;readonly purpose:typeof VEHICLE_ISSUER_PURPOSE;readonly publicKey:string;readonly original:VehicleIssuanceOriginal;readonly material:VehicleIssuerMaterial;readonly message:Uint8Array;readonly signature:Uint8Array;readonly paymentAuthorized:false;readonly activationAuthorized:false;readonly reservationReleaseAuthorized:false}
// Operational resource bounds only; no economy policy or issuance allowance.
const MAX_BYTES=64*1024*1024,MAX_LINE_BYTES=16*1024;
export function copyVehicleIssuerRequest(value:unknown):VehicleIssuerRequest{return Object.freeze(requestSchema.parse(value));}
export function vehicleIssuerRequestId(value:VehicleIssuerRequest):string{const v=requestSchema.parse({wallet:value.wallet,idempotencyKey:value.idempotencyKey});return v.wallet+':'+v.idempotencyKey;}
export function copyVehicleIssuerDomain(value:VehicleIssuerDomain):VehicleIssuerDomain{return Object.freeze(domainSchema.parse(value));}
export function copyVehicleIssuerAttempt(value:VehicleIssuerAttempt,domain:VehicleIssuerDomain){
 const v=attemptSchema.parse(value),original=normalizeVehicleIssuanceOriginal(v.original),m=v.material;
 vehicleIssuerNeed(!!v.original&&typeof v.original==='object'&&'originalHash'in v.original&&v.original.originalHash===original.originalHash,'ORIGINAL');
 vehicleIssuerNeed(original.buyer===v.wallet&&original.genesisHash===domain.genesisHash&&domain.craftProgram===VEHICLE_CRAFT_PROGRAM&&domain.purpose===v.purpose,'DOMAIN');
 const recipeHash=vehicleKeccak(Buffer.from(VEHICLE_RECIPE_HASH_DOMAIN+vehicleRecipeCanonical(m.recipe))).toString('hex');
 vehicleIssuerNeed(recipeHash===m.recipeHash&&vehicleCraftMaterialHash({actorWallet:v.wallet,baseId:m.baseId,rootId:original.rootId,attemptId:original.attemptId,nonce:m.nonce,recipeHash,recipe:m.recipe})===m.materialHash,'MATERIAL');
 vehicleIssuerNeed(original.terms.materialHash===m.materialHash&&original.terms.recipeHash===recipeHash&&original.terms.recipeVersion===m.recipe.recipeVersion&&original.identity.family===m.recipe.family&&original.identity.tier===m.recipe.tier&&original.terms.oddsBps===m.recipe.oddsBps,'RECIPE');
 vehicleIssuerNeed(vehiclePermitMessage(original).toString('hex')===v.messageHex,'MESSAGE');
 const attempt:VehicleIssuerAttempt={wallet:v.wallet,idempotencyKey:v.idempotencyKey,purpose:v.purpose,publicKey:v.publicKey,material:m,original,messageHex:v.messageHex};
 return {attempt,expiry:BigInt(original.permitExpiry)};
}
/** The read capability belongs to the constructor. Validate its whole committed
 * held record again before constructing the immutable journal attempt. */
export function vehicleIssuerAttemptFromMaterial(input:VehicleCraftMaterialRecord,request:VehicleIssuerRequest,publicKey:string,domain:VehicleIssuerDomain):VehicleIssuerAttempt{
 const schema=z.object({id:uuid,actorWallet:address,request:z.object({baseId:uuid,idempotencyKey:uuid,family:PhaseEVehicleRecipeSnapshotSchema.shape.family,tier:PhaseEVehicleRecipeSnapshotSchema.shape.tier,recipeVersion:z.literal(1)}).strict(),nonce:hash,reservedAt:timestamp,recipe:PhaseEVehicleRecipeSnapshotSchema,recipeHash:hash,materialHash:hash,original:z.unknown(),status:z.literal('held'),terminal:z.null()}).strict();
 const r=schema.parse(input);vehicleIssuerNeed(r.actorWallet===request.wallet&&r.request.idempotencyKey===request.idempotencyKey&&r.request.family===r.recipe.family&&r.request.tier===r.recipe.tier&&r.request.recipeVersion===r.recipe.recipeVersion,'MATERIAL');
 const original=normalizeVehicleIssuanceOriginal(r.original);
 vehicleIssuerNeed(!!r.original&&typeof r.original==='object'&&'originalHash'in r.original&&r.original.originalHash===original.originalHash,'ORIGINAL');
 return copyVehicleIssuerAttempt({...request,purpose:VEHICLE_ISSUER_PURPOSE,publicKey,original,material:{reservationId:r.id,baseId:r.request.baseId,nonce:r.nonce,reservedAt:r.reservedAt,recipe:r.recipe,recipeHash:r.recipeHash,materialHash:r.materialHash},messageHex:vehiclePermitMessage(original).toString('hex')},domain).attempt;
}
export function vehicleIssuerReceipt(entry:VehicleIssuerEntry):VehicleIssuerReceipt|null{
 if(entry.signatureHex===null)return null;
 const a=entry.attempt,message=Buffer.from(a.messageHex,'hex'),signature=Buffer.from(signatureSchema.parse(entry.signatureHex),'hex');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(a.publicKey).toBuffer()]),format:'der',type:'spki'});
 vehicleIssuerNeed(verify(null,message,key,signature),'SIGNATURE');
 return {version:1,purpose:a.purpose,wallet:a.wallet,idempotencyKey:a.idempotencyKey,publicKey:a.publicKey,original:structuredClone(a.original),material:structuredClone(a.material),message,signature,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false};
}
const exact=(value:unknown,keys:string)=>{vehicleIssuerNeed(value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).sort().join(' ')===keys,'JOURNAL');return value as Record<string,unknown>;};
const same=(a:VehicleIssuerAttempt,b:VehicleIssuerAttempt)=>JSON.stringify(a)===JSON.stringify(b);
const stamp=(s:Awaited<ReturnType<FileHandle['stat']>>)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function secureDirectory(file:string){
 vehicleIssuerNeed(path.isAbsolute(file),'PATH');const handle=await open(path.dirname(file),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await handle.stat();vehicleIssuerNeed(s.isDirectory()&&(s.mode&0o077)===0&&s.uid===process.getuid?.(),'DIRECTORY');}finally{await handle.close();}
}
async function secureFile(handle:FileHandle){const s=await handle.stat();vehicleIssuerNeed(s.isFile()&&(s.mode&0o077)===0&&s.nlink===1&&s.uid===process.getuid?.(),'FILE');return s;}
async function lock(file:string){
 await secureDirectory(file);const lockFile=file+'.lock',handle=await open(lockFile,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
 let identity:string;try{const s=await secureFile(handle);identity=`${s.dev}:${s.ino}`;}finally{await handle.close();}
 // Keep one lock inode across writers; unlinking on unlock can split waiters.
 const command=process.platform==='darwin'?'/usr/bin/lockf':'flock',args=process.platform==='darwin'?['-k','-t','0',lockFile,'sh','-c','printf LOCKED; cat >/dev/null']:['-n',lockFile,'sh','-c','printf LOCKED; cat >/dev/null'];
 const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});let lost=false;
 child.once('exit',()=>{lost=true;});child.on('error',()=>{lost=true;});child.stderr.resume();
 try{await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new VehicleIssuerError('LOCK'));},5000);let out='';
  const fail=()=>{clearTimeout(timer);reject(new VehicleIssuerError('LOCK'));};child.once('error',fail);child.once('exit',fail);
  child.stdout.on('data',(part:Buffer)=>{out+=part.toString('utf8');if(out==='LOCKED'){clearTimeout(timer);child.off('error',fail);child.off('exit',fail);resolve();}else if(out.length>6)fail();});
 });}catch(error){child.kill('SIGKILL');throw error;}
 const assert=async()=>{vehicleIssuerNeed(!lost,'LOCK');const current=await open(lockFile,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await secureFile(current);vehicleIssuerNeed(`${s.dev}:${s.ino}`===identity&&!lost,'LOCK');}finally{await current.close();}};
 const close=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.stdin.end();await done;};
 try{await assert();return {assert,close};}catch(error){await close();throw error;}
}
/** Explicit offline ceremony; normal open never initializes missing state. */
export async function initializeVehicleIssuerJournal(file:string,input:VehicleIssuerDomain){
 const domain=copyVehicleIssuerDomain(input),guard=await lock(file);
 try{const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify({version:1,domain})+'\n');await handle.sync();}finally{await handle.close();}
  const directory=await open(path.dirname(file),constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
 }finally{await guard.close();}
}
export interface VehicleIssuerJournal {
 read(request:VehicleIssuerRequest):Promise<VehicleIssuerEntry|null>;
 begin(attempt:VehicleIssuerAttempt):Promise<{inserted:boolean;entry:VehicleIssuerEntry}>;
 complete(request:VehicleIssuerRequest,signatureHex:string):Promise<VehicleIssuerReceipt>;
 close():Promise<void>;
}
export async function openVehicleIssuerJournal(file:string,input:VehicleIssuerDomain):Promise<VehicleIssuerJournal>{
 const domain=copyVehicleIssuerDomain(input),guard=await lock(file);let handle:FileHandle;
 try{handle=await open(file,constants.O_RDWR|constants.O_APPEND|constants.O_NOFOLLOW);}catch(error){await guard.close();throw error;}
 const entries=new Map<string,VehicleIssuerEntry>(),unique=new Map<string,string>();let savedStamp='',size=0,closed=false,fatal=false,tail:Promise<unknown>=Promise.resolve();
 const copy=(entry:VehicleIssuerEntry):VehicleIssuerEntry=>({attempt:copyVehicleIssuerAttempt(entry.attempt,domain).attempt,signatureHex:entry.signatureHex});
 const identities=(attempt:VehicleIssuerAttempt)=>['permit:'+attempt.original.permitId,'root:'+attempt.original.rootId,'attempt:'+attempt.original.attemptId,'reservation:'+attempt.material.reservationId];
 function apply(value:unknown){
  const row=exact(value,'attempt signatureHex type');vehicleIssuerNeed(row.type==='pending'||row.type==='complete','JOURNAL');
  const {attempt}=copyVehicleIssuerAttempt(row.attempt as VehicleIssuerAttempt,domain),requestId=vehicleIssuerRequestId(attempt),prior=entries.get(requestId);
  if(row.type==='pending'){
   vehicleIssuerNeed(row.signatureHex===null&&!prior&&identities(attempt).every(id=>!unique.has(id)),'JOURNAL');entries.set(requestId,{attempt,signatureHex:null});for(const id of identities(attempt))unique.set(id,requestId);
  }else{
   vehicleIssuerNeed(prior&&prior.signatureHex===null&&same(prior.attempt,attempt),'JOURNAL');
   const entry={attempt,signatureHex:signatureSchema.parse(row.signatureHex)};vehicleIssuerReceipt(entry);entries.set(requestId,entry);
  }
 }
 async function check(){
  vehicleIssuerNeed(!closed&&!fatal,'JOURNAL');await guard.assert();await secureDirectory(file);
  const s=await secureFile(handle);vehicleIssuerNeed(stamp(s)===savedStamp,'JOURNAL_CHANGED');
  const named=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{vehicleIssuerNeed(stamp(await secureFile(named))===savedStamp,'JOURNAL_CHANGED');}finally{await named.close();}
 }
 function serial<T>(operation:()=>Promise<T>):Promise<T>{const work=tail.then(async()=>{try{await check();return await operation();}catch(error){if(!(error instanceof VehicleIssuerError)||!['CONFLICT','PENDING','SIGNATURE'].includes(error.code))fatal=true;throw error;}});tail=work.catch(()=>{});return work;}
 async function append(row:{type:'pending'|'complete';attempt:VehicleIssuerAttempt;signatureHex:string|null}){
  const line=JSON.stringify(row)+'\n',bytes=Buffer.byteLength(line);vehicleIssuerNeed(bytes<=MAX_LINE_BYTES&&size+bytes<=MAX_BYTES,'JOURNAL_FULL');
  await check();await handle.writeFile(line,'utf8');await handle.sync();await guard.assert();
  const s=await secureFile(handle);vehicleIssuerNeed(s.size===size+bytes,'JOURNAL_CHANGED');savedStamp=stamp(s);size=s.size;
  await check();apply(row);
 }
 try{
  const before=await secureFile(handle);vehicleIssuerNeed(before.size>0&&before.size<=MAX_BYTES,'JOURNAL');const text=await handle.readFile('utf8');
  vehicleIssuerNeed(text.endsWith('\n')&&stamp(await secureFile(handle))===stamp(before),'JOURNAL');
  const lines=text.slice(0,-1).split('\n');vehicleIssuerNeed(lines.every(line=>Buffer.byteLength(line)<=MAX_LINE_BYTES),'JOURNAL');
  const header=exact(JSON.parse(lines.shift()!),'domain version');vehicleIssuerNeed(header.version===1,'JOURNAL');const saved=copyVehicleIssuerDomain(header.domain as VehicleIssuerDomain);
  vehicleIssuerNeed(JSON.stringify(saved)===JSON.stringify(domain),'DOMAIN');for(const line of lines)apply(JSON.parse(line));
  savedStamp=stamp(before);size=before.size;await check();
 }catch(error){await handle.close();await guard.close();throw error;}
 return Object.freeze({
  read:async(request:VehicleIssuerRequest)=>{const requestId=vehicleIssuerRequestId(request);return serial(async()=>{const found=entries.get(requestId);return found?copy(found):null;});},
  begin:async(value:VehicleIssuerAttempt)=>{const {attempt}=copyVehicleIssuerAttempt(value,domain),requestId=vehicleIssuerRequestId(attempt);return serial(async()=>{
   const prior=entries.get(requestId);if(prior){vehicleIssuerNeed(same(prior.attempt,attempt),'CONFLICT');return {inserted:false,entry:copy(prior)};}
   vehicleIssuerNeed(identities(attempt).every(id=>!unique.has(id)),'CONFLICT');await append({type:'pending',attempt,signatureHex:null});return {inserted:true,entry:copy(entries.get(requestId)!)};
  });},
  complete:async(request:VehicleIssuerRequest,value:string)=>{const requestId=vehicleIssuerRequestId(request),signatureHex=signatureSchema.parse(value);return serial(async()=>{
   const prior=entries.get(requestId);vehicleIssuerNeed(prior&&prior.signatureHex===null,'CONFLICT');const entry={attempt:prior.attempt,signatureHex};vehicleIssuerReceipt(entry);
   await append({type:'complete',...entry});return vehicleIssuerReceipt(entry)!;
  });},
  close:async()=>{await tail;if(closed)return;closed=true;try{await handle.close();}finally{await guard.close();}},
 });
}
