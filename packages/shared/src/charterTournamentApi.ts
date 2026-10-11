/** D153.181 bounded public tournament originals. Parsing confers no tournament,
 * signing, score, prize or lock-release authority. Lazy subpath only. */
import {z} from 'zod';
import {CLANS,PHASE_E_CHARTER_TOURNAMENT as P,PHASE_E_CHARTER_ADMISSION} from './constants';
import {CharterCreationOriginalSchema,CharterDeploymentSchema} from './charterApi';
import {CHARTER_TOURNAMENT_POLICY,CharterTournamentAmountsSchema,CharterTournamentBudgetSchema,tournamentSchedule} from './charterTournament';
const Id=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),Hash=z.string().length(64).regex(/^[0-9a-f]+$/);
const Count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),Revision=Count.max(0xffffffff),Amount=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<(1n<<64n));
const Time=Amount.refine(v=>BigInt(v)<(1n<<63n)),Timestamp=z.string().length(24).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const Hex=(n:number)=>z.string().length(n*2).regex(/^[0-9a-f]+$/),BoundedHex=(n:number)=>z.string().min(2).max(n*2).regex(/^(?:[0-9a-f]{2})+$/),No=z.literal(false);
const array=<T extends z.ZodType>(schema:T,max:number)=>z.preprocess(v=>Array.isArray(v)&&v.length<=max?v:null,z.array(schema).max(max));
const Roster=array(Address,CLANS.rosterCap).refine(v=>v.length>0&&v.every((s,i)=>i===0||s>v[i-1]!));
const Domain=z.object({genesisHash:Address,economyProgram:Address,craftProgram:Address,treasury:Address}).strict();
/** PostgreSQL jsonb sorts object keys by UTF8 byte length and then bytes; arrays
 * retain order. Only schema-bounded safe-integer JSON enters this function. */
export function postgresJsonbText(value:unknown):string{
 const enc=new TextEncoder();let nodes=0;
 function json(v:unknown,depth:number):string{
  if(++nodes>20000||depth>16)throw Error('Tournament commitment exceeds bounds.');
  if(v===null||typeof v==='boolean')return JSON.stringify(v);
  if(typeof v==='string'){if(v.length>262144)throw Error('Tournament string exceeds bounds.');return JSON.stringify(v);}
  if(typeof v==='number'){if(!Number.isSafeInteger(v))throw Error('Tournament number is not a safe integer.');return JSON.stringify(v);}
  if(Array.isArray(v)){if(v.length>10000)throw Error('Tournament list exceeds bounds.');return '['+v.map(x=>json(x,depth+1)).join(', ')+']';}
  if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('Tournament commitment is not plain JSON.');
  const r=v as Record<string,unknown>,keys=Object.keys(r);if(keys.length>64||Reflect.ownKeys(r).length!==keys.length)throw Error('Tournament record exceeds bounds.');
  keys.sort((a,b)=>{const x=enc.encode(a),y=enc.encode(b);if(x.length!==y.length)return x.length-y.length;for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]!-y[i]!;return 0;});
  return '{'+keys.map(k=>{const p=Object.getOwnPropertyDescriptor(r,k);if(!p||!('value'in p)||!p.enumerable)throw Error('Tournament accessor refused.');return JSON.stringify(k)+': '+json(p.value,depth+1);}).join(', ')+'}';
 }return json(value,0);
}
const same=(a:unknown,b:unknown)=>postgresJsonbText(a)===postgresJsonbText(b);
const Proof=z.unknown().superRefine((v,c)=>{try{if(v===null||typeof v!=='object'||Array.isArray(v))throw Error();postgresJsonbText(v);}catch{c.addIssue({code:'custom',message:'Invalid bounded original proof'});}});
const Policy=z.unknown().refine(v=>{try{return same(v,CHARTER_TOURNAMENT_POLICY);}catch{return false;}}).transform(()=>structuredClone(CHARTER_TOURNAMENT_POLICY));
const EventTerms=z.object({version:z.literal(1),id:Id,domain:Domain,sponsorWallet:Address,entryStartsAt:Timestamp,playStartsAt:Timestamp,playEndsAt:Timestamp,occupationEndsAt:Timestamp,policy:Policy,budget:CharterTournamentBudgetSchema}).strict();
export const CharterTournamentEventTermsSchema=EventTerms.superRefine((v,c)=>{try{if(!same(tournamentSchedule(v.entryStartsAt),{entryStartsAt:v.entryStartsAt,playStartsAt:v.playStartsAt,playEndsAt:v.playEndsAt,occupationEndsAt:v.occupationEndsAt}))throw Error();}catch{c.addIssue({code:'custom',message:'Tournament schedule differs'});}});
const Ranking=z.object({clanId:Id,stars:Count,destruction:Count,completedRaids:Count.min(1),rosterSize:Count.min(1).max(CLANS.rosterCap)}).strict().refine(v=>v.completedRaids<=v.rosterSize*P.raidsPerWallet&&v.stars<=v.completedRaids*P.maxStarsPerRaid&&v.destruction<=v.completedRaids*P.maxDestructionPerRaid);
export const CharterTournamentTerminalSchema=z.object({version:z.literal(1),eventId:Id,completedAt:Timestamp,rankings:array(Ranking,10000),occupations:array(z.object({site:Count.min(1).max(P.divineSites),clanId:Id}).strict(),P.divineSites),entitlements:array(z.object({wallet:Address,amounts:CharterTournamentAmountsSchema}).strict(),P.divineSites*CLANS.rosterCap+1)}).strict();
export const CharterTournamentEventSchema=EventTerms.extend({terminal:CharterTournamentTerminalSchema.nullable()}).strict().superRefine((v,c)=>{if(!CharterTournamentEventTermsSchema.safeParse(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='terminal'))).success||v.terminal&&v.terminal.eventId!==v.id)c.addIssue({code:'custom',message:'Tournament original differs'});});
export const CharterTournamentEventsSchema=z.object({version:z.literal(1),events:array(CharterTournamentEventSchema,20),nextCursor:z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).nullable()}).strict();
export const CharterTournamentEntryRequestSchema=z.object({eventId:Id,clanId:Id,idempotencyKey:Id}).strict();
export const CharterTournamentClearRequestSchema=z.object({idempotencyKey:Id}).strict();
export const CharterTournamentRaidRequestSchema=z.object({baseId:Id,idempotencyKey:Id}).strict();
export const CharterTournamentPrizeRequestSchema=z.object({baseId:Id}).strict();
export const CharterTournamentPrizeSchema=z.object({eventId:Id,wallet:Address,baseId:Id,amounts:CharterTournamentAmountsSchema,claimedAt:Timestamp}).strict();
const Original=z.object({creation:CharterCreationOriginalSchema.extend({issuedPermitIds:array(Hex(16),256).refine(v=>v.length>0&&new Set(v).size===v.length)}).strict(),operation:z.object({id:Id,fenceId:Id,eventId:Id,leader:Address,lockId:Id,expectedRevision:Revision.max(0xfffffffe),action:z.enum(['set','clear']),termsHash:Hash}).strict()}).strict();
export const CharterTournamentOperationTermsSchema=z.object({version:z.literal(1),epochId:Id,entryId:Id,eventId:Id,clanId:Id,leader:Address,lockId:Id,fenceId:Id,operationId:Id,action:z.enum(['set','clear']),expectedRevision:Revision.max(0xfffffffe),domain:Domain,event:CharterTournamentEventTermsSchema,roster:Roster,clearance:z.union([CharterTournamentTerminalSchema,z.object({version:z.literal(1),kind:z.literal('late-entry-nonparticipation'),entryId:Id,eventId:Id,terminalId:Id,lockId:Id,awards:z.array(z.never()).length(0)}).strict()]).nullable()}).strict();
const LookupPin=z.object({address:Address,dataSha256:Hash}).strict();
const Lookup=z.object({address:Address,owner:Address,executable:No,dataHex:Hex(56+12*32),slot:Count}).strict();
const Packet=z.object({version:z.literal(1),messageHex:BoundedHex(1167),unsignedTransactionHex:BoundedHex(1232),messageSha256:Hash,packetBytes:Count.min(66).max(1232),nativeInstructionIndex:z.literal(1),signingAuthorized:No,relayAuthorized:No}).strict();
const PacketInput=z.object({original:Original,candidateHex:Hex(161),policySigner:Address,lookupTable:Lookup,expectedLookupTable:LookupPin,blockhash:Address,blockhashSlot:Count,lastValidBlockHeight:Count,currentBlockHeight:Count}).strict();
const Source=z.object({genesisHash:Address,programs:CharterDeploymentSchema,accounts:array(z.object({address:Address,owner:Address.nullable(),executable:z.boolean().nullable(),dataSha256:Hash.nullable()}).strict(),16).refine(v=>v.length===16)}).strict();
const Costs=z.object({networkFeeLamports:Amount,rentLamports:Amount,totalLamports:Amount,allocations:array(z.object({kind:z.literal('permit-receipt'),address:Address,bytes:z.literal(107),minimumBalanceLamports:Amount}).strict(),1).refine(v=>v.length===1)}).strict();
const Quote=z.object({version:z.literal(1),packetInput:PacketInput,observation:z.object({slot:Count,unixTimestamp:Time,registryRevision:Revision,registryLeader:Address,lockKind:z.union([z.literal(0),z.literal(1)]),lockId:z.union([Id,Hex(16)]),policySigner:Address,admissionPaused:No,craftPaused:No,source:Source}).strict(),template:Packet,costs:Costs,costLimits:z.object({maxNetworkFeeLamports:Amount,maxRentLamports:Amount,maxAdditionalLamports:Amount}).strict(),context:z.object({feeSlot:Count,closingSlot:Count,closingGenesisHash:Address}).strict(),signingAuthorized:No,entryAuthorized:No,fenceReleaseAuthorized:No}).strict();
export const CharterTournamentWireSchema=z.object({signedTransactionHex:BoundedHex(1232),signature:z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),wireSha256:Hash,messageSha256:Hash}).strict();
const Authority={signingAuthorized:No.optional(),relayAuthorized:No.optional(),entryAuthorized:No.optional(),fenceReleaseAuthorized:No.optional()};
const Operation=z.object({version:z.literal(1),original:Original,operationTerms:CharterTournamentOperationTermsSchema,status:z.enum(['draft','issuing','prepared','signed','completed','cancelled']),entryId:Id,
 attempt:z.object({id:Id,candidateHex:Hex(161),policySigner:Address,quote:Quote}).strict().nullable(),preparation:z.object({policySignatureHex:Hex(64),packet:Packet}).strict().nullable(),signed:CharterTournamentWireSchema.nullable(),terminal:z.object({id:Id,outcome:z.enum(['completed','cancelled']),record:Proof}).strict().nullable(),inventory:z.object({version:z.literal(1),revision:z.enum(['0','1']),count:z.union([z.literal(0),z.literal(1)]),messages:array(Hex(161),1)}).strict(),...Authority}).strict();
export const CharterTournamentOperationSchema=Operation.superRefine((v,c)=>{
 const issue=(message:string)=>c.addIssue({code:'custom',message}),o=v.original.operation,t=v.operationTerms,cr=v.original.creation;
 if(t.entryId!==v.entryId||t.fenceId!==v.entryId||t.operationId!==o.id||t.fenceId!==o.fenceId||t.eventId!==o.eventId||t.clanId!==cr.clanId||t.leader!==o.leader||t.lockId!==o.lockId||t.action!==o.action||t.expectedRevision!==o.expectedRevision||!t.roster.includes(t.leader)||t.event.id!==t.eventId||!same(t.event.domain,t.domain)||t.domain.genesisHash!==cr.chain.genesisHash||t.domain.economyProgram!==cr.chain.economyProgram||t.domain.craftProgram!==cr.chain.craftProgram||(o.action==='set')!==(t.clearance===null))issue('Operation source commitment differs');
 if(t.clearance&&(t.clearance.eventId!==t.eventId||'kind'in t.clearance&&(t.clearance.entryId!==t.entryId||t.clearance.lockId!==t.lockId)))issue('Clearance original differs');
 if(v.status!==(v.terminal?.outcome??(v.signed?'signed':v.preparation?'prepared':v.attempt?'issuing':'draft')))issue('Original status lacks backing');
 if(v.inventory.revision!==String(v.inventory.count)||v.inventory.messages.length!==v.inventory.count||!!v.attempt!==(v.inventory.count===1)||v.attempt&&v.inventory.messages[0]!==v.attempt.candidateHex||v.preparation&&!v.attempt||v.signed&&!v.preparation||v.terminal&&v.terminal.outcome!==v.status||['completed','cancelled'].includes(v.status)!==!!v.terminal)issue('Original lifecycle backing differs');
 if(v.attempt){const q=v.attempt.quote,p=q.packetInput,b=q.observation,slots=[b.slot,p.lookupTable.slot,p.blockhashSlot,q.context.feeSlot,q.context.closingSlot];
  if(!same(p.original,v.original)||p.candidateHex!==v.attempt.candidateHex||p.policySigner!==v.attempt.policySigner||b.policySigner!==p.policySigner||b.registryLeader!==o.leader||b.registryRevision!==o.expectedRevision||b.lockKind!==(o.action==='set'?0:1)||b.lockId!==(o.action==='set'?'0'.repeat(32):o.lockId)||slots.some((n,i)=>i>0&&n<slots[i-1]!)||p.currentBlockHeight>p.lastValidBlockHeight||q.context.closingGenesisHash!==cr.chain.genesisHash||b.source.genesisHash!==cr.chain.genesisHash||p.lookupTable.address!==p.expectedLookupTable.address)issue('Quoted original differs');
  const fee=BigInt(q.costs.networkFeeLamports),rent=BigInt(q.costs.rentLamports);if(q.costs.allocations[0]?.minimumBalanceLamports!==q.costs.rentLamports||BigInt(q.costs.totalLamports)!==fee+rent||fee>BigInt(q.costLimits.maxNetworkFeeLamports)||rent>BigInt(q.costLimits.maxRentLamports)||fee+rent>BigInt(q.costLimits.maxAdditionalLamports))issue('Quoted cost differs');
 }
 const packet=v.preparation?.packet;if(packet&&(packet.packetBytes!==65+packet.messageHex.length/2||packet.unsignedTransactionHex!=='01'+'00'.repeat(64)+packet.messageHex||!packet.messageHex.startsWith('80')))issue('Canonical packet differs');
 if(v.signed&&v.signed.messageSha256!==packet?.messageSha256)issue('Signed original differs');
});
export const CharterTournamentEntrySchema=z.object({version:z.literal(1),id:Id,eventId:Id,clanId:Id,leader:Address,epochId:Id,lockId:Id,roster:Roster,status:z.enum(['pending','entered','nonparticipating','released','cancelled']),set:CharterTournamentOperationSchema,clear:CharterTournamentOperationSchema.nullable()}).strict().superRefine((v,c)=>{if(![v.set,...(v.clear?[v.clear]:[])].every(o=>o.entryId===v.id&&o.operationTerms.eventId===v.eventId&&o.operationTerms.clanId===v.clanId&&o.operationTerms.epochId===v.epochId&&o.original.operation.leader===v.leader&&o.original.operation.lockId===v.lockId&&same(o.operationTerms.roster,v.roster))||v.set.original.operation.action!=='set'||v.clear&&(v.clear.original.operation.action!=='clear'||v.clear.original.operation.expectedRevision!==v.set.original.operation.expectedRevision+1||!same(v.clear.original.creation,v.set.original.creation)||!same(v.clear.operationTerms.event,v.set.operationTerms.event))||v.status==='cancelled'&&v.set.terminal?.outcome!=='cancelled'||['entered','nonparticipating','released'].includes(v.status)&&v.set.terminal?.outcome!=='completed'||v.status==='released'&&v.clear?.terminal?.outcome!=='completed')c.addIssue({code:'custom',message:'Entry original differs'});});
export const CharterTournamentDeliverySchema=z.object({version:z.literal(1),operationId:Id,status:z.enum(['held','terminal','observed','submitted']),signature:z.string().min(64).max(88).nullable(),reason:z.enum(['NOT_SIGNED','PAUSED','TRANSPORT_UNAVAILABLE','IDENTITY','EXPIRED_UNRESOLVED','ADMISSION_HELD','SOURCE_CONFLICT','OBSERVED_TRANSACTION','FINALIZED_ERROR_UNVERIFIED','SEND_UNCERTAIN','TIMEOUT','BUSY']).nullable(),operation:CharterTournamentOperationSchema,signingAuthorized:No,entryAuthorized:No,fenceReleaseAuthorized:No}).strict().refine(v=>v.operationId===v.operation.original.operation.id&&v.signature===(v.operation.signed?.signature??null));
export type CharterTournamentOperation=z.infer<typeof CharterTournamentOperationSchema>;
export type CharterTournamentEntry=z.infer<typeof CharterTournamentEntrySchema>;
export type CharterTournamentEvent=z.infer<typeof CharterTournamentEventSchema>;
export type CharterTournamentEvents=z.infer<typeof CharterTournamentEventsSchema>;
export type CharterTournamentOperationTerms=z.infer<typeof CharterTournamentOperationTermsSchema>;
export type CharterTournamentWire=z.infer<typeof CharterTournamentWireSchema>;
export type CharterTournamentEntryRequest=z.infer<typeof CharterTournamentEntryRequestSchema>;
export type CharterTournamentPrize=z.infer<typeof CharterTournamentPrizeSchema>;
const MemberEntry=z.object({entryId:Id,clanId:Id,leader:Address,roster:Roster,lockId:Id,lockTerminalId:Id}).strict();
export const CharterTournamentRaidSchema=z.object({version:z.literal(1),eventId:Id,requestId:Id,baseId:Id,status:z.enum(['requested','admitted','cancelled']),ordinal:Count.min(1).max(P.raidsPerWallet).nullable(),raid:Proof.nullable()}).strict().superRefine((v,c)=>{if(v.raid!==null){const r=v.raid as Record<string,unknown>;if(!Id.safeParse(r.id).success||v.ordinal===null||v.status!=='admitted')c.addIssue({code:'custom',message:'Invalid admitted raid identity'});}else if(v.ordinal!==null||v.status==='admitted')c.addIssue({code:'custom',message:'Raid ordinal lacks admission'});});
export const CharterTournamentReplaySchema=z.object({raidId:Id,completed:z.boolean(),stars:Count.max(P.maxStarsPerRaid),destruction:Count.max(P.maxDestructionPerRaid),inputSha256:Hash}).strict();
export const CharterTournamentParticipationSchema=z.object({version:z.literal(1),eventId:Id,entry:MemberEntry.nullable(),prize:z.object({amounts:CharterTournamentAmountsSchema,claim:CharterTournamentPrizeSchema.nullable()}).strict().nullable(),raids:array(CharterTournamentRaidSchema,P.raidsPerWallet+1)}).strict().superRefine((v,c)=>{if(v.raids.some(r=>r.eventId!==v.eventId)||v.prize?.claim&&v.prize.claim.eventId!==v.eventId)c.addIssue({code:'custom',message:'Participant event differs'});});
export type CharterTournamentParticipation=z.infer<typeof CharterTournamentParticipationSchema>;
export type CharterTournamentRaid=z.infer<typeof CharterTournamentRaidSchema>;
export type CharterTournamentReplay=z.infer<typeof CharterTournamentReplaySchema>;

export const CharterTournamentEmptySchema=z.object({}).strict();
const StoredOperation=z.object({id:Id,original:CharterTournamentOperationSchema,signingStarted:z.boolean(),signed:CharterTournamentWireSchema.nullable()}).strict();
const Status=z.enum(['completed','cancelled']);
export const CharterTournamentJournalSchema=z.object({version:z.literal(1),identity:z.unknown(),entryKey:Id.nullable(),revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),eventId:Id.nullable(),entryIntent:CharterTournamentEntryRequestSchema.nullable(),entry:CharterTournamentEntrySchema.nullable(),clearIntent:z.object({entryId:Id,idempotencyKey:Id}).strict().nullable(),operations:z.array(StoredOperation).max(32),observed:z.array(z.object({operationId:Id,outcome:Status}).strict()).max(64),raids:z.array(z.object({eventId:Id,request:CharterTournamentRaidRequestSchema,response:CharterTournamentRaidSchema.nullable()}).strict()).max(64),prize:z.object({eventId:Id,request:CharterTournamentPrizeRequestSchema,response:CharterTournamentPrizeSchema.nullable()}).strict().nullable()}).strict();
export type CharterTournamentJournalRecord=z.infer<typeof CharterTournamentJournalSchema>;
