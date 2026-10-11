import {randomUUID} from 'node:crypto';
import {mkdtemp,open,readFile,rename,rm,symlink,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {vehiclePermitMessage} from '@shardkeep/chain/vehicle-issuance-request';
import {normalizeVehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {VEHICLE_CRAFT_PROGRAM,vehicleIdentity} from '@shardkeep/chain/vehicle-issuance-protocol';
import {vehicleCraftMaterialHash} from '../src/game/vehicleCraftMaterials';
import {VEHICLE_ISSUER_PURPOSE,initializeVehicleIssuerJournal,openVehicleIssuerJournal,vehicleIssuerAttemptFromMaterial,type VehicleIssuerAttempt} from '../src/vehiclePolicyIssuerJournal';
import {syntheticVehicleMaterial,signVehiclePolicy,vehiclePolicyBank} from './fixtures/vehiclePolicyIssuer';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(initialize=true){
 const bank=vehiclePolicyBank(),directory=await mkdtemp(path.join(tmpdir(),'vehicle-issuer-journal-')),file=path.join(directory,'vehicle.jsonl');cleanups.push(()=>rm(directory,{recursive:true,force:true}));
 const domain={purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:bank.trust.expectedGenesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM as typeof VEHICLE_CRAFT_PROGRAM};
 if(initialize)await initializeVehicleIssuerJournal(file,domain);
 const attempt=()=>{const material=syntheticVehicleMaterial();return vehicleIssuerAttemptFromMaterial(material,{wallet:material.actorWallet,idempotencyKey:material.request.idempotencyKey},bank.policyAuthority,domain);};
 const signature=(a:VehicleIssuerAttempt)=>signVehiclePolicy(bank.policy,Buffer.from(a.messageHex,'hex')).toString('hex');
 async function reopen(){const journal=await openVehicleIssuerJournal(file,domain);cleanups.push(()=>journal.close());return journal;}
 return {...bank,directory,file,domain,attempt,signature,reopen};
}
function rebind(a:VehicleIssuerAttempt):VehicleIssuerAttempt{
 const {originalHash:_hash,...raw}=a.original;
 a.material.materialHash=vehicleCraftMaterialHash({actorWallet:a.wallet,baseId:a.material.baseId,rootId:raw.rootId,attemptId:raw.attemptId,nonce:a.material.nonce,recipeHash:a.material.recipeHash,recipe:a.material.recipe});
 const original=normalizeVehicleIssuanceOriginal({...raw,terms:{...raw.terms,materialHash:a.material.materialHash}});
 return {...a,original,messageHex:vehiclePermitMessage(original).toString('hex')};
}
it('fsyncs pending/completed body and detached receipts across reopen',async()=>{
 const f=await fixture(),a=f.attempt(),j=await f.reopen();expect(await j.begin(a)).toMatchObject({inserted:true,entry:{signatureHex:null}});
 const receipt=await j.complete(a,f.signature(a));await j.close();const next=await f.reopen();
 expect(await next.read(a)).toEqual({attempt:a,signatureHex:f.signature(a)});receipt.message.fill(0);receipt.material.nonce='00'.repeat(32);
 expect((await next.read(a))?.attempt).toEqual(a);expect((await readFile(f.file,'utf8')).trim().split('\n')).toHaveLength(3);
});
it('serializes duplicate starts and rejects original body, permit, root, attempt and reservation reuse',async()=>{
 const f=await fixture(),j=await f.reopen(),a=f.attempt();expect((await Promise.all([j.begin(a),j.begin(a)])).map(v=>v.inserted).sort()).toEqual([false,true]);
 const changed=rebind({...structuredClone(a),material:{...structuredClone(a.material),nonce:'ab'.repeat(32)}});
 await expect(j.begin(changed)).rejects.toMatchObject({code:'CONFLICT'});
 for(const field of ['permitId','rootId','attemptId','reservationId'] as const){
  let duplicate=f.attempt();if(field==='reservationId')duplicate.material.reservationId=a.material.reservationId;
  else {const raw=structuredClone(duplicate.original);if(field==='rootId'){
   raw.rootId=a.original.rootId;raw.identity=vehicleIdentity(raw.rootId,raw.terms.family,raw.terms.tier);const {originalHash:_ignored,...base}=raw;duplicate={...duplicate,original:normalizeVehicleIssuanceOriginal(base)};
  }else {raw[field]=a.original[field];const {originalHash:_ignored,...base}=raw;duplicate={...duplicate,original:normalizeVehicleIssuanceOriginal(base)};}}
  duplicate=rebind(duplicate);await expect(j.begin(duplicate),field).rejects.toMatchObject({code:'CONFLICT'});
 }
 await expect(j.complete(a,'00'.repeat(64))).rejects.toMatchObject({code:'SIGNATURE'});expect((await j.read(a))?.signatureHex).toBeNull();await j.complete(a,f.signature(a));
 await expect(j.complete(a,f.signature(a))).rejects.toMatchObject({code:'CONFLICT'});
});
it('holds an OS process lock and never automatically recreates missing journals',async()=>{
 const missing=await fixture(false);await expect(missing.reopen()).rejects.toThrow();
 const f=await fixture(),first=await f.reopen();await expect(openVehicleIssuerJournal(f.file,f.domain)).rejects.toMatchObject({code:'LOCK'});await first.close();expect(await (await f.reopen()).read(f.attempt())).toBeNull();
});
it('refuses Charter purpose, wrong domain, partial/tampered/unsafe journal and symlinks',async()=>{
 for(const mode of ['purpose','domain','partial','signature','body','symlink','permissions']){
  const f=await fixture(),j=await f.reopen(),a=f.attempt();await j.begin(a);await j.complete(a,f.signature(a));await j.close();const text=await readFile(f.file,'utf8');
  if(mode==='purpose')await writeFile(f.file,text.replaceAll(VEHICLE_ISSUER_PURPOSE,'charter-registration-v1'));
  if(mode==='domain')await writeFile(f.file,text.replaceAll(f.domain.genesisHash,f.policyAuthority));
  if(mode==='partial')await writeFile(f.file,text.slice(0,-1));
  if(mode==='signature')await writeFile(f.file,text.replace(f.signature(a),'00'.repeat(64)));
  if(mode==='body')await writeFile(f.file,text.replaceAll(a.material.nonce,'12'.repeat(32)));
  if(mode==='symlink'){await rename(f.file,f.file+'.saved');await symlink(f.file+'.saved',f.file);}
  if(mode==='permissions')await chmod(f.file,0o644);
  await expect(f.reopen(),mode).rejects.toThrow();
 }
});
it('detects active journal replacement and poisons further operations',async()=>{
 const f=await fixture(),j=await f.reopen(),a=f.attempt();await j.begin(a);const bytes=await readFile(f.file);await rename(f.file,f.file+'.saved');await writeFile(f.file,bytes,{mode:0o600});
 await expect(j.read(a)).rejects.toMatchObject({code:'JOURNAL_CHANGED'});await expect(j.complete(a,f.signature(a))).rejects.toMatchObject({code:'JOURNAL'});
});
it('never returns a receipt from failed append/fsync and retains crash ambiguity as pending or exact completed replay',async()=>{
 for(const method of ['writeFile','sync'] as const){const f=await fixture(),j=await f.reopen(),a=f.attempt();await j.begin(a);
  const probe=await open(f.file,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();const fault=vi.spyOn(prototype,method).mockRejectedValueOnce(Error('vehicle journal storage failure'));
  await expect(j.complete(a,f.signature(a))).rejects.toThrow('vehicle journal storage failure');fault.mockRestore();await expect(j.read(a)).rejects.toMatchObject({code:'JOURNAL'});await j.close();
  const saved=await(await f.reopen()).read(a);expect(saved?.signatureHex).toBe(method==='sync'?f.signature(a):null);
 }
});
