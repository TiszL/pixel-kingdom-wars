/** D215 genuine earned materials -> immutable SQL/wallet wire -> once-only local
 * SBF request -> paid outcomes/Core/install. Only the VRF provider is synthetic;
 * prerequisite deed/term observations retain the earned fixture's stated scope. */
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Message,PublicKey,VersionedTransaction,type AccountInfo} from '@solana/web3.js';
import {expect} from 'vitest';
import {createVehicleIssuanceQuoteReader,type VehicleIssuanceQuoteRpc} from '@shardkeep/chain/vehicle-issuance-quote';
import {createVehicleIssuanceCurrent} from '@shardkeep/chain/vehicle-issuance-current';
import {createVehicleIssuanceRequestReceiptReader} from '@shardkeep/chain/vehicle-issuance-request-receipt';
import {VEHICLE_CRAFT_PROGRAM} from '@shardkeep/chain/vehicle-issuance-protocol';
import type {VehicleLocalRequest} from '../../../../programs/vehicle-local-issuance';
import {createVehicleCraftMaterials} from '../../src/game/vehicleCraftMaterials';
import {createVehicleCraftPreparation} from '../../src/game/vehicleCraftPreparation';
import {createVehicleCraftSignedStore} from '../../src/game/vehicleCraftSignedStore';
import {createVehicleCraftDelivery} from '../../src/game/vehicleCraftDelivery';
import {createVehiclePolicyIssuer} from '../../src/vehiclePolicyIssuer';
import {initializeVehicleIssuerJournal,VEHICLE_ISSUER_PURPOSE} from '../../src/vehiclePolicyIssuerJournal';
import {signVehiclePolicy} from './vehiclePolicyIssuer';
import {actualVehicleMaterialCore} from './vehicleMaterialCore';
import {resealVehicleDeliveryFixture} from './vehicleCraftDelivery';
const requireChain=createRequire(new URL('../../../../packages/chain/package.json',import.meta.url));
const ChainPublicKey=(requireChain('@solana/web3.js') as {PublicKey:typeof PublicKey}).PublicKey;
const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default;
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
function need(value:unknown,why:string):asserts value{if(!value)throw Error(why);}
function quoteRpc(chain:VehicleLocalRequest['chain']):VehicleIssuanceQuoteRpc{
 const connection=chain.connection;
 return {getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),
  getMultipleAccountsInfoAndContext:async(addresses,settings)=>{const observed=await connection.getMultipleAccountsInfoAndContext(addresses.map(a=>new PublicKey(a.toBytes())),settings);return {context:observed.context,value:observed.value.map((a:AccountInfo<Buffer>|null,i:number)=>a===null?null:{address:addresses[i]!,owner:new ChainPublicKey(a.owner.toBytes()),executable:a.executable,data:Buffer.from(a.data),lamports:a.lamports})};},
  getLatestBlockhashAndContext:o=>connection.getLatestBlockhashAndContext(o),getFeeForMessage:(m,c)=>connection.getFeeForMessage(Message.from(m.serialize()),c),getBlockHeight:o=>connection.getBlockHeight(o)};
}
export async function actualVehicleRequestCore(){
 const directory=await mkdtemp(join(tmpdir(),'vehicle-request-core-')),records:unknown[]=[];
 const retained=new Map<string,{request:{wallet:string;idempotencyKey:string};state:Awaited<ReturnType<ReturnType<typeof createVehicleCraftDelivery>['get']>>}>();
 try{await actualVehicleMaterialCore({before:source=>resealVehicleDeliveryFixture(source.conn),submitRequest:async({chain,original,trust,policySigner,source,saved})=>{
  const request={wallet:saved.actorWallet,idempotencyKey:saved.request.idempotencyKey},journalFile=join(directory,original.rootId+'.jsonl'),rpc=quoteRpc(chain);
  await initializeVehicleIssuerJournal(journalFile,{purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:trust.expectedGenesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM});
  let signatures=0,sends=0;const sentWires:string[]=[];
  const issuerRpc={getGenesisHash:rpc.getGenesisHash,getSlot:rpc.getSlot,getMultipleAccountsInfoAndContext:async(...args:Parameters<VehicleIssuanceQuoteRpc['getMultipleAccountsInfoAndContext']>)=>{
   const observed=await rpc.getMultipleAccountsInfoAndContext(...args);return {context:observed.context,value:observed.value.map(row=>row===null?null:{address:row.address,owner:row.owner,executable:row.executable,data:row.data})};
  }};
  const issuer=await createVehiclePolicyIssuer({journalFile,trust,connect:()=>issuerRpc,material:createVehicleCraftMaterials(source.db),signer:{publicKey:policySigner.publicKey.toBase58(),sign:message=>{signatures++;return signVehiclePolicy(policySigner,message);}}});
  try{
   const quote=createVehicleIssuanceQuoteReader(()=>rpc,trust,policySigner.publicKey.toBase58(),{costLimits:{maxNetworkFeeLamports:'100000',maxInitializationRentLamports:'100000000',maxRequiredLamports:'1000000000'}});
   const preparation=createVehicleCraftPreparation(source.db,{enabled:()=>true,issuer:{publicKey:policySigner.publicKey.toBase58(),issueOnce:issuer.issueOnce,lookup:issuer.lookup},quote});
   const prepared=await preparation.prepare(request,new AbortController().signal),q=prepared.preparation!.quote;
   expect(prepared.preparation!.issuerReceipt.original).toEqual(original);expect(signatures).toBe(1);
   const tx=new VersionedTransaction(Message.from(Buffer.from(q.messageHex,'hex')));tx.sign([source.seller.signer]);const wire=tx.serialize(),signature=bs58.encode(tx.signatures[0]!);
   const savedWire=await createVehicleCraftSignedStore(source.db).accept(request,wire);expect(savedWire.signature).toBe(signature);
   const transport={...rpc,isBlockhashValid:(blockhash:string,options:{commitment:'finalized';minContextSlot:number})=>chain.connection.isBlockhashValid(blockhash,options),
    getSignatureStatuses:(values:string[],options:{searchTransactionHistory:true})=>chain.connection.getSignatureStatuses(values,options),
    sendRawTransaction:async(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number})=>{
     sends++;sentWires.push(Buffer.from(bytes).toString('hex'));expect(Buffer.from(bytes)).toEqual(Buffer.from(wire));
     const ack=await chain.connection.sendRawTransaction(bytes,options);expect(ack).toBe(signature);
     if(records.length===0)throw Error('intentional lost acknowledgement after actual send');return ack;
    }};
   const receiptRpc={...issuerRpc,getTransaction:async(value:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0})=>{
    expect(value).toBe(signature);const response=await fetch(chain.connection.rpcEndpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:[value,{...options,encoding:'json'}]})});
    const body=await response.json() as {result?:unknown;error?:unknown};need(response.ok&&!body.error&&Object.hasOwn(body,'result'),'Actual request transaction RPC unavailable');return body.result;
   }};
   const delivery=createVehicleCraftDelivery(source.db,{enabled:()=>true,current:{connect:()=>transport,trust},receipt:{connect:()=>receiptRpc,trust}});
   const submitted=await delivery.deliver(request,new AbortController().signal);
   if(submitted.status!==(records.length===0?'unknown':'submitted')){
    // One read-only diagnostic exposes a source refusal rather than repeatedly
    // rerunning an expensive validator with a status-only assertion.
    await createVehicleIssuanceCurrent(()=>transport,trust,async()=>({quote:q,signedTransaction:wire})).review(request);
    throw Error('Unexpected actual request delivery state: '+JSON.stringify(submitted));
   }expect(sends).toBe(1);
   expect((await createVehicleCraftMaterials(source.db).read(request.wallet,request.idempotencyKey))?.status).toBe('held');
   // No second send is authorized after the durable marker, including a new
   // service instance while the first acknowledgement was deliberately lost.
   const reopened=createVehicleCraftDelivery(source.db,{enabled:()=>true,current:{connect:()=>transport,trust},receipt:{connect:()=>receiptRpc,trust}});
   await reopened.deliver(request,new AbortController().signal);expect(sends).toBe(1);
   await chain.connection.confirmTransaction({signature,blockhash:q.blockhash,lastValidBlockHeight:q.lastValidBlockHeight},'finalized');
   const executed=await chain.connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(executed?.meta&&executed.meta.err===null,'Actual original request did not finalize');
   const until=Date.now()+30000;while(await chain.connection.getSlot('finalized')<=executed.slot&&Date.now()<until)await sleep(100);need(await chain.connection.getSlot('finalized')>executed.slot,'Request closing bank unavailable');
   const result=await reopened.recover(request,new AbortController().signal);
   if(result.status!=='finalized'){
    const diagnostic=await createVehicleIssuanceRequestReceiptReader(()=>receiptRpc,trust,async()=>({quote:q,signedTransaction:wire}))(request);
    throw Error('Actual request receipt unavailable: '+JSON.stringify({state:result,diagnostic}));
   }expect(sends).toBe(1);expect(signatures).toBe(1);
   expect(result.receipt!.proof.oracleSpendLamports).toBe(String(BigInt(original.terms.oracleBudget)-(records.length===2?1n:0n)));
   expect(await createVehicleCraftDelivery(source.db).get(request)).toEqual(result);
   expect(await createVehicleCraftDelivery(source.db).recover(request,new AbortController().signal)).toEqual(result);
   expect((await createVehicleCraftMaterials(source.db).read(request.wallet,request.idempotencyKey))?.status).toBe('held');
   retained.set(original.rootId,{request,state:result});records.push({original,preparation:prepared,wire:savedWire,submitted,finalized:result,sends,signatures,sentWires,actual:{signature,slot:executed.slot}});
   await writeFile(join(chain.working,'vehicle-request-delivery-proof.json'),JSON.stringify({scope:'actual earned private request retained-wire delivery; synthetic VRF; no live supplier/K140',records},null,2));
   chain.record('D215 exact retained wallet request sent once; finalized pending request does not consume materials');
   return {signature,slot:executed.slot,wireBytes:wire.length};
  }finally{await issuer.close();}
 },onPaidResult:async({source,original,chain})=>{
  const old=retained.get(original.rootId);need(old,'Missing retained finalized request');
  expect(await createVehicleCraftDelivery(source.db).get(old.request)).toEqual(old.state);
  expect(await createVehicleCraftDelivery(source.db).recover(old.request,new AbortController().signal)).toEqual(old.state);
  expect((await createVehicleCraftMaterials(source.db).read(old.request.wallet,old.request.idempotencyKey))?.status).toBe('consumed');
  chain.record('D215 original request receipt replays offline after distinct paid material consumption');
 }});expect(records).toHaveLength(3);
 }finally{await rm(directory,{recursive:true,force:true});}
}
