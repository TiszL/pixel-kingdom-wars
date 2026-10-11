import {Keypair,PublicKey} from '@solana/web3.js';
import {AccountLayout} from '@solana/spl-token';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createMiningTaxSnapshotReader} from './miningTaxSnapshot';
import {readFinalizedSeekerTerm,readFinalizedHistoricalSeekerTerm} from './seekerTerms';
import {createMiningTaxSnapshotFixture} from './testFixtures/miningTaxSnapshot';
const connect=(f:Awaited<ReturnType<typeof createMiningTaxSnapshotFixture>>)=>(_signal:AbortSignal)=>f.rpc;
afterEach(()=>vi.useRealTimers());
describe('finalized original-term KEEP tax snapshot',()=>{
 it('keeps original rights after expiry and paused sales, with actual Clock and no signing authority',async()=>{
  const f=await createMiningTaxSnapshotFixture();
  await expect(readFinalizedSeekerTerm(connect(f),f.seeker.policy)).rejects.toThrow('unavailable');
  const r=await createMiningTaxSnapshotReader(connect(f),f.trust)(f.request);
  expect(r.term.term).toBe(f.term.term.toBase58());expect(r.chainClock.unixTimestamp).toBeGreaterThan(f.term.operatingEnd);
  expect(r.pool).toMatchObject({accrued:10n,paid:3n});expect(r.entitlement).toEqual({cumulative:3n,claimed:3n,available:0n,dust:1n});
  expect(r.epochs.filter(e=>e.epoch!==null)).toHaveLength(1);expect(r.claimsAuthorized).toBe(false);expect(r.signingAuthorized).toBe(false);
  expect(r.source.accounts.every(a=>Object.isFrozen(a))).toBe(true);
 });
 it('current-term admission still accepts an operating Clock and refuses the exact end',async()=>{
  const f=await createMiningTaxSnapshotFixture();f.operatingClock();await expect(readFinalizedSeekerTerm(connect(f),f.seeker.policy)).resolves.toBeDefined();
  f.clock.writeBigInt64LE(f.term.operatingEnd,32);await expect(readFinalizedSeekerTerm(connect(f),f.seeker.policy)).rejects.toThrow();
  await expect(readFinalizedHistoricalSeekerTerm(connect(f),f.seeker.policy)).resolves.toBeDefined();
 });
 it.each(['foreign-wallet','unsold','zero-winners'] as const)('refuses %s without substituting an owner',async(kind)=>{
  const f=await createMiningTaxSnapshotFixture({zeroWinners:kind==='zero-winners'});const request={...f.request,...(kind==='foreign-wallet'?{wallet:f.other}:kind==='unsold'?{spot:22}:{})};
  await expect(createMiningTaxSnapshotReader(connect(f),f.trust)(request)).rejects.toThrow();
 });
 it('gives one equal share to each original spot, including a second spot owned by one wallet',async()=>{
  const f=await createMiningTaxSnapshotFixture();await f.cursorFor(20);const read=createMiningTaxSnapshotReader(connect(f),f.trust);
  expect((await read({...f.request,spot:20})).entitlement).toEqual({cumulative:3n,claimed:0n,available:3n,dust:1n});
  f.models.pool.accrued=20n;f.models.accrual.amount=20n;f.models.epoch.tax=20n;f.models.epoch.budget_gross=200n;f.models.epoch.free_gross=10n;f.models.epoch.deed_gross=190n;f.models.epoch.player_net=160n;f.models.epoch.recycle=20n;f.backing.model.tax_highwater=20n;f.backing.model.gross_published=200n;f.backing.model.recycled_total=20n;
  await f.config();for(const k of ['pool','accrual','epoch'] as const)await f.encode(k);
  expect((await read(f.request)).entitlement).toEqual({cumulative:6n,claimed:3n,available:3n,dust:2n});
 });
 it('distinguishes missing setup accounts and funded epochs without inventing an accrued pool',async()=>{
  const f=await createMiningTaxSnapshotFixture();for(const k of ['pool','cursor','accrual','ata'] as const)f.store.delete(f.addresses[k].toBase58());
  const r=await createMiningTaxSnapshotReader(connect(f),f.trust)(f.request);expect(r.pool).toBeNull();expect(r.cursor).toBeNull();expect(r.entitlement).toBeNull();expect(r.claimantAta.exists).toBe(false);expect(r.epochs.find(e=>e.epoch)?.accrual).toBeNull();
 });
 it.each(['wrong-genesis','deployment','pool-term','pool-count','cursor-high','wrong-cursor-wallet','epoch-v1','epoch-commitment','accrual-total','accrual-time','epoch-split','insolvent','wrong-token-owner','missing-term','regressing-context','claim-clock-regressed','pool-missing-with-cursor','missing-funded-epoch','pool-overpaid','oversized-bank','delegated-ata'] as const)('refuses %s',async(kind)=>{
  const f=await createMiningTaxSnapshotFixture();
  if(kind==='wrong-genesis')f.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
  if(kind==='deployment')f.store.get(f.seeker.programDataAddress.toBase58())!.data[49]=0;
  if(kind==='pool-term'){f.models.pool.term=Keypair.generate().publicKey;await f.encode('pool');}
  if(kind==='pool-count'){f.models.pool.winner_count=2;await f.encode('pool');}
  if(kind==='cursor-high'){f.models.cursor.claimed_total=4n;await f.encode('cursor');}
  if(kind==='wrong-cursor-wallet'){f.models.cursor.wallet=f.other;await f.encode('cursor');}
  if(kind==='epoch-v1'){f.models.epoch.tax_version=1;await f.encode('epoch');}
  if(kind==='epoch-commitment'){f.models.epoch.tax_commitment=Buffer.alloc(32,9);await f.encode('epoch');}
  if(kind==='accrual-total'){f.models.pool.accrued=9n;await f.encode('pool');}
  if(kind==='accrual-time'){f.models.accrual.accrued_at=f.models.epoch.funded_at;await f.encode('accrual');}
  if(kind==='epoch-split'){f.models.epoch.player_net=79n;await f.encode('epoch');}
  if(kind==='insolvent'){const r=f.store.get(f.backing.rows[1]!.address.toBase58())!;const a=AccountLayout.decode(r.data);AccountLayout.encode({...a,amount:0n},r.data);}
  if(kind==='wrong-token-owner'){const r=f.store.get(f.addresses.ata.toBase58())!;const a=AccountLayout.decode(r.data);AccountLayout.encode({...a,owner:f.other},r.data);}
  if(kind==='missing-term')f.store.delete(f.term.term.toBase58());
  if(kind==='regressing-context'){const original=f.rpc.getMultipleAccountsInfoAndContext;f.rpc.getMultipleAccountsInfoAndContext=async(keys,options)=>{const r=await original(keys,options);return {...r,context:{slot:1}};};}
  if(kind==='claim-clock-regressed'){const original=f.rpc.getMultipleAccountsInfoAndContext;f.rpc.getMultipleAccountsInfoAndContext=async(keys,opts)=>{if(keys.some(k=>k.equals(f.addresses.pool)))f.clock.writeBigInt64LE(f.term.operatingEnd,32);return original(keys,opts);};}
  if(kind==='pool-missing-with-cursor')f.store.delete(f.addresses.pool.toBase58());
  if(kind==='missing-funded-epoch')f.store.delete(f.addresses.epoch.toBase58());
  if(kind==='pool-overpaid'){f.models.pool.paid=10n;f.backing.model.tax_paid=10n;await f.config();await f.encode('pool');}
  if(kind==='oversized-bank')f.store.get(f.addresses.pool.toBase58())!.data=Buffer.alloc(1_000_000);
  if(kind==='delegated-ata'){const r=f.store.get(f.addresses.ata.toBase58())!,a=AccountLayout.decode(r.data);AccountLayout.encode({...a,delegateOption:1,delegate:f.other,delegatedAmount:1n},r.data);}
  await expect(createMiningTaxSnapshotReader(connect(f),f.trust)(f.request)).rejects.toThrow();
 });
 it('refuses a failed original settlement even though account bytes name the winner',async()=>{const f=await createMiningTaxSnapshotFixture();f.seeker.bodies.values().next().value!.meta!.err={InstructionError:[0,'InvalidArgument']};await expect(createMiningTaxSnapshotReader(connect(f),f.trust)(f.request)).rejects.toThrow();});
 it('refuses immutable term changes between provenance and the single tax bank',async()=>{const f=await createMiningTaxSnapshotFixture();const original=f.rpc.getMultipleAccountsInfoAndContext;f.rpc.getMultipleAccountsInfoAndContext=async(keys,options)=>{if(keys.some(k=>k.equals(f.addresses.pool)))f.store.get(f.term.term.toBase58())!.data[0]=0;return original(keys,options);};await expect(createMiningTaxSnapshotReader(connect(f),f.trust)(f.request)).rejects.toThrow();});
 it('copies application trust and request before asynchronous provenance reads',async()=>{const f=await createMiningTaxSnapshotFixture();const read=createMiningTaxSnapshotReader(connect(f),f.trust),request={...f.request};const promise=read(request);request.spot=22;f.trust.mining.expectedGenesisHash=PublicKey.default.toBase58();(f.trust.seeker.deployment as {programDataSha256:string}).programDataSha256='00'.repeat(32);const r=await promise;expect(r.spot).toBe(0);expect(r.wallet).toBe(f.wallet.toBase58());});
 it('copies the bank before later RPC awaits and never exposes mutable buffers',async()=>{const f=await createMiningTaxSnapshotFixture();const original=f.rpc.getMultipleAccountsInfoAndContext;let bank:Awaited<ReturnType<typeof original>>|undefined;f.rpc.getMultipleAccountsInfoAndContext=async(keys,options)=>{const r=await original(keys,options);if(keys.some(k=>k.equals(f.addresses.pool)))bank=r;return r;};f.rpc.getSlot=async()=>{if(bank)for(const r of bank.value)r?.data.fill(0);return 2000;};const r=await createMiningTaxSnapshotReader(connect(f),f.trust)(f.request);expect(r.pool?.accrued).toBe(10n);expect(Object.isFrozen(r)).toBe(true);});
 it('keeps abort-ignoring RPC work in capacity until it actually drains',async()=>{const f=await createMiningTaxSnapshotFixture();vi.useFakeTimers();let release!:()=>void;f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{release=()=>resolve(f.backing.trust.expectedGenesisHash);});const read=createMiningTaxSnapshotReader(connect(f),f.trust,{timeoutMs:10,maxPending:1});const first=read(f.request);const rejected=expect(first).rejects.toMatchObject({code:'TIMEOUT'});await vi.advanceTimersByTimeAsync(10);await rejected;await expect(read(f.request)).rejects.toMatchObject({code:'BUSY'});release();await vi.advanceTimersByTimeAsync(0);f.rpc.getGenesisHash=async()=>f.backing.trust.expectedGenesisHash;await expect(read(f.request)).resolves.toBeDefined();});
 it('permits the reserve owner as claimant without counting its canonical ATA twice',async()=>{const f=await createMiningTaxSnapshotFixture({claimReserve:true});const r=await createMiningTaxSnapshotReader(connect(f),f.trust)(f.request);expect(r.claimantAta.address).toBe(r.backing.config.emissionReserveAta);});
 it('refuses contradictory rows for a duplicated canonical account',async()=>{const f=await createMiningTaxSnapshotFixture({claimReserve:true});const original=f.rpc.getMultipleAccountsInfoAndContext;f.rpc.getMultipleAccountsInfoAndContext=async(keys,opts)=>{const r=await original(keys,opts);if(keys.some(k=>k.equals(f.addresses.pool)))r.value[14]!.data[0]=0;return r;};await expect(createMiningTaxSnapshotReader(connect(f),f.trust)(f.request)).rejects.toMatchObject({code:'ACCOUNTS'});});
 it('reports claims pause without deleting verified rights',async()=>{const f=await createMiningTaxSnapshotFixture();f.backing.model.flags=1;await f.config();const r=await createMiningTaxSnapshotReader(connect(f),f.trust)(f.request);expect(r.claimsPaused).toBe(true);expect(r.entitlement?.cumulative).toBe(3n);});
 it('rejects unknown fields, oversized work controls and malformed request domains before RPC',async()=>{const f=await createMiningTaxSnapshotFixture();expect(()=>createMiningTaxSnapshotReader(connect(f),f.trust,{maxPending:33})).toThrow();const read=createMiningTaxSnapshotReader(connect(f),f.trust);for(const request of [{...f.request,amount:1},{...f.request,round:-1n},{...f.request,spot:100}])await expect(read(request)).rejects.toThrow();expect(f.calls).toHaveLength(0);});
});
