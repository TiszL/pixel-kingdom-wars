import {describe,expect,it} from 'vitest';
import {Keypair,Message,Transaction,VersionedTransaction} from '@solana/web3.js';
import {buildVehicleBurnMessage} from './vehicleBurnMessage';
import {buildVehicleServiceBurnMessage} from './vehicleServiceBurnMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
const key=()=>Keypair.generate().publicKey.toBase58();
function fixture(){const wallet=Keypair.generate();return {wallet,input:{wallet:wallet.publicKey.toBase58(),reservationId:'dadf0bd5-4c24-4e5f-8491-4c67901d1b78',blockhash:key(),identity:{assetId:key(),collection:key(),family:'cargo_cutter' as const,tier:2 as const},
 service:{operation:'upgrade' as const,installationId:'548a40c0-8d08-4c53-ac9d-2d2f5ae8b922',baseId:'bf3b77c1-e048-49eb-8f00-2486c6ac8f76',berthId:'6229952c-d168-423e-b71e-f665a93c6de8',revision:7,family:'cargo_cutter' as const,tier:2 as const,completedTotal:'200',allowanceStart:'100'}}};}
describe('purpose-bound vehicle service burn consent',()=>{
 it('preserves the validated Core burn while binding service purpose and revision in a different signed memo',()=>{
  const {input}=fixture(),built=buildVehicleServiceBurnMessage(input),old=buildVehicleBurnMessage({wallet:input.wallet,reservationId:input.reservationId,blockhash:input.blockhash,identity:input.identity}),instructions=Transaction.populate(Message.from(built.messageBytes)).instructions;
  expect(instructions).toHaveLength(2);expect(instructions[0]).toEqual(Transaction.populate(Message.from(old.messageBytes)).instructions[0]);
  expect(instructions[1]!.data.toString()).toBe(`shardkeep:vehicle-service:v1:${input.reservationId}:${built.serviceSha256}`);
  expect(built.messageSha256).not.toBe(old.messageSha256);expect(built.packetBytes).toBeLessThanOrEqual(1232);
  expect(built).toMatchObject({signingAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false});
 });
 it('seals operation, installation, destination, revision and allowance counters independently',()=>{
  const {input}=fixture(),original=buildVehicleServiceBurnMessage(input).messageSha256;
  for(const patch of [{operation:'restore_uses'},{installationId:'548a40c0-8d08-4c53-ac9d-2d2f5ae8b923'},
   {baseId:'bf3b77c1-e048-49eb-8f00-2486c6ac8f77'},{berthId:'6229952c-d168-423e-b71e-f665a93c6de9'},
   {revision:8},{completedTotal:'199'},{completedTotal:'201',allowanceStart:'101'}])
   expect(buildVehicleServiceBurnMessage({...input,service:{...input.service,...patch}} as never).messageSha256).not.toBe(original);
 });
 it('refuses a different family/tier, original installation as service id, or injected authority/instructions',()=>{
  const {input}=fixture();for(const patch of [{identity:{...input.identity,tier:3}},{service:{...input.service,family:'survey_balloon'}},
   {reservationId:input.service.installationId},{serviceAuthorized:true},{instructions:[]}])expect(()=>buildVehicleServiceBurnMessage({...input,...patch} as never)).toThrow();
 });
 it('retains owned consent bytes and immutable service fields',()=>{
  const {input}=fixture(),built=buildVehicleServiceBurnMessage(input),bytes=built.messageBytes;input.service.completedTotal='175';built.messageBytes.fill(0);
  expect(built.messageBytes).toEqual(bytes);expect(built.service.completedTotal).toBe('200');expect(Object.isFrozen(built.service)).toBe(true);
 });
 it('is locally signable as exactly one wallet signature, without finality or service permission',()=>{
  const {wallet,input}=fixture(),built=buildVehicleServiceBurnMessage(input),tx=new VersionedTransaction(Message.from(built.messageBytes));tx.sign([wallet]);
  expect(verifyMiningClaimSignedWire({intentBytes:built.messageBytes,signedTransaction:tx.serialize(),wallet:wallet.publicKey}).messageSha256).toBe(built.messageSha256);
  expect(built.service).toMatchObject({tierAfter:3,remainingUses:0,serviceAuthorized:false});
 });
});
