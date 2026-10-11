/** Ordinary authenticated runtime roles plus independently verified source-funded
 * setup, explicit expiry recovery, signed child and final payment. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {afterEach,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import {createDb} from '../src/db/client';
import {sessions} from '../src/db/schema';
import {SESSION_COOKIE,SESSION_TTL_SEC,issueSessionJwt} from '../src/auth/session';
import {getMiningClaimPreparation} from '../src/mining/claimPreparationStore';
import {withMiningOrderedClaimFixture as fixture} from './fixtures/miningOrderedClaim';
import {TEST_CONFIG} from './helpers';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
type BrowserCall=(input:Record<string,unknown>)=>Promise<unknown>;
const browser=await vi.importActual<{prepareMiningClaimOriginal:BrowserCall;claimMiningOriginal:BrowserCall;submitMiningOriginal:BrowserCall;continueMiningOriginal:BrowserCall}>('../../web/src/lib/miningClaims/transport');
const web=await vi.importActual<{API_URL:string;api:{get(path:string):Promise<unknown>}}>('../../web/src/lib/api');
it('uses explicit ordered fees, authentic setup, recoverable early refusal, one child and providerless actual payment history',async()=>fixture(async f=>{
 vi.stubEnv('MULTI_BASE_ENABLED','false');const role=`ordered_http_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};
 grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures,mining_claim_continuations to ${role};
 grant insert on mining_claim_preparations,mining_claim_signed_wires,mining_claim_continuations to ${role};
 grant execute on function shardkeep_mining_claim_format_valid(jsonb,bigint),shardkeep_mining_claim_continuation_lock(uuid) to ${role}`);
 const url=new URL(f.url);url.username=role;url.password=password;const runtime=createDb(url.toString(),{max:4});
 let app=await buildApp(TEST_CONFIG,runtime.db,{miningClaimsProvider:f.provider});
 const [session]=await f.conn.db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)},headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};
 const http=(path:string,payload?:object)=>app.inject({method:payload?'POST':'GET',url:`/claims/mining${path}`,cookies,headers,...(payload?{payload}:{})});
 const browserCalls:string[]=[],retained:unknown[]=[];let response:Awaited<ReturnType<typeof http>>|undefined;
 const received=():Awaited<ReturnType<typeof http>>|undefined=>response;
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const target=new URL(String(input));if(target.origin!==new URL(web.API_URL).origin||!target.pathname.startsWith('/claims/mining'))throw Error('Unexpected browser transport destination');
  const requestHeaders:Record<string,string>={origin:TEST_CONFIG.WEB_ORIGIN[0]!};new Headers(init?.headers).forEach((v,k)=>{requestHeaders[k]=v;});
  response=await app.inject({method:init?.method==='POST'?'POST':'GET',url:target.pathname+target.search,headers:requestHeaders,...(init?.credentials==='include'?{cookies}:{}),...(init?.body?{payload:String(init.body)}:{})});browserCalls.push(`${init?.method??'GET'} ${target.pathname}`);
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 const browserHttp=async(path:string,payload?:object)=>{
  response=undefined;const common={isCurrent:()=>true,retain:async(raw:unknown)=>{retained.push(raw);}};
  try{if(path==='/prepare')await browser.prepareMiningClaimOriginal({...common,request:payload,method:'POST'});
   else if(path==='/submit')await browser.submitMiningOriginal({...common,request:payload});
   else if(path.includes('/review?'))await web.api.get(`/claims/mining${path}`);
   else if(path.endsWith('/continue')||path.endsWith('/continuation'))await browser.continueMiningOriginal({...common,parentClaimId:path.split('/')[1],request:payload??null});
   else await browser.claimMiningOriginal({...common,claimId:path.slice(1)});
  }catch(error){const result=received();if(!result||result.statusCode<400)throw error;}
  const result=received();if(!result)throw Error('Browser did not dispatch request');return result;
 };
 try{
  expect((await app.inject({url:'/claims/mining/status'})).statusCode).toBe(401);
  expect((await http('/status')).json().features.claims.ordered).toBe(1);
  const request={idempotencyKey:randomUUID(),profile:'ordered-v0'},prep=await browserHttp('/prepare',request);expect(prep.statusCode,prep.body).toBe(201);const prepared=prep.json();
  expect(prepared.version).toBe(2);expect(prepared.fees.feeLamports).toBe('10000');expect(prepared.transactions.map((t:{version:string})=>t.version)).toEqual(['v0','v0']);
  const p=await getMiningClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:request.idempotencyKey});if(!p)throw Error('Missing HTTP original');
  const before=await browserHttp(`/${p.claimId}/review?ordinal=0`);expect(before.statusCode,before.body).toBe(200);
  expect((await browserHttp(`/${p.claimId}/review?ordinal=1`)).statusCode).toBe(409);
  const submitSetup=await browserHttp('/submit',{claimId:p.claimId,signedTransaction:Buffer.from(f.sign(p,0)).toString('base64')});expect(submitSetup.statusCode,submitSetup.body).toBe(202);expect(f.sends).toHaveLength(1);
  const setup=await f.execute(p,0),setupView=(await browserHttp(`/${p.claimId}`)).json(),secondReview=await browserHttp(`/${p.claimId}/review?ordinal=1`);expect(secondReview.statusCode,secondReview.body).toBe(200);expect(setupView.state).toBe('retained');expect(setupView.transactions[0].settledBaseUnits).toBe('0');
  const refused=await browserHttp(`/${p.claimId}/continue`,{idempotencyKey:randomUUID()});expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.code).toBe('MINING_CLAIM_NOT_EXPIRED');
  expect((await browserHttp(`/${p.claimId}/continuation`)).json().status).toBe('unknown');f.advance();
  const childRequest={idempotencyKey:randomUUID()},continued=await browserHttp(`/${p.claimId}/continue`,childRequest);expect(continued.statusCode,continued.body).toBe(201);const link=continued.json();
  const child=await getMiningClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:childRequest.idempotencyKey});if(!child)throw Error('Missing child');
  const childReview=await browserHttp(`/${child.claimId}/review?ordinal=0`);expect(childReview.statusCode,childReview.body).toBe(200);expect(childReview.json().setup.claimId).toBe(p.claimId);
  const childWire=f.sign(child,0),submitted=await browserHttp('/submit',{claimId:child.claimId,signedTransaction:Buffer.from(childWire).toString('base64')});expect(submitted.statusCode,submitted.body).toBe(202);expect(f.sends).toHaveLength(2);
  const payment=await f.execute(child,0);expect(payment.payment).toBeGreaterThan(0n);
  await expect(runtime.sql`insert into mining_claim_receipts default values`).rejects.toMatchObject({code:'42501'});await expect(runtime.sql`insert into mining_claim_failures default values`).rejects.toMatchObject({code:'42501'});await expect(runtime.sql`select * from mining_publication_attempts`).rejects.toMatchObject({code:'42501'});
  await app.close();vi.stubEnv('PHASE_E_MINING_ENABLED','false');app=await buildApp(TEST_CONFIG,runtime.db);
  const final=(await browserHttp(`/${child.claimId}`)).json();expect(final.state).toBe('settled');expect(final.settledBaseUnits).toBe(payment.payment.toString());
  const recovered=await browserHttp(`/${p.claimId}/continuation`);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().continuation.childClaimId).toBe(child.claimId);expect(recovered.headers['cache-control']).toBe('private, no-store');
  expect(browserCalls.length).toBeGreaterThanOrEqual(12);expect(retained.length).toBeGreaterThanOrEqual(5);
  await writeFile('/tmp/phase-e-mining-ordered-http-pair.json',JSON.stringify({browserCalls,trust:{genesisHash:f.trust.expectedGenesisHash,programId:f.trust.programId.toBase58(),configAddress:p.header.configAddress,keepMint:f.trust.keepMint.toBase58(),reserveOwner:f.trust.reserveOwner.toBase58(),orderedLookupTable:p.format!.expectedLookupTable},prepared,review0:before.json(),setupWire:Buffer.from(setup.wire).toString('base64'),setupView,review1:secondReview.json(),continuation:link,childReview:childReview.json(),childWire:Buffer.from(childWire).toString('base64'),final},null,2));
 }finally{await app.close();await runtime.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
}),120000);
