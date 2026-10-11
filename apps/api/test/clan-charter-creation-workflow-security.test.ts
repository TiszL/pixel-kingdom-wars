import {randomUUID} from 'node:crypto';
import {PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LOGIN_COOKIE} from '../src/auth/session';
import {createDb} from '../src/db/client';
import {createCharterCreationWorkflow} from '../src/game/clanCharterCreationWorkflow';
import * as policyModule from '../src/game/clanCharterCreationPolicyAdmission';
import * as preparationModule from '../src/game/clanCharterCreationPreparation';
import {charterCreationWorkflowFixture,charterPath,gate,type WorkflowFixture} from './fixtures/charterCreationWorkflow';
let f:WorkflowFixture|undefined;
const fixture=()=>{if(!f)throw Error('Workflow fixture incomplete');return f;};
beforeEach(async()=>{f=undefined;f=await charterCreationWorkflowFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const current=f;f=undefined;await current?.dispose();},120_000);

it('requires a real active full session and rejects missing, login-pending and revoked cookies',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),url=`${charterPath}/${p.input.creationIntentId}`;
 expect((await app.inject({url})).statusCode).toBe(401);
 expect((await app.inject({url,cookies:{...f.auth.cookies,[LOGIN_COOKIE]:'pending'}})).statusCode).toBe(403);
 await f.sql`update sessions set revoked_at=now() where id=${f.auth.id}`;
 expect((await app.inject({url,cookies:f.auth.cookies})).statusCode).toBe(401);
 const fresh=await f.session(f.payerActor.wallet),response=await app.inject({url,cookies:fresh.cookies});expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
});

it('makes every saved endpoint indistinguishable for foreign and absent originals before external work',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),other=await f.actor(),foreign=await f.session(other.wallet),calls=f.connect.mock.calls.length;
 for(const suffix of ['', '/prepare','/recover-preparation','/signed','/recover','/refund']){
  const known=`${charterPath}/${p.input.creationIntentId}${suffix}`,absent=`${charterPath}/${randomUUID()}${suffix}`,body=suffix==='/signed'?{signedTransaction:Buffer.alloc(66).toString('base64')}:{},
   first=suffix?await f.post(app,known,body,foreign.cookies):await app.inject({url:known,cookies:foreign.cookies}),
   second=suffix?await f.post(app,absent,body,foreign.cookies):await app.inject({url:absent,cookies:foreign.cookies});
  expect(first.statusCode,first.body).toBe(404);expect(second.statusCode,second.body).toBe(404);expect(first.json()).toEqual(second.json());
 }
 const fund=await f.post(app,charterPath,p.input,foreign.cookies);expect(fund.statusCode,fund.body).toBe(404);
 expect(f.connect).toHaveBeenCalledTimes(calls);expect(f.issuer.issueOnce).not.toHaveBeenCalled();expect(f.issuer.lookup).not.toHaveBeenCalled();
});

it('keeps GET offline and read-only and pins trusted methods when the optional plugin is registered',async()=>{
 const f=fixture(),app=await f.open(),p=await f.prepared(app),provider={...createCharterCreationWorkflow(f.db,f.options())},registered=await f.open({provider});
 provider.read=async()=>{throw Error('Caller replaced provider method after registration');};
 f.setOnline(false);const before=await f.terminalSnapshot(),calls=f.connect.mock.calls.length,issued=vi.mocked(f.issuer.issueOnce).mock.calls.length,lookups=vi.mocked(f.issuer.lookup).mock.calls.length;
 const result=await registered.inject({url:`${charterPath}/${p.input.creationIntentId}`,cookies:f.auth.cookies});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual(p.state);
 expect(f.connect).toHaveBeenCalledTimes(calls);expect(f.issuer.issueOnce).toHaveBeenCalledTimes(issued);expect(f.issuer.lookup).toHaveBeenCalledTimes(lookups);expect(await f.terminalSnapshot()).toEqual(before);
});

it('rejects caller authority, extra queries, malformed base64 and oversized bodies before mutation',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),id=p.input.creationIntentId,before=await f.terminalSnapshot();
 for(const fields of [{price:{shards:'1'}},{payer:f.payerActor.wallet},{ownershipEpoch:{id:randomUUID()}},{chain:f.domain},{metadata:{uri:'https://evil.invalid/'}},{clanId:randomUUID()}])
  expect((await f.post(app,charterPath,{...f.request(),...fields})).statusCode).toBe(400);
 expect((await app.inject({url:`${charterPath}/${id}?authority=true`,cookies:f.auth.cookies})).statusCode).toBe(400);
 for(const suffix of ['/prepare','/recover-preparation','/recover'])expect((await f.post(app,`${charterPath}/${id}${suffix}`,{proof:{verified:true}})).statusCode).toBe(400);
 for(const signedTransaction of ['invalid',Buffer.alloc(66).toString('base64')+'\n',Buffer.alloc(1233).toString('base64')])
  expect((await f.post(app,`${charterPath}/${id}/signed`,{signedTransaction})).statusCode).toBe(400);
 expect((await f.post(app,`${charterPath}/${id}/signed`,{signedTransaction:'x'.repeat(5000)})).statusCode).toBe(413);
 expect((await f.post(app,`${charterPath}/${id}/refund`,{destinationBaseId:f.payerActor.baseId,refundAuthorized:true})).statusCode).toBe(400);
 expect(await f.terminalSnapshot()).toEqual(before);expect(f.connect).not.toHaveBeenCalled();
});

it('holds new work at each strict parent flag while the original funded request remains recoverable',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),before=await f.terminalSnapshot();
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_CHARTER_ENABLED']){
  process.env[flag]='false';const fresh=await f.post(app,charterPath,f.request()),prepare=await f.post(app,`${charterPath}/${p.input.creationIntentId}/prepare`);
  expect(fresh.statusCode,fresh.body).toBe(503);expect(prepare.statusCode,prepare.body).toBe(503);
  const original=await f.post(app,charterPath,p.input);expect(original.statusCode,original.body).toBe(201);expect(original.json()).toEqual(p.state);process.env[flag]='true';
 }
 expect(await f.terminalSnapshot()).toEqual(before);expect(f.connect).not.toHaveBeenCalled();
 const unmounted=await f.open({provider:null});expect((await unmounted.inject({url:`${charterPath}/${p.input.creationIntentId}`,cookies:f.auth.cookies})).statusCode).toBe(503);
});

it('serves authenticated history through a private owner provider without granting the public DB Charter authority',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),role=`charter_http_${randomUUID().replaceAll('-','')}`,password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}'`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role}; grant select on public.sessions,public.players to ${role}`);
  const url=await f.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(runtime.sql`select * from charter_creation_reservations`).rejects.toMatchObject({code:'42501'});
  const publicApp=await f.open({runtimeDb:runtime.db}),result=await publicApp.inject({url:`${charterPath}/${p.input.creationIntentId}`,cookies:f.auth.cookies});
  expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual(p.state);
  expect(await runtime.sql`select has_table_privilege(current_user,'charter_creation_reservations','SELECT') allowed`).toEqual([{allowed:false}]);await publicApp.close();
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('releases ordinary SQL locks before both policy RPC and the independent issuer boundary',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),rpcGate=gate(),issuerGate=gate();
 f.hooks.beforeRpc=async()=>{f.hooks.beforeRpc=async()=>{};await rpcGate.enter();};f.hooks.beforeIssue=issuerGate.enter;
 const pending=f.post(app,`${charterPath}/${p.input.creationIntentId}/prepare`);
 const probe=()=>f.sql.begin(async tx=>{await tx`select wallet from players where wallet=${f.payerActor.wallet} for update nowait`;
  await tx`select id from bases where id=${f.payerActor.baseId} for update nowait`;
  await tx`select id from charter_creation_reservations where intent_id=${p.input.creationIntentId} for update nowait`;});
 try{await rpcGate.arrived;await probe();rpcGate.release();await issuerGate.arrived;await probe();issuerGate.release();const result=await pending;expect(result.statusCode,result.body).toBe(200);}
 finally{rpcGate.release();issuerGate.release();await pending;}
});

it('never exposes a mixed stage envelope when admission and preparation advance between historical reads',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),writer=createCharterCreationWorkflow(f.db,f.options()),factory=policyModule.createCharterCreationPolicyAdmission;
 let advance=false;
 vi.spyOn(policyModule,'createCharterCreationPolicyAdmission').mockImplementation((db,options)=>{
  const service=factory(db,options);return {...service,read:async(wallet,id)=>{const value=await service.read(wallet,id);
   if(advance&&id===p.input.creationIntentId){advance=false;await writer.prepare(f.payerActor.wallet,id);}return value;}};
 });
 const raced=await f.open();advance=true;const result=await raced.inject({url:`${charterPath}/${p.input.creationIntentId}`,cookies:f.auth.cookies});
 expect(advance).toBe(false);expect([200,503]).toContain(result.statusCode);
 if(result.statusCode===200){const state=result.json();expect(state.status).toBe('prepared');expect(state.policy).not.toBeNull();expect(state.preparation).not.toBeNull();expect(state.policy.expiry).toMatch(/^[1-9][0-9]*$/);}
 else{expect(result.json().error.code).toBe('CLAN_CHARTER_WORKFLOW_HELD');expect(result.json().preparation).toBeUndefined();}
});

it('shares one bounded external-work budget across issuance and concurrent lookup recovery requests',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),issueGate=gate(),lookupGate=gate();
 f.hooks.beforeIssue=issueGate.enter;f.hooks.lookupNull=true;
 let lookups=0,full!:()=>void,excess!:()=>void;
 const fullBudget=new Promise<void>(resolve=>full=resolve),openedExcess=new Promise<void>(resolve=>excess=resolve);
 f.hooks.beforeLookup=async()=>{lookups++;if(lookups===PHASE_E_CHARTER_PREPARATION.maxPending-1)full();
  if(lookups>=PHASE_E_CHARTER_PREPARATION.maxPending)excess();await lookupGate.enter();};
 const issue=f.post(app,`${charterPath}/${p.input.creationIntentId}/prepare`),pending:Promise<Awaited<ReturnType<typeof f.post>>>[]=[];
 try{
  await issueGate.arrived;
  for(let n=1;n<PHASE_E_CHARTER_PREPARATION.maxPending;n++)pending.push(f.post(app,`${charterPath}/${p.input.creationIntentId}/recover-preparation`));
  await fullBudget;
  const extra=f.post(app,`${charterPath}/${p.input.creationIntentId}/recover-preparation`);pending.push(extra);
  const outcome=await Promise.race([extra.then(response=>response.statusCode),openedExcess.then(()=> 'unbounded issuer lookup')]);
  expect(outcome).toBe(503);expect(lookups).toBe(PHASE_E_CHARTER_PREPARATION.maxPending-1);
 }finally{lookupGate.release();issueGate.release();await Promise.all([...pending,issue]);}
 expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);
});

it('rereads coherent immutable stages when an authentic terminal advances after the preparation read',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),writer=createCharterCreationWorkflow(f.db,f.options()),factory=preparationModule.createCharterCreationPreparation;
 let advance=false;
 vi.spyOn(preparationModule,'createCharterCreationPreparation').mockImplementation((db,options)=>{
  const service=factory(db,options);return {...service,read:async(wallet,id)=>{const value=await service.read(wallet,id);
   if(advance&&id===p.input.creationIntentId){advance=false;await writer.prepare(f.payerActor.wallet,id);await f.sync(id,true);await writer.recover(f.payerActor.wallet,id);}return value;}};
 });
 const raced=await f.open();advance=true;const result=await raced.inject({url:`${charterPath}/${p.input.creationIntentId}`,cookies:f.auth.cookies});
 expect(advance).toBe(false);expect(result.statusCode,result.body).toBe(200);const state=result.json();
 expect(state.status).toBe('activated');expect(state.terminal.state).toBe('activated');expect(state.policy).not.toBeNull();expect(state.preparation).not.toBeNull();
 expect(await f.balance('charter_creation_escrow')).toBe(0n);expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);
});
