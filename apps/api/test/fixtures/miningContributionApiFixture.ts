/** Private pipe + optional loopback HTTP bridge to the REAL authenticated API.
 * Disposable SQL only, synthetic opening materials, no live account or chain. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createServer,type Server } from 'node:http';
import { PublicKey,Keypair } from '@solana/web3.js';
import postgres from 'postgres';
import { z } from 'zod';
import { PHASE_E_MINING_SCORE_POLICY as SCORE } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { ORDINARY_REFINED_IDS } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { buildApp } from '../../src/app';
import { createMiningContributionProvider } from '../../src/game/miningContributionRoutes';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC } from '../../src/auth/session';
import { bootstrapSystemAccounts,getOrCreatePlayerAccount } from '../../src/ledger';
import { rewardBaseShards } from '../../src/game/baseEconomy';
import { readMiningContribution } from '../../src/game/miningContributions';

if(process.env.NODE_ENV!=='test'||process.env.PHASE_E_NATIVE_PAIRED!=='1')throw Error('Explicit paired test mode required');
const url=new URL(process.env.PHASE_E_NATIVE_TEST_DATABASE_URL??'');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)
 ||!/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname)||url.search||url.hash)throw Error('Disposable loopback database required');
const database=`phase_e_native_mining_${randomUUID().replaceAll('-','').slice(0,12)}_test`;url.pathname=`/${database}`;
process.env.TEST_DATABASE_URL=url.toString();
for(const flag of ['GEMS_ENABLED','GEMS_WALLET_BUY_ENABLED','DEVNET_WELCOME_GEMS_ENABLED','PHASE_E_SEEKER_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_CHARTER_ENABLED'])process.env[flag]='false';
process.env.MULTI_BASE_ENABLED='false';process.env.FREE_ONBOARDING='true';
const {TEST_CONFIG}=await import('../helpers');
const adminUrl=new URL(url);adminUrl.pathname='/postgres';
const admin=postgres(adminUrl.toString(),{max:1,onnotice:()=>{}});
const RealDate=Date;let offset=0;
// Test-only clock control cannot be supplied through any API request or header.
globalThis.Date=new Proxy(RealDate,{construct(target,args,newTarget){return Reflect.construct(target,args.length?args:[RealDate.now()+offset],newTarget);},
 get(target,key,receiver){return key==='now'?()=>RealDate.now()+offset:Reflect.get(target,key,receiver);}});
const schema=z.discriminatedUnion('op',[
 z.object({op:z.literal('start'),origin:z.string().url(),listen:z.boolean().optional()}).strict(),
 z.object({op:z.literal('request'),method:z.enum(['GET','POST']),url:z.string().max(512),headers:z.record(z.string(),z.string()),body:z.string().max(32768).optional()}).strict(),
 z.object({op:z.literal('pause'),paused:z.boolean()}).strict(),z.object({op:z.literal('day'),offsetDays:z.number().int().min(0).max(2)}).strict(),
 z.object({op:z.literal('transfer')}).strict(),z.object({op:z.literal('deed')}).strict(),
 z.object({op:z.literal('inspect'),key:z.uuid().optional()}).strict(),z.object({op:z.literal('close')}).strict(),
]);
let created=false,closed=false,connection:ReturnType<typeof createDb>|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined,server:Server|undefined;
let wallet='',buyer='',baseId='',posts=0,origin='';const asset=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();
let currentOwner='';
const config=()=>({...TEST_CONFIG,DATABASE_URL:url.toString(),WEB_ORIGIN:[origin]});
async function close(){if(closed)return;closed=true;try{if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));await app?.close();await connection?.sql.end();if(created)await admin.unsafe(`DROP DATABASE ${database}`);}finally{globalThis.Date=RealDate;await admin.end();}}
async function request(method:'GET'|'POST',path:string,headers:Record<string,string>,body?:string){
 const normalized=path.startsWith('/api/')?path.slice(4):path,pathname=normalized.split('?')[0];
 if(!app||!(method==='POST'?pathname==='/mining/contributions':pathname==='/mining/contributions'||/^\/mining\/contributions\/by-key\/[0-9a-f-]{36}$/.test(pathname!)))throw Error('Unexpected fixture route');
 if(method==='POST')posts++;
 return app.inject({method,url:normalized,headers,...body===undefined?{}:{payload:body}});
}
async function command(raw:unknown):Promise<unknown>{
 const item=schema.parse(raw);
 if(item.op==='close'){await close();return{closed:true};}
 if(item.op==='start'){
  if(created||closed)throw Error('Already started');const allowedOrigin=new URL(item.origin);if(!['http:','https:'].includes(allowedOrigin.protocol)||!['localhost','127.0.0.1','[::1]'].includes(allowedOrigin.hostname))throw Error('Loopback origin required');origin=item.origin;
  await admin.unsafe(`CREATE DATABASE ${database}`);created=true;connection=createDb(url.toString(),{max:4});await runMigrations(connection.db);await bootstrapSystemAccounts(connection.db);
  // Deed authority requires a signable wallet, not the ledger helper's random bytes.
  wallet=Keypair.generate().publicKey.toBase58();buyer=Keypair.generate().publicKey.toBase58();
  for(const actor of [wallet,buyer]){await connection.sql`insert into players(wallet) values(${actor})`;await getOrCreatePlayerAccount(connection.db,actor,'player_keep');}
  currentOwner=wallet;baseId=randomUUID();
  await connection.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},${SCORE.requiredLevel.keep})`;
  await connection.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  for(const[i,type]of(['keep','workshop','goldforge']as const).entries())await connection.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},${type},${SCORE.requiredLevel[type]},${10+i*4},10)`;
  for(const resourceId of PHASE_E_RAW_RESOURCE_IDS)await connection.sql`insert into resource_stocks(base_id,resource_id,available) values(${baseId},${resourceId},1000)`;
  for(const itemId of [...ORDINARY_REFINED_IDS,'navigation_kit'])await connection.sql`insert into crafting_stocks(base_id,item_id,available) values(${baseId},${itemId},10)`;
  await rewardBaseShards(connection.db,baseId,30_000n,'test.mining_http_pair',randomUUID());
  const [session]=await connection.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;
  const jwt=await issueSessionJwt(config(),wallet,session!.id);
  const market={deedCollection:collection,finalizedDeedReader:async(mint:string)=>{
   if(new PublicKey(mint).toBase58()!==asset)throw Error('Unexpected fixture mint');return{owner:currentOwner,slot:100,collection,frozen:false,delegate:null};
  }};
  app=await buildApp(config(),connection.db,{market,miningContributionProvider:createMiningContributionProvider(connection.db,{market})});await app.ready();
  process.env.MULTI_BASE_ENABLED='true';process.env.PHASE_E_BUILDINGS_ENABLED='true';process.env.PHASE_E_MINING_ENABLED='true';
  let apiOrigin:string|null=null;
  if(item.listen){server=createServer(async(req,res)=>{try{
   if(!['GET','POST'].includes(req.method??''))throw Error('Unsupported method');let body='';for await(const part of req){body+=String(part);if(Buffer.byteLength(body)>32768)throw Error('Body too large');}
   const headers=Object.fromEntries(Object.entries(req.headers).flatMap(([k,v])=>v===undefined?[]:[[k,Array.isArray(v)?v.join(','):v]]));
   const reply=await request(req.method as 'GET'|'POST',req.url??'',headers,body||undefined);res.writeHead(reply.statusCode,reply.headers);res.end(reply.body);
  }catch{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'Fixture request refused'}));}});
   await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Missing loopback address');apiOrigin=`http://127.0.0.1:${address.port}`;
  }
  return{wallet,buyer,baseId,day:new Date().toISOString().slice(0,10),apiOrigin,cookie:`${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}`,sessionCookie:`${SESSION_COOKIE}=${jwt}`};
 }
 if(!connection||!app||closed)throw Error('Start required');
 if(item.op==='request'){const r=await request(item.method,item.url,item.headers,item.body);return{status:r.statusCode,body:r.body};}
 if(item.op==='pause'){process.env.PHASE_E_MINING_ENABLED=item.paused?'false':'true';return{paused:item.paused};}
 if(item.op==='day'){offset=item.offsetDays*86400000;return{day:new Date().toISOString().slice(0,10)};}
 if(item.op==='deed'){await connection.sql`update bases set land_paid_at=${new Date(Date.now()-86400000).toISOString()},deed_asset_id=${asset},deed_mint_asset_id=${asset} where id=${baseId}`;return{pool:'deed'};}
 if(item.op==='transfer'){
  await connection.sql.begin(async tx=>{await tx`select wallet from players where wallet in(${wallet},${buyer}) order by wallet for update`;await tx`select id from bases where id=${baseId} for update`;
   await tx`delete from base_slots where base_id=${baseId}`;await tx`update bases set owner_wallet=${buyer} where id=${baseId}`;await tx`insert into base_slots(wallet,slot,base_id) values(${buyer},1,${baseId})`;});
  currentOwner=buyer;return{transferred:true};
 }
 const receipts=await connection.sql`select id,total_value::text from mining_contribution_receipts where actor_wallet=${wallet} order by created_at,id`;
 return{posts,receipts,original:item.key?await readMiningContribution(connection.db,wallet,item.key):null,
  raw:await connection.sql`select resource_id,available::text,mining_pending::text from resource_stocks where base_id=${baseId} order by resource_id`,
  shards:(await connection.sql`select balance::text from accounts where base_id=${baseId} and kind='base_shards'`)[0]?.balance};
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
try{for await(const line of input){try{process.stdout.write(`MINING_CONTRIBUTION_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`);if(closed)break;}
 catch(error){process.stdout.write(`MINING_CONTRIBUTION_FIXTURE:${JSON.stringify({error:error instanceof Error?error.message:'Fixture failed'})}\n`);process.exitCode=1;break;}}}
finally{await close();}
