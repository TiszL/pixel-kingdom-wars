/** D153.204 public retirement originals. These bounded DTOs carry no signing,
 * finality or deletion authority; clients independently reconstruct consent. */
import {z} from 'zod';
import {CLANS} from './constants';
import {CharterCreationOriginalSchema,CharterDeploymentSchema} from './charterApi';
const Id=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const Count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),Revision=Count.max(0xfffffffe);
const Amount=z.string().min(1).max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<(1n<<64n));
const Time=Amount.refine(v=>BigInt(v)<(1n<<63n)),No=z.literal(false);
const Hex=(n:number)=>z.string().length(n*2).regex(/^[0-9a-f]+$/);
const BoundedHex=(n:number)=>z.string().min(2).max(n*2).regex(/^(?:[0-9a-f]{2})+$/);
const Hash=Hex(32),Signature=z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const array=<T extends z.ZodType>(schema:T,max:number)=>z.preprocess(v=>Array.isArray(v)&&v.length<=max?v:null,z.array(schema).max(max));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const CharterRetirementRequestSchema=z.object({clanId:Id,idempotencyKey:Id}).strict();
export const CharterRetirementOriginalSchema=z.object({
 creation:CharterCreationOriginalSchema.extend({issuedPermitIds:array(Hex(16),256).refine(v=>v.length>0&&new Set(v).size===v.length)}).strict(),
 retirement:z.object({id:Id,fenceId:Id,clanId:Id,leader:Address,expectedRevision:Revision,clearanceHash:Hash}).strict(),
}).strict().refine(v=>v.creation.clanId===v.retirement.clanId);
const Packet=z.object({version:z.literal(1),messageHex:BoundedHex(1167),unsignedTransactionHex:BoundedHex(1232),messageSha256:Hash,
 packetBytes:Count.min(66).max(1232),nativeInstructionIndex:z.literal(1),signingAuthorized:No,relayAuthorized:No}).strict();
const Lookup=z.object({address:Address,owner:Address,executable:No,dataHex:BoundedHex(8248),slot:Count}).strict();
const PacketInput=z.object({original:CharterRetirementOriginalSchema,candidateHex:Hex(161),policySigner:Address,lookupTable:Lookup,
 expectedLookupTable:z.object({address:Address,dataSha256:Hash}).strict(),blockhash:Address,blockhashSlot:Count,lastValidBlockHeight:Count,currentBlockHeight:Count}).strict();
const Source=z.object({genesisHash:Address,programs:CharterDeploymentSchema,accounts:array(z.object({address:Address,owner:Address.nullable(),executable:z.boolean().nullable(),dataSha256:Hash.nullable()}).strict(),100)}).strict();
const Allocation=z.object({kind:z.enum(['permit-receipt','retirement-receipt']),address:Address,bytes:Count.min(1).max(1232),minimumBalanceLamports:Amount}).strict();
const Costs=z.object({networkFeeLamports:Amount,rentLamports:Amount,totalLamports:Amount,allocations:array(Allocation,2).refine(v=>v.length===2)}).strict();
export const CharterRetirementQuoteSchema=z.object({version:z.literal(1),packetInput:PacketInput,
 observation:z.object({slot:Count,unixTimestamp:Time,registryRevision:Revision,registryLeader:Address,lockKind:z.literal(0),lockId:Hex(16),policySigner:Address,admissionPaused:No,craftPaused:No,source:Source}).strict(),
 template:Packet,costs:Costs,costLimits:z.object({maxNetworkFeeLamports:Amount,maxRentLamports:Amount,maxAdditionalLamports:Amount}).strict(),
 context:z.object({feeSlot:Count,closingSlot:Count,closingGenesisHash:Address}).strict(),signingAuthorized:No,retirementAuthorized:No,fenceReleaseAuthorized:No,
}).strict().superRefine((q,c)=>{
 const issue=()=>c.addIssue({code:'custom',message:'Retirement quote differs from its original'}),p=q.packetInput,o=p.original.retirement,chain=p.original.creation.chain,b=q.observation;
 const slots=[b.slot,p.lookupTable.slot,p.blockhashSlot,q.context.feeSlot,q.context.closingSlot];
 if(b.registryRevision!==o.expectedRevision||b.registryLeader!==o.leader||b.policySigner!==p.policySigner||b.lockId!=='0'.repeat(32)
  ||slots.some((slot,i)=>i>0&&slot<slots[i-1]!)||p.currentBlockHeight>p.lastValidBlockHeight||p.lookupTable.address!==p.expectedLookupTable.address
  ||q.context.closingGenesisHash!==chain.genesisHash||b.source.genesisHash!==chain.genesisHash||b.source.programs.expectedGenesisHash!==chain.genesisHash
  ||b.source.programs.economy.programId!==chain.economyProgram||b.source.programs.craft.programId!==chain.craftProgram
  ||[b.source.programs.economy,b.source.programs.craft,b.source.programs.core].some(pin=>pin.reviewedDeploymentSlot>b.slot))issue();
 const fee=BigInt(q.costs.networkFeeLamports),rent=q.costs.allocations.reduce((sum,a)=>sum+BigInt(a.minimumBalanceLamports),0n);
 if(rent!==BigInt(q.costs.rentLamports)||fee+rent!==BigInt(q.costs.totalLamports)||fee>BigInt(q.costLimits.maxNetworkFeeLamports)
  ||rent>BigInt(q.costLimits.maxRentLamports)||fee+rent>BigInt(q.costLimits.maxAdditionalLamports)
  ||new Set(q.costs.allocations.map(a=>a.kind)).size!==2||new Set(q.costs.allocations.map(a=>a.address)).size!==2)issue();
});
export const CharterRetirementWireSchema=z.object({signedTransactionHex:BoundedHex(1232),signature:Signature,wireSha256:Hash,messageSha256:Hash}).strict();
const Authority={signingAuthorized:No,relayAuthorized:No,retirementAuthorized:No,fenceReleaseAuthorized:No};
export const CharterRetirementOperationSchema=z.object({version:z.literal(1),original:CharterRetirementOriginalSchema,
 status:z.enum(['cleared','issuing','prepared','signed','completed','cancelled']),memberPayment:z.object({id:Id,totalShards:Amount}).strict(),
 attempt:z.object({id:Id,candidateHex:Hex(161),policySigner:Address,quote:CharterRetirementQuoteSchema}).strict().nullable(),
 preparation:z.object({policySignatureHex:Hex(64),packet:Packet}).strict().nullable(),signed:CharterRetirementWireSchema.nullable(),
 terminal:z.object({id:Id,outcome:z.enum(['completed','cancelled'])}).strict().nullable(),...Authority,
}).strict().superRefine((v,c)=>{
 const issue=()=>c.addIssue({code:'custom',message:'Retirement lifecycle lacks original backing'});
 if(v.status!==(v.terminal?.outcome??(v.signed?'signed':v.preparation?'prepared':v.attempt?'issuing':'cleared'))
  ||v.preparation&&!v.attempt||v.signed&&!v.preparation||v.terminal?.outcome==='completed'&&!v.signed)issue();
 if(v.attempt&&(!same(v.attempt.quote.packetInput.original,v.original)||v.attempt.quote.packetInput.candidateHex!==v.attempt.candidateHex||v.attempt.quote.packetInput.policySigner!==v.attempt.policySigner))issue();
 for(const packet of [v.attempt?.quote.template,v.preparation?.packet])if(packet&&(packet.packetBytes!==65+packet.messageHex.length/2
  ||packet.unsignedTransactionHex!=='01'+'00'.repeat(64)+packet.messageHex||!packet.messageHex.startsWith('80')))issue();
 if(v.signed&&v.signed.messageSha256!==v.preparation?.packet.messageSha256)issue();
});
export type CharterRetirementOperation=z.infer<typeof CharterRetirementOperationSchema>;
export type CharterRetirementQuote=z.infer<typeof CharterRetirementQuoteSchema>;
export type CharterRetirementRequest=z.infer<typeof CharterRetirementRequestSchema>;
export type CharterRetirementWire=z.infer<typeof CharterRetirementWireSchema>;

/** A draft owns the member freeze before any destination lookup or payout.
 * Cancelling that draft is distinct from proving an exposed permit absent. */
export const CharterRetirementDraftSchema=z.object({version:z.literal(1),id:Id,actor:Address,request:CharterRetirementRequestSchema,
 clan:z.object({id:Id,name:z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen),tag:z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen)}).strict(),
 fenceId:Id,totalShards:Amount,shares:array(z.object({wallet:Address,shards:Amount}).strict(),CLANS.rosterCap).refine(v=>v.length>0),
 memberPayment:z.object({id:Id,totalShards:Amount}).strict().nullable(),operation:CharterRetirementOperationSchema.nullable(),cancelled:z.boolean(),...Authority,
}).strict().superRefine((v,c)=>{
 const issue=()=>c.addIssue({code:'custom',message:'Dissolution draft differs from its captured members'});
 if(v.clan.id!==v.request.clanId||v.shares.reduce((sum,s)=>sum+BigInt(s.shards),0n)!==BigInt(v.totalShards)
  ||v.shares.some((s,i)=>i>0&&s.wallet<=v.shares[i-1]!.wallet)||!v.shares.some(s=>s.wallet===v.actor)
  ||v.memberPayment&&v.memberPayment.totalShards!==v.totalShards||v.cancelled&&v.operation)issue();
 if(v.operation){const o=v.operation.original.retirement;
  if(o.leader!==v.actor||o.fenceId!==v.fenceId||o.clanId!==v.clan.id||!v.memberPayment||!same(v.memberPayment,v.operation.memberPayment))issue();
 }
});
export type CharterRetirementDraft=z.infer<typeof CharterRetirementDraftSchema>;
export const CharterRetirementJournalSchema=z.object({version:z.literal(1),identity:z.unknown(),revision:Count,
 request:CharterRetirementRequestSchema.nullable(),draftId:Id.nullable(),draft:CharterRetirementDraftSchema.nullable(),
 signingStarted:z.boolean(),signed:CharterRetirementWireSchema.nullable(),observed:z.array(z.enum(['completed','cancelled','draft_cancelled','unknown'])).max(4)}).strict();
export type CharterRetirementJournalRecord=z.infer<typeof CharterRetirementJournalSchema>;
export const CharterRetirementByKeySchema=z.object({version:z.literal(1),actor:Address,idempotencyKey:Id,draft:CharterRetirementDraftSchema.nullable()}).strict()
 .refine(v=>!v.draft||v.draft.actor===v.actor&&v.draft.request.idempotencyKey===v.idempotencyKey);
