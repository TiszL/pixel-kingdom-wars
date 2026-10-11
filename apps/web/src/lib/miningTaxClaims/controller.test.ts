import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {describe,it,expect,vi} from 'vitest';
import {MiningTaxClaimRecoveryEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import {MiningTaxClaimJournalStore,type MiningTaxClaimStore} from './journal';
import {MiningTaxClaimController,type MiningTaxClaimPorts} from './controller';
// 2026-10-10 (CI cluster F): split-lifecycle cases re-verify the real signed prefix at every
// durable boundary, and every journal read re-derives the canonical messages; PDA derivation
// and base58 encoding dominate the CPU profile. Measured alone on a dev Mac: up to ~15 s
// (split setup). The shared 4-vCPU CI runner, with the package suites running concurrently,
// was >=4x slower and crossed the previous 20 s budget even on a ~4.6 s case. The budget is
// explicit per case (global timeouts unchanged) so a genuine hang still fails.
const SPLIT_LIFECYCLE_BUDGET_MS = 120_000;
function setup(kind:keyof typeof fixtures='combined'){
 const recovery=MiningTaxClaimRecoveryEnvelopeSchema.parse(structuredClone(fixtures[kind])),p=recovery.preparation!,factory=new IDBFactory();
 const trust={genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,keepMint:p.identity.keepMint,reserveOwner:p.identity.reserveOwner,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256};
 const identity={origin:'https://game.test',api:'https://api.test',cluster:'devnet' as const,wallet:p.wallet},store=new MiningTaxClaimJournalStore(identity,trust,factory);
 const state={epoch:0,paused:false,elapsed:0,phase:'prepared' as 'prepared'|'signed'|'setup'|'settled',serverWires:[] as typeof recovery.wires};
 const signed=recovery.wires.map(w=>({ordinal:w.ordinal,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256}));
 const prep=()=>({wallet:p.wallet,idempotencyKey:p.idempotencyKey,status:'prepared',preparation:p,serverNow:p.preparedAt});
 const saved=()=>{const settled=state.phase==='setup'?structuredClone(fixtures.setup).settlement:state.phase==='settled'?recovery.settlement:null;return {...recovery,status:state.phase,wires:state.serverWires,settlement:settled};};
 const review=(ordinal:number)=>{const tx=p.transactions[ordinal]!,prior=ordinal===1?fixtures.setup.settlement.receipt:null;return {wallet:p.wallet,idempotencyKey:p.idempotencyKey,ordinal,status:'ready',serverNow:'2035-01-01T00:00:02.000Z',review:{
  wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,ordinal,status:'ready',messageSha256:tx.messageSha256,blockhash:p.blockhash,preparedAt:p.preparedAt,expiresAt:p.expiresAt,observedAt:'2035-01-01T00:00:01.000Z',
  feeLamports:tx.feeLamports,rentLamports:tx.rentLamports,totalLamports:(BigInt(tx.feeLamports)+BigInt(tx.rentLamports)).toString(),paidFeeLamports:prior?.feeLamports??'0',paidRentLamports:prior?.rentLamports??'0',
  source:{genesisHash:p.source.genesisHash,programId:p.source.programId,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256,snapshotSlot:p.source.snapshotSlot+1,feeSlot:p.source.snapshotSlot+1,blockHeight:p.blockHeight+1,lastValidBlockHeight:p.lastValidBlockHeight},currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false}};};
 const ports:MiningTaxClaimPorts={capture:(mutation)=>{const epoch=state.epoch;return()=>{if(epoch!==state.epoch||mutation&&state.paused)throw Error('session changed or paused');};},lock:async(_name,run)=>run(),key:()=>p.idempotencyKey,clock:()=>state.elapsed,getContinuation:vi.fn(),prepareContinuation:vi.fn(),
  prepare:vi.fn(async(request,guard,retain)=>{guard();expect((await store.read()).operation).toMatchObject({request,prepareAttempted:true});const value=prep();await retain(value);return value;}),
  getPreparation:vi.fn(async(_request,guard,retain)=>{guard();const value=prep();await retain(value);return value;}),getSaved:vi.fn(async(_key,guard,retain)=>{guard();const value=saved();await retain(value);return value;}),
  getFailures:vi.fn(async(_key,guard,retain)=>{guard();const value={recovery:saved(),failures:[]};await retain(value);return value;}),
  currentReview:vi.fn(async(_key,ordinal,guard)=>{guard();return review(ordinal);}),
  sign:vi.fn(async(prepared,guard)=>{guard();expect((await store.read()).operation!.transactions.find(t=>t.ordinal===prepared.ordinal)?.signingStarted).toBe(true);return signed[prepared.ordinal]!;}),
  submit:vi.fn(async(request,guard,retain)=>{guard();const op=(await store.read()).operation!,tx=op.transactions.find(t=>t.signed?.wire===request.signedTransaction)!;expect(tx.submitAttempted).toBe(true);
   const wire=recovery.wires.find(w=>w.ordinal===tx.ordinal)!;state.serverWires.push(wire);state.phase='signed';const value={wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,wire,delivery:'submitted',serverNow:p.preparedAt};await retain(value);return value;})};
 const controller=new MiningTaxClaimController(store,ports,trust),reopen=()=>new MiningTaxClaimController(new MiningTaxClaimJournalStore(identity,trust,factory),ports,trust);
 return {p,recovery,trust,store,identity,factory,state,signed,prep,saved,review,ports,controller,reopen};
}
const begin=async(f:ReturnType<typeof setup>)=>{await f.controller.begin(f.p.round,f.p.spot,f.p.caps);expect(f.controller.snapshot().error).toBeNull();};
const ready=async(f:ReturnType<typeof setup>,ordinal=0)=>{await f.controller.review(ordinal);expect(f.controller.snapshot().error).toBeNull();expect(f.controller.snapshot().review?.ordinal).toBe(ordinal);};
const sign=async(f:ReturnType<typeof setup>,ordinal=0)=>{await ready(f,ordinal);await f.controller.sign();expect(f.controller.snapshot().error).toBeNull();};
describe('original mining tax claim controller',()=>{
 it('retains a valid started sibling when a structurally valid recovery has another invalid signature', async () => {
  const f = setup('split'); await begin(f); await sign(f);
  const row = await f.store.read();
  await f.store.compareAndSet(row.revision, saved => ({ ...saved, operation: { ...saved.operation!, transactions: [...saved.operation!.transactions,
   { ordinal: 1, signingStarted: true, signed: null, submitAttempted: false }] } }));
  const raw = structuredClone(f.recovery); raw.status = 'signed'; raw.settlement = null;
  const first = raw.wires[0]!, bytes = Buffer.from(first.signedTransactionHex, 'hex'); bytes[1] = bytes[1]! ^ 1;
  first.signedTransactionHex = bytes.toString('hex'); first.signature = bs58.encode(bytes.subarray(1, 65));
  MiningTaxClaimRecoveryEnvelopeSchema.parse(raw);
  f.ports.getSaved = vi.fn(async (_key, _guard, retain) => { await retain(raw); return raw; });
  await f.controller.open();
  expect(f.controller.snapshot().error).toBeTruthy();
  expect((await f.store.read()).operation!.transactions[1]!.signed).toEqual(f.signed[1]);
  expect((await f.store.read()).operation!.settlement).toBeNull();
 });
 it.each(['sign', 'submit'] as const)('blocks %s when another original becomes held inside the provider boundary', async effect => {
  const f = setup(), external = vi.fn();
  await begin(f);
  if (effect === 'sign') await ready(f); else await sign(f);
  const hold = (guard: () => void) => {
   f.store.observeSettlementKey('ffffffff-ffff-4fff-8fff-ffffffffffff', 0);
   guard(); external();
  };
  if (effect === 'sign') f.ports.sign = vi.fn(async (_prepared, guard) => { await Promise.resolve(); hold(guard); return f.signed[0]!; });
  else f.ports.submit = vi.fn(async (_request, guard) => { await Promise.resolve(); hold(guard); throw Error('unexpected send'); });
  await f.controller[effect]();
  expect(external).not.toHaveBeenCalled();
  expect(f.controller.snapshot().error).toMatch(/holds/);
 });
 it.each(['receipt', 'outer wallet', 'observation write'] as const)('retains a valid original signed wire before rejecting a malformed %s', async corruption => {
  const f = setup(); await begin(f); await ready(f);
  f.ports.sign = vi.fn(async () => { throw Error('wallet reply lost'); });
  await f.controller.sign();
  const raw = structuredClone(f.recovery);
  if (corruption === 'receipt') raw.settlement!.receipt.feeLamports = 'invalid';
  else if (corruption === 'outer wallet') raw.wallet = f.p.identity.keepMint;
  else vi.spyOn(f.store, 'observeSettlement').mockRejectedValueOnce(Error('observation write unavailable'));
  f.ports.getSaved = vi.fn(async (_key, _guard, retain) => { await retain(raw); return raw; });
  await f.controller.open();
  expect(f.controller.snapshot().error).toBeTruthy();
  const op = (await f.store.read()).operation!;
  expect(op.transactions[0]!.signed).toEqual(f.signed[0]);
  expect(op.settlement).toBeNull();
  expect(f.store.settlementHeld()).toBe(true);
  expect(f.ports.submit).not.toHaveBeenCalled();
 });
 it('persists intent and attempt markers before every explicit external effect and never remounts into a POST',async()=>{
  const f=setup();await begin(f);await sign(f);await f.controller.submit();expect(f.controller.snapshot().error).toBeNull();await f.controller.submit();const reopened=f.reopen();await reopened.open();await reopened.sign();await reopened.submit();
  expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.ports.sign).toHaveBeenCalledOnce();expect(f.ports.submit).toHaveBeenCalledOnce();expect((await f.store.read()).operation?.transactions[0]?.signed).toEqual(f.signed[0]);
 });
 it('recovers a lost prepare reply only by original GET and never clears an unknown unsigned request',async()=>{
  const f=setup();f.ports.prepare=vi.fn(async()=>{throw Error('lost reply');});await f.controller.begin(f.p.round,f.p.spot,f.p.caps);const original=await f.store.read();expect(original.operation?.prepareAttempted).toBe(true);
  await f.controller.archive();expect((await f.store.read()).operation).not.toBeNull();const c=f.reopen();await c.open();expect(c.snapshot().journal?.operation?.preparation).toEqual(f.p);await c.begin(f.p.round,f.p.spot,f.p.caps);expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('retains valid preparation and exact valid late wallet bytes despite logout and dismissal, without submitting',async()=>{
  const f=setup();f.ports.prepare=vi.fn(async(_r,_g,retain)=>{f.state.epoch++;await retain(f.prep());return f.prep();});await f.controller.begin(f.p.round,f.p.spot,f.p.caps);expect((await f.store.read()).operation?.preparation).toEqual(f.p);
  const c=f.reopen();await c.review();expect(c.snapshot().review).not.toBeNull();f.ports.sign=vi.fn(async()=>{f.state.epoch++;c.dismiss();return f.signed[0]!;});await c.sign();expect((await f.store.read()).operation?.transactions[0]?.signed).toEqual(f.signed[0]);expect(f.ports.submit).not.toHaveBeenCalled();
 });
 it('never repeats an uncertain wallet popup or lost submit across restart, pause or manual recovery',async()=>{
  const f=setup();await begin(f);await ready(f);f.ports.sign=vi.fn(async()=>{throw Error('popup disappeared');});await f.controller.sign();const c=f.reopen();f.state.paused=true;await c.open();await c.archive();f.state.paused=false;await c.review();await c.sign();expect(f.ports.sign).toHaveBeenCalledOnce();
  const g=setup();await begin(g);await sign(g);g.ports.submit=vi.fn(async()=>{throw Error('lost submit response');});await g.controller.submit();await g.reopen().open();await g.controller.submit();expect(g.ports.submit).toHaveBeenCalledOnce();expect((await g.store.read()).operation?.transactions[0]?.submitAttempted).toBe(true);
 });
 it('keeps a null-wire STORAGE_UNCERTAIN acknowledgement held and never treats delivery as terminal proof',async()=>{
  const f=setup();await begin(f);await sign(f);f.ports.submit=vi.fn(async(_r,_g,retain)=>{const value={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,claimId:null,wire:null,delivery:'held',reason:'STORAGE_UNCERTAIN',serverNow:f.p.preparedAt};await retain(value);return value;});await f.controller.submit();
  const row=await f.store.read();expect(row.operation?.transactions[0]?.submitAttempted).toBe(true);expect(row.operation?.settlement).toBeNull();await f.reopen().open();await f.controller.submit();await f.controller.archive();expect(f.ports.submit).toHaveBeenCalledOnce();expect((await f.store.read()).operation).not.toBeNull();
 });
 it.each(['combined','aboveQuote'] as const)('archives only a bound full GET %s settlement, preserving original caps and actual paid costs',async kind=>{
  const f=setup(kind);await begin(f);await sign(f);await f.controller.submit();f.state.phase='settled';f.state.paused=true;await f.controller.open();expect(f.controller.snapshot().error).toBeNull();expect((await f.store.read()).operation?.settlement).toEqual(f.saved());
  await f.controller.archive();expect(f.controller.snapshot().error).toBeNull();expect((await f.store.read()).operation).toBeNull();const history=await f.store.archived(f.p.idempotencyKey);expect(history?.operation?.request.caps).toEqual(f.p.caps);expect(history?.operation?.settlement?.settlement?.receipt.feeLamports).toBe(f.recovery.settlement!.receipt.feeLamports);
 });
 it('retains split setup as nonterminal and requires a separate fresh ordinal1 review and approval',async()=>{
  const f=setup('split');await begin(f);await f.controller.review(1);expect(f.controller.snapshot().review).toBeNull();await sign(f);await f.controller.submit(0);f.state.phase='setup';await f.controller.open();expect(f.controller.snapshot().error).toBeNull();expect((await f.store.read()).operation?.setup?.status).toBe('setup');
  await f.controller.archive();expect((await f.store.read()).operation?.settlement).toBeNull();expect(f.ports.sign).toHaveBeenCalledOnce();await f.controller.sign();expect(f.ports.sign).toHaveBeenCalledOnce();await sign(f,1);await f.controller.submit(1);f.state.phase='settled';await f.controller.open();expect(f.controller.snapshot().error).toBeNull();await f.controller.archive();expect((await f.store.read()).operation).toBeNull();expect(f.ports.sign).toHaveBeenCalledTimes(2);expect(f.ports.submit).toHaveBeenCalledTimes(2);
 },SPLIT_LIFECYCLE_BUDGET_MS); // Complete split flow re-verifies the real signed prefix at each durable boundary.
 it('binds ordinal1 paid costs to verified setup rather than a fresh response with invented lower paid cost',async()=>{
  const f=setup('split');await begin(f);await sign(f);await f.controller.submit(0);f.state.phase='setup';await f.controller.open();f.ports.currentReview=vi.fn(async(_key,ordinal)=>{const r=f.review(ordinal);r.review.paidFeeLamports='0';return r;});await f.controller.review(1);expect(f.controller.snapshot().review).toBeNull();expect(f.controller.snapshot().error).toMatch(/paid setup/i);expect(f.ports.sign).toHaveBeenCalledOnce();
 },SPLIT_LIFECYCLE_BUDGET_MS); // Setup recovery re-verifies the same real signed prefix as the split lifecycle above.
 it('latches malformed positive evidence before storage failure and prevents another instance signing',async()=>{
  const f=setup();await begin(f);f.ports.getSaved=vi.fn(async(_k,_g,retain)=>{const value={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,status:'settled',settlement:{ordinal:0},wires:[{broken:true}]};const fail=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementationOnce(()=>{throw Error('read failed');});try{await retain(value);}finally{fail.mockRestore();}return value;});await f.controller.open();expect(f.store.settlementHeld(f.p.idempotencyKey,0)).toBe(true);
  f.ports.getSaved=vi.fn(async()=>f.saved());const c=f.reopen();await c.open();await c.review();await c.sign();expect(f.ports.sign).not.toHaveBeenCalled();expect((await f.store.read()).operation).not.toBeNull();
 });
 it('holds unknown server custody without inventing a signing marker or clearing the original',async()=>{
  const f=setup();await begin(f);f.state.phase='signed';f.state.serverWires=[f.recovery.wires[0]!];await f.controller.open();expect(f.controller.snapshot().error).toBeTruthy();expect((await f.store.read()).operation?.transactions).toEqual([]);expect(f.store.settlementHeld()).toBe(true);await f.controller.review();await f.controller.sign();await f.controller.archive();expect(f.ports.sign).not.toHaveBeenCalled();expect((await f.store.read()).operation).not.toBeNull();
 });
 it.each(['sign','submit'] as const)('rechecks live identity after each current %s review before marking or invoking an effect',async effect=>{
  const f=setup();await begin(f);if(effect==='sign')await ready(f);else await sign(f);f.ports.currentReview=vi.fn(async(_k,o)=>{f.state.epoch++;return f.review(o);});await f.controller[effect]();expect(effect==='sign'?f.ports.sign:f.ports.submit).not.toHaveBeenCalled();expect((await f.store.read()).operation?.transactions[0]?.[effect==='sign'?'signingStarted':'submitAttempted']??false).toBe(false);
 });
 it('rejects changed message, over-cap current cost and elapsed consent before wallet invocation',async()=>{
  for(const kind of ['message','cap','elapsed']){const f=setup();await begin(f);await ready(f);if(kind==='elapsed')f.state.elapsed=Date.parse(f.p.expiresAt)-Date.parse(f.p.preparedAt);else f.ports.currentReview=vi.fn(async(_k,o)=>{const r=f.review(o);if(kind==='message')r.review.messageSha256='ab'.repeat(32);else{r.review.feeLamports='999999';r.review.totalLamports=(999999n+BigInt(r.review.rentLamports)).toString();}return r;});await f.controller.sign();expect(f.ports.sign).not.toHaveBeenCalled();expect((await f.store.read()).operation?.request.caps).toEqual(f.p.caps);}
 });
 it('refuses to prepare when durable storage cannot save the original intent',async()=>{
  const f=setup(),broken:MiningTaxClaimStore={identity:f.identity,key:f.store.key,read:()=>f.store.read(),archived:k=>f.store.archived(k),archive:r=>f.store.archive(r),archiveFailure:(r,v)=>f.store.archiveFailure(r,v),activateContinuation:(r,v,p)=>f.store.activateContinuation(r,v,p),observeContinuationKey:k=>f.store.observeContinuationKey(k),observeSettlementKey:(k,o)=>f.store.observeSettlementKey(k,o),observeFailureKey:k=>f.store.observeFailureKey(k),settlementHeld:(k,o)=>f.store.settlementHeld(k,o),otherSettlementHeld:k=>f.store.otherSettlementHeld(k),observeSettlement:(r,k,o)=>f.store.observeSettlement(r,k,o),compareAndSet:async()=>{throw Error('storage full');}};
  await new MiningTaxClaimController(broken,f.ports,f.trust).begin(f.p.round,f.p.spot,f.p.caps);expect(f.ports.prepare).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it.each(['sign','submit'] as const)('keeps consent expiry in the %s port guard across its own asynchronous provider boundary',async effect=>{
  const f=setup(),external=vi.fn();await begin(f);if(effect==='sign')await ready(f);else await sign(f);
  if(effect==='sign')f.ports.sign=vi.fn(async(_prepared,guard)=>{guard();await Promise.resolve();f.state.elapsed=Date.parse(f.p.expiresAt)-Date.parse(f.p.preparedAt);guard();external();return f.signed[0]!;});
  else f.ports.submit=vi.fn(async(_request,guard)=>{guard();await Promise.resolve();f.state.elapsed=Date.parse(f.p.expiresAt)-Date.parse(f.p.preparedAt);guard();external();throw Error('unexpected send');});
  await f.controller[effect]();expect(external).not.toHaveBeenCalled();expect(f.controller.snapshot().error).toMatch(/expired/);await f.reopen().open();expect(effect==='sign'?f.ports.sign:f.ports.submit).toHaveBeenCalledOnce();
 });
 it.each(['sign','submit'] as const)('does not invoke %s if a positive observation arrives during its final durable marker write',async effect=>{
  const f=setup();await begin(f);if(effect==='sign')await ready(f);else await sign(f);const original=f.store.compareAndSet.bind(f.store);
  vi.spyOn(f.store,'compareAndSet').mockImplementation((revision,update)=>original(revision,row=>{const next=update(row),before=row.operation!.transactions[0],after=next.operation!.transactions[0];if(effect==='sign'?!before?.signingStarted&&after?.signingStarted:!before?.submitAttempted&&after?.submitAttempted)f.store.observeSettlementKey(f.p.idempotencyKey,0);return next;}));
  await f.controller[effect]();expect(effect==='sign'?f.ports.sign:f.ports.submit).not.toHaveBeenCalled();expect(f.store.settlementHeld(f.p.idempotencyKey,0)).toBe(true);expect((await f.store.read()).operation?.transactions[0]?.[effect==='sign'?'signingStarted':'submitAttempted']??false).toBe(false);
 });
 it('preserves original caps while a fresh selected cost is above the old quote and within those caps',async()=>{
  const f=setup('aboveQuote');await begin(f);f.ports.currentReview=vi.fn(async(_key,o)=>{const r=f.review(o);r.review.feeLamports=f.recovery.settlement!.receipt.feeLamports;r.review.totalLamports=(BigInt(r.review.feeLamports)+BigInt(r.review.rentLamports)).toString();return r;});await sign(f);await f.controller.submit();expect(f.controller.snapshot().error).toBeNull();expect((await f.store.read()).operation?.request.caps).toEqual(f.p.caps);
 });
 it('keeps an uncertain signature save behind its durable wallet marker across restart',async()=>{
  const f=setup();await begin(f);await ready(f);f.ports.sign=vi.fn(async()=>{vi.spyOn(f.store,'compareAndSet').mockRejectedValueOnce(Error('storage full'));return f.signed[0]!;});await f.controller.sign();expect(f.controller.snapshot().error).toMatch(/storage full/);const reopened=f.reopen();await reopened.open();await reopened.review();await reopened.sign();await reopened.submit();expect(f.ports.sign).toHaveBeenCalledOnce();expect(f.ports.submit).not.toHaveBeenCalled();expect((await f.store.read()).operation?.transactions[0]).toMatchObject({signingStarted:true,signed:null,submitAttempted:false});
 });
});
