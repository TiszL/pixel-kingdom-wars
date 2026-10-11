import {SystemProgram} from '@solana/web3.js';
import {describe,expect,it,vi} from 'vitest';
import {createVehicleIssuanceCurrent,type VehicleIssuanceRequestSaved} from './vehicleIssuanceCurrent';
import {vehiclePda} from './vehicleIssuanceProtocol';
import {vehicleIssuanceCurrentFixture} from './testFixtures/vehicleIssuanceCurrent';
const setup=async()=>{const f=await vehicleIssuanceCurrentFixture();let saved:VehicleIssuanceRequestSaved|null=f.saved;const load=vi.fn(async()=>saved),service=createVehicleIssuanceCurrent(()=>f.rpc,f.trust,load);return {...f,load,service,setSaved:(value:VehicleIssuanceRequestSaved|null)=>{saved=value;}};};
describe('retained vehicle request current review and once-only send',()=>{
 it('rechecks after the durable-marker gap and submits retained bytes once with bounded preflight',async()=>{
  const f=await setup(),banks=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext'),review=await f.service.review(f.ref);expect(f.deliveries).toHaveLength(0);
  expect(await f.service.send(f.ref,review)).toEqual({signature:f.wire.signature,wireSha256:f.wire.wireSha256,messageSha256:f.wire.messageSha256});expect(f.deliveries).toEqual([{bytes:f.saved.signedTransaction,options:{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:103}}]);expect(banks).toHaveBeenCalledTimes(4);await expect(f.service.send(f.ref,review)).rejects.toMatchObject({code:'HELD'});expect(f.deliveries).toHaveLength(1);
 });
 it.each(['paused','rotated-key','expired-clock','occupied-root','bad-rent','insufficient','higher-fee','invalid-blockhash','expired-height','observed-status','loader-held'])('holds changed %s between review and dispatch',async kind=>{
  const f=await setup(),review=await f.service.review(f.ref);
  if(kind==='paused')f.rows[6]!.data[177]=1;if(kind==='rotated-key')f.payer.publicKey.toBuffer().copy(f.rows[6]!.data,41);if(kind==='expired-clock')f.controls.finalUnixTimestamp=BigInt(f.saved.quote.permitExpiry);
  if(kind==='occupied-root')f.rows.push({address:vehiclePda('vehicle_root',f.input.original.rootId)[0],owner:f.payer.publicKey,executable:false,data:Buffer.alloc(0),lamports:1});if(kind==='bad-rent')f.rows[9]!.data.writeDoubleLE(3,8);if(kind==='insufficient')f.rows.at(-1)!.lamports=1;if(kind==='higher-fee')f.controls.networkFee++;
  if(kind==='invalid-blockhash')f.control.blockhashValid=false;if(kind==='expired-height')f.controls.currentBlockHeight=601;if(kind==='observed-status')f.control.status={slot:104,err:null};if(kind==='loader-held')f.setSaved(null);
  await expect(f.service.send(f.ref,review)).rejects.toThrow();expect(f.deliveries).toHaveLength(0);await expect(f.service.send(f.ref,review)).rejects.toMatchObject({code:'HELD'});
 });
 it('allows lower costs and donations while using the original blockhash and exact fee message',async()=>{
  const f=await setup();f.controls.networkFee--;f.rows.push({address:vehiclePda('vehicle_root',f.input.original.rootId)[0],owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:1_000_000});const validity=vi.spyOn(f.rpc,'isBlockhashValid'),fee=vi.spyOn(f.rpc,'getFeeForMessage'),review=await f.service.review(f.ref);await f.service.send(f.ref,review);expect(validity.mock.calls.every(args=>args[0]===f.saved.quote.blockhash)).toBe(true);expect(fee.mock.calls.every(args=>args[0].serialize().toString('hex')===f.saved.quote.messageHex)).toBe(true);
 });
 it.each(['copied','wrong-actor','wrong-key','other-instance'])('rejects %s review ticket without RPC or relay',async kind=>{
  const f=await setup(),review=await f.service.review(f.ref),spy=vi.spyOn(f.rpc,'getSignatureStatuses'),service=kind==='other-instance'?createVehicleIssuanceCurrent(()=>f.rpc,f.trust,f.load):f.service,ref=kind==='wrong-actor'?{...f.ref,wallet:f.policyAuthority}:kind==='wrong-key'?{...f.ref,idempotencyKey:'22222222-2222-4222-8222-222222222222'}:f.ref;
  await expect(service.send(ref,kind==='copied'?{...review}:review)).rejects.toThrow();expect(spy).not.toHaveBeenCalled();expect(f.deliveries).toHaveLength(0);
 });
 it('rereads committed server authority after asynchronous RPC',async()=>{const f=await setup(),fee=f.rpc.getFeeForMessage;f.rpc.getFeeForMessage=async(...args)=>{f.setSaved(null);return fee(...args);};await expect(f.service.review(f.ref)).rejects.toThrow();expect(f.deliveries).toHaveLength(0);});
 it.each(['throw','wrong-signature'])('consumes ticket on uncertain %s send',async kind=>{const f=await setup(),review=await f.service.review(f.ref);f.rpc.sendRawTransaction=async()=>{if(kind==='wrong-signature')return f.policyAuthority;throw Error('timeout');};await expect(f.service.send(f.ref,review)).rejects.toMatchObject({code:'SEND_UNCERTAIN'});await expect(f.service.send(f.ref,review)).rejects.toMatchObject({code:'HELD'});});
 it.each(['bank-slot','fee-slot','height-unsafe','height-backward','clock-backward','blockhash-context','genesis'])('refuses incoherent %s current source',async kind=>{
  const f=await setup();if(kind==='bank-slot')f.controls.finalBankSlot=102;if(kind==='fee-slot')f.controls.feeSlot=102;if(kind==='height-unsafe')f.controls.currentBlockHeight=NaN;if(kind==='height-backward')f.controls.currentBlockHeight=499;if(kind==='clock-backward')f.controls.finalUnixTimestamp=1700000020n;if(kind==='blockhash-context')f.rpc.isBlockhashValid=async()=>({context:{slot:102},value:true});if(kind==='genesis')f.rpc.getGenesisHash=async()=>f.policyAuthority;await expect(f.service.review(f.ref)).rejects.toThrow();expect(f.deliveries).toHaveLength(0);
 });
 it('does not use nonfinalized status context as finalized account floor',async()=>{const f=await setup();f.rpc.getSignatureStatuses=async()=>({context:{slot:100000},value:[null]});expect((await f.service.review(f.ref)).slot).toBe(103);});
 it.each(['loader','rpc'])('keeps ignored-abort %s work counted until actual promises drain',async kind=>{
  const f=await setup();let release!:()=>void,calls=0;const blocked=new Promise<void>(r=>{release=r;}),load=async()=>{calls++;if(kind==='loader')await blocked;return f.saved;};if(kind==='rpc')f.rpc.getSignatureStatuses=async()=>{calls++;await blocked;return {context:{slot:103},value:[null]};};
  const service=createVehicleIssuanceCurrent(()=>f.rpc,f.trust,load),controllers=Array.from({length:8},()=>new AbortController()),tasks=Promise.allSettled(controllers.map(c=>service.review(f.ref,c.signal)));await vi.waitFor(()=>expect(calls).toBe(kind==='loader'?8:16));controllers.forEach(c=>c.abort());expect((await tasks).every(r=>r.status==='rejected')).toBe(true);await expect(service.review(f.ref)).rejects.toMatchObject({code:'BUSY'});release();await new Promise(r=>setTimeout(r,10));expect(await service.review(f.ref)).toHaveProperty('signature',f.wire.signature);
 });
 it('keeps ignored-abort relay promise counted and reports uncertainty',async()=>{
  const f=await setup();let release!:()=>void;const blocked=new Promise<void>(r=>{release=r;}),send=vi.fn(async()=>{await blocked;return f.wire.signature;});f.rpc.sendRawTransaction=send;
  const reviews=await Promise.all(Array.from({length:8},()=>f.service.review(f.ref))),controllers=reviews.map(()=>new AbortController()),tasks=Promise.allSettled(reviews.map((r,i)=>f.service.send(f.ref,r,controllers[i]!.signal)));await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(8));controllers.forEach(c=>c.abort());expect((await tasks).every(r=>r.status==='rejected'&&r.reason.code==='SEND_UNCERTAIN')).toBe(true);await expect(f.service.review(f.ref)).rejects.toMatchObject({code:'BUSY'});release();await new Promise(r=>setTimeout(r,10));
 });
});
