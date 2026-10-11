import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PublicKey,SYSVAR_SLOT_HASHES_PUBKEY,SystemProgram} from '@solana/web3.js';
import {describe,it,expect} from 'vitest';
import {createVehicleIssuanceEvidenceReader,normalizeVehicleIssuanceOriginal} from './vehicleIssuanceEvidence';
import {vehicleIssuanceFixture} from './testFixtures/vehicleIssuance';
import {vehicleVrfRequest,vehiclePda,vehicleWins,vehicleSha256,vehicleTermsHash,VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE} from './vehicleIssuanceProtocol';
const read=(f:ReturnType<typeof vehicleIssuanceFixture>,deadlineMs?:number)=>createVehicleIssuanceEvidenceReader(()=>f.rpc,f.trust,async()=>f.original,deadlineMs?{deadlineMs}:{})(f.original.rootId);
describe('private original vehicle issuance',()=>{
 it('matches the complete independently generated SDK request, metas and scoped callback identity',()=>{
  const v=JSON.parse(readFileSync(new URL('../../../spikes/phase-e-toolchain-vrf/vectors/vehicle-vrf-v2.json',import.meta.url),'utf8'));
  expect(v.craftProgram).toBe(VEHICLE_CRAFT_PROGRAM);
  expect(vehicleVrfRequest(v.rootIdHex,v.attemptIdHex,v.termsHashHex).toString('hex')).toBe(v.request.dataHex);
  expect(v.request.programId).toBe(VEHICLE_VRF_PROGRAM);expect(v.request.accounts).toEqual([
   {address:vehiclePda('vehicle_oracle',v.rootIdHex)[0].toBase58(),isSigner:true,isWritable:true},{address:vehiclePda('identity')[0].toBase58(),isSigner:true,isWritable:false},{address:VEHICLE_VRF_QUEUE,isSigner:false,isWritable:true},{address:SystemProgram.programId.toBase58(),isSigner:false,isWritable:false},{address:SYSVAR_SLOT_HASHES_PUBKEY.toBase58(),isSigner:false,isWritable:false}]);
  expect(PublicKey.findProgramAddressSync([Buffer.from('identity'),new PublicKey(VEHICLE_CRAFT_PROGRAM).toBuffer()],new PublicKey(VEHICLE_VRF_PROGRAM))[0].toBase58()).toBe(v.scopedProviderIdentity);
 });
 it('preserves the historical SDK vector and its request/callback bytes',()=>{
  for(const [file,digest] of [
   ['vehicle-vrf-v1.json','7ac25a928a5cbcec24af81e01c082f35904c583e9729655712d309d3387afecb'],
   ['vehicle-vrf-request-v1.hex','fb55ede066ccb47a18dce8af800cab426520bd2234aa4248d7c720ad279a2fd0'],
   ['vehicle-vrf-callback-v1.hex','cd6c20ea808f9182b088fa22e00ec42c7041d48d7685c4bbcce17184c679f0da'],
  ] as const)expect(createHash('sha256').update(readFileSync(new URL(`../../../spikes/phase-e-toolchain-vrf/vectors/${file}`,import.meta.url))).digest('hex')).toBe(digest);
 });
 it('binds finalized mint, original buyer, request, fee, metadata and immutable commitment without authorizing actions',async()=>{const f=vehicleIssuanceFixture(),e=await read(f);expect(e).toMatchObject({rootId:f.original.rootId,originalHash:f.original.originalHash,buyer:f.original.buyer,finalizedMintObserved:true,transactionProofVerified:false,activationAuthorized:false,reservationReleaseAuthorized:false,paymentAuthorized:false});expect(e.source.accounts).toHaveLength(14);});
 it('binds the escrow reserve to the saved original and signed terms, so a later quote cannot change retained funds',()=>{
  const f=vehicleIssuanceFixture(),{originalHash,...input}=f.original;
  const changed=normalizeVehicleIssuanceOriginal({...input,escrowRentReserve:(BigInt(input.escrowRentReserve)+1n).toString()});
  expect(changed.originalHash).not.toBe(originalHash);expect(vehicleTermsHash(changed)).not.toBe(vehicleTermsHash(f.original));
  expect(()=>normalizeVehicleIssuanceOriginal({...changed,originalHash})).toThrow();
 });
 it('requires a canonical, positive u64 reserve before an original can be saved',()=>{
  const {originalHash,...input}=vehicleIssuanceFixture().original;
  for(const escrowRentReserve of [undefined,null,890880,'','0','-1','01','1.5','18446744073709551616'])expect(()=>normalizeVehicleIssuanceOriginal({...input,escrowRentReserve})).toThrow();
  const {escrowRentReserve,...missing}=input;expect(()=>normalizeVehicleIssuanceOriginal(missing)).toThrow();
 });
 it('holds a control reserve that differs from the original even when all other issuance facts match',async()=>{
  const f=vehicleIssuanceFixture(),control=Buffer.from(f.rows[6]!.data);expect(control).toHaveLength(189);
  control.writeBigUInt64LE(BigInt(f.original.escrowRentReserve)+1n,178);f.rows[6]!.data=control;
  await expect(read(f)).rejects.toMatchObject({code:'ACCOUNTS'});
 });
 it('refuses the former control layout instead of interpreting its bumps as a reserve',async()=>{
  const f=vehicleIssuanceFixture(),control=Buffer.from(f.rows[6]!.data);f.rows[6]!.data=Buffer.concat([control.subarray(0,178),control.subarray(186)]);
  expect(f.rows[6]!.data).toHaveLength(181);await expect(read(f)).rejects.toMatchObject({code:'ACCOUNTS'});
 });
 it('keeps original buyer after a later plain Core transfer; current owner remains a separate installation check',async()=>{const f=vehicleIssuanceFixture();Buffer.from(f.rows[10]!.data.buffer,f.rows[10]!.data.byteOffset,f.rows[10]!.data.byteLength).set(Buffer.alloc(32,55),1);expect((await read(f)).buyer).toBe(f.original.buyer);});
 it('pins zero, rare, near-certain and certain integer draw boundaries',()=>{for(const odds of [0,1,9999,10000]){const threshold=(BigInt(odds)<<64n)/10000n,draw=Buffer.alloc(32);if(threshold>0n){draw.writeBigUInt64LE(threshold-1n);expect(vehicleWins(draw,odds)).toBe(true);}if(threshold<1n<<64n){draw.writeBigUInt64LE(threshold);expect(vehicleWins(draw,odds)).toBe(false);}}expect(vehicleWins(Buffer.alloc(32,255),10000)).toBe(true);});
 it.each([6,7,8,9,10,11])('refuses every padded account or hidden plugin (account %i)',async i=>{const f=vehicleIssuanceFixture();f.rows[i]!.data=Buffer.concat([f.rows[i]!.data,Buffer.of(0)]);await expect(read(f)).rejects.toThrow();});
 it.each([1,3,5])('refuses changed reviewed craft/provider/Core deployment bytes (account %i)',async i=>{const f=vehicleIssuanceFixture();f.rows[i]!.data=Buffer.from(f.rows[i]!.data);f.rows[i]!.data[45]=f.rows[i]!.data[45]!^1;await expect(read(f)).rejects.toMatchObject({code:'DEPLOYMENT'});});
 it.each([393,513,514,515])('holds altered terms/result/payment/mint state (offset %i)',async offset=>{const f=vehicleIssuanceFixture();f.rows[8]!.data=Buffer.from(f.rows[8]!.data);f.rows[8]!.data[offset]=0; if(offset===393)f.rows[8]!.data[393]=f.rows[8]!.data[393]!^1;await expect(read(f)).rejects.toThrow();});
 it('refuses wrong genesis, queue owner, request identity and original metadata separately',async()=>{
  const a=vehicleIssuanceFixture();a.rpc.getGenesisHash=async()=>a.original.buyer;await expect(read(a)).rejects.toMatchObject({code:'IDENTITY'});
  const b=vehicleIssuanceFixture();b.rows[12]!.owner=new PublicKey(b.original.buyer);await expect(read(b)).rejects.toThrow();
  const c=vehicleIssuanceFixture();c.rows[8]!.data=Buffer.from(c.rows[8]!.data);c.rows[8]!.data[425]=c.rows[8]!.data[425]!^1;await expect(read(c)).rejects.toThrow();
  const d=vehicleIssuanceFixture();expect(()=>normalizeVehicleIssuanceOriginal({...d.original,metadata:{...d.original.metadata,name:'Changed'}})).toThrow();
 });
 it.each([['provider',3],['core',5]] as const)('holds an original older than the reviewed %s deployment',async(kind,index)=>{const f=vehicleIssuanceFixture(),data=Buffer.from(f.rows[index]!.data);data.writeBigUInt64LE(12n,4);f.rows[index]!.data=data;f.trust[kind]={...f.trust[kind],reviewedDeploymentSlot:12,reviewedProgramDataSha256:vehicleSha256(data)};await expect(read(f)).rejects.toMatchObject({code:'ACCOUNTS'});});
 it('bounds timed-out ignored-abort work instead of opening unlimited transports',async()=>{const f=vehicleIssuanceFixture();let resolve!:()=>void;const pending=new Promise<void>(r=>resolve=r);f.rpc.getGenesisHash=async()=>{await pending;return f.original.genesisHash;};const reader=createVehicleIssuanceEvidenceReader(()=>f.rpc,f.trust,async()=>f.original,{deadlineMs:5});const results=await Promise.allSettled(Array.from({length:8},()=>reader(f.original.rootId)));expect(results.every(v=>v.status==='rejected')).toBe(true);await expect(reader(f.original.rootId)).rejects.toMatchObject({code:'BUSY'});resolve();});
});
