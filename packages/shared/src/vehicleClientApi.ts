/** D182 redacted original consent and bounded discovery. None of these parsed
 * records is signing, custody, broadcast, mint or finality authority. */
import {z} from 'zod';
import {PHASE_E_VEHICLE_CLIENT,PHASE_E_VEHICLES,PHASE_E_ADVANCED_EXPEDITIONS,PHASE_E_ORDINARY_ROUTES} from './constants';
import {PhaseEVehicleMintIdentitySchema,PhaseEVehicleFamilySchema,PhaseEVehicleTierSchema} from './phaseEVehicles';
import {VehicleServiceEnvelopeSchema,VehicleServiceRequestSchema,VehicleServicePreparationSchema,VehicleServiceSignedSchema,VehicleServiceSignedRequestSchema} from './vehicleServiceApi';
import {AdvancedExpeditionPreviewSchema,AdvancedExpeditionRouteIdSchema} from './phaseEAdvancedExpeditions';
const Address=PhaseEVehicleMintIdentitySchema.shape.assetId,Uuid=z.uuid().regex(/^[0-9a-f-]+$/),V4=Uuid.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const Hash=z.string().regex(/^[0-9a-f]{64}$/),Key=z.string().min(1).max(128),Integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const JournalTimestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.slice(0,23)+'Z');
const U64=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<1n<<64n),Signature=VehicleServiceSignedSchema.shape.signature;
const Cursor=z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).refine(v=>{const n=v.length%4,last='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(v.at(-1)!);return n!==1&&(n===0||n===2&&(last&15)===0||n===3&&(last&3)===0);}),policy=PHASE_E_VEHICLE_CLIENT;
export const VehicleInstallationRequestSchema=z.object({baseId:Uuid,berthId:Uuid,assetId:Address,idempotencyKey:Key}).strict();
export type VehicleInstallationRequest=z.infer<typeof VehicleInstallationRequestSchema>;
export const VehicleInstallationReservationSchema=z.object({reservationId:V4,wallet:Address,request:VehicleInstallationRequestSchema,identity:PhaseEVehicleMintIdentitySchema,completedBuildJobId:Uuid,berthCompletedAt:JournalTimestamp,reservedAt:JournalTimestamp}).strict().refine(v=>v.request.assetId===v.identity.assetId,'Asset differs from original request');
export type VehicleInstallationReservation=z.infer<typeof VehicleInstallationReservationSchema>;
export const VehicleInstallationPreparationSchema=VehicleServicePreparationSchema.omit({serviceSha256:true});
export type VehicleInstallationPreparation=z.infer<typeof VehicleInstallationPreparationSchema>;
export const VehicleInstallationSignedSchema=VehicleServiceSignedSchema;
export type VehicleInstallationSigned=z.infer<typeof VehicleInstallationSignedSchema>;
export const VehicleInstallationSignedRequestSchema=VehicleServiceSignedRequestSchema;
export const VehicleInstallationResultSchema=z.object({installationId:V4,baseId:Uuid,berthId:Uuid,assetId:Address,family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,installedWallet:Address,installedAt:JournalTimestamp,signature:Signature}).strict();
export type VehicleInstallationResult=z.infer<typeof VehicleInstallationResultSchema>;
const common={version:z.literal(1),purpose:z.literal('vehicle_installation'),wallet:Address,idempotencyKey:Key,serverNow:Timestamp,reservation:VehicleInstallationReservationSchema,signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false),installationAuthorized:z.literal(false)};
export const VehicleInstallationEnvelopeSchema=z.discriminatedUnion('status',[
 z.object({...common,status:z.literal('reserved'),preparation:z.null(),signed:z.null(),installation:z.null()}).strict(),
 z.object({...common,status:z.literal('prepared'),preparation:VehicleInstallationPreparationSchema,signed:z.null(),installation:z.null()}).strict(),
 z.object({...common,status:z.literal('signed'),preparation:VehicleInstallationPreparationSchema,signed:VehicleInstallationSignedSchema,installation:z.null()}).strict(),
 z.object({...common,status:z.literal('installed'),preparation:VehicleInstallationPreparationSchema,signed:VehicleInstallationSignedSchema.nullable(),installation:VehicleInstallationResultSchema}).strict(),
]).superRefine((v,c)=>{const bad=(message:string)=>c.addIssue({code:'custom',message}),r=v.reservation,i=v.installation;
 if(v.wallet!==r.wallet||v.idempotencyKey!==r.request.idempotencyKey)bad('Original actor or key changed');
 if(v.signed&&v.signed.messageSha256!==v.preparation.messageSha256)bad('Signed message changed');
 if(i&&(i.installationId!==r.reservationId||i.baseId!==r.request.baseId||i.berthId!==r.request.berthId||i.assetId!==r.identity.assetId||i.family!==r.identity.family||i.tier!==r.identity.tier||i.installedWallet!==r.wallet||v.signed&&i.signature!==v.signed.signature))bad('Installation differs from original reservation');
});
export type VehicleInstallationEnvelope=z.infer<typeof VehicleInstallationEnvelopeSchema>;
export const VehicleReferenceSchema=z.object({kind:z.enum(['installation','service']),id:V4}).strict();
export type VehicleReference=z.infer<typeof VehicleReferenceSchema>;
export const VehicleConsentSourceSchema=z.object({genesisHash:Address,anchorSlot:Integer,reviewedDeploymentSlot:Integer,reviewedProgramDataSha256:Hash}).strict().refine(v=>v.anchorSlot>=v.reviewedDeploymentSlot);
export type VehicleConsentSource=z.infer<typeof VehicleConsentSourceSchema>;
export const VehicleBurnReceiptSchema=z.object({signature:Signature,messageSha256:Hash,wireSha256:Hash,slot:Integer,finalizedThroughSlot:Integer,feeLamports:U64,assetRefundLamports:U64}).strict().refine(v=>v.finalizedThroughSlot>=v.slot);
export type VehicleBurnReceipt=z.infer<typeof VehicleBurnReceiptSchema>;
const wrapper={version:z.literal(1),consentSource:VehicleConsentSourceSchema.nullable(),burnReceipt:VehicleBurnReceiptSchema.nullable()};
export const VehicleClientSchema=z.discriminatedUnion('kind',[
 z.object({...wrapper,kind:z.literal('installation'),record:VehicleInstallationEnvelopeSchema}).strict(),
 z.object({...wrapper,kind:z.literal('service'),record:VehicleServiceEnvelopeSchema}).strict(),
]).superRefine((v,c)=>{const bad=(message:string)=>c.addIssue({code:'custom',message}),p=v.record.preparation,b=v.burnReceipt,s=v.record.signed,terminal=v.kind==='installation'?v.record.installation:v.record.application;
 if(v.kind==='service'&&!V4.safeParse(v.record.intent.intentId).success)bad('Intent ID must be canonical UUIDv4');
 if(p&&v.consentSource&&p.blockhashContextSlot<v.consentSource.anchorSlot)bad('Preparation predates its original owner capture');
 if((p===null)!==(v.consentSource===null)||(terminal===null)!==(b===null))bad('Contradictory consent or terminal graph');
 if(b&&(!p||!terminal||!v.consentSource||b.messageSha256!==p.messageSha256||b.signature!==terminal.signature||b.slot<=v.consentSource.anchorSlot||s&&(b.signature!==s.signature||b.wireSha256!==s.wireSha256)))bad('Burn receipt differs from original consent');
});
export type VehicleClient=z.infer<typeof VehicleClientSchema>;
export function vehicleReference(v:VehicleClient):VehicleReference{return {kind:v.kind,id:v.kind==='installation'?v.record.reservation.reservationId:v.record.intent.intentId};}
export function vehicleActor(v:VehicleClient){return v.record.wallet;}
export function vehicleOriginalDestination(v:VehicleClient){const d=v.kind==='installation'?v.record.reservation.request:v.record.intent.state;return {baseId:d.baseId,berthId:d.berthId};}
export function matchVehicleClientRequest(raw:unknown,wallet:string,kind:VehicleReference['kind'],original:unknown):VehicleClient{const v=VehicleClientSchema.parse(raw),request=(kind==='installation'?VehicleInstallationRequestSchema:VehicleServiceRequestSchema).parse(original),saved=v.kind==='installation'?v.record.reservation.request:v.record.intent.request;if(v.kind!==kind||v.record.wallet!==Address.parse(wallet)||JSON.stringify(saved)!==JSON.stringify(request))throw Error('Vehicle history differs from original actor or request');return v;}
const flags={signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false)};
const reasons=['NOT_PREPARED','TERMINAL','PAUSED','PROVIDER_UNAVAILABLE','IDENTITY','OWNERSHIP','EXPIRED_UNRESOLVED','INSUFFICIENT_SOL','FEE_LIMIT','OBSERVED_TRANSACTION','TIMEOUT','BUSY'] as const;
const Observation=z.object({genesisHash:Address,core:z.object({reviewedDeploymentSlot:Integer,reviewedProgramDataSha256:Hash,upgradeAuthority:Address.nullable()}).strict(),ownerWallet:Address,ownerSlot:Integer,feeSlot:Integer,balanceSlot:Integer,validitySlot:Integer,closingSlot:Integer,blockhash:Address,lastValidBlockHeight:Integer,currentBlockHeight:Integer,blockhashValid:z.literal(true),networkFeeLamports:U64,payerLamports:U64}).strict().refine(v=>v.ownerSlot>=v.core.reviewedDeploymentSlot&&v.ownerSlot<=v.feeSlot&&v.feeSlot<=v.balanceSlot&&v.balanceSlot<=v.validitySlot&&v.validitySlot<=v.closingSlot&&v.currentBlockHeight<=v.lastValidBlockHeight&&BigInt(v.networkFeeLamports)<=BigInt(policy.maxNetworkFeeLamports)&&BigInt(v.payerLamports)>=BigInt(v.networkFeeLamports));
const review={version:z.literal(1),reference:VehicleReferenceSchema,wallet:Address,reviewedAt:Timestamp,expiresAt:Timestamp,...flags};
export const VehicleReviewSchema=z.discriminatedUnion('status',[
 z.object({...review,status:z.literal('ready'),reason:z.null(),messageSha256:Hash,observation:Observation}).strict(),
 z.object({...review,status:z.literal('held'),reason:z.enum(reasons),messageSha256:Hash.nullable(),observation:z.null()}).strict(),
]).refine(v=>Date.parse(v.expiresAt)-Date.parse(v.reviewedAt)===policy.reviewMaxAgeMs&&(v.status==='held'||v.observation.ownerWallet===v.wallet));
export type VehicleReview=z.infer<typeof VehicleReviewSchema>;
export const VehicleDeliverySchema=z.object({version:z.literal(1),reference:VehicleReferenceSchema,status:z.enum(['held','terminal','observed','submitted']),reason:z.enum(['NOT_SIGNED','PAUSED','PROVIDER_UNAVAILABLE','IDENTITY','OWNERSHIP','EXPIRED_UNRESOLVED','INSUFFICIENT_SOL','FEE_LIMIT','OBSERVED_TRANSACTION','SEND_UNCERTAIN','TIMEOUT','BUSY']).nullable(),signature:Signature.nullable(),client:VehicleClientSchema,broadcastAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false)}).strict().refine(v=>{const r=vehicleReference(v.client),signature=v.client.burnReceipt?.signature??v.client.record.signed?.signature??null;return r.id===v.reference.id&&r.kind===v.reference.kind&&v.signature===signature&&(v.status==='held'?v.reason!==null:v.reason===null)&&(v.status==='terminal'?v.client.burnReceipt!==null:v.status==='submitted'||v.status==='observed'?signature!==null:true);});
export type VehicleDelivery=z.infer<typeof VehicleDeliverySchema>;
const activity={id:V4,idempotencyKey:Key,baseId:Uuid,createdAt:JournalTimestamp};
export const VehicleActivityItemSchema=z.discriminatedUnion('kind',[
 z.object({...activity,kind:z.literal('installation'),status:z.enum(['reserved','prepared','signed','installed'])}).strict(),
 z.object({...activity,kind:z.literal('service'),status:z.enum(['reserved','prepared','signed','applied'])}).strict(),
 z.object({kind:z.literal('expedition'),id:Uuid,idempotencyKey:Uuid,baseId:Uuid,createdAt:Timestamp,status:z.enum(['accepted','returned'])}).strict(),
]).refine(v=>v.kind!=='expedition'||v.id===v.idempotencyKey);
export type VehicleActivityItem=z.infer<typeof VehicleActivityItemSchema>;
export const VehicleActivityPageSchema=z.object({version:z.literal(1),wallet:Address,items:z.array(VehicleActivityItemSchema).max(policy.discoveryPageSize),nextCursor:Cursor.nullable()}).strict().refine(v=>new Set(v.items.map(i=>i.kind+':'+i.id)).size===v.items.length);
export type VehicleActivityPage=z.infer<typeof VehicleActivityPageSchema>;
export const VehicleAssetPageSchema=z.object({version:z.literal(1),wallet:Address,provenance:z.literal('owner-attested-registry'),items:z.array(z.object({identity:PhaseEVehicleMintIdentitySchema,observedSlot:Integer}).strict()).max(policy.discoveryPageSize),nextCursor:Cursor.nullable()}).strict().refine(v=>new Set(v.items.map(i=>i.identity.assetId)).size===v.items.length);
export type VehicleAssetPage=z.infer<typeof VehicleAssetPageSchema>;
export const VehicleAssetPageV2Schema=z.object({version:z.literal(2),wallet:Address,items:z.array(z.object({identity:PhaseEVehicleMintIdentitySchema,observedSlot:Integer,provenance:z.discriminatedUnion('kind',[z.object({kind:z.literal('owner_attested')}).strict(),z.object({kind:z.literal('finalized_issuance'),rootId:z.string().regex(/^[0-9a-f]{32}$/)}).strict()])}).strict()).max(policy.discoveryPageSize),nextCursor:Cursor.nullable()}).strict().refine(v=>new Set(v.items.map(i=>i.identity.assetId)).size===v.items.length);
export type VehicleAssetPageV2=z.infer<typeof VehicleAssetPageV2Schema>;
export const VehicleRoutePolicyVersionSchema=z.union([z.literal(PHASE_E_ADVANCED_EXPEDITIONS.v1.policyVersion),z.literal(PHASE_E_ORDINARY_ROUTES.policyVersion)]);
export const VehicleRoutesSchema=z.object({version:z.literal(1),wallet:Address,baseId:Uuid,items:z.array(z.object({installationId:Uuid,previews:z.array(AdvancedExpeditionPreviewSchema).max(AdvancedExpeditionRouteIdSchema.options.length)}).strict()).max(PHASE_E_VEHICLES.advancedFamilyCount)}).strict().refine(v=>new Set(v.items.map(i=>i.installationId)).size===v.items.length&&v.items.every(i=>new Set(i.previews.map(p=>p.routeId)).size===i.previews.length&&new Set(i.previews.map(p=>p.family+':'+p.tier)).size<=1)&&new Set(v.items.flatMap(i=>i.previews.map(p=>p.policyVersion+':'+p.homeRealmId))).size<=1);
export type VehicleRoutes=z.infer<typeof VehicleRoutesSchema>;
export const VehicleCollectResultSchema=z.object({baseId:Uuid,serverNow:Timestamp,returned:Integer}).strict();
export type VehicleCollectResult=z.infer<typeof VehicleCollectResultSchema>;

export const VehicleWireSchema=VehicleServiceSignedSchema.omit({acceptedAt:true}).extend({signedTransactionHex:z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/)}).strict();
export type VehicleWire=z.infer<typeof VehicleWireSchema>;
