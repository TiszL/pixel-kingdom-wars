/** A distinct existing-clan envelope; registration cryptography is shared with
 * creation, but no funded reservation or SHARDS payment is fabricated. */
import {CharterCreationSigningSchema} from '@shardkeep/shared/charterApi';
import {CharterMigrationSchema,CharterMigrationByKeySchema,CharterMigrationActivitySchema} from '@shardkeep/shared/charterMigrationApi';
import {sql} from 'drizzle-orm';
import {PublicKey} from '@solana/web3.js';
import {phaseECharterEnabled} from '../config';
import type {Db} from '../db/client';
import type {MigrationState} from '../db/charterMigrations';
import {HttpError} from '../lib/errors';
import {createClanCharterMigrationWorkflow,migrationOperationQuote,migrationOperationPacket,type CharterMigrationWorkflowOptions} from './clanCharterMigrationWorkflow';
const authority={signingAuthorized:false,relayAuthorized:false,migrationAuthorized:false,fenceReleaseAuthorized:false} as const;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,v:unknown)=>typeof v==='bigint'?v.toString():v)) as unknown;
export function migrationClientView(state:MigrationState){
 let signing=null;
 if(state.preparation){
  const quote=migrationOperationQuote(state),p=quote.packetInput,source=quote.observation.source,attempt=state.attempt!;
  signing=CharterCreationSigningSchema.parse(json({version:1,kind:'creation',attemptId:attempt.id,original:state.original,
   deployment:{expectedGenesisHash:source.genesisHash,economy:source.programs[0],craft:source.programs[1],core:source.programs[2],stateProvenance:source.stateProvenance},
   policy:{signer:attempt.policySigner,candidateHex:attempt.candidateHex,signatureHex:state.preparation.policySignatureHex},
   lookupTable:p.lookupTable,lookupPin:p.expectedLookupTable,blockhash:p.blockhash,blockhashSlot:p.blockhashSlot,lastValidBlockHeight:p.lastValidBlockHeight,
   packet:migrationOperationPacket(state),costs:quote.costs,costLimits:quote.costLimits,coreCostProfile:quote.coreCostProfile,
   observedSlot:quote.observation.slot,observedUnixTimestamp:quote.observation.unixTimestamp,context:quote.context,signingAuthorized:false,relayAuthorized:false}));
 }
 const w=state.signed;
 return CharterMigrationSchema.parse({version:1,id:state.id,actor:state.actor,request:state.request,snapshot:{clan:state.clan,...state.snapshot},original:state.original,status:state.status,
  signing,wire:w?{signedTransaction:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,wireSha256:w.wireSha256,messageSha256:w.messageSha256}:null,
  terminal:state.terminal?{id:state.terminal.id,outcome:state.terminal.outcome}:null,...authority});
}
export function createClanCharterMigrationClient(db:Db,options:CharterMigrationWorkflowOptions={}){
 const workflow=createClanCharterMigrationWorkflow(db,options),configured=!!(options.newMigration&&options.chain&&options.issuer&&options.recovery);
 const project=async(state:Promise<MigrationState>)=>migrationClientView(await state);
 async function activity(actor:string){
  try{const key=new PublicKey(actor);if(key.equals(PublicKey.default)||key.toBase58()!==actor)throw Error();}catch{throw new HttpError(400,'Invalid clan leader','CLAN_CHARTER_MIGRATION_INPUT');}
  const source=await db.transaction(async tx=>{
   await tx.execute(sql`select public.shardkeep_charter_migration_owner(),public.shardkeep_charter_retirement_source()`);
   const clans=await tx.execute<{id:string;name:string;tag:string;inviteMode:'open'|'invite';birth:unknown;hasBirth:boolean;pendingId:string|null}>(sql`
    select c.id,c.name,c.tag,c.invite_mode "inviteMode",exists(select 1 from public.charter_sale_births b where b.clan_id=c.id) "hasBirth",
     case when exists(select 1 from public.charter_sale_births b where b.clan_id=c.id) then public.shardkeep_charter_sale_birth(c.id) else null end birth,
     (select m.id from public.charter_migrations m where m.actor=${actor} and m.clan_id=c.id
      and not exists(select 1 from public.charter_migration_terminals t where t.migration_id=m.id) limit 1) "pendingId"
    from public.clans c join public.clan_members cm on cm.clan_id=c.id and cm.player_wallet=c.leader_wallet where c.leader_wallet=${actor}`);
   if(clans.length>1)throw new HttpError(503,'Clan authority is unresolved','CLAN_CHARTER_MIGRATION_HELD');
   const history=await tx.execute<{id:string}>(sql`select id from public.charter_migrations where actor=${actor} order by created_at desc,id desc limit 20`);
   return {clan:clans[0]??null,ids:history.map(row=>row.id)};
  },{isolationLevel:'read committed'});
  const c=source.clan;if(c?.hasBirth&&!c.birth)throw new HttpError(503,'Clan authority is unresolved','CLAN_CHARTER_MIGRATION_HELD');const authority=c?.birth?'controlled':c?.pendingId?'pending':'legacy';
  const items=[];
  for(const id of source.ids){const state=await workflow.read(actor,id);items.push({id:state.id,clanId:state.clan.id,name:state.clan.name,tag:state.clan.tag,status:state.status});}
  return CharterMigrationActivitySchema.parse({version:1,actor,newActions:!!(c&&authority==='legacy'&&phaseECharterEnabled()&&configured),
   currentClan:c?{id:c.id,name:c.name,tag:c.tag,inviteMode:c.inviteMode,authority,migrationId:c.pendingId}:null,items});
 }
 return Object.freeze({activity,
  create:(actor:string,input:unknown)=>project(workflow.create(actor,input)),read:(actor:string,id:string)=>project(workflow.read(actor,id)),
  byKey:async(actor:string,key:string)=>{const state=await workflow.readByKey(actor,key);return CharterMigrationByKeySchema.parse({version:1,actor,idempotencyKey:key,migration:state?migrationClientView(state):null});},
  prepare:(actor:string,id:string)=>project(workflow.prepare(actor,id)),recoverPreparation:(actor:string,id:string)=>project(workflow.recoverPreparation(actor,id)),
  retainSigned:(actor:string,id:string,bytes:Uint8Array)=>project(workflow.retainSigned(actor,id,bytes)),recover:(actor:string,id:string)=>project(workflow.recover(actor,id)),cancel:(actor:string,id:string)=>project(workflow.cancel(actor,id)),
  deliver:async(actor:string,id:string)=>{const result=await workflow.deliver(actor,id);if(result.status==='held')throw new HttpError(503,'Migration delivery is unresolved. Keep the original request.','CLAN_CHARTER_MIGRATION_DELIVERY_'+result.reason);return migrationClientView(result.migration);},
 });
}
export type CharterMigrationClientProvider=ReturnType<typeof createClanCharterMigrationClient>;
