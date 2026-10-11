/** D153.180 bounded client DTOs. Parsing is not chain, signing or relay authority.
 * Subpath only; cryptographic reconstruction lives in the lazy client signer. */
import {z} from 'zod';
import {CLANS,PHASE_E_CHARTER_TRANSFER,PHASE_E_POLICY,PHASE_E_CHARTER_PREPARATION} from './constants';
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const Id=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const Hash=z.string().length(64).regex(/^[0-9a-f]+$/),Count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
const amount=(v:string,max=U64)=>v.length<=20&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<=max;
const Amount=z.string().min(1).max(20).refine(v=>amount(v));
const Time=Amount.refine(v=>amount(v,I64)),Positive=Amount.refine(v=>amount(v)&&v!=='0'),Revision=Count.max(0xffffffff);
const hex=(bytes:number)=>z.string().length(bytes*2).regex(/^[0-9a-f]+$/);
const boundedHex=(bytes:number)=>z.string().min(2).max(bytes*2).regex(/^(?:[0-9a-f]{2})+$/);
const Base64=z.string().min(88).max(1644).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine(v=>v.endsWith('==')?/[AQgw]/.test(v.at(-3)!):v.endsWith('=')?/[AEIMQUYcgkosw048]/.test(v.at(-2)!):true);
const Signature=Base64.length(88).regex(/^[A-Za-z0-9+/]{86}==$/);
const TxSignature=z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).refine(v=>v!=='1'.repeat(64));
const Timestamp=z.string().min(20).max(30).refine(v=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&Number.isFinite(Date.parse(v)));
const no=z.literal(false),empty=z.object({}).strict();
const issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
const array=<T extends z.ZodType>(schema:T,max:number)=>z.preprocess(v=>Array.isArray(v)&&v.length<=max?v:null,z.array(schema).max(max));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const Name=z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen).regex(/^[A-Za-z0-9 ._-]+$/).refine(v=>v.trim()===v);
const Tag=z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen).regex(/^[A-Z0-9]+$/),Mode=z.enum(['open','invite']);
const Uri=z.string().min(1).max(292).refine(v=>new TextEncoder().encode(v).length<=292&&v.startsWith('https://')&&(()=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}})());
const Metadata=z.object({name:Name,uri:Uri,hash:Hash}).strict();
const Domain=z.object({genesisHash:Address,economyProgram:Address,craftProgram:Address}).strict();
const SaleDomain=Domain.extend({treasury:Address}).strict();
const Chain=Domain.extend({config:Address,craftControl:Address,collection:Address,collectionAuthority:Address,charter:Address,asset:Address,assetBinding:Address,freezeAuthority:Address,executor:Address,creationReceipt:Address}).strict();
export const CharterCreationOriginalSchema=z.object({creationIntentId:Id,clanId:Id,payer:Address,metadata:Metadata,chain:Chain,admissionCommitment:Hash}).strict();
export const CharterSaleTermsSchema=z.object({version:z.literal(1),id:Id,clanId:Id,seller:Address,buyer:Address,priceLamports:Positive,sellerLeaves:z.boolean(),domain:SaleDomain,expectedRevision:Revision,epochId:Id,fenceId:Id,royaltyBps:z.literal(PHASE_E_CHARTER_TRANSFER.royaltyBps)}).strict();
export const CharterProgramPinSchema=z.object({programId:Address,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:Hash,upgradeAuthority:Address.nullable()}).strict();
export const CharterDeploymentSchema=z.object({expectedGenesisHash:Address,economy:CharterProgramPinSchema,craft:CharterProgramPinSchema,core:CharterProgramPinSchema,stateProvenance:z.literal('fresh-reviewed-deployment')}).strict();
const LookupPin=z.object({address:Address,dataSha256:Hash}).strict();
const PacketFields={version:z.literal(1),messageHex:boundedHex(1167),unsignedTransactionHex:boundedHex(1232),messageSha256:Hash,packetBytes:Count.min(66).max(1232),nativeInstructionIndex:z.literal(1),signingAuthorized:no,relayAuthorized:no};
const CreationPacket=z.object({...PacketFields,mintAuthorized:no}).strict(),SalePacket=z.object(PacketFields).strict();
const Allocation=z.object({kind:z.string().min(1).max(20),address:Address,bytes:Count.min(1).max(1232),minimumBalanceLamports:Amount}).strict();
const CreationCosts=z.object({allocations:array(Allocation,5).refine(v=>v.length===5),networkFeeLamports:Amount,rentLamports:Amount,coreCreateFeeLamports:Amount,totalLamports:Amount}).strict();
const SaleCostsFields={priceLamports:Positive,sellerLamports:Amount,royaltyLamports:Amount,networkFeeLamports:Amount,rentLamports:Amount,totalLamports:Amount};
const SaleCosts=z.object({...SaleCostsFields,allocations:array(Allocation,2).refine(v=>v.length===2)}).strict();
const SigningFields={version:z.literal(1),attemptId:Id,deployment:CharterDeploymentSchema,
 policy:z.object({signer:Address,candidateHex:hex(161),signatureHex:hex(64)}).strict(),
 lookupTable:z.object({address:Address,owner:Address,executable:no,dataHex:hex(56+12*32),slot:Count}).strict(),lookupPin:LookupPin,
 blockhash:Address,blockhashSlot:Count,lastValidBlockHeight:Count,observedSlot:Count,observedUnixTimestamp:Time,
 context:z.object({feeSlot:Count,closingSlot:Count,closingGenesisHash:Address}).strict(),signingAuthorized:no,relayAuthorized:no};
const CreationSigning=z.object({...SigningFields,kind:z.literal('creation'),original:CharterCreationOriginalSchema,packet:CreationPacket,costs:CreationCosts,
 coreCostProfile:z.object({version:z.literal(1),profile:z.literal('mpl-core-0.15.2-charter-pfd-seq-none'),reviewedProgramDataSha256:Hash}).strict(),
 costLimits:z.object({maxNetworkFeeLamports:Positive,maxRentLamports:Positive,maxTotalLamports:Positive}).strict()}).strict();
const SaleSigning=z.object({...SigningFields,kind:z.literal('sale'),original:z.object({creation:CharterCreationOriginalSchema,terms:CharterSaleTermsSchema,termsHash:Hash}).strict(),packet:SalePacket,costs:SaleCosts,
 costLimits:z.object({maxNetworkFeeLamports:Positive,maxRentLamports:Positive,maxAdditionalLamports:Positive}).strict()}).strict();
type Signing=z.infer<typeof CreationSigning>|z.infer<typeof SaleSigning>;
function checkSigning(v:Signing,ctx:z.RefinementCtx){
 const c=v.kind==='creation'?v.original:v.original.creation,slots=[v.observedSlot,v.lookupTable.slot,v.blockhashSlot,v.context.feeSlot,v.context.closingSlot];
 if(slots.some((slot,i)=>i>0&&slot<slots[i-1]!)||v.deployment.expectedGenesisHash!==c.chain.genesisHash||v.context.closingGenesisHash!==c.chain.genesisHash||v.deployment.economy.programId!==c.chain.economyProgram||v.deployment.craft.programId!==c.chain.craftProgram||v.lookupPin.address!==v.lookupTable.address)issue(ctx,'inconsistent signing domain or observation order');
 if([v.deployment.economy,v.deployment.craft,v.deployment.core].some(p=>p.reviewedDeploymentSlot>v.observedSlot))issue(ctx,'observation precedes deployment');
 const prefix=v.kind==='creation'?65:129;
 if(!v.packet.messageHex.startsWith('80')||v.packet.packetBytes!==prefix+v.packet.messageHex.length/2||v.packet.unsignedTransactionHex!==`${v.kind==='creation'?'01':'02'}${'00'.repeat(prefix-1)}${v.packet.messageHex}`)issue(ctx,'inconsistent canonical unsigned packet');
 const amounts=[v.costs.networkFeeLamports,v.costs.rentLamports,v.costs.totalLamports,...v.costs.allocations.map(a=>a.minimumBalanceLamports),...Object.values(v.costLimits),...(v.kind==='creation'?[v.costs.coreCreateFeeLamports]:[v.original.terms.priceLamports])];
 if(amounts.some(a=>!Amount.safeParse(a).success))return;
 const rent=v.costs.allocations.reduce((sum,a)=>sum+BigInt(a.minimumBalanceLamports),0n),fee=BigInt(v.costs.networkFeeLamports);
 if(rent!==BigInt(v.costs.rentLamports)||fee>BigInt(v.costLimits.maxNetworkFeeLamports)||rent>BigInt(v.costLimits.maxRentLamports)||new Set(v.costs.allocations.map(a=>a.address)).size!==v.costs.allocations.length)issue(ctx,'inconsistent quoted costs');
 if(v.kind==='creation'){
  if(v.coreCostProfile.reviewedProgramDataSha256!==v.deployment.core.reviewedProgramDataSha256||BigInt(v.costs.coreCreateFeeLamports)!==BigInt(PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports)||BigInt(v.costs.totalLamports)!==rent+fee+BigInt(v.costs.coreCreateFeeLamports)||BigInt(v.costs.totalLamports)>BigInt(v.costLimits.maxTotalLamports)||!same(v.costs.allocations.map(a=>a.kind),['charter','assetBinding','creationReceipt','permitReceipt','asset']))issue(ctx,'inconsistent creation cost profile');
 }else{
  const t=v.original.terms;if(t.clanId!==c.clanId||t.seller===t.buyer||[t.seller,t.buyer].includes(t.domain.treasury)||!same(t.domain,{genesisHash:c.chain.genesisHash,economyProgram:c.chain.economyProgram,craftProgram:c.chain.craftProgram,treasury:t.domain.treasury}))issue(ctx,'inconsistent original sale');
  if(![v.costs.priceLamports,v.costs.sellerLamports,v.costs.royaltyLamports].every(a=>Amount.safeParse(a).success))return;
  const price=BigInt(t.priceLamports),royalty=price*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints);
  if(v.costs.priceLamports!==t.priceLamports||BigInt(v.costs.royaltyLamports)!==royalty||BigInt(v.costs.sellerLamports)!==price-royalty||BigInt(v.costs.totalLamports)!==price+fee+rent||fee+rent>BigInt(v.costLimits.maxAdditionalLamports)||!same(v.costs.allocations.map(a=>a.kind),['transfer-receipt','permit-receipt']))issue(ctx,'inconsistent sale split or cost');
 }
}
export const CharterCreationSigningSchema=CreationSigning.superRefine(checkSigning);
export const CharterSaleSigningSchema=SaleSigning.superRefine(checkSigning);
export const CharterSigningSchema=z.union([CharterCreationSigningSchema,CharterSaleSigningSchema]);
export const CharterCreationRequestSchema=z.object({creationIntentId:Id,baseId:Id,name:Name,tag:Tag,inviteMode:Mode}).strict();
export const CharterSaleDraftSchema=z.object({clanId:Id,buyer:Address,priceLamports:Positive,sellerLeaves:z.boolean(),idempotencyKey:Id}).strict();
export const CharterSaleAcceptanceSchema=z.object({termsHash:Hash,buyerBaseId:Id}).strict();
export const CharterSignatureRequestSchema=z.object({attemptId:Id,messageSha256:Hash,signature:Signature}).strict();
export const CharterSignedRequestSchema=z.object({signedTransaction:Base64}).strict();
export const CharterRefundRequestSchema=z.object({destinationBaseId:Id.optional()}).strict();
export const CharterEmptyRequestSchema=empty;
const SignedFields={signature:TxSignature,wireSha256:Hash,messageSha256:Hash};
const CreationStatus=z.enum(['funded','admitted','issuing','prepared','signed','activated','cancelled_unpaid','refunded']);
const SaleStatus=z.enum(['draft','accepted','members_paid','issuing','prepared','signed','completed','cancelled']);
export const CharterCreationStateSchema=z.object({version:z.literal(1),wallet:Address,creationIntentId:Id,request:CharterCreationRequestSchema,status:CreationStatus,
 original:z.object({reservationId:Id,clanId:Id,baseId:Id,clan:z.object({name:Name,tag:Tag,inviteMode:Mode}).strict(),price:z.object({shards:Amount}).strict(),metadata:Metadata}).strict(),
 policy:z.object({permitId:hex(16),expiry:Time,signer:Address}).strict().nullable(),
 preparation:z.object({attemptId:Id,packet:CreationPacket,blockhash:Address,lastValidBlockHeight:Count,costs:z.object({networkFeeLamports:Amount,rentLamports:Amount,coreCreateFeeLamports:Amount,totalLamports:Amount}).strict()}).strict().nullable(),
 signed:z.object({...SignedFields,acceptedAt:Timestamp}).strict().nullable(),
 terminal:z.object({state:z.enum(['activated','cancelled_unpaid','refunded']),terminalId:Id,terminalTransactionId:Id.nullable(),refundTransactionId:Id.nullable(),refundDestinationBaseId:Id.nullable()}).strict().nullable(),
 signingAuthorized:no,relayAuthorized:no,reservationReleaseAuthorized:no,mintAuthorized:no,paymentAuthorized:no,activationAuthorized:no,refundAuthorized:no}).strict();
export const CharterSaleStateSchema=z.object({version:z.literal(1),id:Id,status:SaleStatus,
 original:z.object({clanId:Id,seller:Address,buyer:Address,priceLamports:Positive,sellerLeaves:z.boolean(),termsHash:Hash,expectedRevision:Revision}).strict(),
 acceptance:z.object({buyerBaseId:Id,acceptedAt:Timestamp}).strict().nullable(),memberPayment:z.object({id:Id,totalShards:Amount}).strict().nullable(),
 preparation:z.object({packet:SalePacket,costs:z.object(SaleCostsFields).strict()}).strict().nullable(),signed:z.object(SignedFields).strict().nullable(),
 terminal:z.object({id:Id,outcome:z.enum(['completed','cancelled'])}).strict().nullable(),signingAuthorized:no,relayAuthorized:no,transferAuthorized:no,fenceReleaseAuthorized:no}).strict();
export const CharterWireSchema=z.object({...SignedFields,signedTransaction:Base64}).strict();
export const CharterContributionSchema=CharterSignatureRequestSchema.extend({wallet:Address}).strict();
const CreationClient=z.object({version:z.literal(1),actor:Address,kind:z.literal('creation'),key:Id,state:CharterCreationStateSchema,signing:CharterCreationSigningSchema.nullable(),wire:CharterWireSchema.nullable(),contributions:array(CharterContributionSchema,0)}).strict();
const SaleClient=z.object({version:z.literal(1),actor:Address,kind:z.literal('sale'),key:Id,state:CharterSaleStateSchema,signing:CharterSaleSigningSchema.nullable(),wire:CharterWireSchema.nullable(),contributions:array(CharterContributionSchema,2)}).strict();
type Client=z.infer<typeof CreationClient>|z.infer<typeof SaleClient>;
function checkClient(v:Client,ctx:z.RefinementCtx){
 const s=v.state;
 if(v.kind==='creation'){
  const s=v.state;if(v.key!==s.creationIntentId||v.actor!==s.wallet||s.request.creationIntentId!==v.key||s.request.baseId!==s.original.baseId||s.request.name!==s.original.clan.name||s.request.tag!==s.original.clan.tag||s.request.inviteMode!==s.original.clan.inviteMode)issue(ctx,'creation identity differs');
  if(s.original.price.shards!==String(CLANS.createCostShards)||s.terminal&&s.status!==s.terminal.state||s.preparation&&!s.policy||s.preparation&&s.policy&&s.policy.signer!==v.signing?.policy.signer)issue(ctx,'creation cost or immutable backing differs');
  if(v.signing&&(v.signing.original.creationIntentId!==v.key||v.signing.original.clanId!==s.original.clanId||v.signing.original.payer!==v.actor||!same(v.signing.original.metadata,s.original.metadata)||v.signing.attemptId!==s.preparation?.attemptId))issue(ctx,'creation signing original differs');
 }else{
  const s=v.state;if(v.key!==s.id||![s.original.seller,s.original.buyer].includes(v.actor))issue(ctx,'sale identity differs');
  if(s.terminal&&s.status!==s.terminal.outcome||s.preparation&&(!s.acceptance||!s.memberPayment))issue(ctx,'sale terminal or paid backing differs');
  if(v.signing){const t=v.signing.original.terms,o=s.original;if(t.id!==v.key||t.clanId!==o.clanId||t.seller!==o.seller||t.buyer!==o.buyer||t.priceLamports!==o.priceLamports||t.sellerLeaves!==o.sellerLeaves||t.expectedRevision!==o.expectedRevision||v.signing.original.termsHash!==o.termsHash)issue(ctx,'sale signing original differs');}
  const wallets=[s.original.buyer,s.original.seller],indices=v.contributions.map(c=>wallets.indexOf(c.wallet));
  if(v.contributions.length===2&&!v.wire)issue(ctx,'complete contributions require the retained full wire');
  if(new Set(indices).size!==indices.length||indices.some((n,i)=>n<0||i>0&&n<=indices[i-1]!)||v.contributions.some(c=>c.attemptId!==v.signing?.attemptId||c.messageSha256!==v.signing.packet.messageSha256))issue(ctx,'contribution original or order differs');
 }
 if(!!v.signing!==!!s.preparation||v.signing&&s.preparation&&!same(v.signing.packet,s.preparation.packet)||!!v.wire!==!!s.signed||v.wire&&(!v.signing||v.wire.signature!==s.signed?.signature||v.wire.wireSha256!==s.signed?.wireSha256||v.wire.messageSha256!==s.signed?.messageSha256||v.wire.messageSha256!==v.signing.packet.messageSha256))issue(ctx,'prepared or signed backing differs');
}
export const CharterCreationClientSchema=CreationClient.superRefine(checkClient),CharterSaleClientSchema=SaleClient.superRefine(checkClient);
export const CharterClientSchema=z.union([CharterCreationClientSchema,CharterSaleClientSchema]);
export const CharterSaleByKeySchema=z.object({version:z.literal(1),actor:Address,idempotencyKey:Id,sale:CharterSaleClientSchema.nullable()}).strict().superRefine((v,c)=>{if(v.sale&&(v.sale.actor!==v.actor||v.sale.state.original.seller!==v.actor))issue(c,'seller lookup owner differs');});
export const CharterActivitySchema=z.object({version:z.literal(1),actor:Address,newActions:z.object({creation:z.boolean(),sale:z.boolean()}).strict(),items:array(z.object({kind:z.enum(['creation','sale']),key:Id,status:z.union([CreationStatus,SaleStatus]),clanId:Id,participantRole:z.enum(['creator','seller','buyer']),name:Name.nullable(),tag:Tag.nullable()}).strict(),20),nextCursor:z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).nullable()}).strict();
export const CharterDeliverySchema=z.object({version:z.literal(1),actor:Address,kind:z.enum(['creation','sale']),key:Id,status:z.enum(['submitted','observed','terminal','held']),signature:TxSignature.nullable(),reason:z.enum(['PAUSED','BUSY','NOT_SIGNED','SOURCE_CONFLICT','TRANSPORT_UNAVAILABLE','IDENTITY','OBSERVED_TRANSACTION','FINALIZED_ERROR_UNVERIFIED','EXPIRED_UNRESOLVED','ADMISSION_HELD','SEND_UNCERTAIN','TIMEOUT']).nullable(),original:CharterClientSchema}).strict().superRefine((v,c)=>{if(v.actor!==v.original.actor||v.kind!==v.original.kind||v.key!==v.original.key||v.signature!==null&&v.signature!==v.original.wire?.signature)issue(c,'delivery original differs');});
export type CharterCreationRequest=z.infer<typeof CharterCreationRequestSchema>;
export type CharterSaleDraft=z.infer<typeof CharterSaleDraftSchema>;
export type CharterSaleAcceptance=z.infer<typeof CharterSaleAcceptanceSchema>;
export type CharterSignatureRequest=z.infer<typeof CharterSignatureRequestSchema>;
export type CharterCreationSigning=z.infer<typeof CharterCreationSigningSchema>;
export type CharterSaleSigning=z.infer<typeof CharterSaleSigningSchema>;
export type CharterSigning=z.infer<typeof CharterSigningSchema>;
export type CharterCreationClient=z.infer<typeof CharterCreationClientSchema>;
export type CharterSaleClient=z.infer<typeof CharterSaleClientSchema>;
export type CharterClient=z.infer<typeof CharterClientSchema>;
export type CharterWire=z.infer<typeof CharterWireSchema>;
export type CharterContribution=z.infer<typeof CharterContributionSchema>;
export type CharterActivity=z.infer<typeof CharterActivitySchema>;
export type CharterDelivery=z.infer<typeof CharterDeliverySchema>;
