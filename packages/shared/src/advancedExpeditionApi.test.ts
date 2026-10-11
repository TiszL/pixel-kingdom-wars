import {describe,expect,it} from 'vitest';
import {advancedExpeditionPreview} from './phaseEAdvancedExpeditions';
import {AdvancedExpeditionEnvelopeSchema,AdvancedExpeditionRequestSchema,matchAdvancedExpeditionEnvelope} from './advancedExpeditionApi';
const id='10000000-0000-4000-8000-000000000001',baseId='10000000-0000-4000-8000-000000000002',installationId='10000000-0000-4000-8000-000000000003';
const wallet='So11111111111111111111111111111111111111112',other='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const request={idempotencyKey:id,baseId,installationId,routeId:'coastal_survey',policyVersion:1};
function accepted(){
 const route=advancedExpeditionPreview({family:'survey_balloon',tier:1,homeRealmId:'crownlands',routeId:request.routeId});
 const departedAt='2035-01-01T01:00:00.000Z',returnsAt=new Date(Date.parse(departedAt)+route.durationSec*1000).toISOString();
 return {wallet,idempotencyKey:id,serverNow:'2035-01-02T01:00:00.000Z',status:'accepted',receipt:{wallet,request:{...request},expeditionId:id,installationId,route,departedAt,returnsAt,termId:baseId,termHash:'a'.repeat(64),completedBefore:'100'},return:null};
}
describe('advanced expedition saved history contract',()=>{
 it('accepts elapsed flights without inventing completion and keeps lifetime counts above the first allowance',()=>{
  const value=matchAdvancedExpeditionEnvelope(accepted(),wallet,request);expect(value.status).toBe('accepted');expect(value.return).toBeNull();
  if(value.status==='accepted')expect(value.receipt.completedBefore).toBe('100');
 });
 it('recognizes completion only from a conserved next completed-use ordinal after the saved due time',()=>{
  const value=accepted(),returned={returnId:installationId,returnedAt:value.receipt.returnsAt,completedTotal:'101'};
  expect(AdvancedExpeditionEnvelopeSchema.parse({...value,return:returned}).return).toEqual(returned);
  for(const mutation of [{completedTotal:'100'},{completedTotal:'102'},{returnedAt:value.receipt.departedAt}])expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,return:{...returned,...mutation}}).success).toBe(false);
 });
 it.each(['baseId','installationId','routeId','policyVersion'] as const)('keeps the original %s bound across recovery',field=>{
  const changed={...request,[field]:field==='policyVersion'?2:field==='routeId'?'long_survey':id};
  expect(()=>matchAdvancedExpeditionEnvelope(accepted(),wallet,changed)).toThrow();
 });
 it('binds original actor and request key without trusting a structurally valid other-wallet response',()=>{
  const value=accepted();expect(()=>matchAdvancedExpeditionEnvelope({...value,wallet:other,receipt:{...value.receipt,wallet:other}},wallet,request)).toThrow();
  expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,idempotencyKey:baseId}).success).toBe(false);
  expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,receipt:{...value.receipt,expeditionId:baseId}}).success).toBe(false);
 });
 it('rejects contradictory saved policy, duration, output and provision evidence',()=>{
  const value=accepted();
  for(const route of [{...value.receipt.route,policyVersion:2},{...value.receipt.route,grossQuantity:'999'},{...value.receipt.route,supplies:[]}])expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,receipt:{...value.receipt,route}}).success).toBe(false);
  expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,receipt:{...value.receipt,returnsAt:value.receipt.departedAt}}).success).toBe(false);
 });
 it('does not let requests or history carry a wallet, current inventory or caller authority',()=>{
  for(const extra of [{wallet},{family:'survey_balloon'},{proof:{}},{gross:'999'}])expect(AdvancedExpeditionRequestSchema.safeParse({...request,...extra}).success).toBe(false);
  expect(AdvancedExpeditionEnvelopeSchema.safeParse({...accepted(),rawStock:[]}).success).toBe(false);
  expect(AdvancedExpeditionEnvelopeSchema.safeParse({...accepted(),return:{returnId:installationId,returnedAt:accepted().receipt.returnsAt,completedTotal:'101',custodyWallet:other}}).success).toBe(false);
 });
 it('keeps unknown responses bound to the actor/key and unable to assert a receipt or return',()=>{
  const unknown={wallet,idempotencyKey:id,serverNow:accepted().serverNow,status:'unknown',receipt:null,return:null};
  expect(matchAdvancedExpeditionEnvelope(unknown,wallet,request).status).toBe('unknown');
  for(const change of [{wallet:other},{idempotencyKey:baseId},{receipt:accepted().receipt},{return:{}}])expect(()=>matchAdvancedExpeditionEnvelope({...unknown,...change},wallet,request)).toThrow();
 });
 it('rejects noncanonical counters, overflowing next-use counters, timestamps and UUIDs',()=>{
  const value=accepted();for(const completedBefore of ['-1','01','1.0','nope','9223372036854775807','9223372036854775808']){
   expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,receipt:{...value.receipt,completedBefore}}).success).toBe(false);
   expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,return:{returnId:installationId,returnedAt:value.receipt.returnsAt,completedTotal:completedBefore}}).success).toBe(false);
  }
  expect(AdvancedExpeditionEnvelopeSchema.safeParse({...value,serverNow:'2035-01-02T01:00:00Z'}).success).toBe(false);
  expect(AdvancedExpeditionRequestSchema.safeParse({...request,baseId:'ABCDEFAB-0000-4000-8000-000000000002'}).success).toBe(false);
 });
});
