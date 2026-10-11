/** Real source -> ordinary authenticated routes. Captured bytes feed both clients;
 * finalized fixture banks are explicit local observations, not live chain proof. */
import {writeFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import type {Db} from '../src/db/client';
import type {RealmPassportProvider} from '../src/game/realmPassport';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sql} from 'drizzle-orm';
import {TEST_CONFIG} from './helpers';
import {REALM_PASSPORT_TEST_FLAGS,realmPassportStarterFixture,realmPassportAdvancedFixture,withRealmPassportFundedFixture} from './fixtures/realmPassport';
const pairs:Record<string,{wallet:string;raw:Record<string,string>}>= {};
const output='/tmp/realm-passport-http-pair.json';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function appFor(db:Db,wallet:string,provider:RealmPassportProvider){
 const [session]=await db.execute<{id:string}>(sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}::timestamptz) returning id`);
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
 const app=await buildApp(TEST_CONFIG,db,{realmPassportProvider:provider});
 return {app,cookies,read:async(url:string)=>{const response=await app.inject({url,cookies});expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');return response;}};
}
function save(kind:string,wallet:string,raw:Record<string,string>){pairs[kind]={wallet,raw};writeFileSync(output,JSON.stringify({source:'actual source fixtures through ordinary authenticated HTTP; encoded finalized banks, no live source or signing',pairs},null,2));}
it('serves original-actor completed journeys and exclusive pages through normal HTTP after a recorded base-owner transfer',async()=>{
 for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');
 const f=await realmPassportStarterFixture({completed:21});let app:Awaited<ReturnType<typeof appFor>>|undefined;
 try{
  await f.sell();app=await appFor(f.db,f.wallet,f.provider());
  expect((await app.app.inject({url:'/realm-passport/expeditions?kind=starter'})).statusCode).toBe(401);
  const first=await app.read('/realm-passport/expeditions?kind=starter'),page=first.json();
  expect(page.data.rows).toHaveLength(20);expect(page.data.rows.every((r:{originalBaseId:string})=>r.originalBaseId===f.baseId)).toBe(true);
  const second=await app.read('/realm-passport/expeditions?kind=starter&cursor='+page.data.nextCursor);
  expect(second.json().data.rows).toHaveLength(1);expect(second.json().data.nextCursor).toBeNull();
  const buyer=await appFor(f.db,f.buyer,f.provider());try{expect((await buyer.read('/realm-passport/expeditions?kind=starter')).json().data.rows).toEqual([]);}finally{await buyer.app.close();}
  save('starter',f.wallet,{first:first.body,second:second.body});
 }finally{await app?.app.close();await f.close();}
},120_000);
it('serves actual advanced returns with original policy and no invented route version',async()=>{
 for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');
 const f=await realmPassportAdvancedFixture();let app:Awaited<ReturnType<typeof appFor>>|undefined;
 try{app=await appFor(f.db,f.wallet,f.provider());const response=await app.read('/realm-passport/expeditions?kind=advanced');
  const rows=response.json().data.rows;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({kind:'advanced',routeVersion:null,policyVersion:1});
  save('advanced',f.wallet,{first:response.body});
 }finally{await app?.app.close();await f.dispose();vi.useRealTimers();}
},120_000);
it('keeps published funded participation and earlier real claim attestations distinct through normal HTTP',async()=>{
 await withRealmPassportFundedFixture(async f=>{
  let outage=false;const provider=f.provider({identity:f.identity,assess:async(wallet:string)=>{if(outage)throw Error('Explicit fixture current provider outage');return f.assess(wallet);}});
  const app=await appFor(f.db,f.wallet,provider);
  try{
   const history=await app.read('/realm-passport/mining/inclusions'),current=await app.read('/realm-passport/mining/current');
   expect(history.json().data.rows).toHaveLength(2);expect(current.json().data).toMatchObject({published:{cumulativeRenown:'2',cumulativeDays:'2'},attested:{renownTotal:'1',daysAttested:'1',lastSequence:'1'}});
   outage=true;const unavailable=await app.read('/realm-passport/mining/current');expect(unavailable.json()).toMatchObject({state:'unavailable',reason:'SOURCE_UNAVAILABLE',data:null});
   expect((await app.read('/realm-passport/mining/inclusions')).json().data).toEqual(history.json().data);
   expect((await app.app.inject({url:'/realm-passport/mining/current?wallet='+f.buyer,cookies:app.cookies})).statusCode).toBe(400);
   save('mining',f.wallet,{history:history.body,current:current.body,unavailable:unavailable.body});
  }finally{await app.app.close();}
 });
},120_000);
