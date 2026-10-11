import {EquipmentSecondaryOutputSchema,EquipmentFittingSnapshotSchema,equipmentFittingMatches,applyEquipmentFitting,fittingSelection} from './phaseEOrdinaryEquipment';
/** Paid starter preview and historical observation consistency only. Current
 * finalized coverage, canonical PDAs and admission remain server authority.
 * No historical receipt or preview grants a new departure. Subpath only. */
import {z} from 'zod';
import {REALM_IDS} from './baseVisual';
import {PHASE_E_PAID_STARTER_ROUTES as C} from './constants';
import {PHASE_E_RAW_RESOURCE_IDS,PHASE_E_RAW_RESOURCES,PhaseERawResourceIdSchema} from './phaseEResources';
import {splitResourceEarnings} from './phaseEResourceTax';
const U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111',CLOCK='SysvarC1ock11111111111111111111111111111111',SYSVAR='Sysvar1111111111111111111111111111111111111';
function unsigned(v:string,max=U64){return v.length<=20&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=max;}
const Amount=z.string().max(20).refine(v=>unsigned(v)),Seconds=Amount.refine(v=>unsigned(v,I64));
const Address=z.string().min(32).max(44).refine(v=>v.length>=32&&v.length<=44&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(v));
const Hash=z.string().length(64).refine(v=>v.length===64&&/^[a-f0-9]{64}$/.test(v)),Count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Instant=z.string().length(24).refine(v=>v.length===24&&Number.isSafeInteger(Date.parse(v))&&Date.parse(v)>=0&&new Date(v).toISOString()===v);
const Account=z.object({address:Address,exists:z.literal(true),owner:Address,executable:z.boolean(),dataSha256:Hash}).strict();
// Refuse cardinality before Zod visits array children, including hostile getters.
const Accounts=z.preprocess(v=>Array.isArray(v)&&v.length===5?v:null,z.array(Account).length(5));
export const ExpeditionRealmAccessObservationSchema=z.object({version:z.literal(1),wallet:Address.refine(v=>v!=='1'.repeat(32)),realm:Count.max(REALM_IDS.length-1),accessAddress:Address,configAddress:Address,expiresAt:Seconds,
 finality:z.object({commitment:z.literal('finalized'),contextSlot:Amount,observedAt:Instant,chainUnixTimestamp:Seconds}).strict(),
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:Address,programId:Address,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:Hash,upgradeAuthority:Address.nullable(),accounts:Accounts}).strict(),
}).strict().superRefine((v,ctx)=>{
 const {source:s,finality:f}=v,a=s.accounts;
 if(!unsigned(v.expiresAt,I64)||!unsigned(f.contextSlot)||!unsigned(f.chainUnixTimestamp,I64)||!Number.isSafeInteger(s.reviewedDeploymentSlot))return;
 if(BigInt(v.expiresAt)<=0n||BigInt(f.chainUnixTimestamp)<=0n||BigInt(f.contextSlot)<BigInt(s.reviewedDeploymentSlot)
  ||new Set(a.map(row=>row.address)).size!==5||a.some((row,i)=>row.owner!==(i<2?LOADER:i===4?SYSVAR:s.programId)||row.executable!==(i===0))
  ||a[0]!.address!==s.programId||a[1]!.dataSha256!==s.reviewedProgramDataSha256||a[2]!.address!==v.configAddress||a[3]!.address!==v.accessAddress||a[4]!.address!==CLOCK)
  ctx.addIssue({code:'custom',message:'Paid access observation differs from its source accounts'});
});
export type ExpeditionRealmAccessObservation=z.infer<typeof ExpeditionRealmAccessObservationSchema>;
export type PaidStarterRouteId=keyof typeof C.routes;
export const PaidStarterRouteIdSchema=z.enum(Object.keys(C.routes) as [PaidStarterRouteId,...PaidStarterRouteId[]]);
/** Review economics only: selecting a destination does not supply coverage. */
export function paidStarterRoutePreview(routeId:PaidStarterRouteId){
 const id=PaidStarterRouteIdSchema.parse(routeId),realmId=C.routes[id],resourceId=PHASE_E_RAW_RESOURCE_IDS.find(id=>PHASE_E_RAW_RESOURCES[id].realmId===realmId);
 if(!resourceId)throw new Error('Paid realm has no accepted raw resource');const gross=BigInt(C.grossRaw),split=splitResourceEarnings(gross,0n);
 if(split.nextCarry!==0n)throw new Error('Paid starter route requires exact whole-resource tax');
 return {routeCatalogueVersion:C.routeCatalogueVersion,rewardTableVersion:C.rewardTableVersion,routeId:id,realmId,resourceId,vehicleFamily:'starter' as const,
  durationSec:C.durationSec,grossQuantity:gross.toString(),islandPoolQuantity:split.tax.toString(),netQuantity:split.net.toString(),access:{kind:'paid_realm' as const,policyVersion:C.accessPolicyVersion}};
}
const Quantity=z.string().max(19).refine(v=>unsigned(v,I64)),PositiveQuantity=Quantity.refine(v=>v!=='0');
const RouteFields=z.object({routeCatalogueVersion:z.literal(C.routeCatalogueVersion),rewardTableVersion:z.literal(C.rewardTableVersion),routeId:PaidStarterRouteIdSchema,
 realmId:z.enum(REALM_IDS),resourceId:PhaseERawResourceIdSchema,vehicleFamily:z.literal('starter'),durationSec:Count.min(1),grossQuantity:PositiveQuantity,netQuantity:Quantity,islandPoolQuantity:Quantity}).strict();
const Access=z.object({kind:z.literal('paid_realm'),policyVersion:z.literal(C.accessPolicyVersion)}).strict();
export const PaidStarterRoutePreviewSchema=RouteFields.extend({access:Access,fitting:EquipmentFittingSnapshotSchema.optional(),secondaryOutput:EquipmentSecondaryOutputSchema.optional()}).strict().refine(v=>{
 let expected;try{expected=applyEquipmentFitting(paidStarterRoutePreview(v.routeId),fittingSelection(v).fitting);}catch{return false;}return JSON.stringify(v.fitting)===JSON.stringify(expected.fitting)&&JSON.stringify(v.secondaryOutput)===JSON.stringify(expected.secondaryOutput)&& v.realmId===expected.realmId&&v.resourceId===expected.resourceId&&v.durationSec===expected.durationSec
  &&v.grossQuantity===expected.grossQuantity&&v.netQuantity===expected.netQuantity&&v.islandPoolQuantity===expected.islandPoolQuantity;
},'Paid preview differs from current coastal survey policy');
/** Frozen v3/reward2 historical format; never re-evaluate current reward amounts. */
export const PaidStarterExpeditionRouteSnapshotSchema=RouteFields.extend({fitting:EquipmentFittingSnapshotSchema.optional(),secondaryOutput:EquipmentSecondaryOutputSchema.optional(),access:Access.extend({observation:ExpeditionRealmAccessObservationSchema}).strict()}).strict().refine(equipmentFittingMatches).superRefine((v,ctx)=>{
 if(v.realmId!==C.routes[v.routeId]||PHASE_E_RAW_RESOURCES[v.resourceId].realmId!==v.realmId||REALM_IDS[v.access.observation.realm]!==v.realmId)
  ctx.addIssue({code:'custom',message:'Paid route differs from its covered destination'});
 if([v.grossQuantity,v.netQuantity,v.islandPoolQuantity].every(n=>unsigned(n,I64))&&BigInt(v.grossQuantity)!==BigInt(v.netQuantity)+BigInt(v.islandPoolQuantity))
  ctx.addIssue({code:'custom',message:'Original paid route gross must equal net plus tax'});
});
export type PaidStarterExpeditionRouteSnapshot=z.infer<typeof PaidStarterExpeditionRouteSnapshotSchema>;
/** Call after historical route validation. A flight view may belong to a later
 * base custodian; only an original receipt supplies the buyer wallet argument.
 * This never checks today's clock, permit state, source, owner or age policy. */
export function paidStarterRouteAtDeparture(route:{routeId:string;access?:{kind:string;observation?:unknown}},departedAt:string,wallet?:string):boolean{
 if(route.access?.kind!=='paid_realm')return !route.routeId.startsWith('paid_');
 const parsed=PaidStarterExpeditionRouteSnapshotSchema.safeParse(route),time=Instant.safeParse(departedAt);if(!parsed.success||!time.success)return false;
 const o=parsed.data.access.observation,at=BigInt(Date.parse(time.data));
 return (wallet===undefined||o.wallet===wallet)&&Date.parse(o.finality.observedAt)<=Number(at)&&BigInt(o.finality.chainUnixTimestamp)*1000n<=at&&at<BigInt(o.expiresAt)*1000n;
}
