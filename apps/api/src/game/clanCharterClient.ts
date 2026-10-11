/** D153.180 closed, application-owned client facade over the original workflows. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {CharterActivitySchema,CharterCreationClientSchema,CharterSaleClientSchema,CharterSaleByKeySchema,CharterSignatureRequestSchema,type CharterClient} from '@shardkeep/shared/charterApi';
import type {Db} from '../db/client';
import {createClanCharterSalesStore} from '../db/charterSales';
import {createCharterContributions} from '../db/charterContributions';
import {HttpError} from '../lib/errors';
import {phaseECharterEnabled} from '../config';
import {createCharterCreationWorkflow,type CharterCreationWorkflowOptions} from './clanCharterCreationWorkflow';
import {createCharterCreationPreparation} from './clanCharterCreationPreparation';
import {createCharterCreationSignedStore} from './clanCharterCreationSignedStore';
import {createClanCharterSales,charterSaleView,type CharterSalesOptions} from './clanCharterSales';
import {creationClientSigning,saleClientSigning} from './clanCharterClientProjection';
import {createCharterClientDelivery,type CharterClientDeliveryOptions} from './clanCharterClientDelivery';
export interface CharterClientOptions {
 readonly creation?:CharterCreationWorkflowOptions|null;readonly sales?:CharterSalesOptions|null;
 readonly delivery?:CharterClientDeliveryOptions|null;
}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),kind=z.enum(['creation','sale']);
const cursorSchema=z.object({at:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),id:uuid,kind}).strict();
function fail(code:string,status=503):never{throw new HttpError(status,'Charter request unavailable; keep the original request','CLAN_CHARTER_CLIENT_'+code);}
function identity(actor:string,id?:string){try{const p=new PublicKey(actor);if(p.equals(PublicKey.default)||p.toBase58()!==actor||id!==undefined&&!uuid.safeParse(id).success)fail('INPUT',400);}catch{return fail('INPUT',400);}}
function wire(value:{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}|null){return value?{signedTransaction:Buffer.from(value.signedTransactionHex,'hex').toString('base64'),signature:value.signature,wireSha256:value.wireSha256,messageSha256:value.messageSha256}:null;}
export function createClanCharterClient(db:Db,options:CharterClientOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');
 const creation=createCharterCreationWorkflow(db,options.creation??{}),sales=createClanCharterSales(db,options.sales??{}),saleStore=createClanCharterSalesStore(db);
 const preparation=createCharterCreationPreparation(db,{chain:null,issuer:null}),signed=createCharterCreationSignedStore(db),contributions=createCharterContributions(db);
 const configured={creation:!!(options.creation?.newCreation&&options.creation.chain&&options.creation.issuer&&options.creation.finalizedDeedReader&&options.creation.deedCollection),
  sale:!!(options.sales?.newSaleDomain&&options.sales.chain&&options.sales.issuer&&options.sales.finalizedDeedReader&&options.sales.deedCollection)};
 async function readCreation(actor:string,id:string){
  identity(actor,id);
  // A concurrent immutable stage can land between historical readers. One
  // bounded repeat converges it; any remaining inconsistency is a held source.
  for(let n=0;n<2;n++){
   const state=await creation.read(actor,id),p=await preparation.read(actor,id),saved=await signed.get(actor,id);
   const value=CharterCreationClientSchema.safeParse({version:1,actor,kind:'creation',key:id,state,signing:creationClientSigning(p),wire:wire(saved),contributions:[]});
   if(value.success)return value.data;
  }
  return fail('SOURCE');
 }
 async function readSale(actor:string,id:string){
  identity(actor,id);
  for(let n=0;n<2;n++){
   const state=await saleStore.read(actor,id),parts=await contributions.read(actor,id);
   const value=CharterSaleClientSchema.safeParse({version:1,actor,kind:'sale',key:id,state:charterSaleView(state),signing:saleClientSigning(state),wire:wire(state.signed),contributions:parts});
   if(value.success)return value.data;
  }
  return fail('SOURCE');
 }
 async function read(actor:string,family:'creation'|'sale',id:string):Promise<CharterClient>{return family==='creation'?readCreation(actor,id):readSale(actor,id);}
 const delivery=createCharterClientDelivery(db,read,options.delivery??null);
 async function activity(actor:string,rawCursor?:string){
  identity(actor);let cursor:z.infer<typeof cursorSchema>|null=null;
  if(rawCursor!==undefined){try{if(rawCursor.length>256||!/^[A-Za-z0-9_-]+$/.test(rawCursor))return fail('INPUT',400);
   const bytes=Buffer.from(rawCursor,'base64url');if(bytes.toString('base64url')!==rawCursor)return fail('INPUT',400);cursor=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
  }catch{return fail('INPUT',400);}}
  const rows=await db.transaction(async tx=>{
   await tx.execute(sql`select public.shardkeep_charter_creation_owner(),public.shardkeep_charter_creation_hooks(),public.shardkeep_charter_sale_owner(),public.shardkeep_charter_sale_hooks()`);
   return tx.execute<{kind:'creation'|'sale';key:string;status:string;clanId:string;participantRole:'creator'|'seller'|'buyer';name:string|null;tag:string|null;at:string}>(sql`
    with originals as (
     select 'creation'::text kind,r.intent_id id,r.accepted_at at,r.clan_id,
      case when r.state<>'reserved' then r.state when w.attempt_id is not null then 'signed' when p.attempt_id is not null then 'prepared'
       when a.id is not null then 'issuing' when policy.reservation_id is not null then 'admitted' else 'funded' end status,
      'creator'::text role,r.name,r.tag from public.charter_creation_reservations r
      left join public.charter_creation_policy_admissions policy on policy.reservation_id=r.id
      left join public.charter_creation_issuance_attempts a on a.reservation_id=r.id
      left join public.charter_creation_preparations p on p.attempt_id=a.id
      left join public.charter_creation_signed_wires w on w.attempt_id=a.id where r.payer=${actor}
     union all
     select 'sale',s.id,s.created_at,s.clan_id,
      case when t.sale_id is not null then t.outcome when w.sale_id is not null then 'signed' when p.sale_id is not null then 'prepared'
       when a.sale_id is not null then 'issuing' when paid.id is not null then 'members_paid' when accepted.sale_id is not null then 'accepted' else 'draft' end,
      case when s.seller=${actor} then 'seller' else 'buyer' end,s.original->'creation'->'metadata'->>'name',null::text
      from public.charter_sales s left join public.charter_sale_terminals t on t.sale_id=s.id
      left join public.charter_sale_wires w on w.sale_id=s.id left join public.charter_sale_preparations p on p.sale_id=s.id
      left join public.charter_sale_attempts a on a.sale_id=s.id left join public.charter_sale_acceptances accepted on accepted.sale_id=s.id
      left join public.clan_charter_member_payments paid on paid.fence_id=(s.original->>'fenceId')::uuid
      where s.seller=${actor} or s.buyer=${actor}
    ) select kind,id as key,status,clan_id as "clanId",role as "participantRole",name,tag,to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
    from originals ${cursor?sql`where (at,id,kind)<(${cursor.at}::timestamptz,${cursor.id}::uuid,${cursor.kind})`:sql``}
    order by at desc,id desc,kind desc limit 21`);
  },{isolationLevel:'read committed'});
  const page=rows.slice(0,20),last=page.at(-1),next=rows.length>20&&last?Buffer.from(JSON.stringify({at:last.at,id:last.key,kind:last.kind})).toString('base64url'):null;
  return CharterActivitySchema.parse({version:1,actor,newActions:{creation:phaseECharterEnabled()&&configured.creation,sale:phaseECharterEnabled()&&configured.sale},items:page.map(({at:_at,...item})=>item),nextCursor:next});
 }
 async function saleByKey(actor:string,key:string){identity(actor,key);
  const rows=await db.transaction(async tx=>{await tx.execute(sql`select public.shardkeep_charter_sale_owner(),public.shardkeep_charter_sale_hooks()`);
   return tx.execute<{id:string}>(sql`select id from public.charter_sales where seller=${actor} and idempotency_key=${key}`);
  },{isolationLevel:'read committed'});
  return CharterSaleByKeySchema.parse({version:1,actor,idempotencyKey:key,sale:rows[0]?await readSale(actor,rows[0].id):null});
 }
 return Object.freeze({readCreation,readSale,activity,saleByKey,deliver:delivery,
  create:async(actor:string,input:unknown)=>{const state=await creation.fund(actor,input);return readCreation(actor,state.creationIntentId);},
  createSale:async(actor:string,input:unknown)=>{const state=await sales.create(actor,input);return readSale(actor,state.id);},
  prepareCreation:async(actor:string,id:string)=>{await creation.prepare(actor,id);return readCreation(actor,id);},
  recoverCreationPreparation:async(actor:string,id:string)=>{await creation.recoverPreparation(actor,id);return readCreation(actor,id);},
  recoverCreation:async(actor:string,id:string)=>{await creation.recover(actor,id);return readCreation(actor,id);},
  retainCreationSigned:async(actor:string,id:string,bytes:Uint8Array)=>{await creation.retainSigned(actor,id,bytes);return readCreation(actor,id);},
  refundCreation:async(actor:string,id:string,baseId?:string)=>{await creation.claimRefund(actor,id,baseId);return readCreation(actor,id);},
  acceptSale:async(actor:string,id:string,input:unknown)=>{await sales.accept(actor,id,input);return readSale(actor,id);},
  paySaleMembers:async(actor:string,id:string)=>{await sales.payMembers(actor,id);return readSale(actor,id);},
  prepareSale:async(actor:string,id:string)=>{await sales.prepare(actor,id);return readSale(actor,id);},
  recoverSalePreparation:async(actor:string,id:string)=>{await sales.recoverPreparation(actor,id);return readSale(actor,id);},
  recoverSale:async(actor:string,id:string)=>{await sales.recover(actor,id);return readSale(actor,id);},
  cancelSale:async(actor:string,id:string)=>{await sales.cancel(actor,id);return readSale(actor,id);},
  retainSaleSignature:async(actor:string,id:string,input:unknown)=>{await contributions.retain(actor,id,CharterSignatureRequestSchema.parse(input));return readSale(actor,id);},
 });
}
export type CharterClientProvider=ReturnType<typeof createClanCharterClient>;
