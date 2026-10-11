/** Private-pipe local JVM acceptance: disposable loopback DB, real restricted
 * authenticated API, synthetic finalized bank and fixture-only buyer signature. */
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import postgres from 'postgres';
import {Keypair,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {z} from 'zod';
if(process.env['NODE_ENV']!=='test'||process.env['PHASE_E_NATIVE_PAIRED']!=='1')throw Error('Explicit native paired test mode required');
const url=new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL']??'');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname)||url.search||url.hash)throw Error('Disposable loopback fixture URL required');
const database=`phase_e_native_sale_${randomUUID().replaceAll('-','').slice(0,12)}_test`;url.pathname=`/${database}`;
process.env['TEST_DATABASE_URL']=url.toString();process.env['PHASE_E_SEEKER_ENABLED']='true';process.env['MULTI_BASE_ENABLED']='false';
for(const flag of ['PHASE_E_CATALOG_ENABLED','PHASE_E_MINING_ENABLED','GEMS_ENABLED','GEMS_WALLET_BUY_ENABLED','DEVNET_WELCOME_GEMS_ENABLED'])process.env[flag]='false';
const {realmSaleQuoteFixture}=await import('../../../../packages/chain/src/seekerRealmSaleQuote.fixture');
const {settleNativeRealmSaleBank}=await import('../../../../packages/chain/src/testFixtures/realmSalePreparedFinality');
const {buildApp}=await import('../../src/app');const {createDb}=await import('../../src/db/client');
const {runMigrations}=await import('../../src/db/migrate');const {players,sessions}=await import('../../src/db/schema');
const {getRealmSalePreparation}=await import('../../src/seeker/realmSalePreparationStore');
const {createRealmSaleSettlement}=await import('../../src/seeker/realmSaleSettlement');
const {createRealmSaleFailure}=await import('../../src/seeker/realmSaleFailure');
const {getRealmSaleSigned}=await import('../../src/seeker/realmSaleSignedStore');
const {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC}=await import('../../src/auth/session');const {TEST_CONFIG}=await import('../helpers');
const commandSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('start'),origin:z.string().regex(/^https:\/\/localhost:\d+$/)}).strict(),
 z.object({op:z.literal('request'),method:z.enum(['GET','POST']),url:z.string().max(256),headers:z.record(z.string(),z.string()),body:z.string().max(32768).optional()}).strict(),
 z.object({op:z.literal('sign'),unsigned:z.string().max(1644)}).strict(),z.object({op:z.literal('settle'),key:z.uuid()}).strict(),
 z.object({op:z.literal('fail'),key:z.uuid()}).strict(),
 z.object({op:z.literal('restart'),paused:z.boolean()}).strict(),z.object({op:z.literal('exhaustQuota')}).strict(),z.object({op:z.literal('inspect')}).strict(),z.object({op:z.literal('close')}).strict(),
]);
const adminUrl=new URL(url);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1,onnotice:()=>{}});
let created=false,closed=false,origin='',lastKey='',preparePosts=0,submitPosts=0,signatures=0,sends=0;
let owner:ReturnType<typeof createDb>|undefined,runtime:ReturnType<typeof createDb>|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
let signed:Buffer|undefined;const role=`native_sale_${randomUUID().replaceAll('-','')}`,password=randomUUID();let roleCreated=false;
const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58(),sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'native-sale-pair-r1'}};
const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password=password;
const config=()=>({...TEST_CONFIG,DATABASE_URL:runtimeUrl.toString(),WEB_ORIGIN:[origin]});
async function startApp(paused:boolean){
 process.env['PHASE_E_SEEKER_ENABLED']=paused?'false':'true';runtime=createDb(runtimeUrl.toString(),{max:4});
 app=await buildApp(config(),runtime.db,paused?{}:{realmSalePreparationSources:sources,realmSaleRelaySources:{admission:sources,transport:()=>({
  getGenesisHash:async()=>f.controls.genesisHash,getSignatureStatuses:async()=>({context:{slot:f.controls.slot},value:[null]}),getBlockHeight:async()=>f.controls.blockHeight,
  sendRawTransaction:async bytes=>{if(!signed||!Buffer.from(bytes).equals(signed))throw Error('Different native signed wire');sends++;throw Error('Lost fixture relay acknowledgement');},
 })}});await app.ready();
}
async function close(){if(closed)return;closed=true;try{await app?.close();await runtime?.sql.end();if(roleCreated&&owner)await owner.sql.unsafe(`drop owned by ${role}; drop role ${role}`);await owner?.sql.end();if(created)await admin.unsafe(`drop database ${database}`);}finally{await admin.end();}}
async function command(input:unknown):Promise<unknown>{
 const item=commandSchema.parse(input);if(item.op==='close'){await close();return {closed:true};}
 if(item.op==='start'){
  if(created||closed)throw Error('Already started');origin=item.origin;await admin.unsafe(`create database ${database}`);created=true;
  owner=createDb(url.toString(),{max:4});await runMigrations(owner.db);
  await owner.db.insert(players).values({wallet});const [session]=await owner.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  await owner.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
   grant select on players,sessions,seeker_realm_sale_preparations,seeker_realm_sale_signed_wires,seeker_realm_sale_receipts,seeker_realm_sale_failures to ${role};
   grant insert on seeker_realm_sale_preparations,seeker_realm_sale_signed_wires to ${role}`);roleCreated=true;
  await startApp(false);const jwt=await issueSessionJwt(config(),wallet,session!.id);
  return {wallet,blockHeight:f.controls.blockHeight,upgradeAuthority:f.upgradeAuthority.toBase58(),catalogue:{constants:{PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION}},
   trust:{genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision},
   cookie:`${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}`};
 }
 if(!app||!runtime||!owner||closed)throw Error('Fixture not started');
 if(item.op==='restart'){await app.close();await runtime.sql.end();await startApp(item.paused);return {restarted:true,paused:item.paused};}
 // Advance only the encoded fixture quota PDA. The real offer and preparation
 // readers still independently observe it through their unchanged RPC path.
 if(item.op==='exhaustQuota'){f.models.quota.sales=PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax;await f.repack();return {exhausted:true};}
 if(item.op==='request'){
  const allowed=item.method==='POST'?['/api/seeker/realm-sales/prepare','/api/seeker/realm-sales/submit'].includes(item.url):item.url==='/api/seeker/realm-sales/offer?spot=0&realm=0'||/^\/api\/seeker\/realm-sales\/(?:prepare\/|review\/|failures\/)?by-key\/[0-9a-f-]{36}$/.test(item.url);
  if(!allowed)throw Error('Unexpected native realm-sale path');
  if(item.method==='POST'){if(item.url.endsWith('/prepare')){preparePosts++;lastKey=z.uuid().parse(JSON.parse(item.body??'{}').idempotencyKey);}else submitPosts++;}
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
  await settleNativeRealmSaleBank(f,p,signed);await createRealmSaleSettlement(owner.db,{connect:()=>f.rpc,trust:f.accessTrust})({wallet,idempotencyKey:item.key});return {verified:true};
 }
 if(item.op==='fail'){
  if(item.key!==lastKey||!signed)throw Error('No original signed purchase');
  const original=await getRealmSaleSigned(owner.db,{wallet,idempotencyKey:item.key});if(!original?.wire)throw Error('No saved signed purchase');
  const p=original.preparation,w=original.wire,message=Message.from(Buffer.from(p.quote.messageHex,'hex'));
  if(!Buffer.from(w.signedTransactionHex,'hex').equals(signed))throw Error('Different original signed purchase');
  const fee=Number(p.quote.feeLamports)+1,preBalances=message.accountKeys.map(()=>100_000_000);
  // Failure rolls back purchase effects. Only the fixture payer's actual network
  // fee is charged; the encoded quota/access bank remains exactly as prepared.
  const transaction:VersionedTransactionResponse={slot:f.controls.slot+1,blockTime:null,version:'legacy',transaction:{message,signatures:[w.signature]},
   meta:{err:{InstructionError:[message.instructions.length-1,{Custom:9}]},fee,preBalances,postBalances:preBalances.map((n,i)=>n-(i===0?fee:0)),preTokenBalances:[],postTokenBalances:[]}};
  f.controls.slot+=2;await f.repack();
  const failure=await createRealmSaleFailure(owner.db,{connect:()=>({...f.rpc,getTransaction:async()=>transaction}),trust:f.accessTrust})({wallet,idempotencyKey:item.key});
  return {verified:true,feeLamports:failure.receipt.feeLamports,quotaSales:f.models.quota.sales,accessExpiresAt:f.models.access.expires_at.toString()};
 }
 return {preparePosts,submitPosts,signatures,sends,preparations:await owner.sql`select idempotency_key from seeker_realm_sale_preparations where wallet=${wallet}`,
  receipts:await owner.sql`select idempotency_key from seeker_realm_sale_receipts where wallet=${wallet}`,
  failures:await owner.sql`select idempotency_key from seeker_realm_sale_failures where wallet=${wallet}`,
  wires:await owner.sql`select idempotency_key from seeker_realm_sale_signed_wires where wallet=${wallet}`};
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
try{for await(const line of lines){try{process.stdout.write(`NATIVE_REALM_SALES_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`);if(closed)break;}catch(error){process.stdout.write(`NATIVE_REALM_SALES_FIXTURE:${JSON.stringify({error:error instanceof Error?error.message:'Fixture failed'})}\n`);process.exitCode=1;break;}}}finally{await close();lines.close();}
