import {Buffer} from 'buffer';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {CharterTournamentEmptySchema,CharterTournamentEntryRequestSchema,CharterTournamentClearRequestSchema,CharterTournamentPrizeRequestSchema,CharterTournamentRaidRequestSchema,CharterTournamentEntrySchema,CharterTournamentOperationSchema,CharterTournamentEventsSchema,CharterTournamentEventSchema,CharterTournamentParticipationSchema,CharterTournamentPrizeSchema,CharterTournamentRaidSchema,CharterTournamentReplaySchema,CharterTournamentDeliverySchema,CharterTournamentWireSchema} from '@shardkeep/shared/charterTournamentApi';
import {requestCharterTournamentOriginal} from '../api';
const id=(v:unknown)=>CharterTournamentEntryRequestSchema.shape.eventId.parse(v),empty=CharterTournamentEmptySchema,root='/clans/charter/tournaments';
export type TournamentRequest={kind:'events'|'event'|'participation'|'entry'|'operation'|'clear'|'prize'|'raid'|'replay';action:'read'|'create'|'by-key'|'prepare'|'recover-preparation'|'recover'|'cancel'|'signed'|'deliver'|'close';id?:string;key?:string;cursor?:string;body?:unknown};
export async function requestTournament(input:{actor:string;request:TournamentRequest;isCurrent:()=>boolean;retain:(kind:TournamentRequest['kind'],raw:unknown)=>Promise<void>}):Promise<unknown>{
 const r=structuredClone(input.request);if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['kind','action','id','key','cursor','body'].includes(k)))throw Error('Invalid tournament request.');
 let path=root,method:'GET'|'POST'='GET',body:unknown;let schema:{parse:(value:unknown)=>unknown};
 if(r.kind==='events'&&r.action==='read'){
  if(r.id!==undefined||r.key!==undefined||r.body!==undefined||r.cursor!==undefined&&(r.cursor.length>256||!/^[\x21-\x7e]+$/.test(r.cursor)))throw Error('Invalid tournament history cursor.');path+='/events'+(r.cursor?'?cursor='+encodeURIComponent(r.cursor):'');schema=CharterTournamentEventsSchema;
 }else{
  if(r.cursor!==undefined)throw Error('Unexpected tournament cursor.');
  if(r.kind==='entry'){
   schema=CharterTournamentEntrySchema;
   if(r.action==='create'){method='POST';body=CharterTournamentEntryRequestSchema.parse(r.body);path+='/entries';if(r.id!==undefined||r.key!==undefined)throw Error('Unexpected entry identity.');}
   else if(r.action==='read'){path+='/entries/'+id(r.id);if(r.key!==undefined)throw Error('Unexpected entry key.');}
   else if(r.action==='by-key'){path+='/entries/by-key/'+id(r.key);if(r.id!==undefined)throw Error('Unexpected entry ID.');}
   else throw Error('Invalid entry action.');
  }else if(r.kind==='clear'&&r.action==='create'){method='POST';path+='/entries/'+id(r.id)+'/clear';body=CharterTournamentClearRequestSchema.parse(r.body);schema=CharterTournamentOperationSchema;}
  else if(r.kind==='operation'){
   path+='/operations/'+id(r.id);schema=CharterTournamentOperationSchema;
   if(r.action!=='read'){if(!['prepare','recover-preparation','recover','cancel','signed','deliver'].includes(r.action))throw Error('Invalid tournament action.');method='POST';path+='/'+r.action;
    if(r.action==='signed'){const wire=CharterTournamentWireSchema.parse(r.body);body={signedTransaction:Buffer.from(wire.signedTransactionHex,'hex').toString('base64')};}else body=empty.parse(r.body??{});
    if(r.action==='deliver')schema=CharterTournamentDeliverySchema;
   }
  }else if(r.kind==='event'&&['read','close'].includes(r.action)){path+='/events/'+id(r.id);schema=CharterTournamentEventSchema;if(r.action==='close'){method='POST';path+='/close';body=empty.parse(r.body??{});}}
  else if(r.kind==='participation'&&r.action==='read'){path+='/events/'+id(r.id)+'/participation';schema=CharterTournamentParticipationSchema;}
  else if(r.kind==='prize'&&r.action==='create'){method='POST';path+='/events/'+id(r.id)+'/prize';body=CharterTournamentPrizeRequestSchema.parse(r.body);schema=CharterTournamentPrizeSchema;}
  else if(r.kind==='raid'&&r.action==='create'){method='POST';path+='/events/'+id(r.id)+'/raids';body=CharterTournamentRaidRequestSchema.parse(r.body);schema=CharterTournamentRaidSchema;}
  else if(r.kind==='raid'&&r.action==='cancel'){method='POST';path+='/events/'+id(r.id)+'/raids/by-key/'+id(r.key)+'/cancel';body=empty.parse(r.body??{});schema=CharterTournamentRaidSchema;}
  else if(r.kind==='raid'&&r.action==='by-key'){path+='/events/'+id(r.id)+'/raids/by-key/'+id(r.key);schema=CharterTournamentRaidSchema.nullable();}
  else if(r.kind==='replay'&&r.action==='create'){method='POST';path+='/raids/'+id(r.id)+'/replay';body=empty.parse(r.body??{});schema=CharterTournamentReplaySchema;}
  else throw Error('Invalid tournament resource.');
  if(method==='GET'&&r.body!==undefined||r.key!==undefined&&!(r.kind==='entry'&&r.action==='by-key'||r.kind==='raid'&&['by-key','cancel'].includes(r.action)))throw Error('Unexpected tournament fields.');
 }
 return requestCharterTournamentOriginal({method,path,...(method==='POST'?{body}:{}),isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  const value=raw as Record<string,any>|null,original=r.action==='deliver'?value?.operation:value;
  if(['operation','clear'].includes(r.kind)){if(!original||original.original?.operation?.leader!==input.actor||r.kind==='operation'&&original.original.operation.id!==r.id||r.kind==='clear'&&original.entryId!==r.id)throw Error('Tournament operation belongs to another original.');}
  if(r.kind==='entry'&&(!value||value.leader!==input.actor||r.action==='read'&&value.id!==r.id||r.action==='create'&&(value.eventId!==(body as any).eventId||value.clanId!==(body as any).clanId)))throw Error('Tournament entry belongs to another original.');
  if(['event','participation','prize','raid'].includes(r.kind)&&value&&(r.kind==='event'?value.id:value.eventId)!==r.id)throw Error('Tournament event differs.');
  if(r.kind==='prize'&&value?.wallet!==input.actor||r.kind==='participation'&&value?.entry&&!value.entry.roster?.includes(input.actor)||r.kind==='raid'&&value?.raid?.attackerWallet!==undefined&&value.raid.attackerWallet!==input.actor)throw Error('Tournament participant differs.');
  if(r.kind==='raid'&&value&&r.action==='create'&&value.baseId!==(body as any).baseId)throw Error('Tournament raid request differs.');
  if(r.kind==='participation'&&value?.prize?.claim&&value.prize.claim.wallet!==input.actor)throw Error('Tournament prize beneficiary differs.');
  if(r.kind==='replay'&&value?.raidId!==r.id)throw Error('Tournament raid differs.');
  await input.retain(r.kind==='clear'?'operation':r.kind,original);return schema.parse(raw);
 }});
}
