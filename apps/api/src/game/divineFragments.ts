/** D153.192 source-only fragment awards. HTTP cannot enroll, settle or supply a term. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PublicKey} from '@solana/web3.js';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_DIVINE_FRAGMENTS as P} from '@shardkeep/shared';
import {DIVINE_FRAGMENT_POLICY,divineFragmentWeekAt} from '@shardkeep/shared/divineFragments';
import {divineTrialCanonicalJson} from '@shardkeep/shared/divineTrials';
import {DivineTrialEventSchema} from '@shardkeep/shared/divineTrialsApi';
import {CharterTournamentEventSchema} from '@shardkeep/shared/charterTournamentApi';
import {DivineFragmentAwardSchema,DivineFragmentDeliveryRequestSchema,DivineFragmentDeliveryReceiptSchema,DivineFragmentDeliveryEnvelopeSchema,DivineFragmentEventViewSchema,DivineFragmentStockViewSchema,DivineFragmentAwardsPageSchema,DivineFragmentPageQuerySchema} from '@shardkeep/shared/divineFragmentsApi';
import type {Db,DbOrTx,DbTx} from '../db/client';
import {bases,players} from '../db/schema';
import {phaseECatalogEnabled,phaseEBuildingsEnabled,phaseEMiningEnabled,phaseESeekerEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireExactFinalizedOwnedBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {lockStablePrerequisiteBase,requireActiveStablePrerequisiteBase} from './stableBasePrerequisites';
import {pinHistoricalShardsTerm,readStoredExpeditionTerm} from './expeditionTermStore';
import {readDivineFragmentHistoricalTerm,type DivineFragmentTermSource} from './divineFragmentTermReader';
import {serializeHistoricalShardsTermCertificate,hashHistoricalShardsTermCertificate,parseHistoricalShardsTermCertificate} from '../mining/shardsTaxObstacleEvidence';

export const fragmentId=z.uuid().regex(/^[0-9a-f-]+$/).refine(v=>v!=='00000000-0000-0000-0000-000000000000');
export const fragmentWallet=z.string().refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
export function fragmentFail(code:string,status=409):never{throw new HttpError(status,'Original fragment operation unavailable',`DIVINE_FRAGMENT_${code}`);}
export async function assertFragmentSource(db:DbOrTx){await db.execute(sql`select public.shardkeep_divine_fragment_source()`);}
export interface FragmentDestinationOptions{readonly finalizedDeedReader?:FinalizedDeedReader|null;readonly deedCollection?:string|null;readonly clock?:()=>Date;}
export interface DivineFragmentOptions extends FragmentDestinationOptions{readonly domain:{genesisHash:string;economyProgram:string};readonly termSource:DivineFragmentTermSource|null;}
export function fragmentClock(options:FragmentDestinationOptions){return()=>{const d=new Date((options.clock??(()=>new Date()))().getTime());if(!Number.isSafeInteger(d.getTime()))throw Error('DIVINE_FRAGMENT_CLOCK');return d;};}
export async function fragmentOwnedBase(db:Db,wallet:string,baseId:string,options:FragmentDestinationOptions){
 fragmentWallet.parse(wallet);fragmentId.parse(baseId);const [base]=await db.select().from(bases).where(and(eq(bases.id,baseId),eq(bases.ownerWallet,wallet),eq(bases.status,'active')));
 if(!base)fragmentFail('BASE_NOT_OWNED',404);
 if(base.deedAssetId)await requireExactFinalizedOwnedBaseAuthority(db,wallet,baseId,options.finalizedDeedReader??null,options.deedCollection??null,fragmentClock(options)());
 else if(base.deedMintAssetId)fragmentFail('BASE_AUTHORITY',503);
}
export async function fragmentLockedBase(tx:DbTx,wallet:string,baseId:string,options:FragmentDestinationOptions){
 const [p]=await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update');if(!p)fragmentFail('OWNER',404);
 await lockStablePrerequisiteBase(tx,wallet,{baseId,assertAuthority:async(t,w,id)=>{await assertFreshLockedBaseAuthority(t,w,id,fragmentClock(options)());}});
}
export type DivineFragmentSourceKind='individual'|'clan';
export const fragmentTournamentDomain=z.object({genesisHash:fragmentWallet,economyProgram:fragmentWallet,craftProgram:fragmentWallet,treasury:fragmentWallet}).strict();
async function event(db:DbOrTx,id:string,requestedKind?:DivineFragmentSourceKind){
 fragmentId.parse(id);
 const [enrollment]=await db.execute<{source_kind:DivineFragmentSourceKind}>(sql`select source_kind from public.divine_fragment_enrollments where event_id=${id}::uuid`);
 const kind=requestedKind??enrollment?.source_kind??'individual';
 if(enrollment&&enrollment.source_kind!==kind)fragmentFail('SOURCE_KIND');
 const [row]=await db.execute<{source:{event:unknown;terminal:unknown;entries?:unknown}}>(sql`select public.divine_fragment_source_event(${id}::uuid,${kind}) source`);
 if(!row?.source?.event)fragmentFail('EVENT_NOT_FOUND',404);
 const source=row.source,parsed=(kind==='individual'?DivineTrialEventSchema:CharterTournamentEventSchema).parse({...source.event as object,terminal:source.terminal??null});
 const domain={genesisHash:parsed.domain.genesisHash,economyProgram:parsed.domain.economyProgram};
 let wallets:string[];
 if(kind==='individual')wallets=DivineTrialEventSchema.parse(parsed).terminal?.occupations.map(o=>o.wallet)??[];
 else{
  const entries=z.array(z.object({entryId:fragmentId,clanId:fragmentId,leader:fragmentWallet,roster:z.array(fragmentWallet).min(1).max(P.clanRosterCap).refine(r=>r.every((w,i)=>i===0||w>r[i-1]!)),lockId:fragmentId,lockTerminalId:fragmentId}).strict()).max(10_000).parse(source.entries);
  const terminal=CharterTournamentEventSchema.parse(parsed).terminal;
  wallets=(terminal?.occupations??[]).flatMap(o=>{const rows=entries.filter(e=>e.clanId===o.clanId);if(rows.length!==1)fragmentFail('ROSTER',503);return rows[0]!.roster;});
  if(new Set(wallets).size!==wallets.length)fragmentFail('ROSTER',503);
 }
 return {kind,event:source.event,terminal:source.terminal??null,parsed,domain,wallets,hash:createHash('sha256').update(divineTrialCanonicalJson(source)).digest('hex')};
}
/** Bounded complete immutable settlement read. A stored snapshot alone is not an issuer. */
export async function readFragmentSettlement(db:DbOrTx,eventId:string){
 await assertFragmentSource(db);fragmentId.parse(eventId);
 const [r]=await db.execute<{term_id:string;term_hash:string;certificate_json:string;certificate_hash:string;source_hash:string;record:{awards:unknown[]};earned_at:Date;settled_at:Date}>(sql`select s.*,n.earned_at from public.divine_fragment_settlements s join public.divine_fragment_enrollments n using(event_id) where s.event_id=${eventId}::uuid`);
 if(!r)return null;
 if(Buffer.byteLength(r.certificate_json)>256*1024||!Array.isArray(r.record.awards)||r.record.awards.length>Math.max(P.individualSites,P.clanSites*P.clanRosterCap))fragmentFail('SOURCE_BOUNDS',503);
 const original=await event(db,eventId),certificate=parseHistoricalShardsTermCertificate(JSON.parse(r.certificate_json));
 const term=await readStoredExpeditionTerm(db,r.term_id,r.term_hash);
 if(!term||!original.terminal||r.source_hash!==original.hash||serializeHistoricalShardsTermCertificate(certificate)!==r.certificate_json||hashHistoricalShardsTermCertificate(certificate)!==r.certificate_hash
  ||certificate.termHash!==r.term_hash||!isDeepStrictEqual(certificate.snapshot,term.snapshot)||certificate.snapshot.source.genesisHash!==original.parsed.domain.genesisHash
  ||new Date(r.earned_at).toISOString()!==original.parsed.playEndsAt||certificate.completedAt>original.parsed.playEndsAt||original.parsed.playEndsAt<term.snapshot.startsAt||original.parsed.playEndsAt>=term.snapshot.endsAt)fragmentFail('SOURCE',503);
 const awards=r.record.awards.map(a=>DivineFragmentAwardSchema.parse(a));
 const rows=await db.execute<{record:unknown}>(sql`select record from public.divine_fragment_awards where event_id=${eventId}::uuid order by wallet collate "C"`);
 if(!isDeepStrictEqual(rows.map(a=>a.record),awards)||awards.some(a=>a.eventId!==eventId||a.sourceHash!==original.hash||a.termId!==r.term_id||a.termHash!==r.term_hash||!isDeepStrictEqual(a.domain,original.domain)))fragmentFail('SOURCE',503);
 return {record:r.record,awards,term,certificate};
}
export async function readFragmentDelivery(db:DbOrTx,wallet:string,id:string){
 fragmentWallet.parse(wallet);fragmentId.parse(id);await assertFragmentSource(db);
 const [r]=await db.execute<{record:unknown}>(sql`select record from public.divine_fragment_deliveries where id=${id}::uuid and wallet=${wallet}`);
 return r?DivineFragmentDeliveryReceiptSchema.parse(r.record):null;
}
export function createDivineFragments(db:Db,options:DivineFragmentOptions){return createDivineFragmentAccounting(db,options,'individual',options.domain);}
/** Saved wallet rights use their immutable original domain; no new earning source. */
export function createDivineFragmentHistory(db:Db,options:FragmentDestinationOptions={}){
 const service=createDivineFragmentAccounting(db,options,'individual',null);
 return Object.freeze({policy:service.policy,award:service.award,awards:service.awards,deliver:service.deliver,deliveryRead:service.deliveryRead,stock:service.stock});
}
/** Private server composition only: both actual sources use one enrollment,
 * settlement, carry, custody and original Seeker pool. HTTP never selects kind. */
export function createDivineFragmentAccounting(db:Db,options:DivineFragmentOptions|FragmentDestinationOptions,sourceKind:DivineFragmentSourceKind,sourceDomain:DivineFragmentOptions['domain']|z.infer<typeof fragmentTournamentDomain>|null){
 if('rollback'in db)throw Error('DIVINE_FRAGMENT_TOP_LEVEL');
 const domain='domain'in options?z.object({genesisHash:fragmentWallet,economyProgram:fragmentWallet}).strict().parse(options.domain):null,expectedSourceDomain=sourceKind==='clan'?fragmentTournamentDomain.parse(sourceDomain):domain,clock=fragmentClock(options);
 const termSource='termSource'in options?options.termSource:null;
 const enabled=()=>{if(!domain||!phaseECatalogEnabled()||!phaseEBuildingsEnabled()||!phaseEMiningEnabled()||!phaseESeekerEnabled()||!termSource)fragmentFail('DISABLED',503);};
 async function enroll(eventId:string){
  const original=await event(db,eventId,sourceKind);if(!isDeepStrictEqual(original.parsed.domain,expectedSourceDomain))fragmentFail('DOMAIN',503);
  await assertFragmentSource(db);const [prior]=await db.execute<{source_kind:DivineFragmentSourceKind}>(sql`select source_kind from public.divine_fragment_enrollments where event_id=${eventId}::uuid`);if(prior){if(prior.source_kind!==sourceKind)fragmentFail('SOURCE_KIND');return;}
  enabled();return db.transaction(async tx=>{
   await assertFragmentSource(tx);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('shardkeep:crystal_fragment:lineage',0))`);
   const [again]=await tx.execute<{source_kind:DivineFragmentSourceKind}>(sql`select source_kind from public.divine_fragment_enrollments where event_id=${eventId}::uuid`);if(again){if(again.source_kind!==sourceKind)fragmentFail('SOURCE_KIND');return;}
   enabled();const fresh=await event(tx,eventId,sourceKind),at=clock();if(!isDeepStrictEqual(fresh.event,original.event)||at.toISOString()>=fresh.parsed.entryStartsAt)fragmentFail('ENROLLMENT');
   const week=divineFragmentWeekAt(fresh.parsed.playEndsAt);
   await tx.execute(sql`insert into public.divine_fragment_periods(week_start,economic_lineage,policy) values(${week}::timestamptz,${P.economicLineage},${JSON.stringify(DIVINE_FRAGMENT_POLICY)}::jsonb) on conflict do nothing`);
   await tx.execute(sql`insert into public.divine_fragment_enrollments(event_id,week_start,domain,earned_at,enrolled_at,source_kind) values(${eventId}::uuid,${week}::timestamptz,${JSON.stringify(domain)}::jsonb,${fresh.parsed.playEndsAt}::timestamptz,${at.toISOString()}::timestamptz,${sourceKind})`);
  });
 }
 async function settle(eventId:string){
  const prior=await readFragmentSettlement(db,eventId);if(prior)return prior;
  enabled();const original=await event(db,eventId,sourceKind);if(!original.terminal||!isDeepStrictEqual(original.parsed.domain,expectedSourceDomain))fragmentFail('ORIGINAL_SOURCE',503);
  const [enrolled]=await db.execute(sql`select event_id from public.divine_fragment_enrollments where event_id=${eventId}::uuid`);if(!enrolled)fragmentFail('NOT_ENROLLED');
  const certificate=await readDivineFragmentHistoricalTerm(termSource!,original.parsed.playEndsAt,domain!.genesisHash);
  return db.transaction(async tx=>{
   await assertFragmentSource(tx);for(const wallet of [...original.wallets].sort())await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update');
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('shardkeep:crystal_fragment:lineage',0))`);
   const again=await readFragmentSettlement(tx,eventId);if(again)return again;
   enabled();const fresh=await event(tx,eventId,sourceKind);if(!isDeepStrictEqual(fresh,original))fragmentFail('ORIGINAL_SOURCE',503);
   await pinHistoricalShardsTerm(tx,{readHistoricalTerm:async()=>certificate});
   await tx.execute(sql`insert into public.divine_fragment_settlements(event_id,term_id,term_hash,certificate_json,certificate_hash,source_hash,record,settled_at) values(${eventId}::uuid,${certificate.snapshot.termId}::uuid,${certificate.termHash},${serializeHistoricalShardsTermCertificate(certificate)},${hashHistoricalShardsTermCertificate(certificate)},${original.hash},'{}',${clock().toISOString()}::timestamptz)`);
   return (await readFragmentSettlement(tx,eventId))!;
  });
 }
 async function award(wallet:string,eventId:string){
  fragmentWallet.parse(wallet);fragmentId.parse(eventId);await assertFragmentSource(db);
  const [enrolled]=await db.execute(sql`select event_id from public.divine_fragment_enrollments where event_id=${eventId}::uuid`),settled=await readFragmentSettlement(db,eventId);
  const mine=settled?.awards.find(a=>a.wallet===wallet)??null;
  const [delivery]=await db.execute<{record:unknown}>(sql`select record from public.divine_fragment_deliveries where event_id=${eventId}::uuid and wallet=${wallet}`);
  return DivineFragmentEventViewSchema.parse({version:P.version,wallet,eventId,enrolled:!!enrolled,settled:!!settled,award:mine,delivery:delivery?.record??null});
 }
 async function deliver(wallet:string,eventId:string,raw:unknown){
  fragmentWallet.parse(wallet);fragmentId.parse(eventId);const cmd=DivineFragmentDeliveryRequestSchema.parse(raw);
  const match=(r:NonNullable<Awaited<ReturnType<typeof readFragmentDelivery>>>)=>{if(r.wallet!==wallet||r.eventId!==eventId||r.idempotencyKey!==cmd.idempotencyKey||r.baseId!==cmd.baseId)fragmentFail('IDEMPOTENCY_BODY_MISMATCH');return r;};
  const prior=await readFragmentDelivery(db,wallet,cmd.idempotencyKey);if(prior)return match(prior);
  const original=await award(wallet,eventId);if(!original.award)fragmentFail('AWARD_NOT_FOUND',404);if(original.delivery)return match(original.delivery);
  await fragmentOwnedBase(db,wallet,cmd.baseId,options);
  return db.transaction(async tx=>{
   await fragmentLockedBase(tx,wallet,cmd.baseId,options);const again=await readFragmentDelivery(tx,wallet,cmd.idempotencyKey);if(again)return match(again);
   const [existing]=await tx.execute<{record:unknown}>(sql`select record from public.divine_fragment_deliveries where event_id=${eventId}::uuid and wallet=${wallet}`);if(existing)return match(DivineFragmentDeliveryReceiptSchema.parse(existing.record));
   await tx.execute(sql`insert into public.divine_fragment_deliveries(id,event_id,wallet,base_id,quantity,record,delivered_at) values(${cmd.idempotencyKey}::uuid,${eventId}::uuid,${wallet},${cmd.baseId}::uuid,null,'{}',${clock().toISOString()}::timestamptz)`);
   return match((await readFragmentDelivery(tx,wallet,cmd.idempotencyKey))!);
  });
 }
 async function stock(wallet:string,baseId:string){
  await fragmentOwnedBase(db,wallet,baseId,options);await assertFragmentSource(db);await requireActiveStablePrerequisiteBase(db,wallet,baseId);
  const [r]=await db.execute<{available:string}>(sql`select s.available::text from public.bases b join public.base_slots slot on slot.base_id=b.id left join public.crystal_fragment_stocks s on s.base_id=b.id where b.id=${baseId}::uuid and b.owner_wallet=${wallet} and b.status='active' and slot.wallet=${wallet} and slot.active`);
  if(!r)fragmentFail('BASE_NOT_OWNED',404);return DivineFragmentStockViewSchema.parse({version:P.version,resourceId:P.resourceId,wallet,baseId,available:r.available??'0'});
 }
 async function awards(wallet:string,raw:unknown={}){
  fragmentWallet.parse(wallet);const {cursor}=DivineFragmentPageQuerySchema.parse(raw);await assertFragmentSource(db);
  const ids=await db.execute<{event_id:string}>(sql`select event_id from public.divine_fragment_awards where wallet=${wallet} ${cursor?sql`and event_id>${cursor}::uuid`:sql``} order by event_id limit ${P.pageSize+1}`),rows=[];
  for(const id of ids.slice(0,P.pageSize)){const v=await award(wallet,id.event_id);rows.push({award:v.award!,delivery:v.delivery});}
  return DivineFragmentAwardsPageSchema.parse({version:P.version,wallet,rows,nextCursor:ids.length>P.pageSize?rows.at(-1)!.award.eventId:null});
 }
 async function deliveryRead(wallet:string,id:string){return DivineFragmentDeliveryEnvelopeSchema.parse({version:P.version,wallet,idempotencyKey:id,receipt:await readFragmentDelivery(db,wallet,id)});}
 return Object.freeze({policy:()=>DIVINE_FRAGMENT_POLICY,enroll,settle,award,awards,deliver,deliveryRead,stock});
}
export type DivineFragmentProvider=Pick<ReturnType<typeof createDivineFragments>,'policy'|'award'|'awards'|'deliver'|'deliveryRead'|'stock'>;
