/** Dedicated composition bridge: actual native signing -> owner receipt verifier
 * -> same bank RealmAccess -> restricted gameplay dispatch/return. No listener. */
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import postgres from 'postgres';
import {Keypair,SYSVAR_CLOCK_PUBKEY,VersionedTransaction} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {z} from 'zod';
if(process.env['NODE_ENV']!=='test'||process.env['PHASE_E_NATIVE_PAIRED']!=='1')throw Error('Explicit native paired test mode required');
const url=new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL']??'');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname)||url.search||url.hash)throw Error('Disposable loopback fixture URL required');
const database=`phase_e_native_renewal_${randomUUID().replaceAll('-','').slice(0,12)}_test`;url.pathname=`/${database}`;
process.env['TEST_DATABASE_URL']=url.toString();
for(const flag of ['FREE_ONBOARDING','MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_EXPEDITIONS_ENABLED','PHASE_E_SEEKER_ENABLED'])process.env[flag]='true';
for(const flag of ['PHASE_E_CATALOG_ENABLED','PHASE_E_MINING_ENABLED','GEMS_ENABLED','GEMS_WALLET_BUY_ENABLED','DEVNET_WELCOME_GEMS_ENABLED'])process.env[flag]='false';
const {createRealmSaleRenewalPair}=await import('./realmSaleRenewalPair');
const {decodeSpotSalesQuota,spotSalesQuotaPda}=await import('../../../../packages/chain/src/seekerRealmSaleProtocol');
const pair=await createRealmSaleRenewalPair(),f=pair.bank,wallet=f.buyer.toBase58();
const RealDate=Date;
globalThis.Date=new Proxy(RealDate,{construct:(target,args,newTarget)=>Reflect.construct(target,args.length?args:[Number(f.controls.now)*1000],newTarget),
 apply:()=>new RealDate(Number(f.controls.now)*1000).toString(),get:(target,key,receiver)=>key==='now'?()=>Number(f.controls.now)*1000:Reflect.get(target,key,receiver)});
const {buildApp}=await import('../../src/app');const {createDb}=await import('../../src/db/client');
const {runMigrations}=await import('../../src/db/migrate');const {players,sessions}=await import('../../src/db/schema');
const {getRealmSalePreparation}=await import('../../src/seeker/realmSalePreparationStore');
const {createRealmSaleSettlement}=await import('../../src/seeker/realmSaleSettlement');
const {bootstrapEconomyAllocations,getOrCreatePlayerAccount}=await import('../../src/ledger');
const {createStarterExpeditionFixture}=await import('./starterExpeditions');
const {readOwnedStarterExpedition}=await import('../../src/game/starterExpeditionDispatch');
const {settleDueStarterExpeditions}=await import('../../src/game/starterExpeditionReturns');
const {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC}=await import('../../src/auth/session');const {TEST_CONFIG}=await import('../helpers');
const commandSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('start'),origin:z.string().regex(/^https:\/\/localhost:\d+$/)}).strict(),
 z.object({op:z.literal('request'),method:z.enum(['GET','POST']),url:z.string().max(256),headers:z.record(z.string(),z.string()),body:z.string().max(32768).optional()}).strict(),
 z.object({op:z.literal('sign'),unsigned:z.string().max(1644)}).strict(),z.object({op:z.literal('settle'),key:z.uuid()}).strict(),
 z.object({op:z.literal('restart'),paused:z.boolean()}).strict(),z.object({op:z.literal('nextDay')}).strict(),z.object({op:z.literal('nearExpiry')}).strict(),
 z.object({op:z.literal('advanceReturn'),key:z.uuid()}).strict(),z.object({op:z.literal('inspect'),key:z.uuid().optional()}).strict(),z.object({op:z.literal('close')}).strict(),
]);
const adminUrl=new URL(url);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1,onnotice:()=>{}});
let created=false,closed=false,roleCreated=false,origin='',baseId='',lastKey='',preparePosts=0,submitPosts=0,signatures=0,sends=0,expeditionPosts=0;
const role=`native_renewal_${randomUUID().replaceAll('-','')}`,password=randomUUID(),runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password=password;
let owner:ReturnType<typeof createDb>|undefined,runtime:ReturnType<typeof createDb>|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined,signed:Buffer|undefined;
let later:Awaited<ReturnType<typeof pair.operatingTermAt>>|undefined;
const sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'native-renewal-pair-r1'}};
const config=()=>({...TEST_CONFIG,DATABASE_URL:runtimeUrl.toString(),WEB_ORIGIN:[origin]});
async function startApp(paused:boolean){
 process.env['PHASE_E_SEEKER_ENABLED']=paused?'false':'true';process.env['STARTER_EXPEDITIONS_ENABLED']=paused?'false':'true';
 runtime=createDb(runtimeUrl.toString(),{max:4});
 app=await buildApp(config(),runtime.db,paused?{}:{realmSalePreparationSources:sources,realmSaleRelaySources:{admission:sources,transport:()=>({
  getGenesisHash:async()=>f.controls.genesisHash,getSignatureStatuses:async()=>({context:{slot:f.controls.slot},value:[null]}),getBlockHeight:async()=>f.controls.blockHeight,
  sendRawTransaction:async bytes=>{if(!signed||!Buffer.from(bytes).equals(signed))throw Error('Different native signed wire');sends++;throw Error('Lost fixture relay acknowledgement');},
 })},starterExpeditionProvider:later?{policy:later.policy,connect:later.connect}:{policy:f.termPolicy,connect:()=>f.rpc},
 starterExpeditionAccessProvider:{trust:f.accessTrust,connect:()=>f.rpc}});
 app.addHook('onError',async(request,_reply,error)=>{let cause:unknown=error;while(cause&&typeof cause==='object'&&'cause'in cause&&cause.cause)cause=cause.cause;
  if(cause instanceof Error)process.stderr.write(`Native renewal fixture ${request.method} ${request.url}: ${cause.message}\n`);});
 await app.ready();
}
async function sessionCookie(){
 if(!owner)throw Error('Owner session issuer missing');
 const [session]=await owner.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 const jwt=await issueSessionJwt(config(),wallet,session!.id);return `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}
async function close(){if(closed)return;closed=true;try{await app?.close();await runtime?.sql.end();if(roleCreated&&owner)await owner.sql.unsafe(`drop owned by ${role}; drop role ${role}`);await owner?.sql.end();if(created)await admin.unsafe(`drop database ${database}`);}finally{await admin.end();globalThis.Date=RealDate;}}
async function command(input:unknown):Promise<unknown>{
 const item=commandSchema.parse(input);if(item.op==='close'){await close();return {closed:true};}
 if(item.op==='start'){
  if(created||closed)throw Error('Already started');origin=item.origin;await admin.unsafe(`create database ${database}`);created=true;
  owner=createDb(url.toString(),{max:4});await runMigrations(owner.db);await bootstrapEconomyAllocations(owner.db);
  await owner.db.insert(players).values({wallet});await getOrCreatePlayerAccount(owner.db,wallet,'player_keep');
  baseId=(await createStarterExpeditionFixture(owner.db,{wallet,now:new Date()})).baseId;
  await owner.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls; grant usage on schema public to ${role}`);roleCreated=true;
  // Dedicated composition role. Explicit ordinary snapshot/lock/completion
  // rights; no blanket table grants and no finalized-sale receipt mutation.
  await owner.sql.unsafe(`grant select on players,sessions,seeker_realm_sale_preparations,seeker_realm_sale_signed_wires,seeker_realm_sale_receipts,seeker_realm_sale_failures,
   deposits,plots,base_economy_backfills,deed_economy_cutover_state,deed_ownership_observations,seeker_links,fantasy_world_catalog,fantasy_world_tiles,fantasy_land_claims,fantasy_purchase_cutover,fantasy_retirement_exclusions,
   expedition_free_homes,crafting_stocks,
   raw_raid_snapshots,raw_raid_resources,raw_raid_allocations,raw_raid_terminals,raw_raid_entries,raw_raid_reservation_debits,shields,army_training_batches,army_training_batch_closures,
   bases,base_slots,base_raid_locks,buildings,builder_jobs,obstacles,accounts,base_profiles,game_config,base_transfers,base_items,player_items,item_uses,
   onboarding_training_finishes,onboarding_training_wallets,army,training_queue,troop_research,troop_unlocks,base_army,base_training_queue,base_troop_research,base_hero_progress,hero_levels,
   base_hero_loadouts,base_hero_equipment,raids,raid_live_states,raid_commands,base_battle_records,mine_state,mine_accrual_states,base_streaks,base_daily_activity,
   fleet_installations,starter_fleet_commands,starter_expeditions,starter_expedition_inflight,starter_expedition_returns,starter_expedition_entries,
   expedition_term_snapshots,resource_stocks,resource_stock_operations,resource_stock_entries,ordinary_crafting_jobs,ordinary_crafting_inputs,ordinary_crafting_completions,
   workshop_jobs,league_reward_activations,base_league_entitlements to ${role};
   grant insert on seeker_realm_sale_preparations,seeker_realm_sale_signed_wires,starter_expeditions,starter_expedition_inflight,starter_expedition_returns,starter_expedition_entries,
    expedition_term_snapshots,expedition_free_homes,resource_stocks,accounts,base_profiles,mine_state,mine_accrual_states to ${role};
   grant update on raids,players,bases,base_slots,base_raid_locks,buildings,builder_jobs,obstacles,accounts,base_profiles,fleet_installations,resource_stocks,
    mine_state,mine_accrual_states,training_queue,base_training_queue,troop_research,base_troop_research,ordinary_crafting_jobs,starter_expedition_inflight to ${role};
   grant delete on starter_expedition_inflight to ${role}`);
  // Existing base snapshot/settlement reads this head even with mining disabled.
  // This fixture grant does not close production provisioning (K-196).
  await owner.sql.unsafe(`grant select on harvester_source_heads to ${role}`);
  await startApp(false);
  const [rights]=await runtime!.sql`select current_user role,rolsuper,rolbypassrls,has_table_privilege(current_user,'seeker_realm_sale_receipts','INSERT') receipt_write,
   has_table_privilege(current_user,'starter_expeditions','TRUNCATE') truncate from pg_roles where rolname=current_user`;
  if(!rights||rights.role!==role||rights.rolsuper||rights.rolbypassrls||rights.receipt_write||rights.truncate)throw Error('Unexpected composition privileges');
  return {wallet,baseId,cookie:await sessionCookie(),blockHeight:f.controls.blockHeight,upgradeAuthority:f.upgradeAuthority.toBase58(),catalogue:{constants:{PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION}},
   trust:{genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision}};
 }
 if(!app||!runtime||!owner||closed)throw Error('Fixture not started');
 if(item.op==='restart'){await app.close();await runtime.sql.end();await startApp(item.paused);return {restarted:true,paused:item.paused};}
 if(item.op==='request'){
  const path=item.url.split('?')[0]!;
  const allowed=item.method==='POST'?['/api/seeker/realm-sales/prepare','/api/seeker/realm-sales/submit','/api/starter-expeditions'].includes(item.url)
   :item.url==='/api/seeker/realm-sales/offer?spot=0&realm=0'||/^\/api\/seeker\/realm-sales\/(?:prepare\/|review\/|failures\/)?by-key\/[0-9a-f-]{36}$/.test(item.url)
    ||['/api/me','/api/bases','/api/starter-expeditions','/api/starter-expeditions/paid-route'].includes(path)||/^\/api\/starter-expeditions\/by-key\/[0-9a-f-]{36}$/.test(item.url);
  if(!allowed)throw Error('Unexpected composed native path');
  if(item.method==='POST'){if(item.url.endsWith('/prepare')){preparePosts++;lastKey=z.uuid().parse(JSON.parse(item.body??'{}').idempotencyKey);}else if(item.url.endsWith('/submit'))submitPosts++;else expeditionPosts++;}
  const response=await app.inject({method:item.method,url:item.url.slice('/api'.length),headers:item.headers,...(item.body===undefined?{}:{payload:item.body})});
  return {status:response.statusCode,body:response.body};
 }
 if(item.op==='sign'){
  const p=await getRealmSalePreparation(owner.db,{wallet,idempotencyKey:lastKey});if(!p)throw Error('No original preparation');
  const bytes=Buffer.from(item.unsigned,'base64');if(bytes.toString('base64')!==item.unsigned||bytes.length>1232||bytes[0]!==1||!bytes.subarray(1,65).equals(Buffer.alloc(64))||!bytes.subarray(65).equals(Buffer.from(p.quote.messageHex,'hex')))throw Error('Different native wallet request');
  const tx=VersionedTransaction.deserialize(bytes);tx.sign([Keypair.fromSeed(Buffer.alloc(32,1))]);signed=Buffer.from(tx.serialize());signatures++;return {wire:signed.toString('base64')};
 }
 if(item.op==='settle'){
  if(item.key!==lastKey||!signed)throw Error('No original signed purchase');const p=await getRealmSalePreparation(owner.db,{wallet,idempotencyKey:item.key});if(!p)throw Error('No preparation');
  await pair.settle(p,signed);await createRealmSaleSettlement(owner.db,{connect:()=>f.rpc,trust:f.accessTrust})({wallet,idempotencyKey:item.key});return {verified:true};
 }
 if(item.op==='nextDay'){
  const access=Buffer.from(f.store.get(f.addresses.access.toBase58())!.data),oldDay=f.controls.now/BigInt(PHASE_E_MINING_PUBLICATION.daySec);
  const address=spotSalesQuotaPda(f.accessTrust.programId,0,oldDay),row=f.store.get(address.toBase58());if(!row)throw Error('First sale quota missing');
  const prior=decodeSpotSalesQuota({address,owner:row.owner,executable:row.executable,data:row.data},{programId:f.accessTrust.programId,spot:0,day:oldDay});
  const day=pair.nextUtcDay()/BigInt(PHASE_E_MINING_PUBLICATION.daySec),fresh=spotSalesQuotaPda(f.accessTrust.programId,0,day);
  if(f.store.has(fresh.toBase58()))throw Error('Next day quota must start absent');
  return {day:day.toString(),priorDaySales:prior.sales,newDaySales:0,accessExpiresAt:f.models.access.expires_at.toString(),accessUnchanged:access.equals(f.store.get(f.addresses.access.toBase58())!.data)};
 }
 if(item.op==='nearExpiry'){
  if((await owner.sql`select idempotency_key from seeker_realm_sale_receipts where wallet=${wallet}`).length!==2)throw Error('Both real purchase receipts required');
  pair.setTime(f.models.access.expires_at-60n);later=await pair.operatingTermAt(f.controls.now);
  await app.close();await runtime.sql.end();await startApp(false);
  return {cookie:await sessionCookie(),accessAddress:f.addresses.access.toBase58(),configAddress:f.addresses.saleConfig.toBase58()};
 }
 if(item.op==='advanceReturn'){
  const trip=await readOwnedStarterExpedition(runtime.db,wallet,item.key);
  if(!trip||trip.baseId!==baseId||!('access'in trip.routeSnapshot)||trip.routeSnapshot.access.kind!=='paid_realm'
   ||trip.routeSnapshot.access.observation.expiresAt!==f.models.access.expires_at.toString()||trip.routeSnapshot.access.observation.accessAddress!==f.addresses.access.toBase58())throw Error('Exact renewed departure access missing');
  pair.setTime(BigInt(trip.returnsAt.getTime()/1000));later?.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(f.controls.now,32);
  const afterCoverageExpiry=f.controls.now>f.models.access.expires_at;if(!afterCoverageExpiry)throw Error('Return must follow coverage expiry');
  await runtime.db.transaction(tx=>settleDueStarterExpeditions(tx,baseId,new Date()));return {afterCoverageExpiry};
 }
 const [counts]=await owner.sql`select (select count(*)::integer from starter_expeditions where actor_wallet=${wallet}) departures,
  (select count(*)::integer from starter_expedition_returns where expedition_id=${item.key??null}::uuid) returns,
  (select count(*)::integer from starter_expedition_inflight where expedition_id=${item.key??null}::uuid) inflight`;
 const [stock]=await owner.sql`select available::text from resource_stocks where base_id=${baseId} and resource_id=(select resource_id from starter_expeditions where id=${item.key??null}::uuid)`;
 return {...counts,stock:stock?.available,preparePosts,submitPosts,signatures,sends,expeditionPosts,
  receipts:await owner.sql`select idempotency_key from seeker_realm_sale_receipts where wallet=${wallet}`,wires:await owner.sql`select idempotency_key from seeker_realm_sale_signed_wires where wallet=${wallet}`};
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
try{for await(const line of lines){try{process.stdout.write(`NATIVE_REALM_SALES_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`);if(closed)break;}catch(error){process.stdout.write(`NATIVE_REALM_SALES_FIXTURE:${JSON.stringify({error:error instanceof Error?error.message:'Fixture failed'})}\n`);process.exitCode=1;break;}}}finally{await close();lines.close();}
