/** Player-facing dissolution owns a recoverable draft before the member freeze.
 * Public views omit private source witnesses and never grant chain authority. */
import {CharterRetirementByKeySchema,CharterRetirementDraftSchema,CharterRetirementOperationSchema,CharterRetirementRequestSchema} from '@shardkeep/shared/charterRetirementApi';
import type {Db} from '../db/client';
import {createClanCharterRetirementDraftsStore} from '../db/charterRetirementDrafts';
import {createClanCharterRetirementsStore,type RetirementState} from '../db/charterRetirements';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {createClanCharterMemberSettlement,type ClanCharterMemberSettlementOptions} from './clanCharterMemberSettlement';
import {createClanCharterRetirementWorkflow,type CharterRetirementWorkflowOptions} from './clanCharterRetirementWorkflow';
export interface CharterRetirementClientOptions extends CharterRetirementWorkflowOptions,ClanCharterMemberSettlementOptions {}
const authority={signingAuthorized:false,relayAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false} as const;
function fail(suffix:string,status=503):never{throw new HttpError(status,'Clan dissolution is unavailable. Keep your saved request.','CLAN_CHARTER_RETIREMENT_'+suffix);}
function projection(state:RetirementState){
 return CharterRetirementOperationSchema.parse({version:1,original:state.original,status:state.status,memberPayment:state.memberPayment,
  attempt:state.attempt,preparation:state.preparation,signed:state.signed,terminal:state.terminal?{id:state.terminal.id,outcome:state.terminal.outcome}:null,...authority});
}
export function createClanCharterRetirementClient(db:Db,options:CharterRetirementClientOptions={}){
 const drafts=createClanCharterRetirementDraftsStore(db),originals=createClanCharterRetirementsStore(db),members=createClanCharterMemberSettlement(db,options),workflow=createClanCharterRetirementWorkflow(db,options);
 const configured=!!(options.chain&&options.issuer&&options.recovery&&options.finalizedDeedReader&&options.deedCollection);
 async function read(actor:string,id:string){
  const draft=await drafts.read(actor,id),{retirementId,...publicDraft}=draft;
  return CharterRetirementDraftSchema.parse({...publicDraft,operation:retirementId?projection(await originals.read(actor,retirementId)):null,...authority});
 }
 async function byKey(actor:string,key:string){const draft=await drafts.readByKey(actor,key);return CharterRetirementByKeySchema.parse({version:1,actor,idempotencyKey:key,draft:draft?await read(actor,draft.id):null});}
 async function create(actor:string,raw:unknown){
  const input=CharterRetirementRequestSchema.safeParse(raw);if(!input.success)return fail('INPUT',400);
  const prior=await drafts.readByKey(actor,input.data.idempotencyKey);
  if(prior){if(prior.request.clanId!==input.data.clanId)return fail('CONFLICT',409);return read(actor,prior.id);}
  if(!configured||!phaseECharterEnabled())return fail('DISABLED');
  return read(actor,(await drafts.create(actor,input.data)).id);
 }
 async function payMembers(actor:string,id:string){
  const draft=await drafts.read(actor,id);if(draft.cancelled||draft.retirementId)return read(actor,id);
  if(!configured||!phaseECharterEnabled())return fail('DISABLED');
  // Settlement repeats the captured allocation and authentic destination checks
  // under SQL locks. A crash after payout resumes this same immutable receipt.
  const paid=await members.settle(actor,draft.fenceId);
  const shares=new Map(paid.allocations.map(row=>[row.wallet,row.shards]));
  if(paid.totalShards!==draft.totalShards||draft.shares.some(row=>(shares.get(row.wallet)??'0')!==row.shards)
   ||paid.allocations.some(row=>!draft.shares.some(member=>member.wallet===row.wallet)))return fail('HELD');
  await workflow.create(actor,{fenceId:draft.fenceId,idempotencyKey:draft.request.idempotencyKey});return read(actor,id);
 }
 async function originalAction(actor:string,id:string,action:(originalId:string)=>Promise<unknown>){
  const draft=await drafts.read(actor,id);if(draft.cancelled)return read(actor,id);if(!draft.retirementId)return fail('NOT_PREPARED',409);
  await action(draft.retirementId);return read(actor,id);
 }
 return Object.freeze({create,read,byKey,payMembers,
  prepare:(actor:string,id:string)=>originalAction(actor,id,key=>workflow.prepare(actor,key)),
  recoverPreparation:(actor:string,id:string)=>originalAction(actor,id,key=>workflow.recoverPreparation(actor,key)),
  retainSigned:(actor:string,id:string,bytes:Uint8Array)=>originalAction(actor,id,key=>workflow.retainSigned(actor,key,bytes)),
  deliver:(actor:string,id:string)=>originalAction(actor,id,async key=>{const outcome=await workflow.deliver(actor,key);if(outcome.status==='held')return fail('DELIVERY_'+outcome.reason);return outcome;}),
  recover:async(actor:string,id:string)=>{const draft=await drafts.read(actor,id);if(draft.retirementId)await workflow.recover(actor,draft.retirementId);return read(actor,id);},
  cancel:async(actor:string,id:string)=>{const draft=await drafts.read(actor,id);if(draft.retirementId)await workflow.cancel(actor,draft.retirementId);else if(!draft.cancelled)await drafts.cancel(actor,id);return read(actor,id);},
 });
}
export type CharterRetirementClientProvider=ReturnType<typeof createClanCharterRetirementClient>;
