/** Only exact first-preparation refusals may be confirmed absent and archived.
 * This never classifies errors from a review, wallet, submit or recovery read. */
export interface RealmSalePrepareRefusal {readonly status:number;readonly code:string}
function pair(status:unknown,code:unknown):boolean{
 return status===400&&code==='INVALID_INPUT'
  ||status===422&&(code==='INSUFFICIENT_SOL'||code==='REALM_SALE_NO_QUOTA'||code==='REALM_SALE_UNSOLD'||code==='REALM_SALE_REALM_UNAVAILABLE')
  ||status===503&&code==='PHASE_E_DISABLED';
}
export function parseRealmSalePrepareRefusal(raw:unknown):RealmSalePrepareRefusal{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Reflect.ownKeys(raw).length!==2||!Object.hasOwn(raw,'status')||!Object.hasOwn(raw,'code'))throw Error('Invalid original purchase refusal.');
 const value=raw as Record<string,unknown>;if(!pair(value.status,value.code))throw Error('This response does not prove the original preparation was refused.');
 return Object.freeze({status:value.status as number,code:value.code as string});
}
export function realmSalePrepareRefusalResponse(status:number,raw:unknown):RealmSalePrepareRefusal|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Reflect.ownKeys(raw).length!==1||!Object.hasOwn(raw,'error'))return null;
 const error=(raw as {error:unknown}).error;
 if(!error||typeof error!=='object'||Array.isArray(error)||Reflect.ownKeys(error).length!==2||!Object.hasOwn(error,'code')||!Object.hasOwn(error,'message'))return null;
 const value=error as Record<string,unknown>;
 if(typeof value.message!=='string'||value.message.length===0||value.message.length>1024||!pair(status,value.code))return null;
 return parseRealmSalePrepareRefusal({status,code:value.code});
}
