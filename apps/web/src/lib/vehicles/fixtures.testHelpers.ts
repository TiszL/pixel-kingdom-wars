import {createHash} from 'node:crypto';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {buildVehicleBurnMessage} from '../../../../../packages/chain/src/vehicleBurnMessage';
import {buildVehicleServiceBurnMessage} from '../../../../../packages/chain/src/vehicleServiceBurnMessage';
import {VehicleClientSchema} from '@shardkeep/shared/vehicleClientApi';
import type {VehicleSigningTrust} from './signing';
export function vehicleFixture(kind:'installation'|'upgrade'|'restore_uses'='installation'){
 const kp=(n:number)=>Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>(n+i)%256)),signer=kp(17),wallet=signer.publicKey.toBase58(),asset=kp(61).publicKey.toBase58(),collection=kp(94).publicKey.toBase58(),blockhash=kp(118).publicKey.toBase58(),genesis=kp(149).publicKey.toBase58();
 const id='10000000-0000-4000-8000-000000000001',installationId='10000000-0000-4000-8000-000000000002',baseId='10000000-0000-4000-8000-000000000003',berthId='10000000-0000-4000-8000-000000000004',at='2035-01-01T00:00:00.000001Z',identity={assetId:asset,collection,family:'survey_balloon' as const,tier:1 as const};
 const trust:VehicleSigningTrust={version:1,revision:'d182-test-v1',core:{expectedGenesisHash:genesis,reviewedDeploymentSlot:10,reviewedProgramDataSha256:'a'.repeat(64),upgradeAuthority:null},operationalPolicyVersion:1};
 const input={wallet,reservationId:id,identity,blockhash},state={operation:kind==='installation'?'upgrade' as const:kind,installationId,baseId,berthId,revision:0,family:identity.family,tier:identity.tier,completedTotal:kind==='restore_uses'?'100':'3',allowanceStart:'0'};
 const plan=kind==='installation'?buildVehicleBurnMessage(input):buildVehicleServiceBurnMessage({...input,service:state});
 const p={messageHex:Buffer.from(plan.messageBytes).toString('hex'),messageSha256:plan.messageSha256,blockhash,blockhashContextSlot:20,lastValidBlockHeight:1000,recordedAt:at};
 const flags={signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false},common={version:1,wallet,idempotencyKey:'original/key?',serverNow:'2035-01-01T00:00:00.000Z',status:'prepared',signed:null,...flags};
 const record=kind==='installation'?{...common,purpose:'vehicle_installation',reservation:{reservationId:id,wallet,request:{baseId,berthId,assetId:asset,idempotencyKey:common.idempotencyKey},identity,completedBuildJobId:berthId,berthCompletedAt:at,reservedAt:at},preparation:p,installation:null,installationAuthorized:false}:{...common,purpose:'vehicle_service',intent:{intentId:id,wallet,request:{installationId,assetId:asset,operation:kind,idempotencyKey:common.idempotencyKey},identity,state,reservedAt:at},preparation:{...p,serviceSha256:'serviceSha256'in plan?plan.serviceSha256:''},application:null,serviceAuthorized:false};
 const client=VehicleClientSchema.parse({version:1,kind:kind==='installation'?'installation':'service',record,consentSource:{genesisHash:genesis,anchorSlot:20,reviewedDeploymentSlot:10,reviewedProgramDataSha256:'a'.repeat(64)},burnReceipt:null});
 const tx=new VersionedTransaction(Message.from(plan.messageBytes));tx.sign([signer]);const wire={signedTransactionHex:Buffer.from(tx.serialize()).toString('hex'),signature:bs58.encode(tx.signatures[0]!),wireSha256:createHash('sha256').update(tx.serialize()).digest('hex'),messageSha256:plan.messageSha256};return {signer,trust,client,wire,plan};
}
