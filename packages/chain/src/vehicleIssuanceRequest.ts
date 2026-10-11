/** D153.213 exact local request encoding. No current admission, funding,
 * wallet signing or delivery authority is inferred from these bytes. */
import {createPublicKey,verify} from 'node:crypto';
import {Ed25519Program,PACKET_DATA_SIZE,PublicKey,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,SYSVAR_SLOT_HASHES_PUBKEY,Transaction,TransactionInstruction} from '@solana/web3.js';
import {normalizeVehicleIssuanceOriginal} from './vehicleIssuanceAccounts';
import {VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE,vehicleAddress,vehicleDiscriminator,vehiclePda,vehicleTermsBytes,vehicleTermsHash,vehicleU64} from './vehicleIssuanceProtocol';

export class VehicleIssuanceRequestError extends Error {
 constructor(readonly code:'SIGNATURE'|'MESSAGE'){super(`Vehicle request encoding refused: ${code}`);this.name='VehicleIssuanceRequestError';}
}
/** Canonical SKPERMT2 kind3 message consumed by vehicle_permit.rs. */
export function vehiclePermitMessage(original:unknown):Buffer {
 const o=normalizeVehicleIssuanceOriginal(original);
 return Buffer.concat([Buffer.from('SKPERMT2'),new PublicKey(o.genesisHash).toBuffer(),new PublicKey(VEHICLE_CRAFT_PROGRAM).toBuffer(),Buffer.of(3),
  Buffer.from(o.permitId,'hex'),new PublicKey(o.buyer).toBuffer(),vehicleU64(BigInt(o.permitExpiry)),Buffer.from(vehicleTermsHash(o),'hex')]);
}
/** Exactly the Ed25519 proof at index0 followed by request_vehicle at index1.
 * All returned bytes and metas are owned copies; no caller object is retained. */
export function vehicleRequestInstructions(original:unknown,policyAuthority:string,signature:Uint8Array):TransactionInstruction[] {
 const o=normalizeVehicleIssuanceOriginal(original),message=vehiclePermitMessage(o);
 let policy:PublicKey,sig:Buffer;
 try{
  policy=new PublicKey(vehicleAddress(policyAuthority));
  if(!(signature instanceof Uint8Array)||signature.length!==64)throw Error('length');
  sig=Buffer.from(signature);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),policy.toBuffer()]),format:'der',type:'spki'});
  if(!verify(null,message,key,sig))throw Error('signature');
 }catch{throw new VehicleIssuanceRequestError('SIGNATURE');}
 const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
 return [Ed25519Program.createInstructionWithPublicKey({publicKey:policy.toBytes(),message,signature:sig}),new TransactionInstruction({
  programId:new PublicKey(VEHICLE_CRAFT_PROGRAM),
  keys:[meta(new PublicKey(o.buyer),true,true),meta(vehiclePda('vehicle_control')[0]),meta(vehiclePda('vehicle_root',o.rootId)[0],true),
   meta(vehiclePda('vehicle_attempt',o.attemptId)[0],true),meta(vehiclePda('vehicle_permit',o.permitId)[0],true),meta(vehiclePda('vehicle_app',o.rootId)[0],true),
   meta(vehiclePda('vehicle_oracle',o.rootId)[0],true),meta(vehiclePda('vehicle_asset',o.rootId)[0]),meta(vehiclePda('identity')[0]),
   meta(new PublicKey(VEHICLE_VRF_QUEUE),true),meta(new PublicKey(VEHICLE_VRF_PROGRAM)),meta(SYSVAR_INSTRUCTIONS_PUBKEY),meta(SYSVAR_SLOT_HASHES_PUBKEY),meta(SystemProgram.programId)],
  data:Buffer.concat([vehicleDiscriminator('global','request_vehicle'),Buffer.from(o.rootId,'hex'),Buffer.from(o.attemptId,'hex'),vehicleTermsBytes(o.terms),
   Buffer.from(o.permitId,'hex'),vehicleU64(BigInt(o.permitExpiry)),Buffer.of(0,0)]),
 })];
}
/** Unsigned legacy message only. The caller owns blockhash provenance/lifetime
 * and every admission/quote check. No ALT, additional instruction or co-signer. */
export function vehicleRequestLegacyMessage(original:unknown,policyAuthority:string,signature:Uint8Array,recentBlockhash:string):Buffer {
 const o=normalizeVehicleIssuanceOriginal(original),instructions=vehicleRequestInstructions(o,policyAuthority,signature);
 try{
  if(typeof recentBlockhash!=='string'||new PublicKey(recentBlockhash).toBase58()!==recentBlockhash)throw Error('blockhash');
  const tx=new Transaction({feePayer:new PublicKey(o.buyer),recentBlockhash}).add(...instructions),message=tx.compileMessage();
  const bytes=Buffer.from(message.serialize());
  // One compact-vector byte and exactly one 64-byte payer signature.
  if(message.header.numRequiredSignatures!==1||message.header.numReadonlySignedAccounts!==0||bytes.length+65>PACKET_DATA_SIZE)throw Error('packet');
  return bytes;
 }catch{throw new VehicleIssuanceRequestError('MESSAGE');}
}
/** Exact comparison to a freshly encoded canonical legacy message. This is
 * deliberately not a wallet-signature verifier or current delivery admission. */
export function verifyVehicleRequestLegacyMessage(message:Uint8Array,original:unknown,policyAuthority:string,signature:Uint8Array,recentBlockhash:string):void {
 if(!(message instanceof Uint8Array)||message.length===0||message.length+65>PACKET_DATA_SIZE)throw new VehicleIssuanceRequestError('MESSAGE');
 const expected=vehicleRequestLegacyMessage(original,policyAuthority,signature,recentBlockhash);
 if(!expected.equals(message))throw new VehicleIssuanceRequestError('MESSAGE');
}
