import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {DivineTrialIdSchema} from '@shardkeep/shared/divineTrials';
import {DivineTrialEventsSchema,DivineTrialParticipantSchema,DivineTrialEntrySchema,DivineTrialClaimSchema,DivineTrialEntryRequestSchema,DivineTrialSubmitRequestSchema,DivineTrialPrizeRequestSchema,DivineTrialEmptySchema} from '@shardkeep/shared/divineTrialsApi';
import {requestDivineTrialOriginal} from '../api';
import {need,verifyAttempt,verifyEvent} from './validation';
export type DivineRequest={kind:'events';cursor?:string}|{kind:'participant';eventId:string}|{kind:'entry'|'attempt'|'prize';eventId:string;body:unknown}|{kind:'read'|'submit'|'abandon';attemptId:string;body?:unknown};
export async function requestDivineTrial(input:{wallet:string;request:DivineRequest;guard:()=>void;retain:(raw:unknown)=>Promise<void>}){
 const r=structuredClone(input.request),root='/divine-trials',id=(v:unknown)=>DivineTrialIdSchema.parse(v);let path:string,method:'GET'|'POST'='GET',body:unknown;
 if(r.kind==='events'){if(r.cursor!==undefined)need(/^[A-Za-z0-9_-]{1,256}$/.test(r.cursor));path=root+'/events'+(r.cursor?'?cursor='+r.cursor:'');}
 else if(r.kind==='participant')path=root+'/events/'+id(r.eventId)+'/participant';
 else if(r.kind==='entry'||r.kind==='attempt'||r.kind==='prize'){path=root+'/events/'+id(r.eventId)+'/'+({entry:'entries',attempt:'attempts',prize:'prize'}[r.kind]);method='POST';body=(r.kind==='prize'?DivineTrialPrizeRequestSchema:DivineTrialEntryRequestSchema).parse(r.body);}
 else{need('attemptId'in r);path=root+'/attempts/'+id(r.attemptId);if(r.kind!=='read'){path+='/'+r.kind;method='POST';body=(r.kind==='submit'?DivineTrialSubmitRequestSchema:DivineTrialEmptySchema).parse(r.body??{});}else need(r.body===undefined);}
 return requestDivineTrialOriginal({method,path,...(method==='POST'?{body}:{}),timeoutMs:P.rpcTimeoutMs,isCurrent:()=>{input.guard();return true;},observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  if(r.kind==='events'){const page=DivineTrialEventsSchema.parse(raw);page.events.forEach(verifyEvent);return page;}
  const value=r.kind==='participant'?DivineTrialParticipantSchema.parse(raw):r.kind==='entry'?DivineTrialEntrySchema.parse(raw):r.kind==='prize'?DivineTrialClaimSchema.parse(raw):verifyAttempt(raw);
  need(value.wallet===input.wallet);if('eventId'in r)need(value.eventId===r.eventId);if('attemptId'in r)need('id'in value&&value.id===r.attemptId);
  if(r.kind==='entry'||r.kind==='attempt'){const command=DivineTrialEntryRequestSchema.parse(body);need('idempotencyKey'in value&&value.idempotencyKey===command.idempotencyKey&&'baseId'in value&&value.baseId===command.baseId);}
  if(r.kind==='prize')need('baseId'in value&&value.baseId===DivineTrialPrizeRequestSchema.parse(body).baseId);
  await input.retain(value);return value;
 }});
}
