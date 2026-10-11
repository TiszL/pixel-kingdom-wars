/** Actual authenticated HTTP, SQL saga, browser journal, independent kind6
 * reconstruction and sign-only wallet. Finalized banks are explicit fixtures;
 * actual Core acceptance belongs to the separate program harness. */
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {PublicKey,type VersionedTransaction} from '@solana/web3.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PHASE_E_CHARTER_TRANSFER,RAID_RULES} from '@shardkeep/shared';
import type {CharterTournamentEntry,CharterTournamentEvent,CharterTournamentOperation,CharterTournamentWire,CharterTournamentPrize,CharterTournamentRaid,CharterTournamentReplay} from '@shardkeep/shared/charterTournamentApi';
import type {TournamentSigningTrust} from '../../web/src/lib/charterTournament/signing';
import {buildApp} from '../src/app';
import {createClanCharterTournaments,type CharterTournamentProvider} from '../src/game/clanCharterTournaments';
import {createCharterTournamentEventsClient,type CharterTournamentEventsClientProvider} from '../src/game/clanCharterTournamentEventsClient';
import {TEST_CONFIG} from './helpers';
import {baseArmy} from '../src/db/schema';
import {acceptLiveRaidCommand} from '../src/game/liveRaids';
import {recoverDueStartedLiveRaids} from '../src/game/raids';
import {charterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';

type TournamentJournal={raids:{eventId:string;request:{baseId:string;idempotencyKey:string};response:CharterTournamentRaid|null}[];eventId:string|null;entryIntent:object|null;entry:CharterTournamentEntry|null;clearIntent:object|null;operations:{id:string;original:CharterTournamentOperation;signingStarted:boolean;signed:CharterTournamentWire|null}[];prize:null|{response:CharterTournamentPrize|null}};
type TournamentController={openEvent(id:string):Promise<unknown>;enter(clanId:string):Promise<unknown>;check():Promise<unknown>;command(action:string):Promise<unknown>;review():Promise<unknown>;sign():Promise<unknown>;upload():Promise<unknown>;deliver():Promise<unknown>;closeEvent():Promise<unknown>;claim(baseId:string):Promise<unknown>;clear():Promise<unknown>;archive():Promise<unknown>;startRaid(baseId:string):Promise<CharterTournamentRaid>;recoverRaid(key:string,retry?:boolean):Promise<CharterTournamentRaid|null>;replay(id:string):Promise<unknown>;getSnapshot():{event:CharterTournamentEvent|null;replay:CharterTournamentReplay|null}};
type Store={read():Promise<TournamentJournal>;close():Promise<void>;archives():Promise<TournamentJournal[]>};
const {TournamentJournalStore}=await vi.importActual<{TournamentJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/charterTournament/journal');
const {TournamentController:Controller}=await vi.importActual<{TournamentController:new(store:Store,ports:object)=>TournamentController}>('../../web/src/lib/charterTournament/controller');
const {createTournamentBrowserPorts,browserTournamentIdentity}=await vi.importActual<{createTournamentBrowserPorts(input:object):object;browserTournamentIdentity(wallet:string):object}>('../../web/src/lib/charterTournament/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
beforeEach(()=>{vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');vi.stubGlobal('IDBKeyRange',IDBKeyRange);});
afterEach(()=>{useApp.getState().setAuth(null);vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
async function application(db:Parameters<typeof buildApp>[1],provider:CharterTournamentProvider,events:CharterTournamentEventsClientProvider){const previous=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},db,{charterTournamentProvider:provider,charterTournamentEventsProvider:events});await app.ready();return app;}finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=previous;}}
function browserHarness(app:()=>FastifyInstance,trust:TournamentSigningTrust,connection:object,actor:string,cookies:Record<string,string>){
 const factory=new IDBFactory(),stores:Store[]=[],posts:string[]=[],lose=new Set<string>();let store!:Store,enabled=true;
 vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);expect(['GET','POST']).toContain(method);
  const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
  if(method==='POST'){const saved=await store.read();if(target.pathname.endsWith('/entries'))expect(saved.entryIntent).not.toBeNull();else if(target.pathname.endsWith('/clear'))expect(saved.clearIntent).not.toBeNull();else if(target.pathname.includes('/operations/'))expect(saved.operations.length).toBeGreaterThan(0);else if(target.pathname.endsWith('/prize'))expect(saved.prize).not.toBeNull();else if(target.pathname.endsWith('/raids'))expect(saved.raids.some(r=>r.request.idempotencyKey===JSON.parse(String(init?.body)).idempotencyKey)).toBe(true);posts.push(target.pathname);}
  const response=await app().inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
  expect(response.statusCode,response.body).toBeLessThan(300);if(lose.delete(target.pathname))throw Error('paired lost response');return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 function client(sign:(tx:VersionedTransaction)=>Promise<VersionedTransaction>,pins:TournamentSigningTrust|null=trust){
  useApp.getState().setAuth(actor,true);store=new TournamentJournalStore(browserTournamentIdentity(actor),factory);stores.push(store);
  const signer={publicKey:new PublicKey(actor),signVersionedTransaction:async(tx:VersionedTransaction)=>{expect((await store.read()).operations.at(-1)?.signingStarted).toBe(true);return sign(tx);},sendTransaction:vi.fn(()=>{throw Error('Tournament wallet must never relay');}),signMessage:null,isEmbedded:false};
  const controller=new Controller(store,createTournamentBrowserPorts({identity:browserTournamentIdentity(actor),trust:pins,wallet:()=>signer,connection,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})}));return {controller,store};
 }
 return {client,posts,lose,pause:()=>{enabled=false;},close:async()=>{await Promise.all(stores.map(s=>s.close()));}};
}
it('recovers lost entry and upload responses, signs each original once, fixes canonical results and releases the same lock before paused archival',async()=>{
 const f=await charterTournamentWorkflowFixture();let app:FastifyInstance|undefined,h:ReturnType<typeof browserHarness>|undefined;
 try{
  const service=f.service(),provider={...service,prepare:async(actor:string,id:string)=>{expect(actor).toBe(f.source.wallet);return f.prepare(id);}};
  const events=()=>createCharterTournamentEventsClient(f.db,{clock:f.clock,finalizedDeedReader:f.reader,deedCollection:f.source.collection});
  app=await application(f.db,provider,events());
  const trust:TournamentSigningTrust={version:1,revision:'paired-D181',deployment:f.lockChain.trust,policySigner:f.lockChain.expectedCurrentSigner,treasury:f.domain.treasury,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[f.lockChain.lookupTable]};
  h=browserHarness(()=>app!,trust,f.lockRpc,f.source.wallet,f.sellerAuth.cookies);let signatures=0;const sign=async(tx:VersionedTransaction)=>{signatures++;tx.sign([f.keys.get(f.source.wallet)!]);return tx;};
  let current=h.client(sign);const root='/clans/charter/tournaments';await current.controller.openEvent(f.event.id);h.lose.add(root+'/entries');await expect(current.controller.enter(f.birth.consent.clanId)).rejects.toThrow('lost response');const intent=(await current.store.read()).entryIntent!;
  current=h.client(sign);await current.controller.check();let row=await current.store.read();expect(row.entry?.eventId).toBe(f.event.id);expect(row.entryIntent).toEqual(intent);const setId=row.entry!.set.original.operation.id;
  await current.controller.command('prepare');await current.controller.review();await current.controller.sign();const wire=(await current.store.read()).operations.at(-1)!.signed;h.lose.add(`${root}/operations/${setId}/signed`);await expect(current.controller.upload()).rejects.toThrow('lost response');
  current=h.client(sign);await current.controller.check();expect((await current.store.read()).operations.at(-1)!.signed).toEqual(wire);await current.controller.deliver();expect(f.lockRpc.sendRawTransaction).toHaveBeenCalledOnce();await f.finalizeLock(setId);await current.controller.command('recover');await current.controller.check();expect((await current.store.read()).entry?.status).toBe('entered');expect(signatures).toBe(1);
  // No browser-submitted score or ranking exists. The server closes all original
  // attempts and fixes the funded sponsor refund when there is no winner.
  f.setTime(new Date(f.event.playEndsAt));await current.controller.closeEvent();const terminal=current.controller.getSnapshot().event!.terminal;expect(terminal?.rankings).toEqual([]);await current.controller.claim(f.source.baseId);expect((await current.store.read()).prize?.response?.amounts).toEqual(f.event.budget);
  await current.controller.clear();row=await current.store.read();const clearId=row.operations.at(-1)!.id;expect(clearId).not.toBe(setId);expect(row.operations.at(-1)!.original.original.operation.lockId).toBe(row.entry!.lockId);await current.controller.command('prepare');await current.controller.review();await current.controller.sign();await current.controller.upload();await current.controller.deliver();expect(f.lockRpc.sendRawTransaction).toHaveBeenCalledTimes(2);await f.finalizeLock(clearId);await current.controller.command('recover');await current.controller.check();expect((await current.store.read()).entry?.status).toBe('released');
  await app.close();app=await application(f.db,createClanCharterTournaments(f.db),events());f.setOnline(false);h.pause();vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');current=h.client(sign,null);await current.controller.check();await expect(current.controller.sign()).rejects.toThrow();await current.controller.archive();expect((await current.store.read()).eventId).toBe(null);expect((await current.store.archives())[0]?.entry?.status).toBe('released');
  expect(h.posts.filter(p=>p===root+'/entries')).toHaveLength(1);expect(h.posts.filter(p=>p.endsWith('/signed'))).toHaveLength(2);expect(h.posts.filter(p=>p.endsWith('/deliver'))).toHaveLength(2);expect(signatures).toBe(2);
 }finally{await h?.close();await app?.close();await f.dispose();}
},120000);

it('recovers the actual matched raid after a lost HTTP reply using its original key, plays normal commands and fixes the winning prize before clear',async()=>{
 const f=await charterTournamentWorkflowFixture();let app:FastifyInstance|undefined,h:ReturnType<typeof browserHarness>|undefined;
 try{
  const service=f.service(),provider={...service,prepare:async(actor:string,id:string)=>{expect(actor).toBe(f.source.wallet);return f.prepare(id);}},events=()=>createCharterTournamentEventsClient(f.db,{clock:f.clock,finalizedDeedReader:f.reader,deedCollection:f.source.collection});
  app=await application(f.db,provider,events());const trust:TournamentSigningTrust={version:1,revision:'paired-D181-matched-raid',deployment:f.lockChain.trust,policySigner:f.lockChain.expectedCurrentSigner,treasury:f.domain.treasury,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[f.lockChain.lookupTable]};h=browserHarness(()=>app!,trust,f.lockRpc,f.source.wallet,f.sellerAuth.cookies);
  let signatures=0;const sign=async(tx:VersionedTransaction)=>{signatures++;tx.sign([f.keys.get(f.source.wallet)!]);return tx;};let current=h.client(sign);await current.controller.openEvent(f.event.id);await current.controller.enter(f.birth.consent.clanId);const setId=(await current.store.read()).entry!.set.original.operation.id;await current.controller.command('prepare');await current.controller.review();await current.controller.sign();await current.controller.upload();await current.controller.deliver();await f.finalizeLock(setId);await current.controller.command('recover');await current.controller.check();expect((await current.store.read()).entry?.status).toBe('entered');
  f.setTime(new Date(Date.parse(f.event.playStartsAt)+3_600_000));await f.db.insert(baseArmy).values({baseId:f.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});
  const matchPath=`/clans/charter/tournaments/events/${f.event.id}/raids`;h.lose.add(matchPath);await expect(current.controller.startRaid(f.source.baseId)).rejects.toThrow('lost response');const saved=(await current.store.read()).raids[0]!;expect(saved.response).toBe(null);const key=saved.request.idempotencyKey;
  current=h.client(sign);await current.controller.check();expect((await current.store.read()).raids[0]?.response).toBe(null);// Participation cannot guess the binding after the lost POST.
  const recovered=await current.controller.recoverRaid(key);expect(recovered).toMatchObject({eventId:f.event.id,baseId:f.source.baseId,status:'admitted',ordinal:1});expect(recovered!.requestId).not.toBe(key);expect((await current.store.read()).raids[0]?.response?.requestId).toBe(recovered!.requestId);
  const raid=recovered!.raid as {id:string;seed:number};expect(typeof raid.seed).toBe('number');expect(raid).not.toHaveProperty('idempotencyKey');expect(raid).not.toHaveProperty('simulationLeaseToken');expect(await current.controller.recoverRaid(key,true)).toEqual(recovered);expect(await f.sql`select count(*)::int n from charter_tournament_raid_admissions`).toEqual([{n:1}]);expect(await f.sql`select count(*)::int n from charter_tournament_raid_requests`).toEqual([{n:1}]);
  await acceptLiveRaidCommand(f.db,f.source.wallet,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},f.clock());f.setTime(new Date(f.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));expect(await recoverDueStartedLiveRaids(f.db,f.clock(),undefined,raid.id)).toEqual({resolved:1,raced:0});await current.controller.replay(raid.id);expect(current.controller.getSnapshot().replay).toMatchObject({raidId:raid.id,completed:true});
  f.setTime(new Date(f.event.playEndsAt));await current.controller.closeEvent();expect(current.controller.getSnapshot().event?.terminal).toMatchObject({rankings:[{clanId:f.birth.consent.clanId,completedRaids:1,rosterSize:1}],occupations:[{site:1,clanId:f.birth.consent.clanId}],entitlements:[{wallet:f.source.wallet,amounts:f.event.budget}]});await current.controller.claim(f.source.baseId);expect((await current.store.read()).prize?.response?.amounts).toEqual(f.event.budget);
  await current.controller.clear();const clearId=(await current.store.read()).operations.at(-1)!.id;await current.controller.command('prepare');await current.controller.review();await current.controller.sign();await current.controller.upload();await current.controller.deliver();await f.finalizeLock(clearId);await current.controller.command('recover');await current.controller.check();expect((await current.store.read()).entry?.status).toBe('released');await current.controller.archive();expect((await current.store.archives())[0]?.raids[0]?.response?.requestId).toBe(recovered!.requestId);expect(h.posts.filter(path=>path===matchPath)).toHaveLength(2);expect(signatures).toBe(2);
 }finally{await h?.close();await app?.close();await f.dispose();}
},120000);
