/** Once-only private key tests, real Ed25519, explicit serialized source banks. */
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,open as openFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Keypair} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {VEHICLE_CRAFT_PROGRAM} from '@shardkeep/chain/vehicle-issuance-protocol';
import {normalizeVehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {vehiclePermitMessage} from '@shardkeep/chain/vehicle-issuance-request';
import {createVehicleCraftMaterials,type VehicleCraftMaterialRecord} from '../src/game/vehicleCraftMaterials';
import {createVehiclePolicyIssuer,type VehiclePolicyIssuerOptions} from '../src/vehiclePolicyIssuer';
import {VEHICLE_ISSUER_PURPOSE,initializeVehicleIssuerJournal,openVehicleIssuerJournal,vehicleIssuerAttemptFromMaterial} from '../src/vehiclePolicyIssuerJournal';
import {syntheticVehicleMaterial,signVehiclePolicy,vehiclePolicyBank} from './fixtures/vehiclePolicyIssuer';
import {withVehicleMaterialEarnedSource} from './fixtures/vehicleMaterialEarnedSource';
import {SEAL_BOUND_EARNED_VEHICLE_CASE_MS} from './sealLatencyBudgets';
import {vehicleIssuanceFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuance';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const close of cleanups.splice(0).reverse())await close();});
const signal=()=>new AbortController().signal;
async function setup(){
 const bank=vehiclePolicyBank(),directory=await mkdtemp(path.join(tmpdir(),'vehicle-policy-issuer-')),journalFile=path.join(directory,'vehicle.jsonl');cleanups.push(()=>rm(directory,{recursive:true,force:true}));
 const domain={purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:bank.trust.expectedGenesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM as typeof VEHICLE_CRAFT_PROGRAM};await initializeVehicleIssuerJournal(journalFile,domain);
 const records=new Map<string,VehicleCraftMaterialRecord>(),request=(r:VehicleCraftMaterialRecord)=>({wallet:r.actorWallet,idempotencyKey:r.request.idempotencyKey}),add=(r=syntheticVehicleMaterial())=>{records.set(r.actorWallet+':'+r.request.idempotencyKey,r);return r;},record=add();
 const material={read:vi.fn(async(wallet:string,key:string)=>records.get(wallet+':'+key)??null)},connect=vi.fn((_signal:AbortSignal)=>bank.rpc),sign=vi.fn((message:Uint8Array)=>signVehiclePolicy(bank.policy,message));let tick=0;
 const options:VehiclePolicyIssuerOptions={journalFile,trust:bank.trust,connect,material,signer:{publicKey:bank.policyAuthority,sign},monotonicNow:()=>tick};
 async function open(overrides:Partial<VehiclePolicyIssuerOptions>={}){const issuer=await createVehiclePolicyIssuer({...options,...overrides});cleanups.push(()=>issuer.close());return issuer;}
 return {...bank,options,domain,journalFile,record,records,request,add,material,connect,sign,open,setTick:(value:number)=>{tick=value;}};
}
it('persists the whole genuine binding before policy/sign and returns its verified original signature once',async()=>{
 const f=await setup(),issuer=await f.open(),r=f.request(f.record),probe=await openFile(f.journalFile,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();const sync=vi.spyOn(prototype,'sync');
 f.connect.mockImplementation(()=>{expect(sync).toHaveBeenCalled();return f.rpc;});
 const receipt=await issuer.issueOnce(r,signal());expect(receipt.message).toEqual(vehiclePermitMessage(f.record.original));expect(receipt.signature).toEqual(signVehiclePolicy(f.policy,receipt.message));expect(receipt.material.nonce).toBe(f.record.nonce);expect(receipt.paymentAuthorized).toBe(false);
 expect(await issuer.issueOnce(r,signal())).toEqual(receipt);expect(await issuer.lookup(r,signal())).toEqual(receipt);expect(f.material.read).toHaveBeenCalledTimes(1);expect(f.sign).toHaveBeenCalledTimes(1);expect(f.connect).toHaveBeenCalledTimes(1);
 const rows=(await readFile(f.journalFile,'utf8')).trim().split('\n').map(v=>JSON.parse(v));expect(rows.map(v=>v.type)).toEqual([undefined,'pending','complete']);expect(rows[1].attempt.original).toEqual(f.record.original);expect(rows[1].attempt.material.materialHash).toBe(f.record.materialHash);
});
it('accepts only actor/key requests and refuses missing or another actor material before creating pending',async()=>{
 const f=await setup(),issuer=await f.open(),r=f.request(f.record);
 for(const changed of [{...r,original:f.record.original},{...r,message:vehiclePermitMessage(f.record.original)},{...r,proof:{}},{...r,wallet:'not-a-wallet'},{...r,idempotencyKey:'invalid'}])await expect(issuer.issueOnce(changed,signal())).rejects.toThrow();
 await expect(issuer.issueOnce({...r,wallet:Keypair.generate().publicKey.toBase58()},signal())).rejects.toMatchObject({code:'MATERIAL_MISSING'});
 expect(await issuer.lookup(r,signal())).toBeNull();expect(f.connect).not.toHaveBeenCalled();expect(f.sign).not.toHaveBeenCalled();
});
it.each(['actor','key','base','nonce','recipe','recipeHash','materialHash','original','status','terminal','extra'] as const)('refuses corrupted committed source %s before any signing',async mode=>{
 const f=await setup(),issuer=await f.open(),r=f.request(f.record),bad=structuredClone(f.record);
 if(mode==='actor')bad.actorWallet=Keypair.generate().publicKey.toBase58();if(mode==='key')bad.request.idempotencyKey=randomUUID();if(mode==='base')bad.request.baseId=randomUUID();if(mode==='nonce')bad.nonce='12'.repeat(32);
 if(mode==='recipe')bad.recipe.inputs[0]!.quantity='999';if(mode==='recipeHash')bad.recipeHash='12'.repeat(32);if(mode==='materialHash')bad.materialHash='12'.repeat(32);if(mode==='original')bad.original.originalHash='12'.repeat(32);if(mode==='status')bad.status='consumed';if(mode==='terminal')bad.terminal={} as typeof bad.terminal;if(mode==='extra')Object.assign(bad,{message:'caller authority'});
 f.material.read.mockResolvedValue(bad);await expect(issuer.issueOnce(r,signal())).rejects.toThrow();expect(await issuer.lookup(r,signal())).toBeNull();expect(f.sign).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();
});
it('serializes duplicate signing attempts with one durable pending and at most one signature',async()=>{
 const f=await setup(),issuer=await f.open(),r=f.request(f.record),all=await Promise.allSettled([issuer.issueOnce(r,signal()),issuer.issueOnce(r,signal())]);expect(all.some(v=>v.status==='fulfilled')).toBe(true);
 for(const v of all)if(v.status==='rejected')expect(v.reason).toMatchObject({code:'PENDING'});expect(f.sign).toHaveBeenCalledTimes(1);expect((await issuer.lookup(r,signal()))?.signature).toEqual(signVehiclePolicy(f.policy,vehiclePermitMessage(f.record.original)));
});
it('replays across restart, signer rotation, source outage and policy pause without any new source work',async()=>{
 const f=await setup(),issuer=await f.open(),r=f.request(f.record),receipt=await issuer.issueOnce(r,signal());await issuer.close();
 const rotated=Keypair.generate(),sign=vi.fn((v:Uint8Array)=>signVehiclePolicy(rotated,v));f.material.read.mockRejectedValue(Error('material unavailable'));f.connect.mockImplementation(()=>{throw Error('provider unavailable');});f.rows[6]!.data[177]=1;
 const resumed=await f.open({signer:{publicKey:rotated.publicKey.toBase58(),sign}});expect(await resumed.issueOnce(r,signal())).toEqual(receipt);expect(await resumed.lookup(r,signal())).toEqual(receipt);expect(sign).not.toHaveBeenCalled();expect(f.material.read).toHaveBeenCalledTimes(1);expect(f.connect).toHaveBeenCalledTimes(1);
 expect(await resumed.lookup({...r,wallet:rotated.publicKey.toBase58()},signal())).toBeNull();
});
it('a durable pending journal reopened after crash is lookup-only and cannot enter policy',async()=>{
 const f=await setup(),r=f.request(f.record),journal=await openVehicleIssuerJournal(f.journalFile,f.domain);await journal.begin(vehicleIssuerAttemptFromMaterial(f.record,r,f.policyAuthority,f.domain));await journal.close();
 const issuer=await f.open();expect(await issuer.lookup(r,signal())).toBeNull();await expect(issuer.issueOnce(r,signal())).rejects.toMatchObject({code:'PENDING'});expect(f.material.read).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.sign).not.toHaveBeenCalled();
});
it.each(['pause','key','program','clock'] as const)('fresh policy %s refusal remains pending after repair instead of reissuing',async mode=>{
 const f=await setup(),r=f.request(f.record),issuer=await f.open(),snap=f.rows.map(v=>Buffer.from(v.data));
 if(mode==='pause')f.rows[6]!.data[177]=1;if(mode==='key')Keypair.generate().publicKey.toBuffer().copy(f.rows[6]!.data as Buffer,41);if(mode==='program')f.rows[1]!.data[50]=f.rows[1]!.data[50]!^1;if(mode==='clock')(f.rows[8]!.data as Buffer).writeBigInt64LE(BigInt(f.record.original.permitExpiry),32);
 await expect(issuer.issueOnce(r,signal())).rejects.toThrow();f.rows.forEach((row,i)=>{row.data=snap[i]!;});await expect(issuer.issueOnce(r,signal())).rejects.toMatchObject({code:'PENDING'});expect(f.sign).not.toHaveBeenCalled();expect(f.connect).toHaveBeenCalledTimes(1);
});
it.each(['throws','wrong-key','short','post-sign-age'] as const)('signature fault %s never retries an uncertain signer',async mode=>{
 const f=await setup(),other=Keypair.generate(),r=f.request(f.record);
 f.sign.mockImplementation(bytes=>{if(mode==='throws'){signVehiclePolicy(f.policy,bytes);throw Error('crash after key use');}if(mode==='short')return Buffer.alloc(63);if(mode==='wrong-key')return signVehiclePolicy(other,bytes);f.setTick(60_000.001);return signVehiclePolicy(f.policy,bytes);});
 const issuer=await f.open();await expect(issuer.issueOnce(r,signal())).rejects.toThrow();await issuer.close();const resumed=await f.open();await expect(resumed.issueOnce(r,signal())).rejects.toMatchObject({code:'PENDING'});expect(f.sign).toHaveBeenCalledTimes(1);
});
it('captures material/source bytes before an awaited provider and rejects backwards/full-precision monotonic time',async()=>{
 const f=await setup(),issuer=await f.open(),r=f.request(f.record),expected=vehiclePermitMessage(f.record.original);let release!:()=>void,entered!:()=>void;const arrival=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});const actual=f.rpc.getGenesisHash;
 f.rpc.getGenesisHash=vi.fn(async()=>{entered();await gate;return actual();});const pending=issuer.issueOnce(r,signal());await arrival;f.record.nonce='00'.repeat(32);release();expect((await pending).message).toEqual(expected);
 f.rpc.getGenesisHash=vi.fn(async()=>{f.setTick(-1);return actual();});const next=f.add();await expect(issuer.issueOnce(f.request(next),signal())).rejects.toThrow();expect(f.sign).toHaveBeenCalledTimes(1);
});
it.each(['provider','material'] as const)('retains ignored-abort %s calls against the eight-slot lifetime cap and never signs late',async mode=>{
 const f=await setup(),issuer=await f.open({timeoutMs:1000});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 if(mode==='provider')f.rpc.getGenesisHash=vi.fn(async()=>{await gate;return f.trust.expectedGenesisHash;});
 else {const original=f.material.read.getMockImplementation()!;f.material.read.mockImplementation(async(wallet,key)=>{await gate;return original(wallet,key);});}
 const requests=[];
 for(let i=0;i<8;i++){const r=f.request(f.add()),controller=new AbortController(),work=issuer.issueOnce(r,controller.signal).catch(error=>error);requests.push(r);
  await expect.poll(()=>mode==='provider'?vi.mocked(f.rpc.getGenesisHash).mock.calls.length:f.material.read.mock.calls.length).toBe(i+1);controller.abort();expect(await work).toMatchObject({code:'ABORTED'});
 }
 await expect(issuer.lookup(f.request(f.record),signal())).rejects.toMatchObject({code:'BUSY'});release();await expect.poll(async()=>{try{await issuer.lookup(f.request(f.record),signal());return true;}catch{return false;}}).toBe(true);
 for(const r of requests)expect(await issuer.lookup(r,signal())).toBeNull();expect(f.sign).not.toHaveBeenCalled();
});
it('a real deadline closes ignored provider work and permanently holds its committed attempt',async()=>{
 const f=await setup(),issuer=await f.open({timeoutMs:50}),r=f.request(f.record);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.rpc.getGenesisHash=vi.fn(async()=>{await gate;return f.trust.expectedGenesisHash;});
 await expect(issuer.issueOnce(r,signal())).rejects.toMatchObject({code:'ABORTED'});release();await expect.poll(async()=>await issuer.lookup(r,signal())).toBeNull();await expect(issuer.issueOnce(r,signal())).rejects.toMatchObject({code:'PENDING'});expect(f.sign).not.toHaveBeenCalled();
});
it('loads a genuinely earned and committed D211 original through its guarded material capability',()=>withVehicleMaterialEarnedSource(async source=>{
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');
 const f=await setup(),now=BigInt(Math.floor(Date.now()/1000)),{originalHash:_ignored,...template}=vehicleIssuanceFixture(randomBytes(16).toString('hex')).original;
 const material=createVehicleCraftMaterials(source.db,{loadTemplate:async()=>normalizeVehicleIssuanceOriginal({...template,buyer:source.seller.wallet,permitExpiry:String(now+60n)})});
 await source.refresh();const held=await material.reserve(source.seller.wallet,{idempotencyKey:randomUUID(),baseId:source.seller.baseId,family:source.recipe.family,tier:source.recipe.tier,recipeVersion:source.recipe.recipeVersion},source.seller.authority);
 (f.rows[8]!.data as Buffer).writeBigInt64LE(now,32);const issuer=await f.open({material}),request={wallet:held.actorWallet,idempotencyKey:held.request.idempotencyKey},receipt=await issuer.issueOnce(request,signal());
 expect(receipt.original).toEqual(held.original);expect(receipt.material.materialHash).toBe(held.materialHash);expect(receipt.material.recipe).toEqual(source.recipe);expect(f.sign).toHaveBeenCalledTimes(1);
 const replay=await material.read(request.wallet,request.idempotencyKey);expect(replay?.status).toBe('held');expect(replay?.materialHash).toBe(held.materialHash);expect(await issuer.issueOnce(request,signal())).toEqual(receipt);
 await issuer.close();
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
