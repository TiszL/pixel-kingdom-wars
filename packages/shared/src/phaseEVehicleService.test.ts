import {describe,expect,it} from 'vitest';
import {vehicleServiceTransition} from './phaseEVehicleService';
const state=()=>({operation:'upgrade' as const,installationId:'548a40c0-8d08-4c53-ac9d-2d2f5ae8b922',baseId:'bf3b77c1-e048-49eb-8f00-2486c6ac8f76',berthId:'6229952c-d168-423e-b71e-f665a93c6de8',revision:7,family:'cargo_cutter' as const,tier:2 as const,completedTotal:'175',allowanceStart:'100'});
describe('owner-locked vehicle service semantics, without admission authority',()=>{
 it('upgrades preserve lifetime and current allowance usage',()=>{
  expect(vehicleServiceTransition(state())).toMatchObject({tierAfter:3,completedTotal:'175',allowanceStartAfter:'100',remainingUses:25,revisionAfter:8,serviceAuthorized:false});
 });
 it('an exhausted vehicle stays exhausted when upgraded',()=>{
  expect(vehicleServiceTransition({...state(),completedTotal:'200'})).toMatchObject({tierAfter:3,remainingUses:0,allowanceStartAfter:'100'});
 });
 it('exhaustion recovery preserves current tier and lifetime count while resetting only the allowance start',()=>{
  expect(vehicleServiceTransition({...state(),operation:'restore_uses',tier:4,completedTotal:'300',allowanceStart:'200'})).toMatchObject({tierAfter:4,completedTotal:'300',allowanceStartAfter:'300',remainingUses:100});
 });
 it.each([
  {operation:'restore_uses'}, {operation:'restore_uses',completedTotal:'201'}, {tier:4},
  {completedTotal:'99'}, {completedTotal:'0175'}, {completedTotal:'9223372036854775808'},
  {allowanceStart:'-1'}, {revision:Number.MAX_SAFE_INTEGER}, {family:'starter'}, {serviceAuthorized:true},
 ])('rejects impossible, early-recovery or caller-authority state %j',patch=>{
  expect(()=>vehicleServiceTransition({...state(),...patch} as never)).toThrow();
 });
 it('owns the returned immutable projection; a preview cannot mutate its input into authority',()=>{
  const input=state(),projection=vehicleServiceTransition(input);input.completedTotal='200';expect(projection.completedTotal).toBe('175');expect(Object.isFrozen(projection)).toBe(true);
 });
});
