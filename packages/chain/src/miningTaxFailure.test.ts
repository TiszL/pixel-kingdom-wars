import {Message,PublicKey} from '@solana/web3.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createMiningTaxFailureVerifier} from './miningTaxFailure';
import {createMiningTaxFailureFixture as fixture} from './testFixtures/miningTaxFailure';
type Fixture=ReturnType<typeof fixture>;
const read=(f:Fixture)=>createMiningTaxFailureVerifier(f.connect,f.trust)(f.request);
afterEach(()=>vi.useRealTimers());
describe('exact finalized KEEP tax execution failures',()=>{
 it.each([['claim',0],['combined',0],['split',0],['split',1]] as const)('proves failed %s ordinal%s without payment or whole-plan clearing',async(kind,ordinal)=>{
  const f=fixture(kind,ordinal),r=await read(f);
  expect(r).toMatchObject({outcome:'failed',wallet:f.preparation.wallet,idempotencyKey:f.preparation.idempotencyKey,claimId:f.preparation.claimId,ordinal,kind:f.preparation.transactions[ordinal]!.kind,signature:f.tx.transaction.signatures[0],feeLamports:'5',rentLamports:'0',paidKeepBaseUnits:'0',finalityAuthenticated:true,paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
  expect(r.source.snapshotSha256).toBe(f.preparation.source.snapshotSha256);expect(f.calls.transactions).toEqual([r.signature]);expect(f.calls.addresses[0]).toHaveLength(3);expect(f.calls.floors[0]).toBeGreaterThanOrEqual(f.tx.slot);expect(f.signals[0]!.aborted).toBe(true);
 });
 it('reports actual charged fee even above old consent without promising refund or another signature',async()=>{
  const f=fixture();f.tx.meta!.fee=11;f.tx.meta!.postBalances[0]=f.tx.meta!.preBalances[0]!-11;
  expect(await read(f)).toMatchObject({feeLamports:'11',signingAuthorized:false,paymentAuthorized:false});
 });
 it.each([null,{},false,'unknown',{InstructionError:[-1,{Custom:1}]},{InstructionError:[99,{Custom:1}]},{InstructionError:[0,{Custom:4294967296}]},{InstructionError:[0,{Unknown:1}]},{InstructionError:[0,{Custom:1,Other:2}]},{InstructionError:[0,'BadThing']},{DuplicateInstruction:99},{InsufficientFundsForRent:{account_index:99}}])('does not turn an invalid failure observation into terminal proof: %j',async err=>{
  const f=fixture();f.tx.meta!.err=err as never;await expect(read(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it.each(['AccountInUse',{InstructionError:[0,'InvalidArgument']},{InstructionError:[0,{BorshIoError:'fixture'}]},{DuplicateInstruction:0},{InsufficientFundsForRent:{account_index:0}},{ProgramExecutionTemporarilyRestricted:{account_index:0}}])('accepts known bounded failed execution shape %j',async err=>{const f=fixture();f.tx.meta!.err=err as never;expect((await read(f)).outcome).toBe('failed');});
 it('missing history and expired quote or blockheight are never failure proof',async()=>{const f=fixture();f.rpc.getTransaction=async()=>null;await expect(read(f)).rejects.toMatchObject({code:'UNAVAILABLE'});});
 it.each(['fee','payer','other','token','loaded','signature','wire','serializer','v0','slot','time'] as const)('refuses %s substitution',async what=>{
  const f=fixture(),m=f.tx.meta!;
  if(what==='fee')m.fee=-1;if(what==='payer')m.postBalances[0]!--;if(what==='other')m.postBalances[1]=1;
  if(what==='token'){const row={accountIndex:1,mint:f.preparation.identity.keepMint,owner:f.preparation.wallet,programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',uiTokenAmount:{amount:'1',decimals:6,uiAmount:null}};m.preTokenBalances=[row];m.postTokenBalances=[{...row,uiTokenAmount:{...row.uiTokenAmount,amount:'2'}}];}
  if(what==='loaded')m.loadedAddresses={writable:[new PublicKey(f.preparation.wallet)],readonly:[]};if(what==='signature')f.tx.transaction.signatures[0]='1'.repeat(64);
  if(what==='wire')f.request.signedTransaction[1]=f.request.signedTransaction[1]!^1;
  if(what==='serializer'){const message=f.tx.transaction.message as Message,valid=message.serialize();message.instructions[0]!.data='11111111';message.serialize=()=>valid;}
  if(what==='v0')f.tx.version=0;if(what==='slot')f.tx.slot=f.preparation.source.snapshotSlot-1;if(what==='time')f.tx.blockTime=Number(f.preparation.snapshot.unixTimestamp)-1;
  await expect(read(f)).rejects.toThrow();
 });
 it.each(['program-owner','program-bytes','program-data','deployment','clock-owner','clock-slot','clock-time','genesis','after-slot','bank-slot'] as const)('rejects changed trusted bank %s',async what=>{
  const f=fixture();
  if(what==='program-owner')f.bank[0]!.owner=PublicKey.default;if(what==='program-bytes')f.bank[0]!.data[4]=f.bank[0]!.data[4]!^1;if(what==='program-data')f.bank[1]!.data[45]=f.bank[1]!.data[45]!^1;if(what==='deployment')f.bank[1]!.data.writeBigUInt64LE(1n,4);
  if(what==='clock-owner')f.bank[2]!.owner=PublicKey.default;if(what==='clock-slot')f.clock.writeBigUInt64LE(1n);if(what==='clock-time')f.clock.writeBigInt64LE(0n,32);
  if(what==='genesis')f.rpc.getGenesisHash=async()=>f.preparation.wallet;
  if(what==='after-slot'){let i=0;f.rpc.getSlot=async()=>++i===1?f.tx.slot+1:f.tx.slot-1;}
  if(what==='bank-slot')f.setSlot(f.tx.slot-1);
  await expect(read(f)).rejects.toThrow();
 });
 it('owns request and transaction fields before later async providers can mutate them',async()=>{
  const f=fixture(),originalKey=f.preparation.idempotencyKey,get=f.rpc.getGenesisHash;f.rpc.getGenesisHash=async()=>{f.preparation.idempotencyKey='ffffffff-ffff-4fff-8fff-ffffffffffff';f.request.signedTransaction.fill(0);return get();};
  const getSlot=f.rpc.getSlot;f.rpc.getSlot=async()=>{f.tx.meta!.err=null;f.tx.meta!.fee=99;return getSlot('finalized');};
  expect(await read(f)).toMatchObject({idempotencyKey:originalKey,feeLamports:'5',outcome:'failed'});
 });
 it('copies returned account buffers before following provider awaits',async()=>{
  const f=fixture(),get=f.rpc.getSlot;let calls=0;f.rpc.getSlot=async()=>{if(++calls===2)f.bank[1]!.data.fill(0);return get('finalized');};expect((await read(f)).outcome).toBe('failed');
 });
 it.each(['oversized-data','oversized-keys','sparse-balances','sparse-instructions'] as const)('bounds hostile raw %s before provider serializers',async what=>{
  const f=fixture(),message=f.tx.transaction.message as Message;
  if(what==='oversized-data')message.instructions[0]!.data='1'.repeat(1684);if(what==='oversized-keys')message.accountKeys=Array(257).fill(PublicKey.default);
  if(what==='sparse-balances')delete f.tx.meta!.preBalances[1];if(what==='sparse-instructions')delete message.instructions[0];await expect(read(f)).rejects.toThrow();
 });
 it('bounds real abandoned RPC work through timeout until it actually drains',async()=>{
  vi.useFakeTimers();const f=fixture(),drains:Array<()=>void>=[];f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>drains.push(()=>resolve(f.trust.expectedGenesisHash)));
  const verify=createMiningTaxFailureVerifier(f.connect,f.trust,{timeoutMs:10,maxPending:2}),a=verify(f.request),b=verify(f.request);
  const refused=Promise.all([expect(a).rejects.toMatchObject({code:'TIMEOUT'}),expect(b).rejects.toMatchObject({code:'TIMEOUT'})]);await vi.advanceTimersByTimeAsync(11);await refused;
  await expect(verify(f.request)).rejects.toMatchObject({code:'BUSY'});drains.forEach(d=>d());await vi.advanceTimersByTimeAsync(0);f.rpc.getGenesisHash=async()=>f.trust.expectedGenesisHash;expect((await verify(f.request)).outcome).toBe('failed');
 });
 it('validates independent pins and options before connecting',()=>{const f=fixture();for(const options of [{timeoutMs:30001},{maxPending:33},{maxPending:0},{timeoutMs:0}])expect(()=>createMiningTaxFailureVerifier(f.connect,f.trust,options)).toThrow();expect(()=>createMiningTaxFailureVerifier(f.connect,{...f.trust,reviewedProgramDataSha256:'x'})).toThrow();expect(f.signals).toHaveLength(0);});
 it('enforces the default32 pending bound through actual abandoned RPC drain',async()=>{
  vi.useFakeTimers();const f=fixture(),drains:Array<()=>void>=[];f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>drains.push(()=>resolve(f.trust.expectedGenesisHash)));
  const verify=createMiningTaxFailureVerifier(f.connect,f.trust),pending=Array.from({length:32},()=>verify(f.request).catch(e=>e));
  expect(drains).toHaveLength(32);await expect(verify(f.request)).rejects.toMatchObject({code:'BUSY'});await vi.advanceTimersByTimeAsync(30001);
  expect((await Promise.all(pending)).every(e=>e.code==='TIMEOUT')).toBe(true);await expect(verify(f.request)).rejects.toMatchObject({code:'BUSY'});
  drains.forEach(d=>d());await vi.advanceTimersByTimeAsync(0);f.rpc.getGenesisHash=async()=>f.trust.expectedGenesisHash;expect((await verify(f.request)).outcome).toBe('failed');
 });
 it.each(['programId','keepMint','reserveOwner','expectedGenesisHash','reviewedDeploymentSlot','reviewedProgramDataSha256'] as const)('matches independent%s before any provider call',async field=>{
  const f=fixture(),other=field==='reviewedDeploymentSlot'?f.trust.reviewedDeploymentSlot+1:field==='reviewedProgramDataSha256'?'ab'.repeat(32):field==='expectedGenesisHash'?f.preparation.wallet:PublicKey.default;
  if(field==='programId')expect(()=>createMiningTaxFailureVerifier(f.connect,{...f.trust,programId:PublicKey.default})).toThrow();
  else await expect(createMiningTaxFailureVerifier(f.connect,{...f.trust,[field]:other})(f.request)).rejects.toMatchObject({code:'INPUT'});
  expect(f.signals).toHaveLength(0);
 });
});
