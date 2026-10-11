import { describe, expect, it } from 'vitest';
import { BuilderJobSpeedupConsentSchema, BuilderJobSpeedupIntentSchema, BuilderJobSpeedupProofSchema, builderJobSpeedupBody, builderJobSpeedupReceiptPath, matchBuilderJobSpeedupProof } from './builderJobSpeedup';
const id='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
const wallet='11111111111111111111111111111111';
const request={jobId:id,baseId:other,idempotencyKey:'builder-test-key',expectedCurrency:'GEMS' as const,consent:{version:1 as const,kind:'upgrade' as const,buildingId:other,obstacleId:null,startedAt:'2026-09-21T10:00:00.000Z',finishesAt:'2026-09-21T11:00:00.000Z',maxCostKeep:'100'}};
const proof={version:1 as const,status:'accepted' as const,wallet,request,receiptId:id,acceptedAt:'2026-09-21T10:01:00.000Z',funding:{currency:'GEMS' as const,amount:'90'},result:{jobId:id,kind:'upgrade' as const,buildingId:other,obstacleId:null,completedAt:'2026-09-21T10:01:00.000Z'}};
describe('original paid builder protocol',()=>{
  it('keeps currency out of body and includes exact original scope in receipt lookup',()=>{
    expect(builderJobSpeedupBody(request)).toEqual({baseId:other,idempotencyKey:request.idempotencyKey,consent:request.consent});
    expect(builderJobSpeedupReceiptPath({jobId:id,baseId:other,idempotencyKey:request.idempotencyKey})).toContain(`jobId=${id}`);
    expect(matchBuilderJobSpeedupProof(proof,wallet,request)).toEqual(proof);
  });
  it.each([{version:'1'},{maxCostKeep:'01'},{maxCostKeep:'9223372036854775808'},{maxCostKeep:10},{buildingId:null},{obstacleId:id},{kind:'build'},{finishesAt:request.consent.startedAt},{surprise:true}])('rejects coerced/foreign/free or malformed consent %j',change=>{
    expect(BuilderJobSpeedupConsentSchema.safeParse({...request.consent,...change}).success).toBe(false);
  });
  it('clear_obstacle must bind only the original obstacle',()=>{
    expect(BuilderJobSpeedupConsentSchema.safeParse({...request.consent,kind:'clear_obstacle',buildingId:null,obstacleId:id}).success).toBe(true);
    expect(BuilderJobSpeedupConsentSchema.safeParse({...request.consent,kind:'clear_obstacle'}).success).toBe(false);
  });
  it.each([{funding:{currency:'KEEP',amount:'90'}},{funding:{currency:'GEMS',amount:'101'}},{result:{...proof.result,jobId:other}},{result:{...proof.result,completedAt:request.consent.finishesAt}},{result:{...proof.result,completedAt:'2026-09-21T09:59:59.000Z'}}])('cannot turn wrong funding, later target or natural completion into acceptance %j',change=>{
    expect(BuilderJobSpeedupProofSchema.safeParse({...proof,...change}).success).toBe(false);
  });
  it('never accepts another wallet/key/body and rejects extra envelope fields',()=>{
    expect(()=>matchBuilderJobSpeedupProof(proof,'21111111111111111111111111111111',request)).toThrow();
    expect(()=>matchBuilderJobSpeedupProof(proof,wallet,{...request,idempotencyKey:'another-key'})).toThrow();
    expect(()=>matchBuilderJobSpeedupProof({version:1,status:'unknown',idempotencyKey:'another-key'},wallet,request)).toThrow();
    expect(BuilderJobSpeedupIntentSchema.safeParse({...request,surprise:true}).success).toBe(false);
  });
});
