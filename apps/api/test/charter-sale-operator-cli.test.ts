/** CLI dispatch exercises the closed operator boundary. Actual epoch/role and
 * configured source acceptance lives in charter-configured-runtime.test.ts. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PublicKey} from '@solana/web3.js';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import {expect,it,vi} from 'vitest';
import {main,openCharterSaleOperatorSession,type CharterSaleOperatorCliIo,type CharterSaleOperatorSession} from '../src/game/charterSaleOperatorCli';
import {DIVINE_OPERATOR_INPUT_BYTES,readDivineOperatorInput} from '../src/game/divineOperatorCli';
import {HttpError} from '../src/lib/errors';
import {loadConfig} from '../src/config';
import {createDb} from '../src/db/client';
import {charterSalesFixture} from './fixtures/charterSales';
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const base={NODE_ENV:'test',DATABASE_URL:'postgres://request:test@127.0.0.1:5433/test',PHASE_E_SERVICE_DATABASE_URL:'postgres://owner:test@127.0.0.1:5433/test',JWT_SECRET:'x'.repeat(32),WEB_ORIGIN:'http://localhost:5173'};
const env={...base,CHARTER_RECOVERY_ECONOMY_PROGRAM_ID:key(3),CHARTER_RECOVERY_CRAFT_PROGRAM_ID:key(4),CHARTER_RECOVERY_STATE_PROVENANCE:'fresh-reviewed-deployment',
 ...Object.fromEntries(['ECONOMY','CRAFT','CORE'].flatMap(f=>[[`CHARTER_RECOVERY_${f}_DEPLOYMENT_SLOT`,'1'],[`CHARTER_RECOVERY_${f}_PROGRAM_DATA_SHA256`,'a'.repeat(64)],[`CHARTER_RECOVERY_${f}_UPGRADE_AUTHORITY`,'none']])),
 CHARTER_POLICY_ISSUER_URL:'https://issuer.invalid',CHARTER_POLICY_ISSUER_PUBLIC_KEY:key(5),CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE:'/fixture/not-loaded',
 CHARTER_WORKFLOW_METADATA_URI_PREFIX:'https://invalid.example/charters/',CHARTER_WORKFLOW_SALE_TREASURY:key(6),CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS:key(7),CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256:'b'.repeat(64),CHARTER_WORKFLOW_CORE_COST_PROFILE:'mpl-core-0.15.2-charter-pfd-seq-none',CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS:'100000',CHARTER_WORKFLOW_MAX_RENT_LAMPORTS:'100000',CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS:'2000000',CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS:'200000'};
function fixture(body:unknown){
 const result={version:1,id:'original-sale-epoch',domain:{genesisHash:key(1),economyProgram:key(3),craftProgram:key(4),treasury:key(6)}},
  operator={initializeSaleEpoch:vi.fn().mockResolvedValue(result)},close=vi.fn(),openSession=vi.fn().mockResolvedValue({operator,close}),print=vi.fn(),printError=vi.fn();
 const io:CharterSaleOperatorCliIo={readInput:async()=>JSON.stringify(body),openSession,print,printError};return {result,operator,close,openSession,print,printError,io};
}
it('dispatches the explicit empty command once through the configured closed session and closes it',async()=>{
 const f=fixture({});expect(await main(['initialize-epoch','--input','epoch.json'],env,f.io)).toBe(0);
 expect(f.openSession).toHaveBeenCalledTimes(1);expect(f.operator.initializeSaleEpoch).toHaveBeenCalledExactlyOnceWith();expect(f.close).toHaveBeenCalledTimes(1);
 expect(JSON.parse(f.print.mock.calls[0]![0])).toEqual({command:'initialize-epoch',result:f.result});expect(f.printError).not.toHaveBeenCalled();
});
it('refuses other actions, duplicate inputs and caller-selected epoch/domain before opening any source',async()=>{
 for(const args of [[],['initialize-epoch'],['initialize-epoch','--input','x','--replace'],['initialize-epoch','--input','x','--input','y'],['initialize-epoch','extra','--input','x'],['fund-and-enroll','--input','x']]){
  const f=fixture({});expect(await main(args,env,f.io)).toBe(2);expect(f.openSession).not.toHaveBeenCalled();
 }
 for(const body of [null,[],{epochId:'old'},{domain:{treasury:key(9)}},{policy:{royaltyBps:0}}]){
  const f=fixture(body);expect(await main(['initialize-epoch','--input','x'],env,f.io)).toBe(2);expect(f.openSession).not.toHaveBeenCalled();
 }
 const f=fixture({});for(const input of ['{',' '.repeat(DIVINE_OPERATOR_INPUT_BYTES)+'{}']){
  expect(await main(['initialize-epoch','--input','x'],env,{...f.io,readInput:async()=>input})).toBe(2);expect(f.openSession).not.toHaveBeenCalled();
 }
});
it('requires the complete configured current authority before session construction',async()=>{
 for(const selected of [base,{...env,PHASE_E_SERVICE_DATABASE_URL:''},{...env,CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256:''},{...env,CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE:''},{...env,CHARTER_RECOVERY_ECONOMY_PROGRAM_ID:''}]){
  const f=fixture({});expect(await main(['initialize-epoch','--input','x'],selected,f.io)).toBe(1);expect(f.openSession).not.toHaveBeenCalled();expect(f.operator.initializeSaleEpoch).not.toHaveBeenCalled();
 }
});
it('holds a refused or uncertain original without retry, sanitizes errors and closes the private session',async()=>{
 for(const error of [new HttpError(503,'private detail','CLAN_CHARTER_SALE_DISABLED'),Error('postgres://owner:secret@host/db')]){
  const f=fixture({});f.operator.initializeSaleEpoch.mockRejectedValue(error);
  expect(await main(['initialize-epoch','--input','x'],env,f.io)).toBe(1);expect(f.operator.initializeSaleEpoch).toHaveBeenCalledTimes(1);expect(f.close).toHaveBeenCalledTimes(1);expect(f.print).not.toHaveBeenCalled();
  expect(f.printError.mock.calls.flat().join()).not.toMatch(/secret|postgres|private detail/);
 }
 const f=fixture({});f.close.mockRejectedValue(Error('private cleanup secret'));expect(await main(['initialize-epoch','--input','x'],env,f.io)).toBe(1);expect(f.operator.initializeSaleEpoch).toHaveBeenCalledTimes(1);expect(f.printError.mock.calls.flat().join()).not.toContain('secret');
});
it('opens the real private session without creating an epoch and explicitly initializes one exactly once across restarts',async()=>{
 const f=await charterSalesFixture({domain:{genesisHash:SOLANA_GENESIS_HASH.devnet,economyProgram:key(21)}}),dir=await mkdtemp(join(tmpdir(),'charter-sale-operator-'));
 const suffix=randomUUID().replaceAll('-',''),role='sale_api_'+suffix,worker='sale_worker_'+suffix,methods:string[]=[];
 const rpc=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body) as {id:unknown;method:string};methods.push(input.method);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:SOLANA_GENESIS_HASH.devnet}));});
 let session:CharterSaleOperatorSession|undefined,request:ReturnType<typeof createDb>|undefined,provisioned=false;
 try{
  await new Promise<void>(resolve=>rpc.listen(0,'127.0.0.1',resolve));const address=rpc.address();if(!address||typeof address==='string')throw Error('Fixture RPC missing');
  const owner=await f.ownerUrl(),requestUrl=new URL(owner);requestUrl.username=role;requestUrl.password=randomBytes(32).toString('hex');
  const registry={cluster:'devnet',coreProgram:key(22),keepMint:key(23),config:key(24),deedCollection:f.buyer.collection,treasuries:{liquidity:key(25),dev:key(26),ops:key(27)}};
  // Owned fixture setup supplies its public registry/identity; the command must
  // only read it. No old epoch/history is deleted or rewritten for this case.
  expect(await f.sql`select * from economy_chain_identity`).toHaveLength(0);
  await f.sql`insert into economy_chain_identity(cluster,keep_mint,core_program,config_pda) values('devnet',${registry.keepMint},${registry.coreProgram},${registry.config})`;
  await mkdir(join(dir,'infra'));await writeFile(join(dir,'infra/devnet.addresses.json'),JSON.stringify(registry));
  const input=join(dir,'epoch.json'),tokenFile=join(dir,'token');await writeFile(input,'{}');await writeFile(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
  execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:owner.hostname,PGPORT:owner.port,PGDATABASE:owner.pathname.slice(1),PGUSER:decodeURIComponent(owner.username),PGPASSWORD:decodeURIComponent(owner.password),POSTGRES_USER:decodeURIComponent(owner.username),POSTGRES_PASSWORD:decodeURIComponent(owner.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:requestUrl.password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});provisioned=true;
  const selected={...env,REPO_ROOT:dir,SOLANA_CLUSTER:'devnet',SOLANA_RPC_URL:`http://127.0.0.1:${address.port}`,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:owner.toString(),CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE:tokenFile,
   CHARTER_RECOVERY_ECONOMY_PROGRAM_ID:f.domain.economyProgram,CHARTER_RECOVERY_CRAFT_PROGRAM_ID:f.domain.craftProgram,CHARTER_WORKFLOW_SALE_TREASURY:f.domain.treasury};
  const before=await f.salesSnapshot(),identity=await f.sql`select * from economy_chain_identity`;
  expect(await f.sql`select * from charter_sale_epochs`).toHaveLength(0);
  session=await openCharterSaleOperatorSession(loadConfig(selected));expect(Object.keys(session.operator)).toEqual(['initializeSaleEpoch']);
  expect(await f.sql`select * from charter_sale_epochs`).toHaveLength(0);expect(await f.salesSnapshot()).toBe(before);
  await session.close();await session.close();session=undefined;
  request=createDb(requestUrl.toString(),{max:1});await expect(request.sql`select * from charter_sale_epochs`).rejects.toMatchObject({code:'42501'});
  const print=vi.fn(),printError=vi.fn(),io:CharterSaleOperatorCliIo={readInput:readDivineOperatorInput,openSession:openCharterSaleOperatorSession,print,printError};
  for(let pass=0;pass<2;pass++)expect(await main(['initialize-epoch','--input',input],selected,io)).toBe(0);
  const first=JSON.parse(print.mock.calls[0]![0]),again=JSON.parse(print.mock.calls[1]![0]);expect(again).toEqual(first);expect(first.result.domain).toEqual(f.domain);
  expect(await f.sql`select id from charter_sale_epochs`).toEqual([{id:first.result.id}]);expect(await f.salesSnapshot()).toBe(before);expect(await f.sql`select * from economy_chain_identity`).toEqual(identity);
  expect(methods).toEqual(['getGenesisHash','getGenesisHash','getGenesisHash']);expect(printError).not.toHaveBeenCalled();
 }finally{
  await session?.close();await request?.sql.end();if(provisioned)for(const name of [role,worker])await f.sql.unsafe(`drop owned by ${name};drop role ${name}`);
  rpc.closeAllConnections();await new Promise<void>(resolve=>rpc.close(()=>resolve()));await rm(dir,{recursive:true,force:true});await f.dispose();
 }
},120000);
