import {it,expect} from 'vitest';
import {parseRealmSalePrepareRefusal,realmSalePrepareRefusalResponse} from './refusal';
it('only the exact bounded first-prepare status and code pairs admit absence confirmation',()=>{
 for(const [status,code] of [[400,'INVALID_INPUT'],[422,'INSUFFICIENT_SOL'],[503,'PHASE_E_DISABLED']] as const){const raw={error:{code,message:'Declined'}};expect(realmSalePrepareRefusalResponse(status,raw)).toEqual({status,code});for(const other of [200,202,401,403,409,429,500])expect(realmSalePrepareRefusalResponse(other,raw)).toBeNull();}
 for(const code of ['REALM_SALE_UNAVAILABLE','REALM_SALE_REQUEST_CONFLICT','PAYMENT_INSTRUCTIONS_REJECTED','UNKNOWN','TIMEOUT'])expect(realmSalePrepareRefusalResponse(503,{error:{code,message:'Not proven'}})).toBeNull();
});
it('refuses extra fields, malformed errors, oversized text and forged journal markers',()=>{
 for(const raw of [null,[],{error:{code:'INSUFFICIENT_SOL',message:'x'},ok:true},{error:{code:'INSUFFICIENT_SOL',message:'x',details:{}}},{error:{code:'INSUFFICIENT_SOL',message:'x'.repeat(1025)}},{error:{code:'INSUFFICIENT_SOL',message:''}},{error:{code:'INSUFFICIENT_SOL'}}])expect(realmSalePrepareRefusalResponse(422,raw)).toBeNull();
 for(const raw of [{status:422,code:'INSUFFICIENT_SOL',extra:true},{status:'422',code:'INSUFFICIENT_SOL'},{status:503,code:'INSUFFICIENT_SOL'}])expect(()=>parseRealmSalePrepareRefusal(raw)).toThrow();
 const owned=parseRealmSalePrepareRefusal({status:422,code:'INSUFFICIENT_SOL'});expect(Object.isFrozen(owned)).toBe(true);
});
it.each(['REALM_SALE_NO_QUOTA','REALM_SALE_UNSOLD','REALM_SALE_REALM_UNAVAILABLE'])('admits only the exact 422 first-preparation selection refusal %s',code=>{
 const raw={error:{code,message:'Selection refused before preparation'}};
 expect(realmSalePrepareRefusalResponse(422,raw)).toEqual({status:422,code});
 expect(parseRealmSalePrepareRefusal({status:422,code})).toEqual({status:422,code});
 for(const status of [200,400,409,500,503])expect(realmSalePrepareRefusalResponse(status,raw)).toBeNull();
 expect(realmSalePrepareRefusalResponse(422,{error:{...raw.error,preparation:null}})).toBeNull();
});
