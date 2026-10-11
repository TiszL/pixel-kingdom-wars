import {describe,it,expect,vi} from 'vitest';
import {VersionedTransaction,MessageV0} from '@solana/web3.js';
import {createCharterTransferQuoteReader,buildCharterTransferPacket,verifyCharterTransferQuote} from './charterTransferPreparation';
import {verifyCharterTransferSignedWire} from './charterTransferWire';
import {transferPreparationFixture} from './testFixtures/charterTransferPreparation';
describe('original ordinary Charter transfer quote',()=>{
 it('prepares the exact both-wallet packet from genuine current profile and price/royalty/fee/rent',async()=>{
  const f=transferPreparationFixture(),quote=await createCharterTransferQuoteReader(f.connect,f.options)(f.original,f.permitId);
  expect(quote.costs.priceLamports).toBe('101000003');expect(quote.costs.royaltyLamports).toBe('5050000');
  expect(quote.costs.sellerLamports).toBe('95950003');expect(quote.observation.registryRevision).toBe(1);
  const signature=f.sign(f.policy,Buffer.from(quote.packetInput.candidateHex,'hex')).toString('hex');
  const packet=buildCharterTransferPacket({...quote.packetInput,policySignatureHex:signature});
  const tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));tx.sign([f.buyer,f.seller]);
  expect(verifyCharterTransferSignedWire({buyer:f.buyer.publicKey,seller:f.seller.publicKey,intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:tx.serialize()}).signature).toBeTruthy();
  expect(packet.packetBytes).toBeLessThanOrEqual(1232);expect(MessageV0.deserialize(Buffer.from(packet.messageHex,'hex')).header.numRequiredSignatures).toBe(2);
  expect(verifyCharterTransferQuote(JSON.parse(JSON.stringify(quote)))).toEqual(quote);
 });
 it.each(['revision','lock','owner','treasury','core','signer'] as const)('holds %s instead of making an executable sale from an unrecognized source',async kind=>{
  const f=transferPreparationFixture();
  await createCharterTransferQuoteReader(f.connect,f.options)(f.original,f.permitId);
  if(kind==='revision')f.get('charter').data.writeUInt32LE(3,153);
  if(kind==='lock')f.get('charter').data[158]=1;
  if(kind==='owner')f.get('asset').data[1]=f.get('asset').data[1]!^1;
  if(kind==='treasury')f.config[41]=f.config[41]!^1;
  if(kind==='core')f.get('asset').data[f.pluginAt+1]=0;
  if(kind==='signer')f.authorityData[74]=f.authorityData[74]!^1;
  await expect(createCharterTransferQuoteReader(f.connect,f.options)(f.original,f.permitId)).rejects.toThrow(/held/);
 });
 it('rejects changed retained costs and packet rather than granting authority from stored JSON',async()=>{
  const f=transferPreparationFixture(),quote=await createCharterTransferQuoteReader(f.connect,f.options)(f.original,f.permitId);
  expect(()=>verifyCharterTransferQuote({...quote,costs:{...quote.costs,royaltyLamports:'0'}})).toThrow();
  expect(()=>verifyCharterTransferQuote({...quote,template:{...quote.template,messageHex:'00'}})).toThrow();
  const accounts=quote.observation.source.accounts.map(v=>({...v}));accounts[16]!.address=f.buyer.publicKey.toBase58();
  expect(()=>verifyCharterTransferQuote({...quote,observation:{...quote.observation,source:{...quote.observation.source,accounts}}})).toThrow();
 });
 it('pins copied operator configuration and original terms while RPC yields',async()=>{
  const f=transferPreparationFixture(),read=createCharterTransferQuoteReader(f.connect,f.options),original=structuredClone(f.original);
  let release!:(v:string)=>void;f.rpc.getGenesisHash=vi.fn().mockImplementationOnce(()=>new Promise<string>(r=>release=r)).mockResolvedValue(f.genesis.toBase58());
  const pending=read(original,f.permitId);while(!release)await Promise.resolve();(original.sale as {priceLamports:string}).priceLamports='1';
  (f.options.lookupTable as {dataSha256:string}).dataSha256='00'.repeat(32);release(f.genesis.toBase58());
  const quote=await pending;expect(quote.packetInput.original.sale.priceLamports).toBe('101000003');expect(Object.isFrozen(quote.packetInput.original.sale)).toBe(true);
 });
 it('keeps ignored-abort RPC work inside the shared pending cap until it actually settles',async()=>{
  vi.useFakeTimers();try{
   const f=transferPreparationFixture(),read=createCharterTransferQuoteReader(f.connect,f.options),releases:((v:string)=>void)[]=[];
   f.rpc.getGenesisHash=vi.fn(()=>new Promise<string>(r=>releases.push(r)));
   const pending=Array.from({length:8},()=>read(f.original,f.permitId).catch(error=>error));await vi.advanceTimersByTimeAsync(0);
   expect(releases).toHaveLength(8);await expect(read(f.original,f.permitId)).rejects.toMatchObject({code:'BUSY'});
   await vi.advanceTimersByTimeAsync(60000);expect((await Promise.all(pending)).every(error=>error.code==='DEADLINE')).toBe(true);
   await expect(read(f.original,f.permitId)).rejects.toMatchObject({code:'BUSY'});releases.forEach(r=>r(f.genesis.toBase58()));await vi.advanceTimersByTimeAsync(0);
   f.rpc.getGenesisHash=vi.fn(async()=>f.genesis.toBase58());expect((await read(f.original,f.permitId)).packetInput.original).toEqual(f.original);
  }finally{vi.useRealTimers();}
 });
});
