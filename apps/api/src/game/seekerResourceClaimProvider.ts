/** D-153.136: closed owner capability; public routes never receive the DB or
 * raw private source evidence. Each operation owns its original transaction. */
import {SeekerResourceEntitlementQuerySchema} from '@shardkeep/shared/seekerResourceClaimsApi';
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {claimSeekerResourceTax,readSeekerResourceClaim,SeekerResourceClaimRequestSchema,seekerResourceClaimsEnabled} from './seekerResourceClaims';
import {readSeekerResourceEntitlements} from './seekerResourceEntitlements';
export interface SeekerResourceClaimProvider {
 entitlements(wallet:string,query:unknown):ReturnType<typeof readSeekerResourceEntitlements>;
 history(wallet:string,key:string):ReturnType<typeof readSeekerResourceClaim>;
 claim(wallet:string,command:unknown):ReturnType<typeof claimSeekerResourceTax>;
}
export function createSeekerResourceClaimProvider(db:Db,deps:{finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null}={}):SeekerResourceClaimProvider {
 if('rollback'in db)throw Error('Resource claim capability requires top-level DB');
 const reader=deps.finalizedDeedReader??null,collection=deps.deedCollection??null;
 async function owner(){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_expeditions'::regclass) allowed`);if(!r?.allowed)throw new HttpError(503,'Resource claim owner capability unavailable','SEEKER_RESOURCE_OWNER');}
 return Object.freeze({
  async entitlements(wallet:string,query:unknown){const input=SeekerResourceEntitlementQuerySchema.parse(query);await owner();return readSeekerResourceEntitlements(db,wallet,input);},
  async history(wallet:string,key:string){await owner();return db.transaction(tx=>readSeekerResourceClaim(tx,wallet,key),{isolationLevel:'repeatable read',accessMode:'read only'});},
  async claim(wallet:string,command:unknown){const input=SeekerResourceClaimRequestSchema.parse(command);await owner();
   const prior=await readSeekerResourceClaim(db,wallet,input.idempotencyKey);
   if(!prior){if(!seekerResourceClaimsEnabled())throw new HttpError(503,'Seeker resource claims are paused','PHASE_E_DISABLED');await requireFreshBaseAuthority(db,wallet,input.baseId,reader,collection);}
   return claimSeekerResourceTax(db,wallet,input,{baseId:input.baseId,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b);}});
  },
 });
}
