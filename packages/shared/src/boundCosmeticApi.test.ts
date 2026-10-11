import {describe,it,expect} from 'vitest';
import {boundCosmeticRecipe} from './phaseEBoundCosmetics';
import {BoundCosmeticEnvelopeSchema,BoundCosmeticRequestSchema,matchBoundCosmeticEnvelope} from './boundCosmeticApi';
const wallet='11111111111111111111111111111111',buyer='22222222222222222222222222222222';
const jobId='11111111-1111-4111-8111-111111111111',baseId='22222222-2222-4222-8222-222222222222';
function original(){
 const recipe=structuredClone(boundCosmeticRecipe('craft_artisan_market_awning_t1_v1',1)),startedAt='2026-09-30T00:00:00.000Z';
 const request={idempotencyKey:jobId,baseId,recipeId:recipe.recipeId,recipeVersion:recipe.recipeVersion,appearanceBindingSha256:'a'.repeat(64)};
 return {version:1 as const,wallet,idempotencyKey:jobId,serverNow:startedAt,status:'accepted' as const,
  receipt:{wallet,jobId,request,recipe,appearance:{version:1 as const,outputId:recipe.outputId,sourceId:'artisan-market-t1' as const,
   sourceManifestSha256:'b'.repeat(64),sourceIndexSha256:'c'.repeat(64),bindingSha256:request.appearanceBindingSha256},
   blueprint:{blueprintId:recipe.blueprintId,jobId:'33333333-3333-4333-8333-333333333333',baseId,actorWallet:wallet,completedAt:startedAt},
   startedAt,readyAt:new Date(Date.parse(startedAt)+recipe.durationSec*1000).toISOString()},completion:null as null|{completedAt:string}};
}
describe('bound cosmetic original wire custody',()=>{
 it('recovers exact reviewed original independently from current owner, flags or catalogue UI',()=>{
  const proof=original();expect(matchBoundCosmeticEnvelope(proof,wallet,proof.receipt.request)).toEqual(proof);
  proof.completion={completedAt:proof.receipt.readyAt};expect(BoundCosmeticEnvelopeSchema.parse(proof)).toEqual(proof);
 });
 it('does not reinterpret another actor or another base as the saved original',()=>{
  const proof=original();expect(()=>matchBoundCosmeticEnvelope(proof,buyer,proof.receipt.request)).toThrow();
  expect(()=>matchBoundCosmeticEnvelope(proof,wallet,{...proof.receipt.request,baseId:proof.receipt.blueprint.jobId})).toThrow();
  proof.receipt.blueprint.actorWallet=buyer;expect(BoundCosmeticEnvelopeSchema.safeParse(proof).success).toBe(false);
 });
 it('binds selected pixels and source tier to the material-consuming consent',()=>{
  const proof=original();proof.receipt.appearance.bindingSha256='d'.repeat(64);expect(BoundCosmeticEnvelopeSchema.safeParse(proof).success).toBe(false);
  const other=original();expect(BoundCosmeticEnvelopeSchema.safeParse({...other,receipt:{...other.receipt,appearance:{...other.receipt.appearance,sourceId:'artisan-market-t2'}}}).success).toBe(false);
 });
 it('rejects altered immutable recipes even if caller restates a matching deadline',()=>{
  const proof=original();proof.receipt.recipe.inputs[0]!.quantity='999';expect(BoundCosmeticEnvelopeSchema.safeParse(proof).success).toBe(false);
 });
 it('refuses early completion and a Blueprint earned after craft admission',()=>{
  const proof=original();proof.completion={completedAt:proof.receipt.startedAt};expect(BoundCosmeticEnvelopeSchema.safeParse(proof).success).toBe(false);
  const late=original();late.receipt.blueprint.completedAt=late.receipt.readyAt;expect(BoundCosmeticEnvelopeSchema.safeParse(late).success).toBe(false);
 });
 it('rejects shortened deadlines rather than trusting server-shaped data',()=>{
  const proof=original();proof.receipt.readyAt=proof.receipt.startedAt;expect(BoundCosmeticEnvelopeSchema.safeParse(proof).success).toBe(false);
 });
 it('keeps unknown distinct from a completed or missing original receipt',()=>{
  const proof=original(),unknown={version:1,wallet,idempotencyKey:jobId,serverNow:proof.serverNow,status:'unknown',receipt:null,completion:null};
  expect(matchBoundCosmeticEnvelope(unknown,wallet,proof.receipt.request).status).toBe('unknown');
  expect(BoundCosmeticEnvelopeSchema.safeParse({...unknown,completion:{completedAt:proof.receipt.readyAt}}).success).toBe(false);
  expect(()=>matchBoundCosmeticEnvelope({...unknown,idempotencyKey:baseId},wallet,proof.receipt.request)).toThrow();
 });
 it('accepts neither caller-provided price nor loose scalar consent',()=>{
  const request=original().receipt.request;
  for(const invalid of [{...request,price:0},{...request,recipeVersion:'1'},{...request,appearanceBindingSha256:'A'.repeat(64)},
   {...request,idempotencyKey:'bad'},{...request,baseId:1}])expect(BoundCosmeticRequestSchema.safeParse(invalid).success).toBe(false);
 });
});
