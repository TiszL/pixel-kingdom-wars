/** Realm Passport (D153 B7 catalogue outcome): read-only account participation
 * history. Subpath-only: do not add this module to the shared first-paint
 * barrel. No score, reward, eligibility, claim preparation, signing or access
 * pass is granted by these schemas. An unavailable page carries data null and a
 * reason, never zeros; history rows are original-actor receipts only. */
import {z} from 'zod';
import {REALM_IDS} from './baseVisual';
import {PHASE_E_DIVINE_TRIALS} from './constants';

/** Transport page bound (the existing discovery page size), never an activity cap. */
export const REALM_PASSPORT_PAGE_SIZE=PHASE_E_DIVINE_TRIALS.discoveryPageSize;
const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const Address=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Timestamp=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
function u64(v:unknown):bigint|null{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(v))return null;const n=BigInt(v);return n<(1n<<64n)?n:null;}
const Amount=z.string().max(20).refine(v=>u64(v)!==null),Positive=Amount.refine(v=>{const n=u64(v);return n!==null&&n>0n;});
const Count=z.number().int().nonnegative().safe();
const Version=z.number().int().positive().max(2_147_483_647);
/** Starter ids follow phaseEExpeditions, advanced ids follow advancedExpeditionApi; neither is reinterpreted. */
const RouteId=z.string().min(1).max(64).refine(v=>/^[a-z][a-z0-9_]*$/.test(v)||/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(v));
const Hash=z.string().regex(/^[0-9a-f]{64}$/);
const Signature=z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
function issue(ctx:z.RefinementCtx,message:string){ctx.addIssue({code:'custom',message});}
function ascending(values:readonly unknown[],less:(a:unknown,b:unknown)=>boolean){return values.every((v,i)=>i===0||less(values[i-1],v));}

export const RealmPassportExpeditionKindSchema=z.enum(['starter','advanced']);
export const RealmPassportUnavailableReasonSchema=z.enum(['SOURCE_UNAVAILABLE','SOURCE_CONFLICT','NOT_CONFIGURED']);
/** Cursors are exclusive: the last displayed expeditionId (canonical UUID) or publication sequence. */
export const RealmPassportExpeditionsQuerySchema=z.object({kind:RealmPassportExpeditionKindSchema,cursor:Uuid.optional()}).strict();
export const RealmPassportInclusionsQuerySchema=z.object({cursor:Positive.optional()}).strict();

const envelope={version:z.literal(1),wallet:Address,serverNow:Timestamp,projection:z.literal('history-only')};
const Unavailable=z.object({...envelope,state:z.literal('unavailable'),reason:RealmPassportUnavailableReasonSchema,data:z.null()}).strict();
function response<D extends z.ZodType>(data:D){return z.discriminatedUnion('state',[z.object({...envelope,state:z.literal('available'),data}).strict(),Unavailable]);}

/** One verified visit: the original actor's accepted departure and its actual
 * settled return. realmId is the visited route destination. Versions are copied
 * from the original route contract: a starter trip carries its route catalogue
 * version and no policy version; an advanced trip carries its advanced policy
 * version and no route catalogue version. A missing version is null, never a
 * substituted number. */
export const RealmPassportExpeditionRowSchema=z.object({kind:RealmPassportExpeditionKindSchema,expeditionId:Uuid,returnId:Uuid,originalBaseId:Uuid,realmId:z.enum(REALM_IDS),routeId:RouteId,
 routeVersion:Version.nullable(),policyVersion:Version.nullable(),departedAt:Timestamp,scheduledReturnAt:Timestamp,returnedAt:Timestamp}).strict().superRefine((r,ctx)=>{
 if(r.kind==='starter'?r.routeVersion===null||r.policyVersion!==null:r.routeVersion!==null||r.policyVersion===null)issue(ctx,'versions differ from the original route contract');
 if(!(Date.parse(r.departedAt)<Date.parse(r.scheduledReturnAt)&&Date.parse(r.scheduledReturnAt)<=Date.parse(r.returnedAt)))issue(ctx,'return precedes its original departure or schedule');
});
export const RealmPassportExpeditionsResponseSchema=response(z.object({kind:RealmPassportExpeditionKindSchema,
 rows:z.array(RealmPassportExpeditionRowSchema).max(REALM_PASSPORT_PAGE_SIZE),nextCursor:Uuid.nullable()}).strict()).superRefine((v,ctx)=>{
 if(v.state!=='available')return;const {kind,rows,nextCursor}=v.data;
 if(rows.some(r=>r.kind!==kind)||!ascending(rows.map(r=>r.expeditionId),(a,b)=>typeof a==='string'&&typeof b==='string'&&a<b))issue(ctx,'rows must match the page kind and ascend by expeditionId');
 if(nextCursor!==null&&(rows.length!==REALM_PASSPORT_PAGE_SIZE||nextCursor!==rows[rows.length-1]!.expeditionId))issue(ctx,'nextCursor is the last displayed expeditionId of a full page only');
});

/** Exact audited publication header, this wallet's leaf and its public proof.
 * The leaf key is sequence; carried cumulative values are not new daily activity. */
const Leaf=z.object({wallet:Address,sequence:Positive,cumulativeKeepBaseUnits:Positive,cumulativeRenown:Amount,cumulativeDays:Amount}).strict();
const ProofEntry=z.object({hash:Hash,sumBaseUnits:Amount,isLeft:z.boolean()}).strict();
export const RealmPassportInclusionRowSchema=z.object({sequence:Positive,day:Positive,root:Hash,sourceHash:Hash,publicationSignature:Signature,publicationSlot:Count,
 genesisHash:Address,programId:Address,configAddress:Address,keepMint:Address,reserveOwner:Address,totalCumulativeBaseUnits:Positive,leaf:Leaf,proof:z.array(ProofEntry).max(16)}).strict().superRefine((r,ctx)=>{
 if(r.leaf.sequence!==r.sequence)issue(ctx,'leaf belongs to another publication');
 const keep=u64(r.leaf.cumulativeKeepBaseUnits),total=u64(r.totalCumulativeBaseUnits),renown=u64(r.leaf.cumulativeRenown),days=u64(r.leaf.cumulativeDays);
 if(keep===null||total===null||renown===null||days===null)return;
 if(keep>total||renown>days)issue(ctx,'inconsistent leaf');
});
export const RealmPassportInclusionsResponseSchema=response(z.object({rows:z.array(RealmPassportInclusionRowSchema).max(REALM_PASSPORT_PAGE_SIZE),nextCursor:Positive.nullable()}).strict()).superRefine((v,ctx)=>{
 if(v.state!=='available')return;const {rows,nextCursor}=v.data,first=rows[0];
 if(rows.some(r=>r.leaf.wallet!==v.wallet)||!ascending(rows.map(r=>u64(r.sequence)),(a,b)=>typeof a==='bigint'&&typeof b==='bigint'&&a<b))issue(ctx,'rows must belong to the authenticated wallet and ascend by sequence');
 if(first&&rows.some(r=>r.genesisHash!==first.genesisHash||r.programId!==first.programId||r.configAddress!==first.configAddress))issue(ctx,'rows must share one configured source identity');
 if(nextCursor!==null&&(rows.length!==REALM_PASSPORT_PAGE_SIZE||nextCursor!==rows[rows.length-1]!.sequence))issue(ctx,'nextCursor is the last displayed sequence of a full page only');
});

/** Published cumulative participation (the current audited leaf) is shown apart
 * from the already attested chain record; a missing verified record is null. */
export const RealmPassportCurrentResponseSchema=response(z.object({observedSlot:Count,chainUnixTimestamp:Amount,publicationSequence:Positive,
 published:z.object({cumulativeRenown:Amount,cumulativeDays:Amount}).strict(),
 attested:z.object({renownTotal:Amount,daysAttested:Amount,lastSequence:Amount}).strict().nullable()}).strict()).superRefine((v,ctx)=>{
 if(v.state!=='available')return;const d=v.data,renown=u64(d.published.cumulativeRenown),days=u64(d.published.cumulativeDays),sequence=u64(d.publicationSequence);
 if(renown===null||days===null||sequence===null)return;
 if(renown>days)issue(ctx,'published renown exceeds published days');
 if(!d.attested)return;const total=u64(d.attested.renownTotal),attestedDays=u64(d.attested.daysAttested),last=u64(d.attested.lastSequence);
 if(total===null||attestedDays===null||last===null)return;
 if(total>renown||attestedDays>days||last>sequence)issue(ctx,'attested record exceeds the published cumulative leaf');
});

export type RealmPassportExpeditionKind=z.infer<typeof RealmPassportExpeditionKindSchema>;
export type RealmPassportUnavailableReason=z.infer<typeof RealmPassportUnavailableReasonSchema>;
export type RealmPassportExpeditionsQuery=z.infer<typeof RealmPassportExpeditionsQuerySchema>;
export type RealmPassportInclusionsQuery=z.infer<typeof RealmPassportInclusionsQuerySchema>;
export type RealmPassportExpeditionRow=z.infer<typeof RealmPassportExpeditionRowSchema>;
export type RealmPassportInclusionRow=z.infer<typeof RealmPassportInclusionRowSchema>;
export type RealmPassportExpeditionsResponse=z.infer<typeof RealmPassportExpeditionsResponseSchema>;
export type RealmPassportInclusionsResponse=z.infer<typeof RealmPassportInclusionsResponseSchema>;
export type RealmPassportCurrentResponse=z.infer<typeof RealmPassportCurrentResponseSchema>;
