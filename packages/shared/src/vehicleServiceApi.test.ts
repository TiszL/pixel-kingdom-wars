import {describe,expect,it} from 'vitest';
import {PHASE_E_VEHICLES} from './constants';
import {vehicleServiceTransition} from './phaseEVehicleService';
import {VehicleServiceApplicationSchema,VehicleServiceEnvelopeSchema,VehicleServiceIntentSchema,VehicleServicePreparationSchema,VehicleServiceRequestSchema,VehicleServiceSignedRequestSchema,VehicleServiceSignedSchema,matchVehicleServiceEnvelope} from './vehicleServiceApi';

const installationId='10000000-0000-4000-8000-000000000001',baseId='10000000-0000-4000-8000-000000000002',berthId='10000000-0000-4000-8000-000000000003',intentId='10000000-0000-4000-8000-000000000004';
const wallet='So11111111111111111111111111111111111111112',other='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',signature='1'.repeat(64),otherSignature='1'.repeat(63)+'2';
const request={installationId,assetId:wallet,operation:'upgrade' as const,idempotencyKey:'service-at-original-state'};
const state={operation:request.operation,installationId,baseId,berthId,revision:0,family:'survey_balloon' as const,tier:1 as const,completedTotal:'3',allowanceStart:'0'};
const identity={assetId:wallet,collection:other,family:state.family,tier:state.tier};
const time=(micros:string)=>`2035-01-01T01:00:00.${micros}Z`;
// Opaque message/hash/signature fixtures exercise wire shape and consistency.
// Actual message construction, hashes and Ed25519 are the private API's job.
function fixtures(){
 const transition=vehicleServiceTransition(state);
 const intent={intentId,wallet,request:{...request},identity:{...identity},state:{...state},reservedAt:time('000001')};
 const preparation={messageHex:'ab'.repeat(100),messageSha256:'a'.repeat(64),serviceSha256:'b'.repeat(64),blockhash:wallet,blockhashContextSlot:20,lastValidBlockHeight:1000,recordedAt:time('000002')};
 const signed={signature,wireSha256:'c'.repeat(64),messageSha256:preparation.messageSha256,acceptedAt:time('000003')};
 const application={tierAfter:transition.tierAfter,revisionAfter:transition.revisionAfter,completedTotal:state.completedTotal,allowanceStartAfter:transition.allowanceStartAfter,remainingUses:transition.remainingUses,appliedAt:time('000004'),signature};
 return {intent,preparation,signed,application};
}
function envelope(status:'reserved'|'prepared'|'signed'|'applied'='applied'){
 const f=fixtures();return {version:1,purpose:'vehicle_service',wallet,idempotencyKey:request.idempotencyKey,serverNow:'2035-01-01T01:00:00.001Z',status,intent:f.intent,
  preparation:status==='reserved'?null:f.preparation,signed:status==='signed'||status==='applied'?f.signed:null,application:status==='applied'?f.application:null,
  signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false,serviceAuthorized:false};
}
describe('redacted original-actor vehicle service protocol',()=>{
 it.each(['reserved','prepared','signed','applied'] as const)('accepts the exact %s graph without granting authority',status=>{
  const raw=envelope(status),saved=matchVehicleServiceEnvelope(raw,wallet,request);expect(saved).toEqual(raw);expect(saved.serviceAuthorized).toBe(false);
 });
 it('accepts an applied lost-wire recovery with no retained signed row',()=>{
  const raw={...envelope(),signed:null};expect(VehicleServiceEnvelopeSchema.parse(raw)).toEqual(raw);
 });
 it('rejects contradictory status graphs and unknown successful responses',()=>{
  const f=fixtures();for(const raw of [{...envelope('reserved'),preparation:f.preparation},{...envelope('prepared'),preparation:null},{...envelope('prepared'),signed:f.signed},{...envelope('signed'),signed:null},{...envelope('signed'),application:f.application},{...envelope(),preparation:null},{...envelope(),application:null},{...envelope(),status:'unknown'}])expect(VehicleServiceEnvelopeSchema.safeParse(raw).success).toBe(false);
 });
 it('binds original actor, key and every request field when matching history',()=>{
  const raw=envelope();for(const changed of [{...request,installationId:baseId},{...request,assetId:other},{...request,operation:'restore_uses'},{...request,idempotencyKey:'another-key'}])expect(()=>matchVehicleServiceEnvelope(raw,wallet,changed)).toThrow();
  expect(()=>matchVehicleServiceEnvelope(raw,other,request)).toThrow();
  for(const mutation of [{wallet:other},{idempotencyKey:'another-key'},{purpose:'vehicle_installation'},{version:2}])expect(VehicleServiceEnvelopeSchema.safeParse({...raw,...mutation}).success).toBe(false);
 });
 it('ties request, registry identity and full original state in the intent',()=>{
  const {intent}=fixtures();for(const mutation of [{intentId:installationId},{request:{...request,installationId:baseId}},{request:{...request,assetId:other}},{request:{...request,operation:'restore_uses'}},{identity:{...identity,family:'cargo_cutter'}},{identity:{...identity,tier:2}}])expect(VehicleServiceIntentSchema.safeParse({...intent,...mutation}).success).toBe(false);
 });
 it('binds signed message hash and applied signature to the retained artifacts',()=>{
  const raw=envelope(),f=fixtures();expect(VehicleServiceEnvelopeSchema.safeParse({...raw,signed:{...f.signed,messageSha256:'d'.repeat(64)}}).success).toBe(false);
  expect(VehicleServiceEnvelopeSchema.safeParse({...raw,application:{...f.application,signature:otherSignature}}).success).toBe(false);
 });
 it('recomputes every applied field from the original shared transition',()=>{
  const raw=envelope(),f=fixtures();for(const mutation of [{tierAfter:3},{revisionAfter:2},{completedTotal:'4'},{allowanceStartAfter:'1'},{remainingUses:f.application.remainingUses-1}])expect(VehicleServiceEnvelopeSchema.safeParse({...raw,application:{...f.application,...mutation}}).success).toBe(false);
 });
 it('preserves lifetime counters through exhausted upgrade and same-tier restoration',()=>{
  for(const operation of ['upgrade','restore_uses'] as const){const before={...state,operation,completedTotal:String(2*PHASE_E_VEHICLES.completedUsesPerInstall),allowanceStart:String(PHASE_E_VEHICLES.completedUsesPerInstall)},transition=vehicleServiceTransition(before),raw=envelope();
   const value={...raw,intent:{...raw.intent,request:{...request,operation},state:before},application:{...fixtures().application,tierAfter:transition.tierAfter,revisionAfter:transition.revisionAfter,completedTotal:before.completedTotal,allowanceStartAfter:transition.allowanceStartAfter,remainingUses:transition.remainingUses}};
   expect(VehicleServiceEnvelopeSchema.parse(value).application).toEqual(value.application);
  }
 });
 it('rejects noncanonical or overflowing counters, invalid revisions and changed shared policy',()=>{
  const {intent}=fixtures();for(const completedTotal of ['-1','01','1.0','1e2','9223372036854775808'])expect(VehicleServiceIntentSchema.safeParse({...intent,state:{...state,completedTotal}}).success).toBe(false);
  for(const revision of [-1,0.5,Number.MAX_SAFE_INTEGER])expect(VehicleServiceIntentSchema.safeParse({...intent,state:{...state,revision}}).success).toBe(false);
  expect(VehicleServiceIntentSchema.safeParse({...intent,identity:{...identity,tier:4},state:{...state,tier:4}}).success).toBe(false);
  expect(VehicleServiceApplicationSchema.safeParse({...fixtures().application,allowanceStartAfter:'4'}).success).toBe(false);
 });
 it('requires real canonical UTC precision while allowing signed retention after application',()=>{
  const f=fixtures();for(const reservedAt of ['2035-02-30T01:00:00.000001Z','2035-01-01T01:00:00.000Z','2035-01-01T01:00:00.000001+00:00'])expect(VehicleServiceIntentSchema.safeParse({...f.intent,reservedAt}).success).toBe(false);
  expect(VehicleServiceEnvelopeSchema.safeParse({...envelope(),serverNow:time('000001')}).success).toBe(false);
  expect(VehicleServiceEnvelopeSchema.safeParse({...envelope(),signed:{...f.signed,acceptedAt:time('000009')}}).success).toBe(true);
 });
 it('rejects noncanonical identifiers, message bytes, hashes, signatures and unsafe lifetime fields',()=>{
  const f=fixtures();for(const id of ['ABCDEFAB-0000-4000-8000-000000000001','not-a-uuid'])expect(VehicleServiceRequestSchema.safeParse({...request,installationId:id}).success).toBe(false);
  for(const messageHex of ['', 'a','AB','ab'.repeat(1168)])expect(VehicleServicePreparationSchema.safeParse({...f.preparation,messageHex}).success).toBe(false);
  for(const messageSha256 of ['A'.repeat(64),'a'.repeat(63)])expect(VehicleServicePreparationSchema.safeParse({...f.preparation,messageSha256}).success).toBe(false);
  for(const invalid of ['0'.repeat(64),'1'.repeat(63),'1'.repeat(65)])expect(VehicleServiceSignedSchema.safeParse({...f.signed,signature:invalid}).success).toBe(false);
  for(const blockhashContextSlot of [-1,0.5,Number.MAX_SAFE_INTEGER+1])expect(VehicleServicePreparationSchema.safeParse({...f.preparation,blockhashContextSlot}).success).toBe(false);
 });
 it('permits only identifiers in requests and no private proof or raw signed artifacts in responses',()=>{
  for(const extra of [{wallet},{tier:1},{state},{proof:{}},{baseId},{enabled:true}])expect(VehicleServiceRequestSchema.safeParse({...request,...extra}).success).toBe(false);
  const raw=envelope(),f=fixtures();for(const changed of [{...raw,proof:{}},{...raw,preparation:{...f.preparation,anchor:{}}},{...raw,signed:{...f.signed,signedTransactionHex:'ab'}},{...raw,application:{...f.application,proof:{}}},{...raw,intent:{...f.intent,currentOwner:other}}])expect(VehicleServiceEnvelopeSchema.safeParse(changed).success).toBe(false);
  for(const field of ['signingAuthorized','broadcastAuthorized','reservationReleaseAuthorized','serviceAuthorized'])expect(VehicleServiceEnvelopeSchema.safeParse({...raw,[field]:true}).success).toBe(false);
 });
 it('copies parsed artifacts so caller mutation cannot rewrite matched consent',()=>{
  const raw=envelope(),saved=matchVehicleServiceEnvelope(raw,wallet,request);raw.intent.request.assetId=other;raw.intent.state.completedTotal='99';raw.preparation!.messageHex='ff';expect(saved.intent.request.assetId).toBe(wallet);expect(saved.intent.state.completedTotal).toBe('3');expect(saved.preparation!.messageHex).toBe(fixtures().preparation.messageHex);
 });
 it('accepts only canonical bounded base64 packets without Node or chain APIs',()=>{
  for(const bytes of [66,1232]){const signedTransaction=Buffer.alloc(bytes,1).toString('base64');expect(VehicleServiceSignedRequestSchema.parse({signedTransaction})).toEqual({signedTransaction});}
  const padded=Buffer.alloc(67).toString('base64'),noncanonical=padded.slice(0,-3)+'B==';
  for(const signedTransaction of [Buffer.alloc(65).toString('base64'),Buffer.alloc(1233).toString('base64'),padded+'\n',padded.replaceAll('=',''),noncanonical,'____'])expect(VehicleServiceSignedRequestSchema.safeParse({signedTransaction}).success).toBe(false);
  expect(VehicleServiceSignedRequestSchema.safeParse({signedTransaction:Buffer.alloc(66).toString('base64'),proof:{}}).success).toBe(false);
 });
});
