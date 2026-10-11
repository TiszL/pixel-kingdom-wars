/** Real HTTP/base64 transport into existing exact Charter validators. These
 * synthetic banks prove wire composition, not live deployment authority. */
import {createServer,type Server} from 'node:http';
import {MessageV0,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {z} from 'zod';
import {afterEach,expect,it} from 'vitest';
import {createCharterCreationQuoteReader,buildCharterCreationPacket,type CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import {createCharterTransferQuoteReader,buildCharterTransferPacket} from '@shardkeep/chain/charter-transfer-preparation';
import {createCharterLockQuoteReader,buildCharterLockPacket} from '@shardkeep/chain/charter-lock-preparation';
import {createCharterLockEvidenceReader} from '@shardkeep/chain/charter-lock-evidence';
import {preparationFixture,sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {transferPreparationFixture} from '../../../packages/chain/src/testFixtures/charterTransferPreparation';
import {evidenceLock} from '../../../packages/chain/src/testFixtures/charterLock';
import {createCharterWorkflowRpc} from '../src/game/charterWorkflowRpc';

const cleanups:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const signal=()=>new AbortController().signal;
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback port');
 cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});return `http://127.0.0.1:${address.port}`;}
const finalized=z.object({commitment:z.literal('finalized'),minContextSlot:z.number().int().nonnegative()});
async function bank(source:CharterCreationQuoteRpc,transaction:VersionedTransactionResponse|null=null){
 const state={genesis:await source.getGenesisHash(),seen:[] as string[],sent:[] as Buffer[],transaction};
 const encode=(row:{owner:PublicKey;executable:boolean;data:Uint8Array}|null)=>row?{owner:row.owner.toBase58(),executable:row.executable,data:[Buffer.from(row.data).toString('base64'),'base64'],lamports:1,rentEpoch:0}:null;
 const url=await listen(createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=z.object({id:z.union([z.string(),z.number()]),method:z.string(),params:z.array(z.unknown())}).parse(JSON.parse(raw));state.seen.push(body.method);let result:unknown;
  if(body.method==='getGenesisHash')result=state.genesis;
  else if(body.method==='getSlot')result=await source.getSlot('finalized');
  else if(body.method==='getMultipleAccounts'){
   const read=await source.getMultipleAccountsInfoAndContext(z.array(z.string()).parse(body.params[0]).map(value=>new PublicKey(value)),finalized.parse(body.params[1]));result={context:read.context,value:read.value.map(encode)};
  }else if(body.method==='getAccountInfo'){
   const read=await source.getAccountInfoAndContext(new PublicKey(z.string().parse(body.params[0])),finalized.parse(body.params[1]));result={context:read.context,value:encode(read.value)};
  }else if(body.method==='getLatestBlockhash')result=await source.getLatestBlockhashAndContext(finalized.parse(body.params[0]));
  else if(body.method==='getFeeForMessage')result=await source.getFeeForMessage(MessageV0.deserialize(Buffer.from(z.string().parse(body.params[0]),'base64')),'finalized');
  else if(body.method==='getMinimumBalanceForRentExemption')result=await source.getMinimumBalanceForRentExemption(z.number().parse(body.params[0]),'finalized');
  else if(body.method==='getBlockHeight')result=await source.getBlockHeight(finalized.parse(body.params[0]));
  else if(body.method==='getSignatureStatuses'){expect(body.params[1]).toEqual({searchTransactionHistory:true});result={context:{slot:150},value:z.array(z.string()).parse(body.params[0]).map(()=>null)};}
  else if(body.method==='sendTransaction'){
   const options=z.object({encoding:z.literal('base64'),skipPreflight:z.literal(false).optional(),preflightCommitment:z.literal('finalized'),maxRetries:z.literal(0),minContextSlot:z.number().int().nonnegative()}).strict().parse(body.params[1]);expect(options.minContextSlot).toBe(150);
   const wire=Buffer.from(z.string().parse(body.params[0]),'base64');state.sent.push(wire);result=bs58.encode(VersionedTransaction.deserialize(wire).signatures[0]!);
  }else if(body.method==='getTransaction'){
   expect(body.params[1]).toMatchObject({commitment:'finalized',maxSupportedTransactionVersion:0});const tx=state.transaction;
   if(!tx)result=null;else{const message=tx.transaction.message;result={...tx,meta:tx.meta?{...tx.meta,loadedAddresses:tx.meta.loadedAddresses?{writable:tx.meta.loadedAddresses.writable.map(k=>k.toBase58()),readonly:tx.meta.loadedAddresses.readonly.map(k=>k.toBase58())}:undefined}:null,
    transaction:{signatures:tx.transaction.signatures,message:{header:message.header,accountKeys:message.staticAccountKeys.map(k=>k.toBase58()),recentBlockhash:message.recentBlockhash,
     instructions:message.compiledInstructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:ix.accountKeyIndexes,data:bs58.encode(ix.data)})),addressTableLookups:message.addressTableLookups.map(row=>({accountKey:row.accountKey.toBase58(),writableIndexes:row.writableIndexes,readonlyIndexes:row.readonlyIndexes}))}}};}
  }else throw Error('Unexpected RPC '+body.method);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 }catch(error){res.statusCode=500;res.end(String(error));}}));return {url,state};
}
function runtime(readRpcUrl:string,relayRpcUrl?:string){const result=createCharterWorkflowRpc({nodeEnv:'test',readRpcUrl,...(relayRpcUrl?{relayRpcUrl}:{})});cleanups.push(()=>result.close());return result;}

it('requires explicit endpoints and exposes read capabilities without an implicit relay',()=>{
 for(const readRpcUrl of ['', 'ftp://example.test','https://example.test/#fragment','https://user:password@example.test'])expect(()=>createCharterWorkflowRpc({nodeEnv:'test',readRpcUrl})).toThrow();
 expect(()=>createCharterWorkflowRpc({readRpcUrl:'http://127.0.0.1:1234'})).toThrow();expect(()=>createCharterWorkflowRpc({readRpcUrl:'https://api.devnet.solana.com'})).toThrow();
 expect(()=>createCharterWorkflowRpc({readRpcUrl:'https://private.example.test',timeoutMs:30_001})).toThrow();
 const source=runtime('http://127.0.0.1:1234');expect(source.deliveryConnect).toBeUndefined();
 expect(Object.keys(source.quoteConnect(signal())).sort()).toEqual(['getAccountInfoAndContext','getBlockHeight','getFeeForMessage','getGenesisHash','getLatestBlockhashAndContext','getMinimumBalanceForRentExemption','getMultipleAccountsInfoAndContext','getSlot']);
 expect(Object.keys(source.recoveryConnect(signal())).sort()).toEqual(['getGenesisHash','getMultipleAccountsInfoAndContext','getSlot','getTransaction']);
});
it('prepares the exact creation quote and signed-policy packet through actual encoded account and ALT reads',async()=>{
 const f=preparationFixture(),peer=await bank(f.rpc),source=runtime(peer.url),quote=await createCharterCreationQuoteReader(source.quoteConnect,f.options)(f.original,f.candidate);
 const {candidateHex,...input}=quote.packetInput,candidate=Buffer.from(candidateHex,'hex');const packet=buildCharterCreationPacket({...input,candidate,policySignature:sign(f.policy,candidate)});
 expect(packet.messageHex).toBe(buildCharterCreationPacket(f.input).messageHex);expect(peer.state.sent).toHaveLength(0);
 const account=await source.recoveryConnect(signal()).getMultipleAccountsInfoAndContext([f.rows[0]!.address],{commitment:'finalized',minContextSlot:150});
 expect(Object.keys(account.value[0]!).sort()).toEqual(['address','data','executable','owner']);
 const alt=await source.quoteConnect(signal()).getAccountInfoAndContext(f.lookup.address,{commitment:'finalized',minContextSlot:150});expect(Object.keys(alt.value!).sort()).toEqual(['data','executable','owner']);
 const wrong={...f.options,trust:{...f.trust,core:{...f.trust.core,reviewedProgramDataSha256:'00'.repeat(32)}},coreCostProfile:{...f.options.coreCostProfile,reviewedProgramDataSha256:'00'.repeat(32)}};
 await expect(createCharterCreationQuoteReader(source.quoteConnect,wrong)(f.original,f.candidate)).rejects.toThrow();
});
it('prepares sale policy and two-wallet unsigned packet through the same narrow quote transport',async()=>{
 const f=transferPreparationFixture(),peer=await bank(f.rpc),source=runtime(peer.url),quote=await createCharterTransferQuoteReader(source.quoteConnect,f.options)(f.original,f.permitId);
 const packet=buildCharterTransferPacket({...quote.packetInput,policySignatureHex:sign(f.policy,Buffer.from(quote.packetInput.candidateHex,'hex')).toString('hex')});
 const tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));expect(tx.message.header.numRequiredSignatures).toBe(2);expect(tx.signatures.every(bytes=>bytes.every(v=>v===0))).toBe(true);expect(peer.state.sent).toHaveLength(0);
});
it('prepares a lock, relays only exact owned bytes after both cluster checks, and verifies encoded finality',async()=>{
 const f=await evidenceLock(),finalCharter=Buffer.from(f.get('charter').data);f.get('charter').data.writeUInt32LE(0,153);f.get('charter').data[158]=0;f.get('charter').data.fill(0,159,175);
 const reader=await bank(f.rpc,f.transaction),relay=await bank(f.rpc),config={nodeEnv:'test' as const,readRpcUrl:reader.url,relayRpcUrl:relay.url},source=createCharterWorkflowRpc(config);cleanups.push(()=>source.close());
 const quote=await createCharterLockQuoteReader(source.quoteConnect,f.options)(f.original,f.permitId),packetInput={...quote.packetInput,policySignatureHex:sign(f.policy,Buffer.from(quote.packetInput.candidateHex,'hex')).toString('hex')};
 const packet=buildCharterLockPacket(packetInput),tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));tx.sign([f.leader]);const saved=Buffer.from(tx.serialize());expect(saved).toEqual(f.wire);
 const settings={skipPreflight:false as const,preflightCommitment:'finalized' as const,maxRetries:0 as const,minContextSlot:150},delivery=source.deliveryConnect!(signal());
 expect(()=>delivery.sendRawTransaction(saved,settings)).toThrow();relay.state.genesis=PublicKey.default.toBase58();await expect(delivery.getGenesisHash()).rejects.toThrow('cluster mismatch');expect(()=>delivery.sendRawTransaction(saved,settings)).toThrow();expect(relay.state.sent).toHaveLength(0);
 relay.state.genesis=reader.state.genesis;expect(await delivery.getGenesisHash()).toBe(reader.state.genesis);
 relay.state.genesis=PublicKey.default.toBase58();await expect(delivery.sendRawTransaction(saved,settings)).rejects.toThrow('cluster changed');expect(relay.state.sent).toHaveLength(0);relay.state.genesis=reader.state.genesis;
 expect(await delivery.getSignatureStatuses([bs58.encode(tx.signatures[0]!)],{searchTransactionHistory:true})).toEqual({context:{slot:150},value:[null]});
 config.readRpcUrl='http://127.0.0.1:1';config.relayRpcUrl='http://127.0.0.1:1';const callerWire=Buffer.from(saved),sent=delivery.sendRawTransaction(callerWire,settings);callerWire.fill(0);await sent;
 expect(relay.state.sent).toEqual([saved]);expect(reader.state.seen).not.toContain('sendTransaction');expect(relay.state.seen.every(method=>method==='getGenesisHash'||method==='sendTransaction')).toBe(true);
 f.get('charter').data=finalCharter;
 const proof=await createCharterLockEvidenceReader(source.recoveryConnect,f.trust,async()=>({packetInput,signedTransactionHex:saved.toString('hex')}))(f.original.operation.id);
 expect(proof).toMatchObject({finalizedTransitionObserved:true,currentStateMatchesResult:true,revision:1});expect(relay.state.sent).toHaveLength(1);
});
it.each(['caller','deadline','lifetime'] as const)('aborts a stalled real RPC through %s and refuses retained methods',async mode=>{
 let arrived!:()=>void,calls=0;const entered=new Promise<void>(resolve=>{arrived=resolve;}),url=await listen(createServer(()=>{calls++;arrived();}));
 const source=createCharterWorkflowRpc({nodeEnv:'test',readRpcUrl:url,timeoutMs:mode==='deadline'?50:5000});cleanups.push(()=>source.close());const caller=new AbortController(),read=source.quoteConnect(caller.signal).getGenesisHash;
 const refused=expect(read()).rejects.toThrow();await entered;if(mode==='caller')caller.abort();if(mode==='lifetime')source.close();await refused;await expect(read()).rejects.toThrow();expect(calls).toBe(1);
});
it.each(['oversize','redirect'] as const)('refuses %s RPC responses without following a second endpoint',async mode=>{
 let calls=0;const url=await listen(createServer((_req,res)=>{calls++;if(mode==='redirect'){res.writeHead(302,{location:'/other'});res.end();}else{res.setHeader('content-type','application/json');res.end(Buffer.alloc(36*1024*1024+1,120));}}));
 await expect(runtime(url).recoveryConnect(signal()).getGenesisHash()).rejects.toThrow();expect(calls).toBe(1);
});
