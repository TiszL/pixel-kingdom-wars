import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {Keypair,Message,PublicKey,TransactionMessage,VersionedTransaction,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {AccountLayout} from '@solana/spl-token';
import {PHASE_E_MINING_PUBLICATION as P} from '@shardkeep/shared';
import bs58 from 'bs58';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import {createMiningTaxReceiptReader} from './miningTaxReceiptReader';
import {seekerAuthorityPda} from './seekerAuctionProtocol';
import {miningEpochPda} from './miningProgramProtocol';
import {hashMiningTaxCommitment,miningTaxEpochReceiptPda} from './miningTaxProtocol';
import {createMiningTaxReceiptReaderFixture} from './testFixtures/miningTaxReceiptReader';
type Mutable<T>={-readonly [K in keyof T]:T[K] extends object?Mutable<T[K]>:T[K]};
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl);
const read=(f:Awaited<ReturnType<typeof createMiningTaxReceiptReaderFixture>>)=>createMiningTaxReceiptReader(f.connect,f.trust)(f.request);
afterEach(()=>vi.useRealTimers());
describe('trusted finalized original KEEP tax receipt reader',()=>{
 describe.each(['claim','combined'] as const)('fresh advancing %s fixture',kind=>{
  let f:Awaited<ReturnType<typeof createMiningTaxReceiptReaderFixture>>;
  // Independently bound full signed-bank construction and receipt behavior;
  // every case still gets fresh keys, mutable accounts and original settlements.
  beforeEach(async()=>{f=await createMiningTaxReceiptReaderFixture(kind,{advancingQuote:true});},5000);
  it(`authenticates actual ${kind} quote through an advancing post-cost bank`,async()=>{
   expect(f.quote!.source).toMatchObject({firstSnapshotSlot:2000,feeSlot:2002,snapshotSlot:2003});expect(f.request.blockhashContextSlot).toBe(f.quote!.blockhashSlot);expect(f.quote!.blockhashSlot).toBe(2001);
   expect(await read(f)).toMatchObject({phase:'settled',paidKeepBaseUnits:'3',finalityAuthenticated:true,source:{observedAccountSlot:2005}});
   f.txs[0]!.slot=2002;await expect(read(f)).rejects.toThrow();f.txs[0]!.slot=2004;
   await expect(createMiningTaxReceiptReader(f.connect,f.trust)({...f.request,blockhashContextSlot:2005})).rejects.toThrow();
   await expect(createMiningTaxReceiptReader(f.connect,f.trust)({...f.request,blockhashContextSlot:f.trust.mining.reviewedDeploymentSlot-1})).rejects.toMatchObject({code:'INPUT'});
  });
 });
 it('authenticates all original settlement bodies before accepting historical payment',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),result=await read(f);
  expect(result).toMatchObject({phase:'settled',paidKeepBaseUnits:'3',finalityAuthenticated:true,signingAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
  expect(result.source).toMatchObject({trust:'trusted-finalized-rpc-reviewed-program',originalTermContextSlot:2003,observedAccountSlot:2003});
  expect(f.calls.transactions).toHaveLength(101);expect(f.calls.history).toBe(0);expect(f.calls.blocks).toBe(0);expect(f.signals).toHaveLength(1);expect(f.signals[0]!.aborted).toBe(true);
  expect(f.calls.banks.at(-1)!.floor).toBe(2003);expect(new Set(f.calls.banks.at(-1)!.addresses.map(a=>a.toBase58())).size).toBe(f.calls.banks.at(-1)!.addresses.length);
 });
 describe('fresh native-permit split fixture',()=>{
  let f:Awaited<ReturnType<typeof createMiningTaxReceiptReaderFixture>>;
  beforeEach(async()=>{f=await createMiningTaxReceiptReaderFixture('split');},5000);
  it('authenticates native-permit original settlements for seven-day split; setup stays non-paying',async()=>{
   const verify=createMiningTaxReceiptReader(f.connect,f.trust);
   expect(f.request.snapshot.term.auctions.every(a=>a.settlement.method==='permit')).toBe(true);
   const result=await verify(f.request);expect(result.phase).toBe('settled');expect(result.paidKeepBaseUnits).toBe('23');
   const setup=await verify({...f.request,signedTransactions:[f.request.signedTransactions[0]!]});expect(setup.phase).toBe('setup');expect(setup.paidKeepBaseUnits).toBe('0');
  });
 });
 it('recovers after ATA closure and a settled auction loser refund',async()=>{
  const f=await createMiningTaxReceiptReaderFixture();f.state.store.delete(f.state.addresses.ata.toBase58());const auction=f.state.store.get(f.state.models.cursor.auction.toBase58())!,model=coder.accounts.decode('Auction',auction.data);model.outstanding_escrow=new BN(300);auction.data=await coder.accounts.encode('Auction',model);
  expect((await read(f)).paidKeepBaseUnits).toBe('3');
 });
 it('proves only the historical payment when newer accruals and own cursor claims exist',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),s=f.state,day=s.models.epoch.day+1n,epoch=miningEpochPda(s.term.programId,day),accrual=miningTaxEpochReceiptPda(s.term.programId,epoch),le=Buffer.alloc(8);le.writeBigUInt64LE(day);
  s.models.pool.accrued=20n;s.models.pool.paid=9n;s.models.cursor.claimed_total=6n;await s.encode('pool');await s.encode('cursor');Object.assign(s.backing.model,{tax_highwater:20n,tax_paid:9n,latest_day:day,gross_published:200n,recycled_total:20n});await s.config();
  const pack=(value:object)=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typeof v==='bigint'?new BN(v.toString()):v instanceof Uint8Array?[...v]:v]));
  const model={...s.models.epoch,day,funded_at:(day+1n)*BigInt(P.daySec),tax_commitment:hashMiningTaxCommitment(s.term,{day,epoch}),bump:PublicKey.findProgramAddressSync([Buffer.from('mining_epoch'),le],s.term.programId)[1]},template=s.store.get(s.addresses.epoch.toBase58())!;
  s.store.set(epoch.toBase58(),{...template,data:await coder.accounts.encode('MiningEpochReceipt',pack(model))});
  s.store.set(accrual.toBase58(),{...template,data:await coder.accounts.encode('MiningTaxAccrual',pack({...s.models.accrual,epoch,accrued_at:f.clock.readBigInt64LE(32),bump:PublicKey.findProgramAddressSync([Buffer.from('mining_tax_epoch'),s.term.config.toBuffer(),epoch.toBuffer()],s.term.programId)[1]}))});
  const vault=s.store.get(s.backing.rows[1]!.address.toBase58())!;AccountLayout.encode({...AccountLayout.decode(vault.data),amount:94n},vault.data);
  const result=await read(f);expect(result.paidKeepBaseUnits).toBe('3');expect(result.transactions[0]).toMatchObject({claimedCumulativeBaseUnits:'3',currentClaimedTotal:'6',currentPoolAccrued:'20',currentPoolPaid:'9'});
 });
 it('accepts an actual signed v0 original settlement while the tax message remains exact legacy',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),snapshot=structuredClone(f.request.snapshot) as Mutable<typeof f.request.snapshot>,original=snapshot.term.auctions[0]!,tx=f.transactions.get(original.settlement.signature)!,settler=Keypair.generate(),parsed=TransactionMessage.decompile(tx.transaction.message);
  const old=parsed.payerKey;parsed.payerKey=settler.publicKey;for(const ix of parsed.instructions)for(const key of ix.keys)if(key.pubkey.equals(old))key.pubkey=settler.publicKey;
  const message=parsed.compileToV0Message(),signed=new VersionedTransaction(message);signed.sign([settler]);const signature=bs58.encode(signed.signatures[0]!);
  f.transactions.set(signature,{...tx,version:0,transaction:{message,signatures:[signature]},meta:{...tx.meta!,loadedAddresses:{writable:[],readonly:[]}}});original.settlement={...original.settlement,signature,settler:settler.publicKey.toBase58()};
  expect((await createMiningTaxReceiptReader(f.connect,f.trust)({...f.request,snapshot})).paidKeepBaseUnits).toBe('3');expect(f.calls.transactions).toContain(signature);
 });
 it('accepts authority rotation and a later pause without replacing original permit/winner facts',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),row=f.state.store.get(seekerAuthorityPda(f.trust.mining.programId).toBase58())!,data=coder.accounts.decode('SeekerAuthority',row.data);data.current_policy_key=Keypair.generate().publicKey;data.admission_paused=false;(await coder.accounts.encode('SeekerAuthority',data)).copy(row.data);
  f.state.backing.model.flags=1;await f.state.config();expect((await read(f)).paidKeepBaseUnits).toBe('3');
 });
 it.each(['missing-tax','missing-original','failed-original','failed-tax'] as const)('holds %s separately from paid or safely releasable evidence',async kind=>{
  const f=await createMiningTaxReceiptReaderFixture(),sig=kind.endsWith('tax')?f.txs[0]!.transaction.signatures[0]!:f.request.snapshot.term.auctions[0]!.settlement.signature;
  if(kind.startsWith('missing'))f.transactions.set(sig,null);else f.transactions.get(sig)!.meta!.err={InstructionError:[0,{Custom:1}]};
  await expect(read(f)).rejects.toMatchObject({code:kind==='failed-tax'?'FAILED_OBSERVATION':'UNAVAILABLE',journalClearingAuthorized:false});expect(f.calls.history+f.calls.blocks).toBe(0);
 });
 it.each(['extra','wire','wallet','round','spot','cap','signature-hint','winner','terms','retained-deployment','large-facts'] as const)('refuses substituted stored %s facts',async kind=>{
  const f=await createMiningTaxReceiptReaderFixture(),request={...f.request,snapshot:structuredClone(f.request.snapshot) as Mutable<typeof f.request.snapshot>,plan:{...f.request.plan},caps:{...f.request.caps},signedTransactions:f.request.signedTransactions.map(w=>Uint8Array.from(w))};
  if(kind==='extra')Object.assign(request,{evidence:[]});if(kind==='wire')request.signedTransactions[0]![20]=request.signedTransactions[0]![20]!^1;if(kind==='wallet')request.plan.wallet=Keypair.generate().publicKey;if(kind==='round')request.plan.round++;if(kind==='spot')request.plan.spot++;
  if(kind==='cap')request.caps.maxFeeLamports=-1n;
  if(kind==='signature-hint')request.snapshot.term.auctions[0]!.settlement={...request.snapshot.term.auctions[0]!.settlement,signature:request.snapshot.term.auctions[1]!.settlement.signature};
  if(kind==='winner')request.snapshot.term.auctions[20]!.winner=Keypair.generate().publicKey.toBase58();
  if(kind==='terms')request.snapshot.term.auctions[20]!.terms={...request.snapshot.term.auctions[20]!.terms,prizeBps:1};
  if(kind==='retained-deployment')request.snapshot.term.deployment={...request.snapshot.term.deployment,upgradeAuthority:Keypair.generate().publicKey.toBase58()};
  if(kind==='large-facts')Object.assign(request.snapshot,{padding:'x'.repeat(4097)});
  await expect(createMiningTaxReceiptReader(f.connect,f.trust)(request)).rejects.toThrow();
 });
 it.each(['genesis','deployment','mint','bank-short','bank-sparse','bank-oversized','bank-slot','clock','slot-after','metadata-logs','metadata-inner','metadata-token'] as const)('refuses %s provider evidence',async kind=>{
  const f=await createMiningTaxReceiptReaderFixture();
  if(kind==='genesis')f.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
  if(kind==='deployment')f.state.store.get(f.state.backing.programDataAddress.toBase58())!.data[45]=f.state.store.get(f.state.backing.programDataAddress.toBase58())!.data[45]!^1;
  if(kind==='mint')f.state.store.get(f.trust.mining.keepMint.toBase58())!.data[44]=0;
  if(kind==='bank-short'||kind==='bank-sparse'||kind==='bank-oversized'||kind==='bank-slot'||kind==='clock'){
   const original=f.rpc.getMultipleAccountsInfoAndContext;f.rpc.getMultipleAccountsInfoAndContext=async(keys,opts)=>{const r=await original(keys,opts);if(keys.some(k=>k.equals(f.state.term.config))){if(kind==='bank-short')r.value.pop();if(kind==='bank-sparse')delete r.value[r.value.length-1];if(kind==='bank-oversized')r.value[0]!.data=Buffer.alloc(4097);if(kind==='bank-slot')r.context.slot--;if(kind==='clock')r.value[keys.findIndex(k=>k.equals(SYSVAR_CLOCK_PUBKEY))]!.data.writeBigInt64LE(BigInt(f.txs[0]!.blockTime!),32);}return r;};
  }
  if(kind==='slot-after'){let count=0;f.rpc.getSlot=async()=>++count===1?2003:2002;}
  if(kind==='metadata-logs')f.txs[0]!.meta!.logMessages=['x'.repeat(2049)];
  if(kind==='metadata-inner')f.txs[0]!.meta!.innerInstructions![0]!.instructions[0]!.data='1'.repeat(701);
  if(kind==='metadata-token')f.txs[0]!.meta!.postTokenBalances![0]!.uiTokenAmount.amount='1'.repeat(21);
  await expect(read(f)).rejects.toThrow();
 });
 it('copies transaction fields instead of trusting an injected serializer',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),message=f.txs[0]!.transaction.message as Message,valid=message.serialize();message.instructions[0]!.data='11111111';message.serialize=()=>valid;await expect(read(f)).rejects.toThrow();
 });
 it('copies tax metadata before the following provider call can mutate it',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),slot=f.rpc.getSlot;f.rpc.getSlot=async c=>{f.txs[0]!.meta!.err={InstructionError:[0,{Custom:9}]};f.txs[0]!.meta!.logMessages=[];return slot(c);};expect((await read(f)).paidKeepBaseUnits).toBe('3');
 });
 it('copies the post-bank before subsequent provider work mutates reusable buffers',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),accounts=f.rpc.getMultipleAccountsInfoAndContext,slot=f.rpc.getSlot;let post=false;
  f.rpc.getMultipleAccountsInfoAndContext=async(keys,opts)=>{const r=await accounts(keys,opts);if(keys.some(k=>k.equals(f.state.term.config))){post=true;return {...r,value:keys.map(k=>f.state.store.get(k.toBase58())??null)};}return r;};
  f.rpc.getSlot=async c=>{if(post){f.state.store.get(f.state.addresses.cursor.toBase58())!.data.fill(0);f.clock.fill(0);}return slot(c);};expect((await read(f)).paidKeepBaseUnits).toBe('3');
 });
 it('owns stored request and independent trust before the first await',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),genesis=f.trust.mining.expectedGenesisHash,request={...f.request,plan:{...f.request.plan},caps:{...f.request.caps},signedTransactions:f.request.signedTransactions.map(w=>Uint8Array.from(w))};
  let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r;});f.rpc.getGenesisHash=async()=>{await gate;return genesis;};const verify=createMiningTaxReceiptReader(f.connect,f.trust),pending=verify(request);
  request.plan.spot=20;request.caps.maxTotalLamports=0n;request.signedTransactions[0]!.fill(0);f.trust.mining.keepMint=Keypair.generate().publicKey;f.trust.seeker.deployment={...f.trust.seeker.deployment,programDataSha256:'00'.repeat(32)};resolve();expect((await pending).paidKeepBaseUnits).toBe('3');
 });
 it('holds timed-out noncooperative RPC work against capacity until it actually drains',async()=>{
  const f=await createMiningTaxReceiptReaderFixture(),genesis=f.trust.mining.expectedGenesisHash;vi.useFakeTimers();let resolve!:(value:string)=>void;
  f.rpc.getGenesisHash=()=>new Promise<string>(r=>{resolve=r;});const verify=createMiningTaxReceiptReader(f.connect,f.trust,{timeoutMs:20,maxPending:1}),pending=verify(f.request),failure=expect(pending).rejects.toMatchObject({code:'TIMEOUT'});
  await vi.advanceTimersByTimeAsync(20);await failure;expect(f.signals[0]!.aborted).toBe(true);await expect(verify(f.request)).rejects.toMatchObject({code:'BUSY'});resolve(genesis);await vi.advanceTimersByTimeAsync(0);
  f.rpc.getGenesisHash=async()=>genesis;expect((await verify(f.request)).paidKeepBaseUnits).toBe('3');
 });
 it('refuses unknown trust/options and enforces the 32/30-second factory work bounds',async()=>{
  const f=await createMiningTaxReceiptReaderFixture();for(const options of [{maxPending:33},{maxPending:0},{timeoutMs:30001},{timeoutMs:0},{unknown:true}])expect(()=>createMiningTaxReceiptReader(f.connect,f.trust,options)).toThrow();
  expect(()=>createMiningTaxReceiptReader(f.connect,{...f.trust,extra:true} as never)).toThrow();expect(()=>createMiningTaxReceiptReader(f.connect,{...f.trust,mining:{...f.trust.mining,extra:true}} as never)).toThrow();
 });
});
