/** Realm Passport HTTP adapter (P2): three authenticated read-only GETs over the
 * frozen provider. The wallet comes from the session only; queries are strict
 * (400); a wholly missing provider is 503 like the adjacent disabled-provider
 * routes; a configured but unavailable source stays inside the DTO state. */
import {CHAT} from '@shardkeep/shared';
import {RealmPassportExpeditionsQuerySchema,RealmPassportInclusionsQuerySchema} from '@shardkeep/shared/realmPassportApi';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {RealmPassportError,type RealmPassportProvider} from './realmPassport';

const Empty=z.object({}).strict();
/** Per-wallet read admission applied AFTER authentication and layered on the
 * app's global per-IP bucket (no route-level override, so both apply). One
 * Passport page can perform dozens of source reads, so one authenticated wallet
 * is bounded independently of IP rotation, exactly like the chat and avatar
 * read buckets. The ceiling reuses the existing authenticated per-wallet read
 * constant (CHAT.readsPerWalletMinute) instead of inventing a Passport number;
 * root may pin a dedicated constant. Fail-closed on a Redis fault. */
export const REALM_PASSPORT_READ_RATE_LIMIT={max:CHAT.readsPerWalletMinute,timeWindow:60_000,keyGenerator:(req:FastifyRequest):string=>`realm-passport-read-wallet:${req.wallet}`,skipOnError:false};
export function registerRealmPassportRoutes(app:FastifyInstance,provider?:RealmPassportProvider|null):void{
 const use=()=>{if(!provider)throw new HttpError(503,'Realm Passport is unavailable','REALM_PASSPORT_UNAVAILABLE');return provider;};
 const noStore=async(_req:unknown,reply:{header:(key:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;};
 const walletLimiter=app.hasDecorator('createRateLimit')?app.createRateLimit(REALM_PASSPORT_READ_RATE_LIMIT):null;
 const enforceWalletLimit=async(req:FastifyRequest):Promise<void>=>{
  if(walletLimiter===null)return;const limit=await walletLimiter(req);
  if(!limit.isAllowed&&limit.isExceeded)throw new HttpError(429,`realm passport read limit reached; try again in ${limit.ttlInSeconds}s`,'REALM_PASSPORT_RATE_LIMITED');
 };
 const auth={preHandler:[app.authenticate,enforceWalletLimit],onSend:noStore},root='/realm-passport';
 // Refusals stay inside the DTO for the client; the operator signal is this log line (route and reason only, never the
 // wallet). A conflict means immutable history disagrees with itself (error); an unreachable source is a warning; a
 // deliberately unconfigured capability is only debug noise.
 async function answer<T extends {state:string;reason?:string}>(req:FastifyRequest,route:string,read:()=>Promise<T>):Promise<T>{
  let view:T;
  try{view=await read();}catch(error){if(error instanceof RealmPassportError)throw new HttpError(400,'invalid request: passport query',`REALM_PASSPORT_${error.code}`);throw error;}
  if(view.state==='unavailable'){
   const entry={route,reason:view.reason};
   if(view.reason==='SOURCE_CONFLICT')req.log.error(entry,'realm passport source conflict');
   else if(view.reason==='NOT_CONFIGURED')req.log.debug(entry,'realm passport source not configured');
   else req.log.warn(entry,'realm passport source unavailable');
  }
  return view;
 }
 app.get(root+'/expeditions',auth,async req=>{const query=parse(RealmPassportExpeditionsQuerySchema,req.query);return answer(req,'expeditions',()=>use().expeditions(req.wallet,query));});
 app.get(root+'/mining/inclusions',auth,async req=>{const query=parse(RealmPassportInclusionsQuerySchema,req.query);return answer(req,'inclusions',()=>use().inclusions(req.wallet,query));});
 app.get(root+'/mining/current',auth,async req=>{parse(Empty,req.query);return answer(req,'current',()=>use().current(req.wallet));});
}
