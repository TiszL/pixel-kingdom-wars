import {PublicKey,SystemProgram} from '@solana/web3.js';
import {describe,expect,it,vi} from 'vitest';
import {createVehicleIssuanceQuoteReader,verifyVehicleIssuanceQuote,type VehicleIssuanceQuote} from './vehicleIssuanceQuote';
import {normalizeVehicleIssuanceOriginal} from './vehicleIssuanceAccounts';
import {vehiclePda,vehicleFees} from './vehicleIssuanceProtocol';
import {vehicleIssuanceQuoteFixture} from './testFixtures/vehicleIssuanceQuote';
const read=(f:ReturnType<typeof vehicleIssuanceQuoteFixture>)=>createVehicleIssuanceQuoteReader(()=>f.rpc,f.trust,f.policyAuthority,{costLimits:f.costLimits})(f.input);
const payer=(f:ReturnType<typeof vehicleIssuanceQuoteFixture>)=>f.rows.find(row=>row.address.toBase58()===f.input.original.buyer)!;
const prefund=(f:ReturnType<typeof vehicleIssuanceQuoteFixture>,seed:string,lamports:number)=>{const id=seed==='vehicle_attempt'?f.input.original.attemptId:seed==='vehicle_permit'?f.input.original.permitId:f.input.original.rootId;f.rows.push({address:vehiclePda(seed,id)[0],owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports});};
const rent=(size:number)=>(128+size)*3480*2;
describe('private complete vehicle request quote',()=>{
 it('quotes exact message fees, three init rents and both escrow transfers from a coherent final payer bank',async()=>{
  const f=vehicleIssuanceQuoteFixture(),bank=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext'),fee=vi.spyOn(f.rpc,'getFeeForMessage'),height=vi.spyOn(f.rpc,'getBlockHeight'),q=await read(f);
  expect(q.costs.allocations.map(a=>[a.kind,a.bytes,a.minimumBalanceLamports,a.topUpLamports])).toEqual([['root',170,String(rent(170)),String(rent(170))],['attempt',557,String(rent(557)),String(rent(557))],['permit',170,String(rent(170)),String(rent(170))]]);
  const expected=BigInt(f.controls.networkFee+rent(170)*2+rent(557))+vehicleFees().application+BigInt(f.input.original.terms.oracleBudget)+2n*BigInt(f.input.original.escrowRentReserve);
  expect(q.costs.requiredLamports).toBe(expected.toString());expect(q.payer.remainingLamports).toBe((BigInt(payer(f).lamports)-expected).toString());
  expect(bank.mock.calls.map(c=>c[0].length)).toEqual([18,18]);expect(bank.mock.calls[1]![1].minContextSlot).toBe(102);expect(height.mock.calls[0]![0]).toEqual({commitment:'finalized',minContextSlot:103});
  expect(Buffer.from(fee.mock.calls[0]![0].serialize()).toString('hex')).toBe(q.messageHex);expect(q.currentBlockHeight).toBe(500);expect(q.source.final.admission.slot).toBe(103);
  expect(JSON.stringify(q).length).toBeLessThan(50000);expect(verifyVehicleIssuanceQuote(JSON.parse(JSON.stringify(q)),f.input)).toEqual(q);
  expect([q.signingAuthorized,q.broadcastAuthorized,q.paymentAuthorized,q.activationAuthorized,q.reservationReleaseAuthorized]).toEqual([false,false,false,false,false]);
 });
 it.each(['vehicle_root','vehicle_attempt','vehicle_permit'])('credits only %s init rent top-up for prefunding below/equal/above rent',async seed=>{
  for(const delta of [-1,0,1]){const f=vehicleIssuanceQuoteFixture(),size=seed==='vehicle_attempt'?557:170;prefund(f,seed,rent(size)+delta);const q=await read(f),a=q.costs.allocations.find(a=>a.kind===seed.slice(8))!;expect(a.existingLamports).toBe(String(rent(size)+delta));expect(a.topUpLamports).toBe(delta<0?'1':'0');}
 });
 it('does not discount escrow donations or buyer recipient aliases or invent a later Core fee',async()=>{
  const f=vehicleIssuanceQuoteFixture();prefund(f,'vehicle_app',123456);prefund(f,'vehicle_oracle',987654);const {originalHash:_,...raw}=f.input.original;
  const original=normalizeVehicleIssuanceOriginal({...raw,terms:{...raw.terms,site:raw.buyer,operator:raw.buyer,project:raw.buyer}});f.input=f.authorize(original);const q=await read(f);
  expect(q.costs.applicationFundingLamports).toBe((vehicleFees().application+BigInt(original.escrowRentReserve)).toString());expect(q.costs.oracleFundingLamports).toBe((BigInt(original.terms.oracleBudget)+BigInt(original.escrowRentReserve)).toString());expect(q.costs).not.toHaveProperty('coreCreateFeeLamports');
 });
 it('uses final-bank donations and payer balance after asynchronous fee work',async()=>{
  const f=vehicleIssuanceQuoteFixture(),fee=f.rpc.getFeeForMessage;f.rpc.getFeeForMessage=async(...args)=>{prefund(f,'vehicle_root',rent(170));payer(f).lamports=900000000;return fee(...args);};const q=await read(f);
  expect(q.source.initial.balances[11]!.lamports).toBe('0');expect(q.costs.allocations[0]!.topUpLamports).toBe('0');expect(q.payer.balanceLamports).toBe('900000000');
 });
 it('admits exact full spend/rent-exempt remainder and refuses shortage/dust separately',async()=>{
  const baseline=await read(vehicleIssuanceQuoteFixture()),required=Number(baseline.costs.requiredLamports);
  for(const delta of [0,rent(0)]){const f=vehicleIssuanceQuoteFixture();payer(f).lamports=required+delta;expect((await read(f)).payer.remainingLamports).toBe(String(delta));}
  const short=vehicleIssuanceQuoteFixture();payer(short).lamports=required-1;await expect(read(short)).rejects.toMatchObject({code:'INSUFFICIENT_SOL'});
  const dust=vehicleIssuanceQuoteFixture();payer(dust).lamports=required+1;await expect(read(dust)).rejects.toMatchObject({code:'DUST'});
 });
 it.each(['network','rent','total'])('holds above explicit %s ceiling',async kind=>{
  const f=vehicleIssuanceQuoteFixture();f.costLimits[kind==='network'?'maxNetworkFeeLamports':kind==='rent'?'maxInitializationRentLamports':'maxRequiredLamports']='0';await expect(read(f)).rejects.toMatchObject({code:'COST'});
 });
 it('matches zero-rent Anchor branches without treating escrow reserve as rebate',async()=>{
  const f=vehicleIssuanceQuoteFixture();f.rows[9]!.data.writeDoubleLE(0,8);prefund(f,'vehicle_root',1);const q=await read(f);expect(q.costs.initializationRentLamports).toBe('0');expect(q.costs.escrowRentReserveLamports).toBe(f.input.original.escrowRentReserve);
 });
 it.each(['unsafe-balance','negative-balance','missing-payer','nonce-payer','payer-owner','null-fee','unsafe-fee','negative-fee'])('fails closed for %s',async kind=>{
  const f=vehicleIssuanceQuoteFixture();if(kind==='unsafe-balance')payer(f).lamports=Number.MAX_SAFE_INTEGER+1;if(kind==='negative-balance')payer(f).lamports=-1;
  if(kind==='missing-payer')f.rows.splice(f.rows.indexOf(payer(f)),1);if(kind==='nonce-payer')payer(f).data=Buffer.alloc(80);if(kind==='payer-owner')payer(f).owner=new PublicKey(f.policyAuthority);
  if(kind==='null-fee')f.rpc.getFeeForMessage=async()=>({context:{slot:102},value:null});if(kind==='unsafe-fee')f.controls.networkFee=Number.MAX_SAFE_INTEGER+1;if(kind==='negative-fee')f.controls.networkFee=-1;
  await expect(read(f)).rejects.toMatchObject({reservationReleaseAuthorized:false});
 });
 it('refuses u64 funding overflow before returning a complete quote',async()=>{
  const f=vehicleIssuanceQuoteFixture(),{originalHash:_,...raw}=f.input.original;f.input=f.authorize(normalizeVehicleIssuanceOriginal({...raw,terms:{...raw.terms,oracleBudget:'18446744073709551615'}}));await expect(read(f)).rejects.toThrow();
 });
 it.each(['occupied','paused','key','rent','clock','payer'])('refuses changed %s in final source bank',async kind=>{
  const f=vehicleIssuanceQuoteFixture(),fee=f.rpc.getFeeForMessage;f.rpc.getFeeForMessage=async(...args)=>{
   if(kind==='occupied'){prefund(f,'vehicle_root',1);f.rows.at(-1)!.owner=new PublicKey(f.policyAuthority);}if(kind==='paused')f.rows[6]!.data[177]=1;if(kind==='key')new PublicKey(f.input.original.buyer).toBuffer().copy(f.rows[6]!.data,41);
   if(kind==='rent')f.rows[9]!.data.writeDoubleLE(3,8);if(kind==='clock')f.controls.finalUnixTimestamp=1700000060n;if(kind==='payer')payer(f).lamports=1;return fee(...args);
  };await expect(read(f)).rejects.toThrow();
 });
 it.each(['blockhash-slot','fee-slot','opening-floor','bank-floor','closing-slot','genesis','height','clock-backward','zero-blockhash'])('refuses %s incoherence',async kind=>{
  const f=vehicleIssuanceQuoteFixture();if(kind==='blockhash-slot')f.controls.blockhashSlot=99;if(kind==='fee-slot')f.controls.feeSlot=100;if(kind==='bank-floor')f.controls.finalBankSlot=101;
  if(kind==='opening-floor'){const fee=f.rpc.getFeeForMessage;f.rpc.getFeeForMessage=async(...args)=>{const r=await fee(...args);f.controls.slot=101;return r;};}
  if(kind==='closing-slot'){const height=f.rpc.getBlockHeight;f.rpc.getBlockHeight=async(...args)=>{f.controls.slot=102;return height(...args);};}
  if(kind==='genesis'){let calls=0;f.rpc.getGenesisHash=async()=>++calls===5?f.policyAuthority:f.input.original.genesisHash;}
  if(kind==='height')f.controls.currentBlockHeight=601;if(kind==='clock-backward')f.controls.finalUnixTimestamp=1700000019n;if(kind==='zero-blockhash')f.rpc.getLatestBlockhashAndContext=async()=>({context:{slot:101},value:{blockhash:SystemProgram.programId.toBase58(),lastValidBlockHeight:600}});
  await expect(read(f)).rejects.toThrow();
 });
 it('refuses altered retained identity/message/cost/source fields and exact expected receipt conflicts',async()=>{
  const f=vehicleIssuanceQuoteFixture(),q=await read(f),mutations:((q:VehicleIssuanceQuote)=>void)[]=[q=>{q.originalHash='ab'.repeat(32);},q=>{q.policySignatureHex='ab'.repeat(64);},q=>{q.blockhash=f.policyAuthority;},q=>{q.messageHex=q.messageHex.slice(0,-2)+'ff';},q=>{q.messageSha256='ab'.repeat(32);},q=>{q.currentBlockHeight=601;},q=>{q.costs.requiredLamports='1';},q=>{q.costs.allocations[0]!.bytes=171;},q=>{q.costs.allocations[0]!.address=f.policyAuthority;},q=>{q.costs.allocations[0]!.topUpLamports='0';},q=>{q.source.final.bankSha256='ab'.repeat(32);},q=>{q.source.final.balances[11]!.lamports='1';},q=>{q.source.final.rentHex='00'.repeat(17);},q=>{q.source.final.admission.unixTimestamp='1';},q=>{q.source.final.admission.source.programs[0]!.reviewedProgramDataSha256='ab'.repeat(32);},q=>{q.source.final.admission.source.accounts[0]!.address=f.policyAuthority;},q=>{q.source.feeSlot=99;},q=>{q.source.closingGenesisHash=f.policyAuthority;},q=>{q.payer.remainingLamports='1';}];
  for(const mutation of mutations){const changed=structuredClone(q);mutation(changed);expect(()=>verifyVehicleIssuanceQuote(changed,f.input)).toThrow();}
  expect(()=>verifyVehicleIssuanceQuote({...q,unexpected:true},f.input)).toThrow();expect(()=>verifyVehicleIssuanceQuote(q,{...f.input,policyAuthority:f.input.original.buyer})).toThrow();
 });
 it('detaches retained bytes, balances and input signature',async()=>{
  const f=vehicleIssuanceQuoteFixture(),q=await read(f),json=JSON.stringify(q);payer(f).lamports=0;f.rows[6]!.data[177]=1;f.input.policySignature[0]=0;expect(JSON.stringify(q)).toBe(json);expect(Object.isFrozen(q.source.final.balances[0])).toBe(true);expect(Object.isFrozen(q.costs.allocations[0])).toBe(true);
  const copied=JSON.parse(json),verified=verifyVehicleIssuanceQuote(copied);copied.source.final.balances[0].lamports='0';expect(JSON.stringify(verified)).toBe(json);
 });
 // 2026-10-10 (CI cluster F): the deadline variant used to race a real 100 ms wall
 // clock. Under CI load an interleaved reader could spend >100 ms of its own budget
 // before reaching the RPC, so active() refused it while it held no RPC work, its
 // slot was correctly released, and the ninth read saw DEADLINE instead of BUSY.
 // The rule pinned here is "an abandoned (aborted or expired) reader keeps its slot
 // until the RPC it ignored drains", so the deadline clock (timers + performance.now)
 // is now test-controlled and only moves once all eight readers are inside the RPC.
 it.each(['abort','deadline'])('bounds ignored %s quote RPC until its real work drains',async kind=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  try{
   const f=vehicleIssuanceQuoteFixture();let release!:()=>void,allBlocked!:()=>void,calls=0;const blocked=new Promise<void>(resolve=>{release=resolve;}),allStarted=new Promise<void>(resolve=>{allBlocked=resolve;});f.rpc.getGenesisHash=async()=>{if(++calls===8)allBlocked();await blocked;return f.input.original.genesisHash;};
   const reader=createVehicleIssuanceQuoteReader(()=>f.rpc,f.trust,f.policyAuthority,{costLimits:f.costLimits,deadlineMs:kind==='deadline'?100:1000}),controllers=Array.from({length:8},()=>new AbortController()),settled=Promise.allSettled(controllers.map(c=>reader(f.input,c.signal)));
   await allStarted;if(kind==='abort')controllers.forEach(c=>c.abort());else await vi.advanceTimersByTimeAsync(100);const results=await settled;expect(results.every(r=>r.status==='rejected'&&r.reason.code==='DEADLINE')).toBe(true);await expect(reader(f.input)).rejects.toMatchObject({code:'BUSY'});expect(calls).toBe(8);release();await new Promise(resolve=>setImmediate(resolve));expect((await reader(f.input)).originalHash).toBe(f.input.original.originalHash);
  }finally{vi.useRealTimers();}
 });
 it('detaches the canonical payer address from provider-owned request arrays',async()=>{
  const f=vehicleIssuanceQuoteFixture(),get=f.rpc.getMultipleAccountsInfoAndContext,slot=f.rpc.getSlot;let received:PublicKey[]|undefined;
  f.rpc.getMultipleAccountsInfoAndContext=async(keys,options)=>{received=keys;keys[17]=new PublicKey(f.policyAuthority);const result=await get(keys,options);result.value[17]={address:keys[17]!,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:1000000000};return result;};
  f.rpc.getSlot=async()=>{if(received)received[17]=new PublicKey(f.input.original.buyer);return slot('finalized');};await expect(read(f)).rejects.toThrow();
 });
 it.each(['fee','height'])('retains ignored abort capacity in later %s RPC, not only initial admission',async stage=>{
  const base=vehicleIssuanceQuoteFixture();let release!:()=>void,ready!:()=>void,calls=0;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),allStarted=new Promise<void>(resolve=>{ready=resolve;});
  const connect=()=>{const f=vehicleIssuanceQuoteFixture();if(stage==='fee'){const original=f.rpc.getFeeForMessage;f.rpc.getFeeForMessage=async(...args)=>{if(++calls===8)ready();await blocked;return original(...args);};}else{const original=f.rpc.getBlockHeight;f.rpc.getBlockHeight=async(...args)=>{if(++calls===8)ready();await blocked;return original(...args);};}return f.rpc;};
  const reader=createVehicleIssuanceQuoteReader(connect,base.trust,base.policyAuthority,{costLimits:base.costLimits,deadlineMs:1000}),controllers=Array.from({length:8},()=>new AbortController()),settled=Promise.allSettled(controllers.map(c=>reader(base.input,c.signal)));
  await allStarted;controllers.forEach(c=>c.abort());expect((await settled).every(r=>r.status==='rejected')).toBe(true);await expect(reader(base.input)).rejects.toMatchObject({code:'BUSY'});release();await new Promise(resolve=>setTimeout(resolve,0));expect((await reader(base.input)).originalHash).toBe(base.input.original.originalHash);
 });
 it('does not connect on pre-abort or after changed original terms invalidate the policy signature',async()=>{
  const f=vehicleIssuanceQuoteFixture(),connect=vi.fn(()=>f.rpc),reader=createVehicleIssuanceQuoteReader(connect,f.trust,f.policyAuthority,{costLimits:f.costLimits}),controller=new AbortController();controller.abort();await expect(reader(f.input,controller.signal)).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
  const {originalHash:_,...raw}=f.input.original;await expect(reader({...f.input,original:normalizeVehicleIssuanceOriginal({...raw,terms:{...raw.terms,materialHash:'ab'.repeat(32)}})})).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
 });
});
