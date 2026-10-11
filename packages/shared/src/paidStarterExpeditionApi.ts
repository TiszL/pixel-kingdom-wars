import {EquipmentFittingQueryFields,equipmentFittingQuery} from './phaseEOrdinaryEquipment';
/** Selected paid-route display only. A preview never grants departure authority. */
import {z} from 'zod';
import {REALM_IDS} from './baseVisual';
import {PaidStarterRoutePreviewSchema} from './paidStarterExpeditions';
import {RealmSaleCoverageQuerySchema} from './realmSaleOfferApi';
const Base=z.uuid().regex(/^[0-9a-f-]+$/),Instant=z.string().length(24).refine(v=>v.length===24&&Number.isSafeInteger(Date.parse(v))&&Date.parse(v)>=0&&new Date(v).toISOString()===v);
const Seconds=z.string().max(19).refine(v=>/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<(1n<<63n));
export const PaidStarterExpeditionQuerySchema=RealmSaleCoverageQuerySchema.extend({baseId:Base,...EquipmentFittingQueryFields}).strict().refine(v=>{try{equipmentFittingQuery(v);return true;}catch{return false;}},'Invalid equipment selection');
export const PaidStarterExpeditionViewSchema=z.object({wallet:z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),baseId:Base,
 realm:z.number().int().min(0).max(REALM_IDS.length-1),serverNow:Instant,authorization:z.literal('none'),acceptingDepartures:z.boolean(),route:PaidStarterRoutePreviewSchema,
 coverage:z.discriminatedUnion('status',[
  z.object({status:z.literal('covered'),expiresAt:Seconds,observedAt:Instant}).strict(),
  z.object({status:z.literal('blocked'),reason:z.enum(['NO_COVERAGE','EXPIRED'])}).strict(),
  z.object({status:z.literal('unavailable')}).strict(),
 ]),
}).strict().refine(v=>v.route.realmId===REALM_IDS[v.realm]&&(v.coverage.status!=='covered'||Instant.safeParse(v.serverNow).success&&Instant.safeParse(v.coverage.observedAt).success&&Seconds.safeParse(v.coverage.expiresAt).success
 &&BigInt(v.coverage.expiresAt)*1000n>BigInt(Date.parse(v.serverNow))&&Date.parse(v.coverage.observedAt)<=Date.parse(v.serverNow)), 'Selected paid preview differs from its destination or observation time');
export type PaidStarterExpeditionView=z.infer<typeof PaidStarterExpeditionViewSchema>;
