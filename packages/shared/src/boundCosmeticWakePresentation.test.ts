import {expect,it} from 'vitest';
import {BoundCosmeticWakeOriginalEnvelopeSchema as Original,BoundCosmeticWakeCurrentEnvelopeSchema as Current,BoundCosmeticWakeOriginalQuerySchema as Query} from './boundCosmeticWakePresentation';
const key='00000000-0000-4000-8000-000000000001',installationId='00000000-0000-4000-8000-000000000002',baseId='00000000-0000-4000-8000-000000000003';
const wallet='So11111111111111111111111111111111111111112',kind='starter',departedAt='2026-09-29T01:00:00.000Z',returnsAt='2026-09-29T02:00:00.000Z',serverNow='2026-09-29T03:00:00.000Z';
import {REALM_IDS} from './baseVisual';
const trip={expeditionId:key,installationId,homeRealmId:REALM_IDS[0],realmId:REALM_IDS[0],departedAt,returnsAt,wake:{state:'available',visual:{version:1,wake:null}}};
const known={version:1,wallet,kind,key,serverNow,status:'known',presentation:{...trip,baseId},returnedAt:null};
it('requires opt-in version, exact strict keys and canonical account, kind, key and times',()=>{
 expect(Original.parse(known)).toEqual(known);expect(Query.parse({kind,key})).toEqual({kind,key});
 for(const value of [{...known,version:2},{...known,actor:wallet},{...known,wallet:'1'.repeat(32)},{...known,kind:'boat'},{...known,key:baseId},{...known,serverNow:'2026-09-29T03:00:00Z'},{...known,presentation:{...known.presentation,route:{}}}])expect(Original.safeParse(value).success).toBe(false);
 expect(Query.safeParse({kind,key,wallet}).success).toBe(false);
});
it('keeps legacy, unavailable and explicit off separate; unknown never carries a presentation',()=>{
 for(const wake of [{state:'legacy',visual:null},{state:'unavailable',visual:null},trip.wake])expect(Original.parse({...known,presentation:{...known.presentation,wake}}).status).toBe('known');
 for(const wake of [undefined,null,{state:'legacy',visual:trip.wake.visual},{state:'available',visual:null}])expect(Original.safeParse({...known,presentation:{...known.presentation,wake}}).success).toBe(false);
 const unknown={...known,status:'unknown',presentation:null,returnedAt:null};expect(Original.parse(unknown)).toEqual(unknown);
 expect(Original.safeParse({...unknown,presentation:known.presentation}).success).toBe(false);expect(Original.safeParse({...unknown,returnedAt:returnsAt}).success).toBe(false);
});
it('observes an actual return separately without treating elapsed due time as completion',()=>{
 expect(Original.parse(known).returnedAt).toBeNull();expect(Original.parse({...known,returnedAt:returnsAt})).toMatchObject({presentation:known.presentation,returnedAt:returnsAt});
 for(const value of [{...known,returnedAt:departedAt},{...known,returnedAt:'2026-09-30T00:00:00.000Z'},{...known,serverNow:'2026-09-28T00:00:00.000Z'},{...known,presentation:{...known.presentation,returnsAt:departedAt}}])expect(Original.safeParse(value).success).toBe(false);
});
it('permits only minimal current trip facts and refuses duplicate expedition or installation identities',()=>{
 const current={version:1,wallet,baseId,serverNow,trips:[{...trip,kind}]};expect(Current.parse(current)).toEqual(current);
 for(const trips of [[{...trip,kind,actorWallet:wallet}],[{...trip,kind,returnedAt:null}],[{...trip,kind},{...trip,kind,installationId:baseId}],[{...trip,kind},{...trip,kind,expeditionId:baseId}],[{...trip,kind,departedAt:'2026-09-30T00:00:00.000Z',returnsAt:'2026-09-30T02:00:00.000Z'}]])expect(Current.safeParse({...current,trips}).success).toBe(false);
 expect(Current.parse({...current,trips:[]})).toMatchObject({trips:[]});
});
