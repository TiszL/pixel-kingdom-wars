import {createPrivateKey,sign} from 'node:crypto';
import {Ed25519Program,Keypair,Message,PublicKey,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,SYSVAR_SLOT_HASHES_PUBKEY,Transaction} from '@solana/web3.js';
import {describe,expect,it} from 'vitest';
import {normalizeVehicleIssuanceOriginal} from './vehicleIssuanceAccounts';
import {vehicleIssuanceFixture} from './testFixtures/vehicleIssuance';
import {VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE,vehicleIdentity,vehicleMetadataHash,vehiclePda,vehicleTermsHash,type VehicleIssuanceOriginal} from './vehicleIssuanceProtocol';
import {vehiclePermitMessage,vehicleRequestInstructions,vehicleRequestLegacyMessage,verifyVehicleRequestLegacyMessage} from './vehicleIssuanceRequest';
const policy=Keypair.fromSeed(Buffer.alloc(32,17)),blockhash=new PublicKey(Buffer.alloc(32,21)).toBase58();
const signature=(o:VehicleIssuanceOriginal)=>sign(null,vehiclePermitMessage(o),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(policy.secretKey).subarray(0,32)]),format:'der',type:'pkcs8'}));
function original(){return vehicleIssuanceFixture().original;}
function changed(change:(o:VehicleIssuanceOriginal)=>void){const value=structuredClone(original());change(value);const {originalHash:_,...input}=value;return normalizeVehicleIssuanceOriginal(input);}

describe('private original vehicle canonical request encoding',()=>{
 it('matches the accepted Rust kind3 ABI with an independently laid out161-byte permit and274-byte request',()=>{
  const o=original(),permit=vehiclePermitMessage(o),expected=Buffer.alloc(161);
  expected.write('SKPERMT2');new PublicKey(o.genesisHash).toBuffer().copy(expected,8);new PublicKey(VEHICLE_CRAFT_PROGRAM).toBuffer().copy(expected,40);
  expected[72]=3;Buffer.from(o.permitId,'hex').copy(expected,73);new PublicKey(o.buyer).toBuffer().copy(expected,89);expected.writeBigInt64LE(BigInt(o.permitExpiry),121);Buffer.from(vehicleTermsHash(o),'hex').copy(expected,129);
  expect(permit).toEqual(expected);
  const [proof,request]=vehicleRequestInstructions(o,policy.publicKey.toBase58(),signature(o));
  expect(proof!.programId).toEqual(Ed25519Program.programId);expect(proof!.keys).toEqual([]);
  expect(proof!.data.length).toBe(273);expect(proof!.data.subarray(0,16).toString('hex')).toBe('01003000ffff1000ffff7000a100ffff');
  expect(proof!.data.subarray(16,48)).toEqual(policy.publicKey.toBuffer());expect(proof!.data.subarray(112)).toEqual(expected);
  const data=request!.data;expect(data).toHaveLength(274);expect([...data.subarray(0,8)]).toEqual([77,24,114,216,192,7,239,72]);expect(request!.programId.toBase58()).toBe(VEHICLE_CRAFT_PROGRAM);
  // Offsets independently pin Anchor request args, including the proof index0.
  expect(data.subarray(8,24).toString('hex')).toBe(o.rootId);expect(data.subarray(24,40).toString('hex')).toBe(o.attemptId);
  expect(data.readUInt32LE(40)).toBe(o.terms.recipeVersion);
  for(const [offset,key]of [[44,'recipeHash'],[76,'materialHash'],[108,'metadataHash']]as const)expect(data.subarray(offset,offset+32).toString('hex')).toBe(o.terms[key]);
  for(const [offset,key]of [[140,'site'],[172,'operator'],[204,'project']]as const)expect(new PublicKey(data.subarray(offset,offset+32)).toBase58()).toBe(o.terms[key]);
  expect(data.readBigUInt64LE(236)).toBe(BigInt(o.terms.oracleBudget));expect(data.readUInt16LE(244)).toBe(o.terms.oddsBps);expect([...data.subarray(246,248)]).toEqual([o.terms.family,o.terms.tier]);
  expect(data.subarray(248,264).toString('hex')).toBe(o.permitId);expect(data.readBigInt64LE(264)).toBe(BigInt(o.permitExpiry));expect(data.readUInt16LE(272)).toBe(0);
  expect(request!.keys.map(k=>[k.pubkey.toBase58(),k.isWritable,k.isSigner])).toEqual([
   [o.buyer,true,true],[vehiclePda('vehicle_control')[0].toBase58(),false,false],
   ...[['vehicle_root',o.rootId],['vehicle_attempt',o.attemptId],['vehicle_permit',o.permitId],['vehicle_app',o.rootId],['vehicle_oracle',o.rootId]].map(([seed,id])=>[vehiclePda(seed!,id)[0].toBase58(),true,false]),
   [o.identity.assetId,false,false],[vehiclePda('identity')[0].toBase58(),false,false],[VEHICLE_VRF_QUEUE,true,false],[VEHICLE_VRF_PROGRAM,false,false],
   [SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),false,false],[SYSVAR_SLOT_HASHES_PUBKEY.toBase58(),false,false],[SystemProgram.programId.toBase58(),false,false],
  ]);
 });
 it.each([
  ['actor',(o:VehicleIssuanceOriginal)=>{o.buyer=policy.publicKey.toBase58();}],
  ['root',(o:VehicleIssuanceOriginal)=>{o.rootId='ab'.repeat(16);o.identity=vehicleIdentity(o.rootId,o.terms.family,o.terms.tier);}],
  ['attempt',(o:VehicleIssuanceOriginal)=>{o.attemptId='ab'.repeat(16);}],
  ['permit',(o:VehicleIssuanceOriginal)=>{o.permitId='ab'.repeat(16);}],
  ['expiry',(o:VehicleIssuanceOriginal)=>{o.permitExpiry=(BigInt(o.permitExpiry)+1n).toString();}],
  ['genesis',(o:VehicleIssuanceOriginal)=>{o.genesisHash=blockhash;}],
  ['rent',(o:VehicleIssuanceOriginal)=>{o.escrowRentReserve=(BigInt(o.escrowRentReserve)+1n).toString();}],
  ['recipe',(o:VehicleIssuanceOriginal)=>{o.terms.recipeHash='ab'.repeat(32);}],
  ['version',(o:VehicleIssuanceOriginal)=>{o.terms.recipeVersion++;}],
  ['materials',(o:VehicleIssuanceOriginal)=>{o.terms.materialHash='ab'.repeat(32);}],
  ['metadata',(o:VehicleIssuanceOriginal)=>{o.metadata.name='Changed';o.terms.metadataHash=vehicleMetadataHash(o.metadata.name,o.metadata.uri);}],
  ['site',(o:VehicleIssuanceOriginal)=>{o.terms.site=blockhash;}],
  ['operator',(o:VehicleIssuanceOriginal)=>{o.terms.operator=blockhash;}],
  ['project',(o:VehicleIssuanceOriginal)=>{o.terms.project=blockhash;}],
  ['oracle',(o:VehicleIssuanceOriginal)=>{o.terms.oracleBudget=(BigInt(o.terms.oracleBudget)+1n).toString();}],
  ['odds',(o:VehicleIssuanceOriginal)=>{o.terms.oddsBps--;}],
  ['family',(o:VehicleIssuanceOriginal)=>{o.terms.family=1;o.identity=vehicleIdentity(o.rootId,o.terms.family,o.terms.tier);}],
  ['tier',(o:VehicleIssuanceOriginal)=>{o.terms.tier=2;o.identity=vehicleIdentity(o.rootId,o.terms.family,o.terms.tier);}],
 ] as const)('never reuses one policy authorization after changing %s',(_label,change)=>{
  expect(()=>vehicleRequestInstructions(changed(change),policy.publicKey.toBase58(),signature(original()))).toThrow('SIGNATURE');
 });
 it('rejects another signer, malformed and altered signatures before constructing instructions',()=>{
  const o=original(),sig=signature(o);sig[0]=sig[0]!^1;
  for(const bytes of [sig,Buffer.alloc(63),Buffer.alloc(65),Buffer.alloc(64)])expect(()=>vehicleRequestInstructions(o,policy.publicKey.toBase58(),bytes)).toThrow('SIGNATURE');
  expect(()=>vehicleRequestInstructions(o,blockhash,signature(o))).toThrow('SIGNATURE');
 });
 it('fits the exact single-payer legacy packet and rejects altered consent or extra instructions',()=>{
  const o=original(),sig=signature(o),key=policy.publicKey.toBase58(),bytes=vehicleRequestLegacyMessage(o,key,sig,blockhash),message=Message.from(bytes);
  expect(bytes.length+65).toBeLessThanOrEqual(1232);expect(message.header.numRequiredSignatures).toBe(1);expect(message.accountKeys[0]!.toBase58()).toBe(o.buyer);expect(message.instructions).toHaveLength(2);
  expect(()=>verifyVehicleRequestLegacyMessage(bytes,o,key,sig,blockhash)).not.toThrow();
  const make=()=>new Transaction({feePayer:new PublicKey(o.buyer),recentBlockhash:blockhash}).add(...vehicleRequestInstructions(o,key,sig));
  const mutations=[
   (t:Transaction)=>{t.instructions[0]!.data[184]=2;},(t:Transaction)=>{t.instructions[0]!.data[14]=0;},
   (t:Transaction)=>{t.instructions[1]!.programId=policy.publicKey;},
   (t:Transaction)=>{t.instructions.reverse();},(t:Transaction)=>{t.instructions[1]!.data[272]=1;},
   (t:Transaction)=>{t.instructions[1]!.keys[9]!.pubkey=policy.publicKey;},(t:Transaction)=>{t.instructions[1]!.keys[7]!.isWritable=true;},
   (t:Transaction)=>{t.instructions[1]!.keys[10]!.isSigner=true;},(t:Transaction)=>{t.feePayer=policy.publicKey;},
   (t:Transaction)=>{t.recentBlockhash=policy.publicKey.toBase58();},(t:Transaction)=>{t.add(SystemProgram.transfer({fromPubkey:new PublicKey(o.buyer),toPubkey:policy.publicKey,lamports:1}));},
  ];
  for(const change of mutations){const tx=make();change(tx);expect(()=>verifyVehicleRequestLegacyMessage(tx.serializeMessage(),o,key,sig,blockhash)).toThrow();}
  for(const malformed of [Buffer.alloc(0),Buffer.concat([bytes,Buffer.of(0)]),Buffer.alloc(1233)])expect(()=>verifyVehicleRequestLegacyMessage(malformed,o,key,sig,blockhash)).toThrow('MESSAGE');
 });
 it('detaches all outputs and rejects stale original hashes and noncanonical blockhashes',()=>{
  const o=original(),sig=signature(o),key=policy.publicKey.toBase58(),before=vehicleRequestLegacyMessage(o,key,sig,blockhash),instructions=vehicleRequestInstructions(o,key,sig);
  instructions[0]!.data.fill(0);instructions[1]!.keys.length=0;sig.fill(0);vehiclePermitMessage(o).fill(0);
  expect(vehicleRequestLegacyMessage(o,key,signature(o),blockhash)).toEqual(before);
  expect(()=>vehicleRequestLegacyMessage({...o,permitExpiry:'1'},key,signature(o),blockhash)).toThrow('ORIGINAL');
  expect(()=>vehicleRequestLegacyMessage(o,key,signature(o),'bad blockhash')).toThrow('MESSAGE');
 });
});
