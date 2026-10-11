/** Disposable loopback bank/SQL resources for the manual full API fixture.
 * Nothing is reused or deployed. Cleanup addresses only IDs/PIDs created here. */
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWriteStream} from 'node:fs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Connection,Keypair,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {TOKEN} from '@shardkeep/shared';

const execute=promisify(execFile),pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const tokenProgram=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),associatedProgram=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const localKeepAta=(mint:PublicKey,wallet:PublicKey)=>PublicKey.findProgramAddressSync([wallet.toBuffer(),tokenProgram.toBuffer(),mint.toBuffer()],associatedProgram)[0];
async function available(port:number){await new Promise<void>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(error):resolve()));});}
export async function openKeepEquipmentLocal(){
 const directory=await mkdtemp('/tmp/phase-e-keep-market-api-'),name='phase-e-keep-local-'+randomUUID().replaceAll('-','').slice(0,12),containers:string[]=[],creating=new Set<Promise<string>>();
 const controller=new AbortController(),funder=Keypair.generate();let validator:ReturnType<typeof spawn>|undefined,closed:Promise<void>|undefined,stopping:Promise<void>|undefined;
 const log=createWriteStream(join(directory,'validator.log'));
 const docker=async(args:string[])=>{const result=await execute('docker',args,{timeout:30_000,maxBuffer:1_000_000});return result.stdout.trim();};
 const container=async(args:string[])=>{const task=docker(args).then(id=>{containers.push(id);return id;});creating.add(task);try{return await task;}finally{creating.delete(task);}};
 const stop=()=>stopping??=(async()=>{
  controller.abort();clearTimeout(deadline);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  if(validator?.pid&&validator.exitCode===null&&validator.signalCode===null){try{process.kill(-validator.pid,'SIGINT');}catch{}}
  const force=setTimeout(()=>{if(validator?.pid&&validator.exitCode===null&&validator.signalCode===null){try{process.kill(-validator.pid,'SIGKILL');}catch{}}},5_000);
  await closed;clearTimeout(force);await new Promise<void>(resolve=>log.end(resolve));
  await Promise.allSettled([...creating]);
  const cleanup=await Promise.allSettled(containers.map(id=>docker(['stop','--time','3',id])));
  assert(cleanup.every(r=>r.status==='fulfilled'),'An owned fixture container failed to stop');
 })();
 const interrupt=()=>{controller.abort();void stop().catch(error=>console.error(error));process.exitCode=1;};
 process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);const deadline=setTimeout(interrupt,360_000);
 const active=()=>{assert(!controller.signal.aborted,'Owned fixture interrupted');};
 try{
  const pg=await container(['run','--pull=never','--rm','-d','--name',name+'-pg','--cpus','1','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_USER=shardkeep','-e','POSTGRES_PASSWORD=shardkeep','-e','POSTGRES_DB=shardkeep_test','-p','127.0.0.1::5432','postgres:16-alpine']);active();
  const redis=await container(['run','--pull=never','--rm','-d','--name',name+'-redis','-p','127.0.0.1::6379','redis:7-alpine']);active();
  let databaseReady=false;for(let i=0;i<50;i++){active();try{await docker(['exec',pg,'pg_isready','-U','shardkeep','-d','shardkeep_test']);databaseReady=true;break;}catch{}await pause(200);}assert(databaseReady,'Owned database did not start');
  const pgPort=(await docker(['port',pg,'5432/tcp'])).split(':').at(-1),redisPort=(await docker(['port',redis,'6379/tcp'])).split(':').at(-1);
  const databaseUrl=`postgres://shardkeep:shardkeep@127.0.0.1:${pgPort}/shardkeep_test`,redisUrl=`redis://127.0.0.1:${redisPort}`;
  let port=0;for(let trial=0;trial<12;trial++){const candidate=30000+Math.floor(Math.random()*200)*50;try{for(let i=0;i<42;i++)await available(candidate+i);port=candidate;break;}catch{}}assert(port,'No isolated validator port range available');
  const ledger=join(directory,'ledger'),endpoint=`http://127.0.0.1:${port}`;
  active();
  validator=spawn('solana-test-validator',['--ledger',ledger,'--rpc-port',String(port),'--faucet-port',String(port+40),'--gossip-port',String(port+2),'--dynamic-port-range',`${port+3}-${port+30}`,'--bind-address','127.0.0.1','--mint',funder.publicKey.toBase58(),'--limit-ledger-size','10000'],{stdio:['ignore','pipe','pipe'],detached:true});
  validator.stdout!.pipe(log,{end:false});validator.stderr!.pipe(log,{end:false});let spawnError:Error|undefined;validator.once('error',error=>{spawnError=error;});closed=new Promise<void>(resolve=>validator!.once('close',()=>resolve()));
  const connect=(signal?:AbortSignal)=>new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(url,init)=>{
   const target=new URL(String(url));assert.equal(target.origin,endpoint,'Fixture attempted a non-owned RPC');
   return fetch(url,{...init,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5_000),...(signal?[signal]:[]),...(init?.signal?[init.signal]:[])])});
  }});
  const connection=connect();
  let ready=false;for(let i=0;i<100;i++){active();if(spawnError)throw spawnError;assert(validator.exitCode===null&&validator.signalCode===null,'Owned validator exited');try{ready=(await connection.getSlot('finalized'))>0;}catch{}if(ready)break;await pause(500);}assert(ready,'Owned validator did not finalize');
  const genesis=bs58.encode(createHash('sha256').update(await readFile(join(ledger,'genesis.bin'))).digest());assert.equal(await connection.getGenesisHash(),genesis);
  console.log(JSON.stringify({kind:'owned local market resources',directory,validatorPid:validator.pid,containers,containerName:name,endpoint,genesis}));
  async function finalized(signature:string,lastValidBlockHeight?:number,expectFailure=false){
   const end=Date.now()+45_000;
   while(Date.now()<end){active();const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(!expectFailure)assert(!status?.err,`Actual transaction failed: ${JSON.stringify(status?.err)}`);
    if(status?.confirmationStatus==='finalized'){if(expectFailure)assert(status.err,'Expected a genuine failed execution');return;}
    if(lastValidBlockHeight!==undefined)assert((await connection.getBlockHeight('finalized'))<=lastValidBlockHeight,'Original blockhash expired');await pause(250);
   }throw Error('Original transaction did not finalize within fixture bound');
  }
  async function setup(instructions:TransactionInstruction[],signers:Keypair[]){
   const block=await connection.getLatestBlockhash('finalized'),message=new TransactionMessage({payerKey:signers[0]!.publicKey,recentBlockhash:block.blockhash,instructions}).compileToLegacyMessage(),tx=new VersionedTransaction(message);tx.sign(signers);
   const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0});await finalized(signature,block.lastValidBlockHeight);return signature;
  }
  async function tokens(buyer:Keypair,seller:PublicKey,existingSellerAta:boolean){
   const mint=Keypair.generate(),buyerAta=localKeepAta(mint.publicKey,buyer.publicKey),sellerAta=localKeepAta(mint.publicKey,seller),initial=20_000_000n;
   await setup([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:buyer.publicKey,lamports:1_000_000_000})],[funder]);
   // Pinned Classic SPL ABI: InitializeMint2 (no freeze authority), Create ATA,
   // MintTo. Protocol fixture bytes avoid adding an API runtime dependency.
   const initialize=new TransactionInstruction({programId:tokenProgram,keys:[{pubkey:mint.publicKey,isSigner:false,isWritable:true}],data:Buffer.concat([Buffer.from([20,TOKEN.decimals]),buyer.publicKey.toBuffer(),Buffer.of(0)])});
   const createAta=(owner:PublicKey,address:PublicKey)=>new TransactionInstruction({programId:associatedProgram,data:Buffer.alloc(0),keys:[{pubkey:buyer.publicKey,isSigner:true,isWritable:true},{pubkey:address,isSigner:false,isWritable:true},{pubkey:owner,isSigner:false,isWritable:false},{pubkey:mint.publicKey,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:tokenProgram,isSigner:false,isWritable:false}]});
   const mintData=Buffer.alloc(9);mintData[0]=7;mintData.writeBigUInt64LE(initial,1);
   const issue=new TransactionInstruction({programId:tokenProgram,data:mintData,keys:[{pubkey:mint.publicKey,isSigner:false,isWritable:true},{pubkey:buyerAta,isSigner:false,isWritable:true},{pubkey:buyer.publicKey,isSigner:true,isWritable:false}]});
   await setup([SystemProgram.createAccount({fromPubkey:buyer.publicKey,newAccountPubkey:mint.publicKey,lamports:await connection.getMinimumBalanceForRentExemption(82,'finalized'),space:82,programId:tokenProgram}),initialize,createAta(buyer.publicKey,buyerAta),...(existingSellerAta?[createAta(seller,sellerAta)]:[]),issue],[buyer,mint]);
   assert.equal((await connection.getTokenSupply(mint.publicKey,'finalized')).value.amount,initial.toString());
   return {mint:mint.publicKey,buyerAta,sellerAta,initial};
  }
  async function burnForFailure(buyer:Keypair,mint:PublicKey,buyerAta:PublicKey,amount:bigint){
   const data=Buffer.alloc(10);data[0]=15;data.writeBigUInt64LE(amount,1);data[9]=TOKEN.decimals;
   await setup([new TransactionInstruction({programId:tokenProgram,data,keys:[{pubkey:buyerAta,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:true},{pubkey:buyer.publicKey,isSigner:true,isWritable:false}]})],[buyer]);
  }
  return {directory,name,containers,validatorPid:validator.pid,endpoint,databaseUrl,redisUrl,connection,connect,genesis,finalized,tokens,burnForFailure,close:stop};
 }catch(error){await stop();throw error;}
}
