/** D-153.123: pure reserved Core burn consent. The application must commit the
 * family/berth/asset reservation before exposing these bytes. This builder has
 * no registry, ownership, finality, signing, relay or reservation authority. */
import {createHash} from 'node:crypto';
import {getBurnV1InstructionDataSerializer,MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,PACKET_DATA_SIZE,SystemProgram} from '@solana/web3.js';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';

const CORE=new PublicKey(MPL_CORE_PROGRAM_ID),MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export class VehicleBurnMessageError extends Error {
 constructor(){super('Vehicle burn message refused: INPUT');this.name='VehicleBurnMessageError';}
}
export interface VehicleBurnMessageInput {
 readonly wallet:string;
 readonly reservationId:string;
 readonly identity:PhaseEVehicleMintIdentity;
 readonly blockhash:string;
}
function need(v:unknown):asserts v{if(!v)throw new VehicleBurnMessageError();}
function key(v:string){need(typeof v==='string'&&v.length>=32&&v.length<=44);const k=new PublicKey(v);need(k.toBase58()===v);return k;}
export function buildVehicleBurnMessage(input:VehicleBurnMessageInput){
 try{
  need(input&&typeof input==='object'&&!Array.isArray(input));
  const fields=Reflect.ownKeys(input);need(fields.length===4&&fields.every(k=>['wallet','reservationId','identity','blockhash'].includes(k as string)));
  const identity=PhaseEVehicleMintIdentitySchema.parse(input.identity),wallet=key(input.wallet),blockhash=key(input.blockhash).toBase58();
  need(PublicKey.isOnCurve(wallet.toBytes()));
  need(typeof input.reservationId==='string'&&input.reservationId.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.reservationId));
  const asset=key(identity.assetId),collection=key(identity.collection),reservationId=input.reservationId;
  // Programs, wallet, asset and collection have distinct roles. Aliasing any
  // role changes writable/signer semantics and is not an admitted vehicle.
  need(new Set([wallet,asset,collection,CORE,MEMO,SystemProgram.programId].map(k=>k.toBase58())).size===6);
  const burn=new TransactionInstruction({programId:CORE,keys:[
   {pubkey:asset,isSigner:false,isWritable:true},{pubkey:collection,isSigner:false,isWritable:true},
   {pubkey:wallet,isSigner:true,isWritable:true},{pubkey:wallet,isSigner:true,isWritable:false},
   {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:CORE,isSigner:false,isWritable:false},
  ],data:Buffer.from(getBurnV1InstructionDataSerializer().serialize({}))});
  const memo=new TransactionInstruction({programId:MEMO,keys:[{pubkey:wallet,isSigner:true,isWritable:false}],
   data:Buffer.from(`shardkeep:vehicle-install:v1:${reservationId}:${identity.family}:${identity.tier}`,'utf8')});
  const message=new TransactionMessage({payerKey:wallet,recentBlockhash:blockhash,instructions:[burn,memo]}).compileToLegacyMessage();
  need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.accountKeys[0]!.equals(wallet));
  const bytes=message.serialize(),packetBytes=new VersionedTransaction(message).serialize().length;need(packetBytes<=PACKET_DATA_SIZE);
  return Object.freeze({reservationId,wallet:wallet.toBase58(),identity:Object.freeze(identity),blockhash,
   get messageBytes(){return Uint8Array.from(bytes);},messageSha256:createHash('sha256').update(bytes).digest('hex'),packetBytes,
   signingAuthorized:false as const,broadcastAuthorized:false as const});
 }catch{throw new VehicleBurnMessageError();}
}
