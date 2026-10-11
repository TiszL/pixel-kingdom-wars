/** Encoded RPC banks over real loopback transport and actual SQL payment
 * custody. Separate fixture listeners do not claim live provider independence. */
import {createServer,type Server} from 'node:http';
import {Keypair,Message,PublicKey,VersionedMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {createKeepEquipmentRuntime,type KeepEquipmentRuntimeConfiguration} from '../src/game/keepEquipmentRuntime';
import {createKeepEquipmentPayments} from '../src/game/keepEquipmentPayments';
import {createKeepEquipmentReleases} from '../src/game/keepEquipmentReleases';
import {createKeepEquipmentMarketProvider} from '../src/game/keepEquipmentMarketProvider';
import {paymentFixture,paymentStock} from './fixtures/keepEquipmentPayments';
import {connectTestDb} from './helpers';

const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
const key=()=>Keypair.generate().publicKey.toBase58();
function configured():KeepEquipmentRuntimeConfiguration{return {nodeEnv:'test',readRpcUrls:['http://127.0.0.1:20001','http://127.0.0.1:20002'],readProviders:['reviewed-a','reviewed-b'],
 trust:{expectedGenesisHash:key(),expectedKeepMint:key(),providerIds:['reviewed-a','reviewed-b'],minContextSlot:1,deadlineMs:5000,transactionVersion:'legacy',maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000}};}
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback port');return `http://127.0.0.1:${address.port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
it('requires complete admitted trust and distinct reviewed sources before exposing only bounded read methods',()=>{
 expect(createKeepEquipmentRuntime()).toBeNull();const input=configured();
 for(const patch of [
  {readRpcUrls:[input.readRpcUrls[0],input.readRpcUrls[0]+'/']},
  {readProviders:['reviewed-a','reviewed-a']},
  {readProviders:['other-a','other-b']},
  {readRpcUrls:['https://one.example/a','https://one.example/b']},
  {readRpcUrls:['https://one.example./a','https://ONE.EXAMPLE/b']},
  {readRpcUrls:['https://one.example/#redirect','https://two.example']},
  {trust:{...input.trust,maxPriorityFeeLamports:input.trust.maxFeeLamports+1n}},
  {trust:{...input.trust,expectedKeepMint:PublicKey.default.toBase58()}},
  {trust:{...input.trust,deadlineMs:60_001}},
 ])expect(()=>createKeepEquipmentRuntime({...input,...patch} as KeepEquipmentRuntimeConfiguration)).toThrow();
 expect(()=>createKeepEquipmentRuntime({...input,nodeEnv:'production'})).toThrow();
 const runtime=createKeepEquipmentRuntime(input)!;
 try{
  expect(Object.isFrozen(runtime.sources)).toBe(true);expect(runtime.sources.payments.broadcastConnect).toBeUndefined();
  expect(Object.keys(runtime.sources.payments.preparationConnect![0](new AbortController().signal)).sort()).toEqual(['getBlockHeight','getFeeForMessage','getGenesisHash','getLatestBlockhashAndContext','getMinimumBalanceForRentExemption','getMultipleAccountsInfoAndContext','getSlot','isBlockhashValid']);
  expect(Object.keys(runtime.sources.payments.finalityConnect![0](new AbortController().signal)).sort()).toEqual(['getGenesisHash','getSlot','getTransaction']);
  expect(runtime.sources.releases.failureConnect).toBe(runtime.sources.payments.finalityConnect);
 }finally{runtime.close();}
});

it('cancels a real stalled request and prevents retained methods from starting after close',async()=>{
 let arrived!:()=>void,calls=0;const entered=new Promise<void>(resolve=>arrived=resolve),server=createServer(()=>{calls++;arrived();}),url=await listen(server);
 const input=configured(),runtime=createKeepEquipmentRuntime({...input,readRpcUrls:[url,input.readRpcUrls[1]]})!,caller=new AbortController();
 const read=runtime.sources.payments.finalityConnect![0](caller.signal).getGenesisHash;
 try{const pending=read(),refused=expect(pending).rejects.toThrow();await entered;caller.abort();await refused;await expect(read()).rejects.toThrow();
  const retained=runtime.sources.payments.finalityConnect![0](new AbortController().signal).getGenesisHash;runtime.close();await expect(retained()).rejects.toThrow();expect(calls).toBe(1);
  expect(()=>runtime.sources.payments.finalityConnect![0](new AbortController().signal)).toThrow();
 }finally{runtime.close();await close(server);}
});

it.each(['oversize','redirect'] as const)('refuses %s responses without following another endpoint',async mode=>{
 let calls=0;const server=createServer((_req,res)=>{calls++;if(mode==='redirect'){res.writeHead(302,{location:'/other'});res.end();}else{res.setHeader('content-type','application/json');res.end('x'.repeat(1024*1024+1));}}),url=await listen(server),input=configured();
 const runtime=createKeepEquipmentRuntime({...input,readRpcUrls:[url,input.readRpcUrls[1]]})!;
 try{await expect(runtime.sources.payments.finalityConnect![0](new AbortController().signal).getGenesisHash()).rejects.toThrow();expect(calls).toBe(1);}
 finally{runtime.close();await close(server);}
});

async function banks(f:Awaited<ReturnType<typeof paymentFixture>>){
 const state={slot:100,outcome:'missing' as 'missing'|'success'|'failed',sent:[] as Uint8Array[],calls:[[] as string[],[] as string[],[] as string[]]};
 const servers=[0,1,2].map(peer=>createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw) as {id:string;method:string;params:any[]};state.calls[peer]!.push(body.method);
  const signal=new AbortController().signal,p=f.deps.preparationConnect[Math.min(peer,1)]!(signal);let result:unknown;
  if(body.method==='getGenesisHash')result=f.genesis;
  else if(body.method==='getSlot'){expect(body.params[0].commitment).toBe('finalized');result=state.slot;}
  else if(peer===2&&body.method==='sendTransaction'){
   // web3.js omits the false default when serializing this explicit option.
   expect(body.params[1].skipPreflight??false).toBe(false);expect(body.params[1]).toMatchObject({encoding:'base64',preflightCommitment:'finalized',maxRetries:0,minContextSlot:state.slot});
   const bytes=Buffer.from(body.params[0],'base64');expect(bytes.toString('hex')).toBe(Buffer.from(f.controls.wire!).toString('hex'));state.sent.push(Uint8Array.from(bytes));result=bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);
  }else if(peer===2)throw Error('Relay received a read outside its narrow source');
  else if(body.method==='getMultipleAccounts'){
   const accounts=await p.getMultipleAccountsInfoAndContext(body.params[0].map((v:string)=>new PublicKey(v)),body.params[1]);
   result={context:{slot:state.slot},value:accounts.value.map(row=>row?{...row,owner:row.owner.toBase58(),data:[Buffer.from(row.data).toString('base64'),'base64'],rentEpoch:0}:null)};
  }else if(body.method==='getMinimumBalanceForRentExemption')result=await p.getMinimumBalanceForRentExemption(body.params[0],body.params[1].commitment);
  else if(body.method==='getLatestBlockhash')result=await p.getLatestBlockhashAndContext(body.params[0]);
  else if(body.method==='getFeeForMessage'){
   const bytes=Buffer.from(body.params[0],'base64'),m=f.trust.transactionVersion==='legacy'?Message.from(bytes):VersionedMessage.deserialize(bytes);
   const fee=await p.getFeeForMessage(m,body.params[1].commitment);result={...fee,context:{slot:state.slot}};
  }else if(body.method==='isBlockhashValid'){const valid=await p.isBlockhashValid(body.params[0],body.params[1]);result={...valid,context:{slot:state.slot}};}
  else if(body.method==='getBlockHeight')result=await p.getBlockHeight(body.params[0]);
  else if(body.method==='getTransaction'){
   const tx=state.outcome==='missing'?null:await f.deps.finalityConnect[peer]!(signal).getTransaction(body.params[0],body.params[1]);
   if(!tx)result=null;else{
    if(state.outcome==='failed'){tx.meta!.err={InstructionError:[0,'InvalidArgument']};tx.meta!.postBalances=tx.meta!.preBalances.map((value,i)=>value-(i===0?tx.meta!.fee:0));tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances??null);tx.meta!.innerInstructions=[];}
    const message=tx.transaction.message;result={...tx,meta:{...tx.meta,loadedAddresses:{writable:[],readonly:[]}},transaction:{signatures:tx.transaction.signatures,message:{header:message.header,accountKeys:message.staticAccountKeys.map(key=>key.toBase58()),recentBlockhash:message.recentBlockhash,
     instructions:message.compiledInstructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:ix.accountKeyIndexes,data:bs58.encode(ix.data)})),...(message.version===0?{addressTableLookups:[]}:{}),}}};
   }
  }else throw Error('Unexpected RPC '+body.method);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 }catch(error){res.statusCode=500;res.end(String(error));}}));
 const urls=await Promise.all(servers.map(listen));return {state,urls,close:()=>Promise.all(servers.map(close))};
}

it.each([['legacy','success'],[0,'failed']] as const)('uses two encoded %s read sources and one explicit original relay before %s settlement',async(version,outcome)=>{
 vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','true');
 const f=await paymentFixture(conn,version),rpc=await banks(f),input:KeepEquipmentRuntimeConfiguration={nodeEnv:'test',trust:{...f.trust,deadlineMs:5000},readProviders:f.trust.providerIds,
  readRpcUrls:[rpc.urls[0]!,rpc.urls[1]!],broadcastRpcUrl:rpc.urls[2]!};
 const runtime=createKeepEquipmentRuntime(input)!,payments=createKeepEquipmentMarketProvider(conn.db,runtime.sources),release=createKeepEquipmentReleases(conn.db,runtime.sources.releases);
 try{
  const wrong=createKeepEquipmentRuntime({...input,trust:{...input.trust,expectedGenesisHash:key()}})!;
  try{await expect(createKeepEquipmentMarketProvider(conn.db,wrong.sources).prepare(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PREPARATION_UNAVAILABLE'});}finally{wrong.close();}
  f.controls.preparationMode='disagree';await expect(payments.prepare(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PREPARATION_UNAVAILABLE'});
  expect(await conn.sql`select fill_id from keep_equipment_payment_preparations where fill_id=${f.fill.id}`).toHaveLength(0);f.controls.preparationMode='ok';
  const prepared=await payments.prepare(f.buyer.wallet,f.fill.id);f.controls.preparation=prepared.preparation;
  expect(rpc.state.sent).toHaveLength(0);expect(rpc.state.calls[2]).toHaveLength(0);
  const wire=f.sign(prepared.preparation!);f.controls.wire=wire;await payments.retainSigned(f.buyer.wallet,f.fill.id,wire);rpc.state.slot=120;
  // Capture immutable URLs and trust before mutating the caller's configuration.
  Reflect.set(input.readRpcUrls,0,'http://127.0.0.1:1');(input.trust as {expectedKeepMint:string}).expectedKeepMint=key();
  const sent=await payments.deliver(f.buyer.wallet,f.fill.id);expect(sent.status,JSON.stringify({reason:sent.reason,calls:rpc.state.calls})).toBe('submitted');expect(rpc.state.sent).toHaveLength(1);expect(rpc.state.calls.slice(0,2).flat()).not.toContain('sendTransaction');
  rpc.state.outcome=outcome;
  if(outcome==='success'){
   f.controls.finalityMode='disagree';await expect(payments.recover(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE'});
   expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});f.controls.finalityMode='ok';
   const done=await payments.recover(f.buyer.wallet,f.fill.id);expect(done.status).toBe('delivered');expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'2',market_incoming:'0'});
   runtime.close();expect(await createKeepEquipmentPayments(conn.db).recover(f.buyer.wallet,f.fill.id)).toEqual(done);
  }else{
   const done=await release.release(f.buyer.wallet,f.fill.id);expect(done.reason).toBe('finalized_failed');expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
   runtime.close();expect(await createKeepEquipmentReleases(conn.db).release(f.buyer.wallet,f.fill.id)).toEqual(done);
  }
  expect(rpc.state.sent).toHaveLength(1);expect(rpc.state.calls[2]).toEqual(['getGenesisHash','getSlot','sendTransaction']);
 }finally{runtime.close();await rpc.close();}
},120_000);
