import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LOGIN_COOKIE} from '../src/auth/session';
import {createClanCharterSales} from '../src/game/clanCharterSales';
import {charterSalesWorkflowFixture,salesPath,saleGate,type SalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
let f:SalesWorkflowFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesWorkflowFixture();},120000);
afterEach(async()=>{const old=f;f=undefined;try{await old?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);

it('requires genuine active full sessions and retains no-store on private sale history',async()=>{
 const c=f!,app=await c.open(),p=await c.drafted(app),url=`${salesPath}/${p.state.id}`;
 expect((await app.inject({url})).statusCode).toBe(401);expect((await app.inject({url,cookies:{...c.sellerAuth.cookies,[LOGIN_COOKIE]:'pending'}})).statusCode).toBe(403);
 await c.sql`update sessions set revoked_at=now() where id=${c.sellerAuth.id}`;expect((await app.inject({url,cookies:c.sellerAuth.cookies})).statusCode).toBe(401);
 const result=await app.inject({url,cookies:c.buyerAuth.cookies});expect(result.statusCode,result.body).toBe(200);expect(result.headers['cache-control']).toBe('private, no-store');
});

it('makes every original endpoint indistinguishable for foreign and absent sales before any external provider',async()=>{
 const c=f!,app=await c.open(),p=await c.drafted(app),other=await c.actor(),auth=await c.session(other.wallet),before=await c.salesSnapshot();
 for(const suffix of ['', '/accept','/pay-members','/prepare','/recover-preparation','/signed','/recover','/cancel']){
  const body=suffix==='/accept'?{termsHash:p.state.original.termsHash,buyerBaseId:other.baseId}:suffix==='/signed'?{signedTransaction:Buffer.alloc(130).toString('base64')}:{};
  const request=(id:string)=>suffix?c.post(app,`${salesPath}/${id}${suffix}`,body,auth.cookies):app.inject({url:`${salesPath}/${id}`,cookies:auth.cookies});
  const known=await request(p.state.id),absent=await request(randomUUID());expect(known.statusCode,known.body).toBe(404);expect(absent.statusCode,absent.body).toBe(404);expect(known.json()).toEqual(absent.json());
 }
 expect(c.connect).not.toHaveBeenCalled();expect(c.issuer.issueOnce).not.toHaveBeenCalled();expect(c.issuer.lookup).not.toHaveBeenCalled();expect(await c.salesSnapshot()).toBe(before);
});

it('keeps GET offline and mutation-free and captures provider methods at registration',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),provider={...createClanCharterSales(c.db,c.options())},registered=await c.open({provider});provider.read=async()=>{throw Error('Replaced provider');};
 c.setOnline(false);const before=await c.salesSnapshot(),calls=c.connect.mock.calls.length,lookups=vi.mocked(c.issuer.lookup).mock.calls.length;
 const result=await registered.inject({url:`${salesPath}/${p.state.id}`,cookies:c.sellerAuth.cookies});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual(p.state);
 expect(await c.salesSnapshot()).toBe(before);expect(c.connect).toHaveBeenCalledTimes(calls);expect(c.issuer.lookup).toHaveBeenCalledTimes(lookups);
});

it('rejects caller authority and malformed wire envelopes before mutation and verifies both actual wallet signatures',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),before=await c.salesSnapshot();
 for(const extra of [{seller:c.buyer.wallet},{termsHash:'00'.repeat(32)},{fenceId:randomUUID()},{domain:c.domain},{transferAuthorized:true}])expect((await c.post(app,salesPath,{...c.request(),...extra})).statusCode).toBe(400);
 expect((await app.inject({url:`${salesPath}/${p.state.id}?verified=true`,cookies:c.sellerAuth.cookies})).statusCode).toBe(400);
 for(const signedTransaction of ['invalid',Buffer.alloc(130).toString('base64')+'\n',Buffer.alloc(1233).toString('base64')])expect((await c.post(app,`${salesPath}/${p.state.id}/signed`,{signedTransaction})).statusCode).toBe(400);
 expect((await c.post(app,`${salesPath}/${p.state.id}/signed`,{signedTransaction:'x'.repeat(5000)})).statusCode).toBe(413);
 const one=await c.post(app,`${salesPath}/${p.state.id}/signed`,c.signed(p.state,true).body);expect(one.statusCode,one.body).toBe(400);expect((await c.store().read(c.buyer.wallet,p.state.id)).signed).toBeNull();expect(await c.salesSnapshot()).toBe(before);
});

it('releases SQL locks before quote and issuer work while preserving a committed original attempt before dispatch',async()=>{
 const c=f!,app=await c.open(),p=await c.accepted(app),rpcGate=saleGate(),issueGate=saleGate();c.hooks.beforeRpc=async()=>{c.hooks.beforeRpc=async()=>{};await rpcGate.enter();};c.hooks.beforeIssue=issueGate.enter;
 const pending=c.post(app,`${salesPath}/${p.state.id}/prepare`),probe=()=>c.sql.begin(async tx=>{await tx`select wallet from players where wallet=${c.birth.actor.wallet} for update nowait`;await tx`select wallet from players where wallet=${c.buyer.wallet} for update nowait`;await tx`select id from clans where id=${c.birth.consent.clanId} for update nowait`;});
 try{await rpcGate.arrived;await probe();rpcGate.release();await issueGate.arrived;await probe();expect((await c.store().read(c.buyer.wallet,p.state.id)).inventory.count).toBe(1);issueGate.release();const response=await pending;expect(response.statusCode,response.body).toBe(200);}
 finally{rpcGate.release();issueGate.release();await pending;}
});

it('blocks new attempt under parent flags but keeps exact accepted original readable without current chain configuration',async()=>{
 const c=f!,app=await c.open(),p=await c.accepted(app),before=await c.salesSnapshot();
 for(const flag of ['PHASE_E_CHARTER_ENABLED','MULTI_BASE_ENABLED']){vi.stubEnv(flag,'false');const result=await c.post(app,`${salesPath}/${p.state.id}/prepare`);expect(result.statusCode,result.body).toBe(503);vi.stubEnv(flag,'true');}
 const offline=await c.open({options:{chain:null,issuer:null,newSaleDomain:null}});expect((await c.post(offline,salesPath,p.input)).json()).toEqual(p.state);expect(await c.salesSnapshot()).toBe(before);expect(c.connect).not.toHaveBeenCalled();
});
