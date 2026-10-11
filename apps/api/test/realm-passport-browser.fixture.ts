/** Opt-in browser fixture: actual completed-return/funded-publication source,
 * normal authenticated endpoints, separate original-wallet scenarios. */
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import type {Db} from '../src/db/client';
import {buildApp} from '../src/app';
import type {RealmPassportProvider} from '../src/game/realmPassport';
import {HttpError} from '../src/lib/errors';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {REALM_PASSPORT_TEST_FLAGS,realmPassportStarterFixture,realmPassportAdvancedFixture,withRealmPassportFundedFixture} from './fixtures/realmPassport';
const stop='/tmp/realm-passport-browser-stop',ready='/tmp/realm-passport-browser-ready.json';
it('serves the actual Passport entry and dialog until the explicit local stop',async()=>{
 if(process.env.PHASE_E_PASSPORT_BROWSER!=='1'||existsSync(stop))throw Error('Explicit local opt-in and absent previous stop file required');
 const scenario=process.env.PHASE_E_PASSPORT_BROWSER_SCENARIO;
 if(!['starter','advanced','mining'].includes(scenario??''))throw Error('Choose an explicit real-source scenario');
 for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');
 let outage=false;
 async function serve(db:Db,wallet:string,provider:RealmPassportProvider){
  const config={...TEST_CONFIG,HOST:'127.0.0.1',PORT:18950,WEB_ORIGIN:['http://127.0.0.1:18951']};
  const [session]=await db.execute<{id:string}>(sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}::timestamptz) returning id`);
  const token=await issueSessionJwt(config,wallet,session!.id),app=await buildApp(config,db,{realmPassportProvider:provider});
  app.get('/__fixture/login',async(req,reply)=>{if(req.headers.origin!==config.WEB_ORIGIN[0])throw new HttpError(403,'Fixture origin required');reply.setCookie(SESSION_COOKIE,token,{path:'/',httpOnly:true,sameSite:'lax',secure:false,maxAge:SESSION_TTL_SEC});return {wallet,scenario};});
  app.post('/__fixture/control',{preHandler:[app.authenticate]},async req=>{if(req.headers.origin!==config.WEB_ORIGIN[0])throw new HttpError(403,'Fixture origin required');const body=req.body as {outage?:unknown};if(typeof body?.outage==='boolean')outage=body.outage;return {outage};});
  try{await app.listen({host:config.HOST,port:config.PORT});writeFileSync(ready,JSON.stringify({wallet,scenario,url:'http://127.0.0.1:18951/testFixtures/realm-passport-render.html',source:'actual source via authenticated routes; finalized banks are local encoded fixtures'}));
   const deadline=performance.now()+28*60*1000;while(!existsSync(stop)&&performance.now()<deadline)await delay(500);
   expect(existsSync(stop),'Browser inspection must end with explicit stop').toBe(true);
  }finally{await app.close();}
 }
 if(scenario==='starter'){const f=await realmPassportStarterFixture({completed:21});try{await f.sell();await serve(f.db,f.wallet,f.provider());}finally{await f.close();}}
 if(scenario==='advanced'){const f=await realmPassportAdvancedFixture();try{await serve(f.db,f.wallet,f.provider());}finally{await f.dispose();vi.useRealTimers();}}
 if(scenario==='mining')await withRealmPassportFundedFixture(async f=>serve(f.db,f.wallet,f.provider({identity:f.identity,assess:async(wallet:string)=>{if(outage)throw Error('Explicit fixture current source outage');return f.assess(wallet);}})));
 vi.unstubAllEnvs();
},30*60*1000);
