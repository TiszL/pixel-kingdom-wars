/** Explicit local-only browser fixture. Never collected by the default suite.
 * Actual earned materials and authenticated API, serialized finalized banks.
 * Run only with the include-only config and PHASE_E_VEHICLE_CRAFT_BROWSER=1. */
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import {createVehicleCraftClient} from '../src/game/vehicleCraftClient';
import {HttpError} from '../src/lib/errors';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {withVehicleCraftClientFixture} from './fixtures/vehicleCraftClient';
const ready='/tmp/vehicle-craft-browser-ready.json',stop='/tmp/vehicle-craft-browser-stop';
it('serves the actual vehicle screen against earned originals until the explicit stop file',async()=>{
 if(process.env.PHASE_E_VEHICLE_CRAFT_BROWSER!=='1')throw Error('Explicit local browser fixture opt-in required');
 if(existsSync(stop))throw Error('Remove only the previous fixture stop file before starting');
 await withVehicleCraftClientFixture(async f=>{
  const {wallet,baseId}=f.seller,held=await f.reserve(),won=await f.reserve(),lost=await f.reserve();
  const win=await f.terminal(won,'won'),loss=await f.terminal(lost,'lost'),mint=await f.minted(won);
  let outage=false,paused=false;
  const result=async(root:string)=>{if(outage)throw Error('Explicit fixture provider outage');if(root===won.original.rootId)return win;if(root===lost.original.rootId)return loss;throw Error('Original still has no proved outcome');};
  const initial=createVehicleCraftClient(f.db,{...f.identity,readFinalizedResult:result});
  expect((await initial.recover(wallet,won.request.idempotencyKey)).record.status).toBe('won_unminted');
  expect((await initial.recover(wallet,lost.request.idempotencyKey)).record.status).toBe('paid_loss');
  const recovery=createVehicleCraftClient(f.db,{...f.identity,readFinalizedResult:result,readFinalizedMint:async root=>{if(outage||root!==won.original.rootId)throw Error('Mint evidence unavailable');return mint;}});
  const config={...TEST_CONFIG,HOST:'127.0.0.1',PORT:18940,WEB_ORIGIN:['http://127.0.0.1:18941']};
  const [session]=await f.conn.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;
  const token=await issueSessionJwt(config,wallet,session!.id);
  vi.stubEnv('MULTI_BASE_ENABLED','false');
  const provider={...recovery,
   quote:async(actor:string,input:unknown)=>{if(outage)throw new HttpError(503,'Fixture provider temporarily unavailable');await f.refresh();return recovery.quote(actor,input);},
   history:async(actor:string,cursor?:string)=>{if(outage)throw new HttpError(503,'Fixture provider temporarily unavailable');return recovery.history(actor,cursor);}};
  const app=await buildApp(config,f.db,{vehicleCraftClientProvider:provider,vehicleClientProvider:f.candidates(won).client});
  // This minimal presentation snapshot contains actual DB owner/facility facts,
  // never invented balances. All ingredient and original values use normal APIs.
  const facilities=await f.conn.sql`select b.id,b.type from buildings b where b.base_id=${baseId} and exists(select 1 from builder_jobs j where j.building_id=b.id and j.kind='build' and j.completed_at is not null)`;
  const snapshot={baseId,player:{wallet},buildings:facilities.map(b=>({...b,underConstruction:false}))};
  app.get('/__fixture/login',async(req,reply)=>{
   if(req.headers.origin!==config.WEB_ORIGIN[0])throw new HttpError(403,'Fixture origin required');
   reply.setCookie(SESSION_COOKIE,token,{path:'/',httpOnly:true,sameSite:'lax',secure:false,maxAge:SESSION_TTL_SEC});
   return {wallet,baseId,alternateBaseId:f.inheritedBaseId,snapshot,paused,outage};
  });
  app.post('/__fixture/control',{preHandler:[app.authenticate]},async(req)=>{
   if(req.headers.origin!==config.WEB_ORIGIN[0])throw new HttpError(403,'Fixture origin required');
   const body=req.body as {outage?:unknown;paused?:unknown};
   if(typeof body?.outage==='boolean')outage=body.outage;
   if(typeof body?.paused==='boolean'){paused=body.paused;vi.stubEnv('PHASE_E_VEHICLES_ENABLED',paused?'false':'true');}
   return {paused,outage};
  });
  try{
   await app.listen({host:config.HOST,port:config.PORT});
   writeFileSync(ready,JSON.stringify({url:'http://127.0.0.1:18941/testFixtures/vehicle-craft-render.html',api:'http://127.0.0.1:18940',wallet,baseId,keys:{held:held.request.idempotencyKey,won:won.request.idempotencyKey,lost:lost.request.idempotencyKey},source:'actual earned ingredients and authenticated HTTP; serialized finality bank; no live signing'}));
   const deadline=Date.now()+28*60*1000;
   while(!existsSync(stop)&&Date.now()<deadline)await delay(500);
   expect(existsSync(stop),'Browser inspection must finish with an explicit stop file').toBe(true);
  }finally{await app.close();}
 });
},30*60*1000);
