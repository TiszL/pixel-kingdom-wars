/** Private-pipe JVM acceptance over this run's owned loopback database and
 * fixture signer/banks. Never public RPC, production credentials or live funds. */
import {createInterface} from 'node:readline';
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION,TOKEN} from '@shardkeep/shared';
if(process.env['NODE_ENV']!=='test'||process.env['PHASE_E_NATIVE_PAIRED']!=='1')throw Error('Explicit native paired test mode required');
const url=new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL']??'');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname)||url.search||url.hash)throw Error('Disposable loopback fixture URL required');
process.env['TEST_DATABASE_URL']=url.toString();const admin=new URL(url);admin.pathname='/postgres';process.env['TEST_ADMIN_DATABASE_URL']=admin.toString();
for(const flag of ['PHASE_E_CATALOG_ENABLED','PHASE_E_SEEKER_ENABLED','GEMS_ENABLED','GEMS_WALLET_BUY_ENABLED','DEVNET_WELCOME_GEMS_ENABLED','MULTI_BASE_ENABLED'])process.env[flag]='false';
const {withMiningTaxApiFixture}=await import('./miningTaxApi');
const {SOLANA_GENESIS_HASH}=await import('../../../../packages/chain/src/cluster');
type Fixture=Parameters<Parameters<typeof withMiningTaxApiFixture>[0]>[0];
const commandSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('start'),mode:z.enum(['claim','combined','split']),origin:z.string().regex(/^https:\/\/localhost:\d+$/),continuationKey:z.uuid().optional()}).strict(),
 z.object({op:z.literal('request'),method:z.enum(['GET','POST']),url:z.string().max(256),headers:z.record(z.string(),z.string()),body:z.string().max(32768).optional()}).strict(),
 z.object({op:z.literal('sign'),unsigned:z.string().max(1644),key:z.uuid(),ordinal:z.number().int().min(0).max(1)}).strict(),
 z.object({op:z.literal('settle'),key:z.uuid(),ordinal:z.number().int().min(0).max(1),setupFee:z.number().int().nonnegative().optional()}).strict(),
 z.object({op:z.literal('fail'),key:z.uuid(),ordinal:z.number().int().min(0).max(1),fee:z.number().int().nonnegative().optional()}).strict(),
 z.object({op:z.literal('advance'),expired:z.boolean()}).strict(),
 z.object({op:z.literal('restart'),paused:z.boolean()}).strict(),z.object({op:z.literal('inspect')}).strict(),z.object({op:z.literal('close')}).strict(),
]);
let continuationEnabled=false;
let fixture:Fixture|undefined,started=false,closed=false,finish:(()=>void)|undefined,work:Promise<void>|undefined;
async function close(){if(closed)return;closed=true;finish?.();await work;}
async function command(value:unknown):Promise<unknown>{
 const item=commandSchema.parse(value);if(item.op==='close'){await close();return {closed:true};}
 if(item.op==='start'){
  if(started||closed)throw Error('Already started');if(item.continuationKey&&item.mode!=='split')throw Error('Continuation requires split fixture');started=true;continuationEnabled=item.continuationKey!==undefined;
  let ready!:(f:Fixture)=>void,failed!:(e:unknown)=>void;const opened=new Promise<Fixture>((resolve,reject)=>{ready=resolve;failed=reject;});
  const untilClosed=new Promise<void>(resolve=>{finish=resolve;});
  work=withMiningTaxApiFixture(async f=>{fixture=f;ready(f);await untilClosed;},{mode:item.mode,origin:item.origin,genesisHash:SOLANA_GENESIS_HASH.devnet,loseRelay:true,...(item.continuationKey?{continuationKey:item.continuationKey}:{})});
  void work.catch(failed);const f=await opened,p=f.preparation;
  return {wallet:p.wallet,cookie:f.cookieHeader,blockHeight:f.blockHeight,trust:f.trust,preparation:p,
   request:{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:p.caps},catalogue:{constants:{PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION,TOKEN}}};
 }
 if(!fixture||closed)throw Error('Fixture not started');
 if(item.op==='request'){
  if(!item.url.startsWith('/api/claims/mining-tax/'))throw Error('Unexpected native tax path');
  return fixture.request({method:item.method,url:item.url.slice('/api'.length),headers:item.headers,...(item.body===undefined?{}:{body:item.body})});
 }
 if(item.op==='advance'){
  if(!continuationEnabled)throw Error('Continuation fixture required');
  fixture.chain.control.now=new Date(Date.parse(fixture.preparation.expiresAt)+1);
  fixture.chain.control.height=fixture.preparation.lastValidBlockHeight+(item.expired?1:0);
  return {blockHeight:fixture.chain.control.height};
 }
 if(item.op==='sign')return fixture.sign(item);
 if(item.op==='settle'){await fixture.settle({key:item.key,ordinal:item.ordinal,...(item.setupFee===undefined?{}:{setupFee:item.setupFee})});return {verified:true};}
 if(item.op==='fail'){await fixture.fail({key:item.key,ordinal:item.ordinal,...(item.fee===undefined?{}:{fee:item.fee})});return {verified:true};}
 if(item.op==='restart'){await fixture.restart(item.paused);return {restarted:true,paused:item.paused};}
 return fixture.inspect();
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
try{for await(const line of lines){try{process.stdout.write(`NATIVE_MINING_TAX_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`);if(closed)break;}catch(error){process.stdout.write(`NATIVE_MINING_TAX_FIXTURE:${JSON.stringify({error:error instanceof Error?error.message:'Fixture failed'})}\n`);process.exitCode=1;break;}}}finally{await close();lines.close();}
