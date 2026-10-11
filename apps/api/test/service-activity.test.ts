import {expect,it} from 'vitest';
import {PHASE_E_ORDINARY_CRAFTING} from '@shardkeep/shared';
import {parseServiceActivity} from '../src/game/serviceActivity';
const workshop={id:'00000000-0000-4000-8000-000000000001',type:'workshop',level:1};
const lodge={id:'00000000-0000-4000-8000-000000000002',type:'lodge',level:1};
const wire={version:1,pendingCount:1,services:[{buildingId:workshop.id,state:'working'},{buildingId:lodge.id,state:'idle'}]};
it('strips private queue counts and retains exact sorted current service closure',()=>{
 expect(parseServiceActivity(wire,[lodge,workshop])).toEqual({version:1,services:wire.services});
 expect(parseServiceActivity({...wire,pendingCount:PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase+1},[workshop,lodge])).toBeNull();
 expect(parseServiceActivity(null,[workshop])).toBeNull();
});
it('refuses invented ready states positive Lodge and construction activity or extra private fields',()=>{
 for(const value of [{...wire,secret:true},{...wire,services:[{buildingId:workshop.id,state:'ready'}]},
  {...wire,services:[wire.services[0],{buildingId:lodge.id,state:'working'}]}, {...wire,services:[...wire.services].reverse()}])expect(()=>parseServiceActivity(value,[workshop,lodge])).toThrow();
 expect(()=>parseServiceActivity(wire,[{...workshop,underConstruction:true},lodge])).toThrow();
 expect(()=>parseServiceActivity(wire,[workshop,workshop,lodge])).toThrow();
 expect(()=>parseServiceActivity(undefined,[workshop])).toThrow();
});
