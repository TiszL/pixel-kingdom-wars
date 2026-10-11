/** Manual R1 local execution only. Own ephemeral loopback validator, fresh mint,
 * real Classic SPL TransferChecked/BurnChecked, no public RPC or game grant.
 * Both reader adapters target this ONE fixture bank: not production independence. */
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {AddressLookupTableProgram,Connection,Keypair,SystemProgram,TransactionMessage,VersionedTransaction,type TransactionInstruction,type AddressLookupTableAccount} from '@solana/web3.js';
import {ACCOUNT_SIZE,MINT_SIZE,TOKEN_PROGRAM_ID,createInitializeMint2Instruction,createAssociatedTokenAccountInstruction,createMintToInstruction,getAssociatedTokenAddressSync,getMinimumBalanceForRentExemptMint,getMint,getAccount} from '@solana/spl-token';
import {TOKEN,PHASE_E_KEEP_EQUIPMENT_MARKET as POLICY} from '@shardkeep/shared';
import {buildKeepEquipmentPaymentInstructions,verifyKeepEquipmentPaymentTransaction,createKeepEquipmentPaymentReader,type KeepEquipmentPaymentOriginal} from './keepEquipmentPayment';
import bs58 from 'bs58';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function check(v:unknown,why:string):asserts v{if(!v)throw Error(why);}
async function available(port:number){await new Promise<void>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(e=>e?reject(e):resolve()));});}
async function main(){
 const directory=await mkdtemp('/tmp/phase-e-keep-equipment-'),funder=Keypair.generate(),buyer=Keypair.generate(),seller=Keypair.generate();
 let port=0;for(let trial=0;trial<12;trial++){const candidate=30000+Math.floor(Math.random()*200)*50;try{for(let i=0;i<42;i++)await available(candidate+i);port=candidate;break;}catch{}}
 check(port,'No isolated loopback port range available');const ledger=join(directory,'ledger'),log=createWriteStream(join(directory,'validator.log'));
 const validator=spawn('solana-test-validator',['--ledger',ledger,'--rpc-port',String(port),'--faucet-port',String(port+40),'--gossip-port',String(port+2),'--dynamic-port-range',`${port+3}-${port+30}`,'--bind-address','127.0.0.1','--mint',funder.publicKey.toBase58(),'--limit-ledger-size','10000'],{stdio:['ignore','pipe','pipe'],detached:true});
 validator.stdout!.pipe(log);validator.stderr!.pipe(log);let spawnError:Error|undefined;validator.once('error',error=>{spawnError=error;});const closed=new Promise<void>(resolve=>validator.once('close',()=>resolve()));let stopping:Promise<void>|undefined;
 const stop=()=>stopping??=(async()=>{if(validator.pid){try{process.kill(-validator.pid,'SIGINT');}catch{}}const force=setTimeout(()=>{if(validator.pid){try{process.kill(-validator.pid,'SIGKILL');}catch{}}},5000);await closed;clearTimeout(force);await new Promise<void>(resolve=>log.end(resolve));})();
 const controller=new AbortController();const interrupt=()=>{controller.abort();void stop();process.exitCode=1;};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);const deadline=setTimeout(interrupt,360_000);
 try{
  const connection=new Connection(`http://127.0.0.1:${port}`,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])})});
  let ready=false;for(let attempt=0;attempt<100;attempt++){check(!controller.signal.aborted,'Fixture interrupted');if(spawnError)throw spawnError;check(validator.exitCode===null&&validator.signalCode===null,'Owned validator exited');try{ready=(await connection.getSlot('finalized'))>0;}catch{}if(ready)break;await pause(500);}check(ready,'Owned validator did not finalize');
  const localGenesis=bs58.encode(createHash('sha256').update(await readFile(join(ledger,'genesis.bin'))).digest());check(await connection.getGenesisHash()===localGenesis,'RPC does not match owned ledger genesis');
  // HTTP-only confirmation keeps this disposable fixture free of reconnecting
  // WebSocket subscriptions. Finalized preflight/setup must observe the same bank.
  async function sendFinalized(instructions:TransactionInstruction[],signers:Keypair[],version:'legacy'|0='legacy',table?:AddressLookupTableAccount){
   const block=await connection.getLatestBlockhash('finalized'),plan=new TransactionMessage({payerKey:signers[0]!.publicKey,recentBlockhash:block.blockhash,instructions});
   const transaction=new VersionedTransaction(version==='legacy'?plan.compileToLegacyMessage():plan.compileToV0Message(table?[table]:[]));transaction.sign(signers);
   const signature=await connection.sendRawTransaction(transaction.serialize(),{preflightCommitment:'finalized',maxRetries:0});
   const end=Date.now()+45_000;
   while(Date.now()<end){
    check(!controller.signal.aborted,'Fixture interrupted');
    const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
    check(!status?.err,`Local transaction failed: ${JSON.stringify(status?.err)}`);
    if(status?.confirmationStatus==='finalized')return signature;
    check(await connection.getBlockHeight('finalized')<=block.lastValidBlockHeight,'Local transaction blockhash expired');
    await pause(250);
   }
   throw Error(`Local transaction did not finalize: ${signature}`);
  }
  await sendFinalized([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:buyer.publicKey,lamports:1_000_000_000})],[funder]);
  const mintSigner=Keypair.generate(),mint=mintSigner.publicKey;
  await sendFinalized([SystemProgram.createAccount({fromPubkey:buyer.publicKey,newAccountPubkey:mint,space:MINT_SIZE,lamports:await getMinimumBalanceForRentExemptMint(connection),programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(mint,TOKEN.decimals,buyer.publicKey,null)],[buyer,mintSigner]);
  const from={address:getAssociatedTokenAddressSync(mint,buyer.publicKey)},to={address:getAssociatedTokenAddressSync(mint,seller.publicKey)};
  // Explicit instructions surface setup/preflight failures; the convenience
  // get-or-create helper swallows ATA creation errors before its account reread.
  await sendFinalized([createAssociatedTokenAccountInstruction(buyer.publicKey,from.address,buyer.publicKey,mint),createAssociatedTokenAccountInstruction(buyer.publicKey,to.address,seller.publicKey,mint)],[buyer]);
  const initial=20_000_000n;await sendFinalized([createMintToInstruction(mint,from.address,buyer.publicKey,initial)],[buyer]);
  const limits={maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000},results=[];let totalBurn=0n,totalSpent=0n;
  const rent=await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'finalized'),systemRent=await connection.getMinimumBalanceForRentExemption(0,'finalized');
  const cases=(['legacy',0] as const).flatMap(version=>(['existing','fresh','raced','prefunded','funded-rent'] as const).map(mode=>({version,mode,seller:mode==='existing'?seller.publicKey:Keypair.generate().publicKey})));
  const prepare=cases.flatMap(c=>{const ata=getAssociatedTokenAddressSync(mint,c.seller);return c.mode==='raced'?[createAssociatedTokenAccountInstruction(buyer.publicKey,ata,c.seller,mint)]:c.mode==='prefunded'||c.mode==='funded-rent'?[SystemProgram.transfer({fromPubkey:buyer.publicKey,toPubkey:ata,lamports:c.mode==='prefunded'?systemRent:rent})]:[];});
  await sendFinalized(prepare,[buyer]);
  // The table uses a finalized ancestor, and its address set is frozen before use.
  const root=await connection.getSlot('finalized'),ancestors=await connection.getBlocks(Math.max(0,root-32),root-1,'finalized'),slot=ancestors.at(-1);check(slot!==undefined,'No finalized lookup-table ancestor');
  const [create,address]=AddressLookupTableProgram.createLookupTable({authority:buyer.publicKey,payer:buyer.publicKey,recentSlot:slot});
  const addresses=[from.address,mint,...new Map(cases.map(c=>{const ata=getAssociatedTokenAddressSync(mint,c.seller);return [ata.toBase58(),ata];})).values()];
  await sendFinalized([create,AddressLookupTableProgram.extendLookupTable({lookupTable:address,authority:buyer.publicKey,payer:buyer.publicKey,addresses})],[buyer]);
  const table=(await connection.getAddressLookupTable(address,{commitment:'finalized'})).value;check(table,'Local lookup table missing');
  for(let i=0;i<30&&(await connection.getSlot('finalized'))<=table.state.lastExtendedSlot;i++){check(!controller.signal.aborted,'Fixture interrupted');await pause(100);}
  check((await connection.getSlot('finalized'))>table.state.lastExtendedSlot,'Finalized lookup table not yet active');
  const sellerTotals=new Map<string,bigint>();
  for(const c of cases){
   const original:KeepEquipmentPaymentOriginal={reservationId:randomUUID(),buyer:buyer.publicKey.toBase58(),seller:c.seller.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:POLICY.minFillBaseUnits+1n,sellerAtaExists:c.mode==='existing',...(c.mode==='existing'?{}:{sellerAtaRentCapLamports:BigInt(rent)})};
   const signature=await sendFinalized(buildKeepEquipmentPaymentInstructions(original,limits),[buyer],c.version,c.version===0?table:undefined);
   const raw=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
   await writeFile(join(directory,`${c.version}-${c.mode}.json`),JSON.stringify(raw,null,2)+'\n');
   if(c.version===0)check(raw?.transaction.message.version===0&&raw.transaction.message.addressTableLookups.length===1&&raw.meta?.loadedAddresses?.writable.length===3,'Actual payment did not use the lookup table');
   const proof=verifyKeepEquipmentPaymentTransaction(raw,signature,original,limits);
   const trust={...limits,expectedGenesisHash:localGenesis,minContextSlot:1,deadlineMs:10000,providerIds:['local-fixture-adapter-one','local-fixture-adapter-two'] as const};
   const make=()=>({getGenesisHash:()=>connection.getGenesisHash(),getSlot:(x:'finalized')=>connection.getSlot(x),getTransaction:(s:string,o:{commitment:'finalized';maxSupportedTransactionVersion:0})=>connection.getTransaction(s,o)});
   const agreed=await createKeepEquipmentPaymentReader([make,make],trust)(original,signature);check(agreed.finalizedAgreement,'Local fixture adapters did not agree');
   totalBurn+=BigInt(proof.burnBaseUnits);totalSpent+=BigInt(proof.totalBaseUnits);
   const sellerTotal=(sellerTotals.get(original.seller)??0n)+BigInt(proof.sellerBaseUnits);sellerTotals.set(original.seller,sellerTotal);
   const supply=await getMint(connection,mint,'finalized'),buyerStock=await getAccount(connection,from.address,'finalized'),sellerStock=await getAccount(connection,getAssociatedTokenAddressSync(mint,c.seller),'finalized');
   check(supply.supply===initial-totalBurn&&buyerStock.amount===initial-totalSpent&&sellerStock.amount===sellerTotal,'Actual SPL supply/stock conservation failed');
   check(proof.sellerAtaCreated===(c.mode==='fresh'||c.mode==='prefunded'||c.mode==='funded-rent')&&BigInt(proof.sellerAtaRentLamports)===BigInt(c.mode==='fresh'?rent:c.mode==='prefunded'?rent-systemRent:0),'Actual ATA creation/rent mismatch');
   results.push({version:c.version,mode:c.mode,lookupTable:c.version===0?table.key.toBase58():null,signature,slot:proof.slot,burnBaseUnits:proof.burnBaseUnits,sellerBaseUnits:proof.sellerBaseUnits,sellerAtaRentLamports:proof.sellerAtaRentLamports,mintSupply:supply.supply.toString(),evidenceSha256:proof.evidenceSha256});
  }
  const report={kind:'R1 local execution',genesisHash:localGenesis,mint:mint.toBase58(),results,actualSupplyDecreasedBy:totalBurn.toString(),twoIndependentProvidersProven:false,marketDeliveryImplemented:false};
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,report:join(directory,'report.json')},null,2));
 }finally{controller.abort();clearTimeout(deadline);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);await stop();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
