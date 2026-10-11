/** Manual isolated failed-payment execution. Both adapters point at ONE owned
 * loopback validator: this proves real rollback, not provider independence. */
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Connection,Keypair,SystemProgram,TransactionMessage,VersionedTransaction,type TransactionInstruction} from '@solana/web3.js';
import {MINT_SIZE,TOKEN_PROGRAM_ID,createInitializeMint2Instruction,createAssociatedTokenAccountInstruction,createMintToInstruction,createBurnCheckedInstruction,getAssociatedTokenAddressSync,getMinimumBalanceForRentExemptMint,getMint,getAccount} from '@solana/spl-token';
import {TOKEN,PHASE_E_POLICY,PHASE_E_KEEP_EQUIPMENT_MARKET as POLICY} from '@shardkeep/shared';
import bs58 from 'bs58';
import {createKeepEquipmentPaymentPreparationReader,type KeepEquipmentPaymentPreparationRpc} from './keepEquipmentPaymentPreparation';
import {verifyKeepEquipmentPaymentSignedWire} from './keepEquipmentPaymentWire';
import {createKeepEquipmentPaymentFailureReader,type KeepEquipmentPaymentFailureInput} from './keepEquipmentPaymentFailure';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function check(v:unknown,why:string):asserts v{if(!v)throw Error(why);}
async function available(port:number){await new Promise<void>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(e=>e?reject(e):resolve()));});}
async function main(){
 const directory=await mkdtemp('/tmp/phase-e-keep-equipment-failure-'),funder=Keypair.generate(),buyer=Keypair.generate();let port=0;
 for(let trial=0;trial<12;trial++){const candidate=30000+Math.floor(Math.random()*200)*50;try{for(let i=0;i<42;i++)await available(candidate+i);port=candidate;break;}catch{}}
 check(port,'No isolated loopback port range');const ledger=join(directory,'ledger'),log=createWriteStream(join(directory,'validator.log'));
 const validator=spawn('solana-test-validator',['--ledger',ledger,'--rpc-port',String(port),'--faucet-port',String(port+40),'--gossip-port',String(port+2),'--dynamic-port-range',`${port+3}-${port+30}`,'--bind-address','127.0.0.1','--mint',funder.publicKey.toBase58(),'--limit-ledger-size','10000'],{stdio:['ignore','pipe','pipe'],detached:true});
 validator.stdout!.pipe(log);validator.stderr!.pipe(log);let spawnError:Error|undefined;validator.once('error',e=>{spawnError=e;});const closed=new Promise<void>(r=>validator.once('close',()=>r()));let stopping:Promise<void>|undefined;
 const stop=()=>stopping??=(async()=>{if(validator.pid)try{process.kill(-validator.pid,'SIGINT');}catch{}const force=setTimeout(()=>{if(validator.pid)try{process.kill(-validator.pid,'SIGKILL');}catch{}},5000);await closed;clearTimeout(force);await new Promise<void>(r=>log.end(r));})();
 const controller=new AbortController(),interrupt=()=>{controller.abort();void stop();process.exitCode=1;};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);const deadline=setTimeout(interrupt,360_000);
 try{
  const connection=new Connection(`http://127.0.0.1:${port}`,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])})});
  let ready=false;for(let i=0;i<100;i++){check(!controller.signal.aborted,'Interrupted');if(spawnError)throw spawnError;check(validator.exitCode===null&&validator.signalCode===null,'Owned validator exited');try{ready=(await connection.getSlot('finalized'))>0;}catch{}if(ready)break;await pause(500);}check(ready,'Owned validator did not finalize');
  const genesis=bs58.encode(createHash('sha256').update(await readFile(join(ledger,'genesis.bin'))).digest());check(await connection.getGenesisHash()===genesis,'RPC is not owned ledger');
  async function finalized(wire:Uint8Array,lastValidBlockHeight:number,failed=false){
   const signature=await connection.sendRawTransaction(wire,{preflightCommitment:'finalized',skipPreflight:failed,maxRetries:0}),end=Date.now()+45_000;
   while(Date.now()<end){check(!controller.signal.aborted,'Interrupted');const s=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
    if(s?.confirmationStatus==='finalized'){check(failed?s.err!==null:s.err===null,`Unexpected execution outcome ${JSON.stringify(s.err)}`);return signature;}
    if(!failed)check(!s?.err,`Setup failed ${JSON.stringify(s?.err)}`);check(await connection.getBlockHeight('finalized')<=lastValidBlockHeight,'Fixture blockhash expired');await pause(250);
   }throw Error('Fixture transaction did not finalize');
  }
  async function setup(instructions:TransactionInstruction[],signers:Keypair[]){const block=await connection.getLatestBlockhash('finalized'),message=new TransactionMessage({payerKey:signers[0]!.publicKey,recentBlockhash:block.blockhash,instructions}).compileToLegacyMessage(),tx=new VersionedTransaction(message);tx.sign(signers);return finalized(tx.serialize(),block.lastValidBlockHeight);}
  await setup([SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:buyer.publicKey,lamports:1_000_000_000})],[funder]);
  const mintSigner=Keypair.generate(),mint=mintSigner.publicKey,buyerAta=getAssociatedTokenAddressSync(mint,buyer.publicKey);
  await setup([SystemProgram.createAccount({fromPubkey:buyer.publicKey,newAccountPubkey:mint,space:MINT_SIZE,lamports:await getMinimumBalanceForRentExemptMint(connection),programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(mint,TOKEN.decimals,buyer.publicKey,null),createAssociatedTokenAccountInstruction(buyer.publicKey,buyerAta,buyer.publicKey,mint)],[buyer,mintSigner]);
  const makePreparation=():KeepEquipmentPaymentPreparationRpc=>({
   getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getMultipleAccountsInfoAndContext:(keys,options)=>connection.getMultipleAccountsInfoAndContext(keys,options),
   getMinimumBalanceForRentExemption:(bytes,c)=>connection.getMinimumBalanceForRentExemption(bytes,c),getLatestBlockhashAndContext:o=>connection.getLatestBlockhashAndContext(o),
   getFeeForMessage:(message,c)=>connection.getFeeForMessage(message,c),isBlockhashValid:(block,o)=>connection.isBlockhashValid(block,o),getBlockHeight:o=>connection.getBlockHeight(o)
  });
  const makeFailure=()=>({getGenesisHash:()=>connection.getGenesisHash(),getSlot:(c:'finalized')=>connection.getSlot(c),getTransaction:(s:string,o:{commitment:'finalized';maxSupportedTransactionVersion:0})=>connection.getTransaction(s,o)});
  const results=[];
  for(const [version,create] of [['legacy',false],[0,true]] as const){
   const seller=Keypair.generate().publicKey,sellerAta=getAssociatedTokenAddressSync(mint,seller),total=POLICY.minFillBaseUnits+1n;
   const prepIxs=[createMintToInstruction(mint,buyerAta,buyer.publicKey,total)];if(!create)prepIxs.push(createAssociatedTokenAccountInstruction(buyer.publicKey,sellerAta,seller,mint));await setup(prepIxs,[buyer]);
   const trust={expectedGenesisHash:genesis,expectedKeepMint:mint.toBase58(),minContextSlot:1,deadlineMs:10000,transactionVersion:version,providerIds:['owned-fixture-bank-a','owned-fixture-bank-b'] as const,maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
   const preparation=await createKeepEquipmentPaymentPreparationReader([makePreparation,makePreparation],trust)({reservationId:randomUUID(),buyer:buyer.publicKey.toBase58(),seller:seller.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:total});check(preparation.original.sellerAtaExists===!create,'Unexpected ATA admission');
   const unsigned=new Uint8Array(65+preparation.messageBytes.length);unsigned[0]=1;unsigned.set(preparation.messageBytes,65);const tx=VersionedTransaction.deserialize(unsigned);tx.sign([buyer]);const wire=verifyKeepEquipmentPaymentSignedWire({preparedMessageBytes:preparation.messageBytes,signedTransaction:tx.serialize(),buyer:buyer.publicKey});
   // An ordinary later wallet transaction makes the saved payment fail at its
   // burn after its transfer (and optional ATA creation) actually execute.
   const sellerAmount=total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),balance=(await getAccount(connection,buyerAta,'finalized')).amount;
   await setup([createBurnCheckedInstruction(buyerAta,mint,buyer.publicKey,balance-sellerAmount,TOKEN.decimals)],[buyer]);
   const before={buyer:(await getAccount(connection,buyerAta,'finalized')).amount,supply:(await getMint(connection,mint,'finalized')).supply,sol:await connection.getBalance(buyer.publicKey,'finalized'),seller:await connection.getAccountInfo(sellerAta,'finalized')};
   const signature=await finalized(wire.signedTransaction,preparation.lastValidBlockHeight,true);check(signature===wire.signature,'Relay replaced original signature');
   const input:KeepEquipmentPaymentFailureInput={original:preparation.original,messageBytes:preparation.messageBytes,messageSha256:preparation.messageSha256,blockhash:preparation.blockhash,lastValidBlockHeight:preparation.lastValidBlockHeight,minContextSlot:preparation.minContextSlot,signedTransaction:wire.signedTransaction,signature,wireSha256:wire.wireSha256};
   const proof=await createKeepEquipmentPaymentFailureReader([makeFailure,makeFailure],trust)(input),raw=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
   const after={buyer:(await getAccount(connection,buyerAta,'finalized')).amount,supply:(await getMint(connection,mint,'finalized')).supply,sol:await connection.getBalance(buyer.publicKey,'finalized'),seller:await connection.getAccountInfo(sellerAta,'finalized')};
   check(BigInt(proof.feeLamports)>0n&&BigInt(before.sol-after.sol)===BigInt(proof.feeLamports),'Actual fee debit missing');check(before.buyer===after.buyer&&before.supply===after.supply,'Failed payment changed KEEP balance or supply');
   check(create?before.seller===null&&after.seller===null:before.seller&&after.seller&&before.seller.data.equals(after.seller.data)&&before.seller.lamports===after.seller.lamports,'Failed payment retained seller credit or ATA rent');
   const record={version,createSellerAta:create,signature,wireSha256:wire.wireSha256,signedTransactionHex:Buffer.from(wire.signedTransaction).toString('hex'),messageHex:Buffer.from(preparation.messageBytes).toString('hex'),original:{...preparation.original,totalBaseUnits:total.toString(),...(create?{sellerAtaRentCapLamports:preparation.original.sellerAtaRentCapLamports!.toString()}:{})},proof,before:{buyer:before.buyer.toString(),supply:before.supply.toString(),sol:before.sol,sellerExists:!!before.seller},after:{buyer:after.buyer.toString(),supply:after.supply.toString(),sol:after.sol,sellerExists:!!after.seller}};
   await writeFile(join(directory,`${version}-failure.json`),JSON.stringify({record,transaction:raw},null,2)+'\n');results.push(record);console.log(`Verified actual ${version} failure: fee ${proof.feeLamports}; zero KEEP burn/seller credit/ATA rent`);
  }
  const report={kind:'actual finalized failed KEEP payments',genesisHash:genesis,mint:mint.toBase58(),results,twoIndependentProvidersProven:false,releaseDatabaseExercised:false};await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:join(directory,'report.json'),cases:results.length,twoIndependentProvidersProven:false,releaseDatabaseExercised:false}));
 }finally{controller.abort();clearTimeout(deadline);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);await stop();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
