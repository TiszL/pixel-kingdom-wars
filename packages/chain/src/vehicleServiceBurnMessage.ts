/** D-153.132: purpose-bound service consent, never service admission or release.
 * Reuses the validated Core burn from the frozen installation builder, leaving
 * all original installation messages and verification paths unchanged. */
import {createHash} from 'node:crypto';
import {Message,PACKET_DATA_SIZE,PublicKey,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {vehicleServiceTransition,type VehicleServiceState} from '@shardkeep/shared/phaseEVehicleService';
import {buildVehicleBurnMessage,type VehicleBurnMessageInput} from './vehicleBurnMessage';
export interface VehicleServiceBurnMessageInput extends VehicleBurnMessageInput {readonly service:VehicleServiceState}
export class VehicleServiceBurnMessageError extends Error{constructor(){super('Vehicle service burn consent refused');this.name='VehicleServiceBurnMessageError';}}
export function buildVehicleServiceBurnMessage(input:VehicleServiceBurnMessageInput){
 try{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('input');
  const keys=Reflect.ownKeys(input);if(keys.length!==5||!keys.every(k=>['wallet','reservationId','identity','blockhash','service'].includes(k as string)))throw Error('input');
  const service=vehicleServiceTransition(input.service),original=buildVehicleBurnMessage({wallet:input.wallet,reservationId:input.reservationId,identity:input.identity,blockhash:input.blockhash});
  if(service.installationId===original.reservationId||service.family!==original.identity.family||service.tier!==original.identity.tier)throw Error('identity');
  // Fixed field order is the canonical v1 hash preimage. It binds the complete
  // original state and deterministic result, not a caller's JSON key order.
  const serviceJson=JSON.stringify({version:service.version,operation:service.operation,installationId:service.installationId,baseId:service.baseId,berthId:service.berthId,
   revision:service.revision,family:service.family,tier:service.tier,completedTotal:service.completedTotal,allowanceStart:service.allowanceStart,
   tierAfter:service.tierAfter,revisionAfter:service.revisionAfter,allowanceStartAfter:service.allowanceStartAfter,remainingUses:service.remainingUses});
  const serviceSha256=createHash('sha256').update(serviceJson).digest('hex'),wallet=new PublicKey(original.wallet);
  const instructions=Transaction.populate(Message.from(original.messageBytes)).instructions;if(instructions.length!==2)throw Error('burn');
  const memo=new TransactionInstruction({programId:instructions[1]!.programId,keys:[{pubkey:wallet,isSigner:true,isWritable:false}],
   data:Buffer.from(`shardkeep:vehicle-service:v1:${original.reservationId}:${serviceSha256}`,'utf8')});
  const message=new TransactionMessage({payerKey:wallet,recentBlockhash:original.blockhash,instructions:[instructions[0]!,memo]}).compileToLegacyMessage(),bytes=message.serialize(),packetBytes=new VersionedTransaction(message).serialize().length;
  if(packetBytes>PACKET_DATA_SIZE||message.header.numRequiredSignatures!==1||message.header.numReadonlySignedAccounts!==0||!message.accountKeys[0]!.equals(wallet))throw Error('packet');
  return Object.freeze({reservationId:original.reservationId,wallet:original.wallet,identity:original.identity,blockhash:original.blockhash,service,serviceJson,serviceSha256,
   get messageBytes(){return Uint8Array.from(bytes);},messageSha256:createHash('sha256').update(bytes).digest('hex'),packetBytes,
   signingAuthorized:false as const,broadcastAuthorized:false as const,serviceAuthorized:false as const});
 }catch{throw new VehicleServiceBurnMessageError();}
}
