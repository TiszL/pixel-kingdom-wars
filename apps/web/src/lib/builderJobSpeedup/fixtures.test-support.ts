import type { BuilderJobSpeedupIntent } from '@shardkeep/shared/builderJobSpeedup';
import type { BuilderJobSpeedupIdentity } from './journal';
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: BuilderJobSpeedupIdentity = { origin:'https://game.test', api:'https://game.test/api', cluster:'devnet', wallet:'11111111111111111111111111111111' };
export const builder: BuilderJobSpeedupIntent = { jobId:id(3), baseId:id(1), idempotencyKey:'original-builder-key', expectedCurrency:'GEMS',
  consent:{version:1,kind:'upgrade',buildingId:id(4),obstacleId:null,startedAt:'2026-09-21T11:00:00.000Z',finishesAt:'2026-09-21T12:00:00.000Z',maxCostKeep:'100'} };
export const restarted: BuilderJobSpeedupIntent = {...builder,jobId:id(5),consent:{...builder.consent,kind:'clear_obstacle',buildingId:null,obstacleId:id(6)}};
export function proof(intent:BuilderJobSpeedupIntent, accepted=false) {
  if(!accepted) return {version:1,status:'unknown',idempotencyKey:intent.idempotencyKey};
  return {version:1,status:'accepted',wallet:identity.wallet,receiptId:id(2),acceptedAt:'2026-09-21T11:00:01.000Z',request:intent,
    funding:{currency:intent.expectedCurrency,amount:'90'},result:{jobId:intent.jobId,kind:intent.consent.kind,buildingId:intent.consent.buildingId,obstacleId:intent.consent.obstacleId,completedAt:'2026-09-21T11:00:01.000Z'}};
}
